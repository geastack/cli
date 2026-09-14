import path from 'node:path'

import { flag, option, optionList } from '../args.mjs'
import { loadBoardConfig, normalizeBoardConfig } from '../boards/config.mjs'
import { resolveBoardSelection } from '../boards/resolve.mjs'
import { resolveUsbSerialPort } from '../boards/usb.mjs'
import { createChildEnv } from '../context.mjs'
import { chooseTransport, openDevice, saveScreenshot } from '../device/device.mjs'
import { geadev } from '../device/serial.mjs'
import { ExitCode, fail } from '../errors.mjs'
import { buildEsp32Firmware, buildImages, esp32BuildDir, fullCleanEsp32, requireEspIdf } from '../esp32/build.mjs'
import { eraseSlot, flashFirmware, flashImageSet, flashOptions, postFlashRestartNote, restoreBootMetadata, stageImage } from '../esp32/flash.mjs'
import { bleOta, otaEraseSlot, otaFlash, otaStage, waitForReboot } from '../esp32/ota.mjs'
import { manifestRequestsBleOta } from '../esp32/capabilities.mjs'
import { runGeaos } from '../geaos/adapter.mjs'
import { assertTargetEnabled, assertValidApp, discoverApps, resolveRequestedApp, targetEnabledForApp } from '../manifest.mjs'
import { buildRp2350, flashRp2350, rp2350BuildDir } from '../rp2350/adapter.mjs'
import { runXbox } from '../xbox/adapter.mjs'
import { success } from '../report.mjs'

// Every board-facing command: resolve the alias, pick the adapter, run.

export function selectBoard(ctx, parsed, needs = {}) {
  const targetName = option(parsed, 'target', '')
  const boardName = option(parsed, 'board', '') || (targetName ? '' : onlyRegisteredBoard(ctx))
  if (!boardName && !targetName) fail('--board <alias> is required (see gea boards list).', ExitCode.usage)
  try {
    return resolveBoardSelection({
      ctx,
      boardName,
      targetName,
      requestedPort: option(parsed, 'port', ''),
      requestedHost: option(parsed, 'host', ''),
      needs,
      deferUsbPort: true
    })
  } catch (error) {
    fail(error.message, ExitCode.usage)
  }
}

// A single registered alias needs no --board; several do, and the error names
// them so the reader can pick.
function onlyRegisteredBoard(ctx) {
  const aliases = Object.keys(normalizeBoardConfig(loadBoardConfig(ctx)))
  if (aliases.length === 1) return aliases[0]
  if (aliases.length > 1) fail(`--board <alias> is required, several boards are registered: ${aliases.join(', ')}.`, ExitCode.usage)

  return ''
}

function optionalApp(ctx, parsed, rest, selection, { required = false } = {}) {
  const requested = option(parsed, 'app') || rest[0]
  let app = null
  if (requested) {
    app = resolveRequestedApp(ctx, parsed, rest)
  } else {
    try {
      app = resolveRequestedApp(ctx, parsed, [])
    } catch {
      app = null
    }
    // Outside an app folder the bare "No app selected" is useless; name the
    // apps this board can take instead.
    if (!app && required) requireApp(ctx, selection, null)
  }
  if (!app) return null
  assertValidApp(app)
  assertTargetEnabled(ctx, app, selection.boardName || selection.target)
  return app
}

// An app that asked for BLE updates at create time updates over BLE unless
// --transport says otherwise. Outside an app folder there is nothing to read,
// and Wi-Fi stays the default.
function defaultOtaTransport(ctx, parsed, rest) {
  try {
    const app = resolveRequestedApp(ctx, parsed, option(parsed, 'app') || rest[0] ? rest : [])
    return manifestRequestsBleOta(app?.packageJson) ? 'ble' : 'wifi'
  } catch {
    return 'wifi'
  }
}

function bleOtaRequested(parsed, app, env) {
  return option(parsed, 'transport') === 'ble' || env.GEA_EMBEDDED_BLE_OTA === '1' || manifestRequestsBleOta(app?.packageJson)
}

function io(parsed, options) {
  return {
    env: options.env,
    dryRun: flag(parsed, 'dry-run'),
    stdout: options.stdout,
    stderr: options.stderr
  }
}

// ---- build ------------------------------------------------------------------

// Firmware is built per app and the ESP32/RP2350 CMake refuses to configure
// without one (its script-mode pass would otherwise analyze a directory), so
// those adapters need an app even for --configure-only; the geaos adapter has
// app-less actions.
const appRequiredAdapters = new Set(['esp32-idf', 'rp2350-pico', 'xbox-uwp'])

function requireAppForAdapter(ctx, parsed, selection, app) {
  if (app || !appRequiredAdapters.has(selection.adapter)) return app
  return requireApp(ctx, selection, app)
}

function requireApp(ctx, selection, app) {
  if (app) return app
  const candidates = discoverApps(ctx).filter((candidate) => targetEnabledForApp(ctx, candidate, selection.boardName || selection.target))
  const hint = candidates.length > 0 ? `apps targeting '${selection.boardName || selection.target}': ${candidates.map((candidate) => candidate.id).join(', ')}` : `no app in ${ctx.projectRoot} targets '${selection.boardName || selection.target}' yet`
  fail(`Board '${selection.boardName || selection.target}' builds one app at a time: pass --app <id> or run inside the app folder (${hint}).`, ExitCode.usage)
}

export async function buildCommand(ctx, parsed, rest, options) {
  const selection = selectBoard(ctx, parsed)
  const app = requireAppForAdapter(ctx, parsed, selection, optionalApp(ctx, parsed, rest, selection))
  const base = io(parsed, options)
  const env = createChildEnv(ctx, base.env)
  switch (selection.adapter) {
    case 'xbox-uwp':
      return runXbox({ app, action: 'build', env, dryRun: base.dryRun, stdout: base.stdout })
    case 'esp32-idf': {
      await buildEsp32Firmware({ ctx, selection, app, env, bleOta: bleOtaRequested(parsed, app, env), dryRun: base.dryRun, verbose: flag(parsed, 'verbose'), stdout: base.stdout, stderr: base.stderr, configureOnly: flag(parsed, 'configure-only') })
      return 0
    }
    case 'rp2350-pico':
      buildRp2350({ ctx, selection, app, env, dryRun: base.dryRun, stdout: base.stdout, stderr: base.stderr, configureOnly: flag(parsed, 'configure-only') })
      return 0
    case 'geaos-linux':
    case 'geaos-arm64':
      return runGeaos({ ctx, selection, action: 'build', app, positionals: rest, env, dryRun: base.dryRun, stdout: base.stdout })
    default:
      fail(`Unknown adapter '${selection.adapter}' for target '${selection.target}'.`, ExitCode.usage)
  }
}

export async function cleanCommand(ctx, parsed, rest, options) {
  const selection = selectBoard(ctx, parsed)
  const app = optionalApp(ctx, parsed, rest, selection)
  const base = io(parsed, options)
  if (selection.adapter === 'esp32-idf') {
    fullCleanEsp32({ ctx, selection, app, env: base.env, stdout: base.stdout })
    return 0
  }
  if (selection.adapter === 'rp2350-pico') {
    const dir = rp2350BuildDir(ctx, selection)
    base.stdout(`Removing build artifacts in ${dir}...`)
    const { rmSync } = await import('node:fs')
    rmSync(dir, { recursive: true, force: true })
    return 0
  }
  fail(`'clean' is not supported for ${selection.adapter} boards.`, ExitCode.usage)
}

// ---- flash / run --------------------------------------------------------------

async function flashEsp32(ctx, parsed, rest, options, selection, { monitor }) {
  const base = io(parsed, options)
  const env = createChildEnv(ctx, base.env)
  const idf = requireEspIdf(env, base.stdout)
  const flashEnv = idf.env
  const opts = flashOptions(flashEnv, { idf, selection, manualBoot: flag(parsed, 'manual-boot'), noReset: option(parsed, 'reset') === false, baud: option(parsed, 'flash-baud', '') })
  const common = { idf, selection, options: opts, port: selection.port, env: flashEnv, dryRun: base.dryRun, verbose: flag(parsed, 'verbose'), stdout: base.stdout, stderr: base.stderr }
  const slotImages = optionList(parsed, 'slot-image')
  const eraseSlotName = option(parsed, 'erase-slot', '')
  const slot = option(parsed, 'slot', '')
  const explicitImage = option(parsed, 'image', '')
  const app = explicitImage && !option(parsed, 'app') && !rest[0] ? null : optionalApp(ctx, parsed, rest, selection, { required: !explicitImage && !slotImages.length && !eraseSlotName && !flag(parsed, 'restore-boot') })

  const buildDir = esp32BuildDir(ctx, selection, app?.id, flashEnv)
  const images = { ...buildImages(buildDir), buildDir }

  if (eraseSlotName) {
    await eraseSlot({ ...common, slot: eraseSlotName, buildDir })
    return 0
  }
  if (flag(parsed, 'restore-boot')) {
    await restoreBootMetadata({ ...common, images })
    return 0
  }
  if (slotImages.length) {
    await flashImageSet({ ...common, images, slotImages })
    postFlashRestartNote(selection, base.stderr)
    return 0
  }

  let image = explicitImage ? path.resolve(ctx.cwd, explicitImage) : images.app
  if (!explicitImage && !flag(parsed, 'no-build')) {
    await buildEsp32Firmware({ ctx, selection, app, env, bleOta: bleOtaRequested(parsed, app, env), dryRun: base.dryRun, verbose: flag(parsed, 'verbose'), stdout: base.stdout, stderr: base.stderr })
  }
  const appLabel = app?.id || 'prebuilt image'
  if (slot) {
    await stageImage({ ...common, image, slot, buildDir, appLabel })
    return 0
  }
  await flashFirmware({ ...common, images, appImage: image, appLabel })
  if (!monitor) {
    postFlashRestartNote(selection, base.stderr)
    return 0
  }
  return monitorCommand(ctx, parsed, rest, options, selection)
}

export async function flashCommand(ctx, parsed, rest, options, { monitor = false } = {}) {
  const selection = selectBoard(ctx, parsed, { usbPort: true })
  const base = io(parsed, options)
  const env = createChildEnv(ctx, base.env)
  switch (selection.adapter) {
    case 'xbox-uwp': {
      const app = optionalApp(ctx, parsed, rest, selection, { required: true })
      return runXbox({ app, action: 'deploy', env, host: option(parsed, 'host', '') || selection.otaHost,
        noBuild: option(parsed, 'build') === false, dryRun: base.dryRun, stdout: base.stdout })
    }
    case 'esp32-idf':
      return flashEsp32(ctx, parsed, rest, options, selection, { monitor })
    case 'rp2350-pico': {
      const app = optionalApp(ctx, parsed, rest, selection)
      const { uf2 } = buildRp2350({ ctx, selection, app, env, dryRun: base.dryRun, stdout: base.stdout, stderr: base.stderr })
      flashRp2350({ selection, uf2, env, dryRun: base.dryRun, stdout: base.stdout })
      return monitor ? monitorCommand(ctx, parsed, rest, options, selection) : 0
    }
    case 'geaos-linux':
    case 'geaos-arm64': {
      const app = optionalApp(ctx, parsed, rest, selection)
      return runGeaos({ ctx, selection, action: monitor ? 'flash-monitor' : 'flash', app, positionals: rest, env, dryRun: base.dryRun, stdout: base.stdout })
    }
    default:
      fail(`Unknown adapter '${selection.adapter}' for target '${selection.target}'.`, ExitCode.usage)
  }
}

// ---- ota ------------------------------------------------------------------------

export async function otaCommand(ctx, parsed, rest, options) {
  const transport = option(parsed, 'transport', '') || defaultOtaTransport(ctx, parsed, rest)
  if (transport !== 'wifi' && transport !== 'ble') fail("--transport must be 'wifi' or 'ble'.", ExitCode.usage)
  const selection = selectBoard(ctx, parsed, transport === 'wifi' ? { otaHost: true } : {})
  if (selection.bootMode === 'ram-only') {
    if (transport !== 'wifi' || option(parsed, 'slot') || option(parsed, 'erase-slot') ||
        flag(parsed, 'boot') || flag(parsed, 'reboot')) {
      fail('This target supports Wi-Fi application replacement in RAM only; firmware slots and reboot flags do not apply.', ExitCode.usage)
    }
    const base = io(parsed, options)
    const env = createChildEnv(ctx, base.env)
    if (flag(parsed, 'no-build')) env.W87_NO_BUILD = '1'
    if (option(parsed, 'image')) env.W87_APP_IMAGE = path.resolve(ctx.cwd, option(parsed, 'image'))
    return runGeaos({ ctx, selection, action: 'ota', positionals: rest, env, dryRun: base.dryRun, stdout: base.stdout })
  }
  if (selection.adapter !== 'esp32-idf') fail(`OTA is only available for ESP32 boards (board '${selection.boardName}' is ${selection.adapter}).`, ExitCode.usage)
  const base = io(parsed, options)
  const env = createChildEnv(ctx, base.env)
  const slot = option(parsed, 'slot', '')
  const eraseSlotName = option(parsed, 'erase-slot', '')
  const explicitImage = option(parsed, 'image', '')

  const app = explicitImage && !option(parsed, 'app') && !rest[0] ? null : optionalApp(ctx, parsed, rest, selection, { required: !explicitImage && !eraseSlotName })
  const buildDir = esp32BuildDir(ctx, selection, app?.id, env)

  if (eraseSlotName) {
    await otaEraseSlot({ selection, host: selection.host, slot: eraseSlotName, buildDir, dryRun: base.dryRun, stdout: base.stdout })
    return 0
  }

  let image = explicitImage ? path.resolve(ctx.cwd, explicitImage) : ''
  if (!explicitImage) {
    const prepared = flag(parsed, 'no-build')
      ? { images: buildImages(buildDir) }
      : await buildEsp32Firmware({ ctx, selection, app, env, bleOta: transport === 'ble' || bleOtaRequested(parsed, app, env), dryRun: base.dryRun, verbose: flag(parsed, 'verbose'), stdout: base.stdout, stderr: base.stderr })
    image = prepared.images.app
  }

  if (transport === 'ble') {
    bleOta({ cliPackageRoot: ctx.cliPackageRoot, image, deviceName: option(parsed, 'device', ''), env, dryRun: base.dryRun, stdout: base.stdout })
    return 0
  }
  if (slot) {
    await otaStage({ selection, host: selection.host, image, slot, buildDir, boot: flag(parsed, 'boot'), reboot: flag(parsed, 'reboot'), appLabel: app?.id || 'prebuilt image', dryRun: base.dryRun, stdout: base.stdout })
    return 0
  }
  await otaFlash({ host: selection.host, image, dryRun: base.dryRun, stdout: base.stdout })
  if (flag(parsed, 'monitor') || flag(parsed, 'logs')) {
    if (base.dryRun) return 0
    await waitForReboot({ host: selection.host, stdout: base.stdout })
    return logsCommand(ctx, { ...parsed, options: { ...parsed.options, transport: 'wifi', follow: true } }, rest, options, selection)
  }
  return 0
}

// ---- monitor / logs / screenshot ---------------------------------------------

function abortOnSigint() {
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.once('SIGINT', onSigint)
  return { signal: controller.signal, release: () => process.removeListener('SIGINT', onSigint) }
}

async function withDevice(ctx, parsed, options, selection, transport, fn) {
  const base = io(parsed, options)
  if (base.dryRun) {
    base.stdout(`[dry-run] ${transport} device: ${transport === 'wifi' ? option(parsed, 'host', '') || selection.otaHost : selection.port || `usb serial ${selection.usbSerial}`}`)
    return 0
  }
  const device = await openDevice({
    selection,
    transport,
    host: option(parsed, 'host', ''),
    port: selection.port,
    env: base.env,
    trace: flag(parsed, 'trace'),
    stderr: base.stderr,
    waitSeconds: Number(option(parsed, 'wait', base.env.GEA_ESP32_MONITOR_WAIT_SECONDS || 0))
  })
  try {
    return (await fn(device, base)) ?? 0
  } finally {
    await device.close()
  }
}

export async function monitorCommand(ctx, parsed, rest, options, preselected = null) {
  const selection = preselected || selectBoard(ctx, parsed, { usbPort: true })
  if (selection.adapter === 'geaos-linux' || selection.adapter === 'geaos-arm64') {
    const base = io(parsed, options)
    return runGeaos({ ctx, selection, action: 'monitor', positionals: rest, env: createChildEnv(ctx, base.env), dryRun: base.dryRun, stdout: base.stdout })
  }
  return withDevice(ctx, parsed, options, selection, 'usb', async (device, base) => {
    base.stderr(`Opening serial monitor on ${device.description}... (Ctrl+C to exit)`)
    const { signal, release } = abortOnSigint()
    try {
      await device.logs({ write: (line) => base.stdout(line), timestamps: flag(parsed, 'timestamps'), logFile: option(parsed, 'log-file', ''), signal })
    } finally {
      release()
    }
  })
}

export async function logsCommand(ctx, parsed, rest, options, preselected = null) {
  const selection = preselected || selectBoard(ctx, parsed, {})
  const transport = chooseTransport(option(parsed, 'transport', 'auto'), selection, { host: option(parsed, 'host', '') })
  if (transport === 'usb') return monitorCommand(ctx, parsed, rest, options, preselected || selectBoard(ctx, parsed, { usbPort: true }))
  return withDevice(ctx, parsed, options, selection, 'wifi', async (device, base) => {
    const follow = flag(parsed, 'follow')
    base.stderr(`Connecting to diagnostics stream at ${device.host}:8081${follow ? ' (Ctrl+C to exit)' : ''}`)
    const { signal, release } = abortOnSigint()
    try {
      await device.logs({ follow, write: (chunk) => process.stdout.write(chunk), timeoutMs: Number(option(parsed, 'timeout', 10)) * 1000, signal })
    } finally {
      release()
    }
  })
}

export async function screenshotCommand(ctx, parsed, rest, options) {
  const selection = selectBoard(ctx, parsed, {})
  const transport = chooseTransport(option(parsed, 'transport', 'auto'), selection, { host: option(parsed, 'host', '') })
  const file = path.resolve(ctx.cwd, rest[0] || option(parsed, 'out', '') || 'screenshot.png')
  const usbSelection = transport === 'usb' ? selectBoard(ctx, parsed, { usbPort: true }) : selection
  return withDevice(ctx, parsed, options, usbSelection, transport, async (device, base) => {
    const timeoutMs = Number(option(parsed, 'timeout', transport === 'wifi' ? 30 : 12)) * 1000
    const shot = await saveScreenshot(device, file, { timeoutMs, legacy: flag(parsed, 'legacy') })
    success(base.stdout, `Saved ${shot.width}x${shot.height} screenshot${shot.app ? ` of ${shot.app}` : ''} from ${device.description} to ${file}`)
  })
}

// ---- devctl -------------------------------------------------------------------------

const devctlUsage = `gea devctl <verb> [args] [--board <alias>] [--transport auto|usb|wifi]

Verbs (USB, GEADEV protocol):
  ping | app | state | mem | summary | i2cscan | reboot
  node <class>            hit <x> <y>            tap <x> <y> [holdMs]
  drag <x1> <y1> <x2> <y2> [steps] [delayMs]      swipe <x> <y1> <y2>
  back                    key <code>             notify <text>
  storage get <key> | storage set <key> <value>
  set-default <app-id>    set-time [epochSeconds]
  ls [path]               rm <path>
  push <local> <remote> [--base64]               pull <remote> <local>
  playfile <path>

Display knobs (either transport; no value reports the current one):
  brightness [0-100]      hbm [on|off]           vsync [on|off]`

// Brightness, high-brightness mode and vsync: the board answers all three
// over USB (GEADEV) and over WiFi (/display/*), and the device handle exposes
// the same method for either, so this is transport-agnostic. Passing no value
// reports the knob rather than setting it -- an app with no network binding
// builds firmware with WiFi off, and USB is then the only way to reach them.
const displayVerbs = new Set(['brightness', 'hbm', 'vsync'])

// A knob is a one-shot control, not a stream, so the cable is its reliable
// path: `auto` prefers USB whenever the board is actually attached and only
// falls back to the board's address when it is not. This is the opposite of
// the logs/screenshot preference, where an address saves plugging in at all.
// It matters because an app with no network binding builds firmware with WiFi
// off while the alias still records the OTA host an earlier app answered on --
// exactly when `hbm` used to be unreachable.
function usbAttached(selection) {
  if (selection.port) return true
  if (!selection.usbSerial) return false
  try {
    return Boolean(resolveUsbSerialPort({ serial: selection.usbSerial }))
  } catch {
    return false
  }
}

function displayTransport(ctx, parsed, selection) {
  const requested = option(parsed, 'transport', '')
  const host = option(parsed, 'host', '')
  if (requested) return chooseTransport(requested, selection, { host })
  if (!host && usbAttached(selection)) return 'usb'
  return chooseTransport('auto', selection, { host })
}

function parseOnOff(verb, value) {
  if (['on', '1', 'true', 'yes'].includes(value)) return true
  if (['off', '0', 'false', 'no'].includes(value)) return false
  fail(`devctl ${verb} expects on|off (or no value to report the current one).`, ExitCode.usage)
}

function displayKnob(device, verb, value) {
  if (verb === 'brightness') {
    if (value === undefined) return device.brightness()
    const percent = Number(value)
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) fail('devctl brightness expects 0-100 (or no value to report the current one).', ExitCode.usage)
    return device.brightness(percent)
  }
  return value === undefined ? device[verb]() : device[verb](parseOnOff(verb, value))
}

export async function devctlCommand(ctx, parsed, rest, options) {
  const verb = rest[0]
  const args = rest.slice(1)
  if (!verb || verb === 'help') {
    options.stdout(devctlUsage)
    return verb ? 0 : ExitCode.usage
  }
  const selection = selectBoard(ctx, parsed, {})
  // Display knobs answer on both transports, so they follow the board's own
  // preference (WiFi when it has an address) instead of forcing one; every
  // other verb is GEADEV-only and needs the cable.
  const transport = displayVerbs.has(verb)
    ? displayTransport(ctx, parsed, selection)
    : chooseTransport(option(parsed, 'transport', 'usb'), selection, { host: option(parsed, 'host', '') })
  const usbSelection = transport === 'usb' ? selectBoard(ctx, parsed, { usbPort: true }) : selection
  return withDevice(ctx, parsed, options, usbSelection, transport, async (device, base) => {
    if (displayVerbs.has(verb)) {
      const reply = await displayKnob(device, verb, args[0])
      base.stdout(JSON.stringify(reply))
      return 0
    }
    if (device.kind !== 'usb') fail(`devctl ${verb} needs the USB transport.`, ExitCode.usage)
    const d = device.serial
    const num = (value, name) => {
      const n = Number(value)
      if (!Number.isFinite(n)) fail(`devctl ${verb}: ${name} must be a number.`, ExitCode.usage)
      return n
    }
    const need = (count) => {
      if (args.length < count) fail(`devctl ${verb} needs ${count} argument(s).\n${devctlUsage}`, ExitCode.usage)
    }
    const print = (value) => base.stdout(String(value))
    switch (verb) {
      case 'ping': print(await geadev.ping(d)); break
      case 'app': print(await geadev.app(d)); break
      case 'state': print(await geadev.state(d)); break
      case 'mem': print(await geadev.mem(d)); break
      case 'summary': print(await geadev.summary(d)); break
      case 'i2cscan': print(await geadev.i2cScan(d)); break
      case 'reboot': print(await geadev.reboot(d)); break
      case 'node': need(1); print(await geadev.node(d, args[0])); break
      case 'hit': need(2); print(await geadev.hit(d, num(args[0], 'x'), num(args[1], 'y'))); break
      case 'tap': need(2); print(await geadev.tap(d, num(args[0], 'x'), num(args[1], 'y'), args[2] ? num(args[2], 'holdMs') : 80)); break
      case 'drag': need(4); print(await geadev.drag(d, num(args[0], 'x1'), num(args[1], 'y1'), num(args[2], 'x2'), num(args[3], 'y2'), args[4] ? num(args[4], 'steps') : 6, args[5] ? num(args[5], 'delayMs') : 24)); break
      case 'swipe': need(3); print(await geadev.swipe(d, num(args[0], 'x'), num(args[1], 'y1'), num(args[2], 'y2'))); break
      case 'back': print(await geadev.back(d)); break
      case 'key': need(1); print(await geadev.key(d, args[0])); break
      case 'notify': need(1); print(await geadev.notify(d, args.join(' '))); break
      case 'storage':
        need(2)
        if (args[0] === 'get') print((await geadev.storageGet(d, args[1])).value)
        else if (args[0] === 'set') { need(3); print(await geadev.storageSet(d, args[1], args.slice(2).join(' '))) }
        else fail('devctl storage expects get <key> or set <key> <value>.', ExitCode.usage)
        break
      case 'set-default': need(1); print(await geadev.setDefault(d, args[0])); break
      case 'set-time': print(await geadev.setTime(d, args[0] ? num(args[0], 'epoch') : Math.floor(Date.now() / 1000))); break
      case 'ls': print(await geadev.ls(d, args[0] || '/sdcard')); break
      case 'rm': need(1); print(await geadev.rm(d, args[0])); break
      case 'push': need(2); print(await geadev.pushFile(d, path.resolve(ctx.cwd, args[0]), args[1], { base64: flag(parsed, 'base64'), stderr: base.stderr })); break
      case 'pull': need(2); print(await geadev.pullFile(d, args[0], path.resolve(ctx.cwd, args[1]))); break
      case 'playfile': need(1); print(await geadev.playFile(d, args[0])); break
      default:
        fail(`Unknown devctl verb '${verb}'.\n${devctlUsage}`, ExitCode.usage)
    }
    return 0
  })
}

// ---- geaos device passthrough -------------------------------------------------

export async function geaosDeviceCommand(ctx, parsed, rest, options) {
  const selection = selectBoard(ctx, parsed, { usbPort: true })
  if (selection.adapter !== 'geaos-linux' && selection.adapter !== 'geaos-arm64') fail(`'${rest[0]}' is a geaos device action; board '${selection.boardName}' is ${selection.adapter}.`, ExitCode.usage)
  const base = io(parsed, options)
  return runGeaos({ ctx, selection, action: rest[0], positionals: rest.slice(1), env: createChildEnv(ctx, base.env), dryRun: base.dryRun, stdout: base.stdout })
}
