import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { waitForSerialPort } from '../boards/usb.mjs'
import { CliError, ExitCode, fail } from '../errors.mjs'
import { quietSteps, runStep } from '../run.mjs'
import { esptoolCommand } from './idf-env.mjs'
import { buildFlashSettings, flashOffsetForBuildImage, loadPartitions, normalizeOtaSlot, partitionByName, readFlashPlan, sizeToBytes } from './partitions.mjs'
import { success, warn } from '../report.mjs'

// USB flashing through esptool, with the board addressed by its USB serial:
// a board re-enumerates after every reset, so the port is resolved again on
// every attempt rather than cached.

// esptool's RTS/DTR "hard reset" does not reliably launch the app on a board
// flashed through the chip's own USB-Serial-JTAG. The pin sequence that ends
// the reset is the same one that enters ROM download mode, so the chip can come
// up in the ROM's UartConnCheck loop instead of the app -- a silent console and
// a dark panel that look exactly like a bad image, on a board whose flash
// verified byte for byte. Triggering the RTC watchdog from the flasher stub
// resets the chip from the inside instead, where the strapping pins play no
// part. Only esptool 5 (ESP-IDF 6) offers it, and only these chips have the
// peripheral; everything else keeps the pin reset.
const usbSerialJtagChips = new Set(['esp32s3', 'esp32c3', 'esp32c5', 'esp32c6', 'esp32c61', 'esp32h2', 'esp32p4'])

function postFlashReset(idf, selection) {
  if (!usbSerialJtagChips.has(esptoolChip(selection))) return 'hard-reset'
  // Hyphenated: this branch only runs on esptool 5, where the underscore
  // spellings are deprecated.
  return Number(idf?.version?.major || 0) >= 6 ? 'watchdog-reset' : 'hard-reset'
}

export function flashOptions(env, { idf = null, selection = null, manualBoot = false, noReset = false, baud = '' } = {}) {
  const flashBaud = String(baud || env.GEA_ESP32_FLASH_BAUD || '921600')
  if (!/^[1-9]\d*$/.test(flashBaud)) fail(`--flash-baud must be a positive integer (got '${flashBaud}').`, ExitCode.usage)
  return {
    before: manualBoot ? 'no-reset' : 'default-reset',
    after: noReset ? 'no-reset' : postFlashReset(idf, selection),
    baud: flashBaud,
    retrySeconds: Number(env.GEA_ESP32_FLASH_RETRY_SECONDS ?? 300),
    manualBootGraceSeconds: Number(env.GEA_ESP32_MANUAL_BOOT_GRACE_SECONDS ?? 4)
  }
}

function esptoolChip(selection) {
  return selection?.esptoolChip || selection?.idfTarget || 'esp32s3'
}

function esptoolPrefix(selection, options) {
  return ['--chip', esptoolChip(selection), '--before', options.before, '--after', options.after, '-b', options.baud]
}

function writeFlashArgs(selection, options, pairs, buildDir = '') {
  const flash = buildFlashSettings(buildDir, selection.flashSize)
  return [...esptoolPrefix(selection, options), 'write-flash', '--flash-mode', flash.mode, '--flash-freq', flash.freq, '--flash-size', flash.size, ...pairs]
}

export async function runEsptoolOverUsb({ idf, selection, options, args, port = '', env, dryRun = false, verbose = false, logDir = os.tmpdir(), stdout = console.log, stderr = console.error }) {
  const startedAt = Date.now()
  let attempt = 1
  let status = 1
  for (;;) {
    let remaining = options.retrySeconds
    if (options.retrySeconds > 0) {
      remaining = options.retrySeconds - (Date.now() - startedAt) / 1000
      if (remaining <= 0) {
        throw new CliError('ERROR: Timed out waiting for USB flash connection.', ExitCode.deployFailed)
      }
    }
    const flashPort = dryRun
      ? port || `<usb serial ${selection.usbSerial}>`
      : await waitForSerialPort({ port, serial: selection.usbSerial, timeoutSeconds: remaining, label: 'ESP32 USB flash port', log: stderr })
    if (options.before === 'no-reset') {
      stdout('Manual boot mode: hold BOOT/IO0, reset or power-cycle the board, then keep BOOT held until esptool connects.')
      stdout('Manual boot mode: esptool will not toggle reset before connecting.')
      if (options.manualBootGraceSeconds > 0 && !dryRun) {
        stdout(`Manual boot mode: waiting ${options.manualBootGraceSeconds}s before attempt ${attempt}...`)
        await new Promise((resolve) => setTimeout(resolve, options.manualBootGraceSeconds * 1000))
      }
    }
    const { command, args: fullArgs } = esptoolCommand(idf, ['-p', flashPort, ...args])
    // Retries append to one log; the summary reads the last attempt only.
    const logFile = path.join(logDir, 'gea-flash.log')
    const step = await runStep(command, fullArgs, {
      cwd: selection.targetDir,
      env,
      dryRun,
      verbose,
      label: attempt === 1 ? `Flashing over USB on ${flashPort}` : `USB flash attempt ${attempt} on ${flashPort}`,
      logFile,
      appendLog: attempt > 1,
      stdout,
      stderr
    })
    if (dryRun) return 0

    status = step.status
    if (status === 0) {
      if (step.quiet) stdout(flashSummary(logFile))
      return 0
    }
    if (status === 130 || status === 143) throw new CliError('ERROR: USB flash interrupted.', ExitCode.deployFailed)
    if (options.retrySeconds > 0 && (Date.now() - startedAt) / 1000 >= options.retrySeconds) {
      throw new CliError(`ERROR: USB flash failed after ${attempt} attempt(s).`, ExitCode.deployFailed)
    }
    warn(stderr, `USB flash attempt ${attempt} failed with status ${status}; waiting for board and retrying...`)
    attempt += 1
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

// esptool prints one "Wrote N bytes ... at 0x... in T seconds" line per
// image; those, plus the chip line, are the parts worth keeping.
function flashSummary(logFile) {
  // esptool redraws progress with carriage returns and cursor escapes, so
  // split on both line endings and drop the escapes before matching.
  const attempts = readFileSync(logFile, 'utf8').split(/^(?=esptool v)/m)
  const lines = attempts[attempts.length - 1].split(/\r?\n|\r/).map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
  const chip = lines.map((line) => line.match(/^Chip type:\s+(.+)$/)?.[1]).find(Boolean)
  const writes = lines.map((line) => line.match(/^Wrote (\d+) bytes .* at (0x[0-9a-f]+) in ([\d.]+) seconds/)).filter(Boolean)
  const total = writes.reduce((sum, match) => sum + Number(match[1]), 0)
  const seconds = writes.reduce((sum, match) => sum + Number(match[3]), 0)
  const parts = writes.map((match) => `${formatBytes(Number(match[1]))} at ${match[2]}`)
  return [chip ? `Connected to ${chip}` : '', `Wrote ${parts.join(', ')} (${formatBytes(total)} in ${seconds.toFixed(1)}s)`].filter(Boolean).join('\n')
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function requireImage(file, what) {
  if (!existsSync(file)) fail(`${what} not found: ${file}`, ExitCode.deployFailed)
  return file
}

function assertFits(image, slot, slotSize, what = 'App image') {
  const imageSize = statSync(image).size
  if (imageSize > slotSize) {
    fail(`${what} is ${imageSize} bytes but ${slot} only has ${slotSize} bytes.\nRegenerate a partition plan with fewer apps or larger slots.`, ExitCode.deployFailed)
  }
}

export function slotGeometry(selection, slot, buildDir = '') {
  const name = normalizeOtaSlot(slot)
  const partition = partitionByName(loadPartitions(selection.targetDir, buildDir), name)
  return { name, offset: partition.offset, size: sizeToBytes(partition.size) }
}

// The files the app declared for its data partitions -- a profile library, a
// preset image. IDF's own flash target writes these; esptool has to be told.
function payloadPairs(partitions, buildDir, stdout) {
  const payloads = readFlashPlan(buildDir).payloads
  const pairs = []
  for (const payload of payloads) {
    const partition = partitionByName(partitions, payload.name)
    const file = requireImage(payload.file, `Payload for partition '${payload.name}'`)
    assertFits(file, payload.name, sizeToBytes(partition.size), `Payload for '${payload.name}'`)
    pairs.push(partition.offset, file)
  }
  if (pairs.length) stdout(`Writing ${payloads.length} data partition payload(s): ${payloads.map((payload) => payload.name).join(', ')}.`)
  return pairs
}

// Bootloader + partition table + otadata + app in ota_0: a full provisioning
// of the board from one build directory.
export async function flashFirmware({ idf, selection, images, appImage = images.app, appLabel = 'prebuilt image', options, port, env, dryRun, verbose = false, stdout, stderr }) {
  const image = requireImage(appImage, 'App image')
  for (const required of [images.bootloader, images.partitionTable, images.otaData]) {
    if (!existsSync(required)) fail(`${required} was not found. Build the launcher once first.`, ExitCode.deployFailed)
  }
  const buildDir = images.buildDir
  const partitions = loadPartitions(selection.targetDir, buildDir)
  const app = partitionByName(partitions, 'ota_0')
  const otadata = partitionByName(partitions, 'otadata')
  assertFits(image, 'ota_0', sizeToBytes(app.size))
  stdout(`Flashing '${appLabel}' from ${image} to ota_0 (${app.offset}) over USB...`)
  stdout('Writing bootloader, partition table, default OTA boot metadata, and app image.')
  const pairs = [
    flashOffsetForBuildImage(buildDir, images.bootloader, '0x0'), images.bootloader,
    app.offset, image,
    flashOffsetForBuildImage(buildDir, images.partitionTable, '0x8000'), images.partitionTable,
    otadata.offset, images.otaData,
    ...payloadPairs(partitions, buildDir, stdout)
  ]
  if (!quietSteps(env, verbose)) stdout(`Flashing '${appLabel}' to ota_0 (${app.offset}) over USB with bootloader, partition table and OTA boot metadata.`)
  await runEsptoolOverUsb({ idf, selection, options, args: writeFlashArgs(selection, options, pairs, buildDir), port, env, dryRun, verbose, logDir: buildDir, stdout, stderr })
  success(stdout, `Flashed '${appLabel}' in ota_0 and reset OTA boot metadata to ota_0.`)
}

export async function flashImageSet({ idf, selection, images, slotImages, options, port, env, dryRun, stdout, stderr }) {
  for (const required of [images.bootloader, images.partitionTable, images.otaData]) {
    if (!existsSync(required)) fail(`${required} was not found. Build the launcher once first.`, ExitCode.deployFailed)
  }
  const buildDir = images.buildDir
  const partitions = loadPartitions(selection.targetDir, buildDir)
  const otadata = partitionByName(partitions, 'otadata')
  stdout(`Flashing ${slotImages.length} prebuilt app image(s) over USB...`)
  stdout('Writing bootloader, partition table, default OTA boot metadata, and app images.')
  const pairs = [
    flashOffsetForBuildImage(buildDir, images.bootloader, '0x0'), images.bootloader,
    flashOffsetForBuildImage(buildDir, images.partitionTable, '0x8000'), images.partitionTable,
    otadata.offset, images.otaData,
    ...payloadPairs(partitions, buildDir, stdout)
  ]
  for (const entry of slotImages) {
    const eq = entry.indexOf('=')
    if (eq <= 0 || eq === entry.length - 1) fail(`Invalid --slot-image value '${entry}'. Use --slot-image=ota_<n>=<bin>.`, ExitCode.usage)
    const slot = slotGeometry(selection, entry.slice(0, eq), buildDir)
    const image = requireImage(entry.slice(eq + 1), `App image for ${slot.name}`)
    assertFits(image, slot.name, slot.size)
    pairs.push(slot.offset, image)
  }
  stdout(`Flashing ${slotImages.length} prebuilt app image(s) over USB...`)
  stdout('Writing bootloader, partition table, default OTA boot metadata, and app images.')
  await runEsptoolOverUsb({ idf, selection, options, args: writeFlashArgs(selection, options, pairs, buildDir), port, env, dryRun, stdout, stderr })
  success(stdout, options.after === 'no-reset' ? 'Flashed app images. Device was not reset after flashing.' : 'Flashed app images. Device was reset after flashing.')
}

// App image only, into a chosen OTA slot; boot selection is untouched.
export async function stageImage({ idf, selection, image, slot, buildDir = '', appLabel = 'prebuilt image', options, port, env, dryRun, stdout, stderr }) {
  const geometry = slotGeometry(selection, slot, buildDir)
  requireImage(image, 'App image')
  assertFits(image, geometry.name, geometry.size)
  stdout(`Staging '${appLabel}' from ${image} to ${geometry.name} (${geometry.offset}) over USB...`)
  stdout('Writing app image only; bootloader, partition table, and otadata are unchanged.')
  await runEsptoolOverUsb({ idf, selection, options, args: writeFlashArgs(selection, options, [geometry.offset, image], buildDir), port, env, dryRun, stdout, stderr })
  success(stdout, `Staged '${appLabel}' in ${geometry.name}. Boot selection was not changed.`)
}

export async function restoreBootMetadata({ idf, selection, images, options, port, env, dryRun, stdout, stderr }) {
  if (!existsSync(images.otaData)) fail(`${images.otaData} was not found. Flash the launcher once first.`, ExitCode.deployFailed)
  const otadata = partitionByName(loadPartitions(selection.targetDir, images.buildDir), 'otadata')
  stdout(`Restoring OTA boot metadata at ${otadata.offset}...`)
  await runEsptoolOverUsb({ idf, selection, options, args: writeFlashArgs(selection, options, [otadata.offset, images.otaData], images.buildDir), port, env, dryRun, stdout, stderr })
  success(stdout, 'Launcher OTA boot metadata restored.')
}

export async function eraseSlot({ idf, selection, slot, buildDir = '', options, port, env, dryRun, stdout, stderr }) {
  const geometry = slotGeometry(selection, slot, buildDir)
  stdout(`Erasing ${geometry.name} (${geometry.offset}, ${geometry.size} bytes) over USB...`)
  await runEsptoolOverUsb({ idf, selection, options, args: [...esptoolPrefix(selection, options), 'erase-region', geometry.offset, String(geometry.size)], port, env, dryRun, stdout, stderr })
  success(stdout, `Erased ${geometry.name}.`)
}

export function postFlashRestartNote(selection, stderr) {
  if (selection.usbRestartAfterFlash !== 'manual') return
  stderr(`
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Flash complete. This board does NOT auto-restart after a USB flash.        │
  │  Tap the RESET button (or unplug/replug power) to launch the app.           │
  │                                                                             │
  │  Why: its USB-Serial-JTAG re-enters ROM download mode when the flash port   │
  │  is closed. It boots normally from a reset/power-cycle (no host involved).  │
  └──────────────────────────────────────────────────────────────────────────┘`)
}
