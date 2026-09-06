import path from 'node:path'

import { flag, option, optionList } from '../args.mjs'
import { resolveBoardSelection } from '../boards/resolve.mjs'
import { createChildEnv } from '../context.mjs'
import { chooseTransport, openDevice, saveScreenshot } from '../device/device.mjs'
import { geadev } from '../device/serial.mjs'
import { ExitCode, fail } from '../errors.mjs'
import { buildEsp32Firmware, buildImages, esp32BuildDir, fullCleanEsp32, requireEspIdf } from '../esp32/build.mjs'
import { eraseSlot, flashFirmware, flashImageSet, flashOptions, postFlashRestartNote, restoreBootMetadata, stageImage } from '../esp32/flash.mjs'
import { bleOta, otaEraseSlot, otaFlash, otaStage, waitForReboot } from '../esp32/ota.mjs'
import { manifestRequestsBleOta } from '../esp32/capabilities.mjs'
import { runGeaos } from '../geaos/adapter.mjs'
import { assertTargetEnabled, assertValidApp, resolveRequestedApp } from '../manifest.mjs'
import { buildRp2350, flashRp2350, rp2350BuildDir } from '../rp2350/adapter.mjs'
import { runTargetHook } from '../taurus/adapter.mjs'

// Every board-facing command: resolve the alias, pick the adapter, run.

export function selectBoard(ctx, parsed, needs = {}) {
  const boardName = option(parsed, 'board', '')
  const targetName = option(parsed, 'target', '')
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

function optionalApp(ctx, parsed, rest, selection, { required = false } = {}) {
  const requested = option(parsed, 'app') || rest[0]
  let app = null
  if (requested || required) {
    app = resolveRequestedApp(ctx, parsed, rest)
  } else {
    try {
      app = resolveRequestedApp(ctx, parsed, [])
    } catch {
      app = null
    }
  }
  if (!app) return null
  assertValidApp(app)
  assertTargetEnabled(ctx, app, selection.boardName || selection.target)
  return app
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

export async function buildCommand(ctx, parsed, rest, options) {
  const selection = selectBoard(ctx, parsed)
  const app = optionalApp(ctx, parsed, rest, selection)
  const base = io(parsed, options)
  const env = createChildEnv(ctx, base.env)
  switch (selection.adapter) {
    case 'esp32-idf': {
      buildEsp32Firmware({ ctx, selection, app, env, bleOta: bleOtaRequested(parsed, app, env), dryRun: base.dryRun, stdout: base.stdout, stderr: base.stderr, configureOnly: flag(parsed, 'configure-only') })
      return 0
    }
    case 'rp2350-pico':
      buildRp2350({ ctx, selection, app, env, dryRun: base.dryRun, stdout: base.stdout, stderr: base.stderr, configureOnly: flag(parsed, 'configure-only') })
      return 0
    case 'geaos-linux':
    case 'geaos-arm64':
      return runGeaos({ ctx, selection, action: 'build', app, positionals: rest, env, dryRun: base.dryRun, stdout: base.stdout })
    case 'taurus-s3':
      return runTargetHook({ ctx, selection, action: 'build', app, env, dryRun: base.dryRun, stdout: base.stdout })
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
  const opts = flashOptions(flashEnv, { manualBoot: flag(parsed, 'manual-boot'), noReset: option(parsed, 'reset') === false, baud: option(parsed, 'flash-baud', '') })
  const common = { idf, selection, options: opts, port: selection.port, env: flashEnv, dryRun: base.dryRun, stdout: base.stdout, stderr: base.stderr }
  const slotImages = optionList(parsed, 'slot-image')
  const eraseSlotName = option(parsed, 'erase-slot', '')
  const slot = option(parsed, 'slot', '')
  const explicitImage = option(parsed, 'image', '')
  const app = explicitImage && !option(parsed, 'app') && !rest[0] ? null : optionalApp(ctx, parsed, rest, selection, { required: !explicitImage && !slotImages.length && !eraseSlotName && !flag(parsed, 'restore-boot') })

  const buildDir = esp32BuildDir(ctx, selection, app?.id, flashEnv)
  const images = { ...buildImages(buildDir), buildDir }

  if (eraseSlotName) {
    await eraseSlot({ ...common, slot: eraseSlotName })
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
    buildEsp32Firmware({ ctx, selection, app, env, bleOta: bleOtaRequested(parsed, app, env), dryRun: base.dryRun, stdout: base.stdout, stderr: base.stderr })
  }
  const appLabel = app?.id || 'prebuilt image'
  if (slot) {
    await stageImage({ ...common, image, slot, appLabel })
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
    case 'taurus-s3': {
      const app = optionalApp(ctx, parsed, rest, selection)
      return runTargetHook({ ctx, selection, action: 'flash', app, env, dryRun: base.dryRun, stdout: base.stdout })
    }
    default:
      fail(`Unknown adapter '${selection.adapter}' for target '${selection.target}'.`, ExitCode.usage)
  }
}

// ---- ota ------------------------------------------------------------------------

export async function otaCommand(ctx, parsed, rest, options) {
  const transport = option(parsed, 'transport', 'wifi')
  if (transport !== 'wifi' && transport !== 'ble') fail("--transport must be 'wifi' or 'ble'.", ExitCode.usage)
  const selection = selectBoard(ctx, parsed, transport === 'wifi' ? { otaHost: true } : {})
  if (selection.adapter !== 'esp32-idf') fail(`OTA is only available for ESP32 boards (board '${selection.boardName}' is ${selection.adapter}).`, ExitCode.usage)
  const base = io(parsed, options)
  const env = createChildEnv(ctx, base.env)
  const slot = option(parsed, 'slot', '')
  const eraseSlotName = option(parsed, 'erase-slot', '')
  const explicitImage = option(parsed, 'image', '')

  if (eraseSlotName) {
    await otaEraseSlot({ selection, host: selection.host, slot: eraseSlotName, dryRun: base.dryRun, stdout: base.stdout })
    return 0
  }

  const app = explicitImage && !option(parsed, 'app') && !rest[0] ? null : optionalApp(ctx, parsed, rest, selection, { required: !explicitImage })
  let image = explicitImage ? path.resolve(ctx.cwd, explicitImage) : ''
  if (!explicitImage) {
    const prepared = flag(parsed, 'no-build')
      ? { images: buildImages(esp32BuildDir(ctx, selection, app.id, env)) }
      : buildEsp32Firmware({ ctx, selection, app, env, bleOta: transport === 'ble' || bleOtaRequested(parsed, app, env), dryRun: base.dryRun, stdout: base.stdout, stderr: base.stderr })
    image = prepared.images.app
  }

  if (transport === 'ble') {
    bleOta({ cliPackageRoot: ctx.cliPackageRoot, image, deviceName: option(parsed, 'device', ''), env, dryRun: base.dryRun, stdout: base.stdout })
    return 0
  }
  if (slot) {
    await otaStage({ selection, host: selection.host, image, slot, boot: flag(parsed, 'boot'), reboot: flag(parsed, 'reboot'), appLabel: app?.id || 'prebuilt image', dryRun: base.dryRun, stdout: base.stdout })
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
    base.stdout(`Saved ${shot.width}x${shot.height} screenshot${shot.app ? ` of ${shot.app}` : ''} from ${device.description} to ${file}`)
  })
}

// ---- devctl -------------------------------------------------------------------------

const devctlUsage = `gea devctl <verb> [args] --board <alias> [--transport auto|usb|wifi]

Verbs (USB, GEADEV protocol):
  ping | app | state | mem | summary | i2cscan | reboot
  node <class>            hit <x> <y>            tap <x> <y> [holdMs]
  drag <x1> <y1> <x2> <y2> [steps] [delayMs]      swipe <x> <y1> <y2>
  back                    key <code>             notify <text>
  storage get <key> | storage set <key> <value>
  set-default <app-id>    set-time [epochSeconds]
  brightness [0-100]      ls [path]              rm <path>
  push <local> <remote> [--base64]               pull <remote> <local>
  playfile <path>
Verbs (WiFi):
  hbm on|off              -- high-brightness mode (POST /display/hbm)`

export async function devctlCommand(ctx, parsed, rest, options) {
  const verb = rest[0]
  const args = rest.slice(1)
  if (!verb || verb === 'help') {
    options.stdout(devctlUsage)
    return verb ? 0 : ExitCode.usage
  }
  const selection = selectBoard(ctx, parsed, {})
  const wifiVerbs = new Set(['hbm'])
  const requested = option(parsed, 'transport', wifiVerbs.has(verb) ? 'wifi' : 'usb')
  const transport = chooseTransport(requested, selection, { host: option(parsed, 'host', '') })
  const usbSelection = transport === 'usb' ? selectBoard(ctx, parsed, { usbPort: true }) : selection
  return withDevice(ctx, parsed, options, usbSelection, transport, async (device, base) => {
    if (verb === 'hbm') {
      const state = args[0]
      if (!['on', 'off', '1', '0'].includes(state)) fail('devctl hbm expects on|off.', ExitCode.usage)
      const reply = await device.hbm(state === 'on' || state === '1')
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
      case 'brightness': print(await geadev.brightness(d, args[0] === undefined ? undefined : num(args[0], 'value'))); break
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
