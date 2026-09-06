import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

import { otaErase, otaUpload, waitForOtaServer } from '../device/wifi.mjs'
import { CliError, ExitCode, fail } from '../errors.mjs'
import { formatCommand } from '../run.mjs'
import { slotGeometry } from './flash.mjs'

// Over-the-air delivery: WiFi through the board's OTA server, or BLE through
// the CoreBluetooth helper. Neither touches the bootloader or partition table.

function requireImage(image) {
  if (!existsSync(image)) fail(`App image not found: ${image}`, ExitCode.deployFailed)
  return image
}

export async function otaFlash({ host, image, dryRun = false, stdout = console.log }) {
  requireImage(image)
  stdout(`Sending OTA update to ${host}...`)
  if (dryRun) {
    stdout(`POST http://${host}:8080/ota <- ${image}`)
    return
  }
  await otaUpload({ host, image, stdout })
  stdout('OTA complete. Board is rebooting.')
}

export async function otaStage({ selection, host, image, slot, boot = false, reboot = false, appLabel = 'prebuilt image', dryRun = false, stdout = console.log }) {
  const geometry = slotGeometry(selection, slot)
  requireImage(image)
  const size = statSync(image).size
  if (size > geometry.size) {
    fail(`App image is ${size} bytes but ${geometry.name} only has ${geometry.size} bytes.\nRegenerate a partition plan with fewer apps or larger slots.`, ExitCode.deployFailed)
  }
  stdout(`Staging '${appLabel}' from ${image} to ${geometry.name} over WiFi OTA...`)
  if (dryRun) {
    stdout(`POST http://${host}:8080/ota?slot=${geometry.name}&boot=${boot ? 1 : 0}&reboot=${reboot ? 1 : 0} <- ${image}`)
    return
  }
  await otaUpload({ host, image, slot: geometry.name, boot, reboot, stdout })
  stdout(`Staged '${appLabel}' in ${geometry.name} over OTA. Boot selection was not changed.`)
}

export async function otaEraseSlot({ selection, host, slot, dryRun = false, stdout = console.log }) {
  const geometry = slotGeometry(selection, slot)
  stdout(`Erasing ${geometry.name} over WiFi OTA...`)
  if (dryRun) {
    stdout(`POST http://${host}:8080/ota/erase?slot=${geometry.name}`)
    return
  }
  const reply = await otaErase({ host, slot: geometry.name })
  if (reply) stdout(reply)
  stdout(`Erased ${geometry.name} over OTA.`)
}

export async function waitForReboot({ host, stdout = console.log, timeoutMs = 120000 }) {
  stdout('OTA sent. Waiting for reboot + WiFi reconnect...')
  await new Promise((resolve) => setTimeout(resolve, 8000))
  await waitForOtaServer({ host, timeoutMs })
}

export function bleOtaHelperPath(cliPackageRoot) {
  return path.join(cliPackageRoot, 'src', 'ble', 'ble-ota.swift')
}

export function bleOta({ cliPackageRoot, image, deviceName, env, dryRun = false, stdout = console.log }) {
  requireImage(image)
  const helper = bleOtaHelperPath(cliPackageRoot)
  const args = [helper, image, deviceName || env.GEA_BLE_OTA_DEVICE || 'Geastack OTA']
  if (dryRun) {
    stdout(formatCommand(['swift', ...args]))
    return
  }
  const probe = spawnSync('swift', ['--version'], { env, stdio: 'ignore' })
  if (probe.error || probe.status !== 0) fail('BLE OTA currently requires Swift/CoreBluetooth on macOS.', ExitCode.missingDependency)
  const result = spawnSync('swift', args, { env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new CliError(`ERROR: BLE OTA failed (${result.status}).`, ExitCode.deployFailed)
}
