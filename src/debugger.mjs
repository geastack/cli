import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CliError, ExitCode, fail } from './errors.mjs'
import { formatCommand } from './run.mjs'
import { appForNativeDebugger } from './build-config.mjs'
import { debugFps } from './debug-fps.mjs'
import { runMacos } from './macos/adapter.mjs'
import { resolveSimulatorDir } from './web/adapter.mjs'
import { option } from './args.mjs'

export function debuggerEntry(env, module = 'launch.mjs', {
  hasFile = existsSync,
  resolvePackage = specifier => createRequire(import.meta.url).resolve(specifier)
} = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22)
    fail('The debugger requires Node.js 22 or later.', ExitCode.missingDependency)
  const root = env.GEA_DEBUGGER_DIR
    ? path.resolve(env.GEA_DEBUGGER_DIR)
    : path.resolve(fileURLToPath(new URL('../..', import.meta.url)), 'debugger')
  let entry = path.join(root, 'src', module)
  if (!hasFile(entry)) {
    if (env.GEA_DEBUGGER_DIR)
      fail(`GEA_DEBUGGER_DIR does not contain src/${module}: ${root}`, ExitCode.missingDependency)
    try {
      entry = path.join(path.dirname(resolvePackage('@geastack/debugger/package.json')), 'src', module)
    } catch {
      fail('Debugger package not found. Install @geastack/debugger or set GEA_DEBUGGER_DIR.', ExitCode.missingDependency)
    }
  }
  if (!hasFile(entry)) fail(`Debugger module not found: ${entry}`, ExitCode.missingDependency)
  return entry
}

export function sourceDebuggingRequested(parsed, env = process.env) {
  const value = option(parsed, 'debug-sources')
  if (value !== undefined) {
    if (value !== true && value !== false)
      fail('Use --debug-sources or --no-debug-sources without a value.', ExitCode.usage)
    return value
  }
  return env.GEA_DEBUGGER_JTAG === '1'
}

// Build and run share instrumentation and manifest overrides. Launching a
// debugger is a separate step, so a build never needs a browser or device.
export function nativeDebugBuildOf(app, platform, env, { sources = platform === 'macos', fps = 0 } = {}) {
  if (!['macos', 'esp32'].includes(platform)) fail('--debug builds support native macOS and ESP32 targets.', ExitCode.usage)
  if (app.runtime !== 'gea') fail(`Debugger requires the gea runtime; '${app.id}' uses '${app.runtime}'.`, ExitCode.usage)
  const entry = debuggerEntry(env, platform === 'macos' ? 'launch.mjs' : 'device.mjs')
  const debuggerRoot = path.resolve(path.dirname(entry), '..')
  const nativeEnv = { ...env, GEA_NATIVE_DEBUGGER: '1' }
  if (platform === 'macos') {
    const source = path.join(debuggerRoot, 'native/macos.mm')
    if (!existsSync(source)) fail(`Native debugger source not found: ${source}`, ExitCode.missingDependency)
    nativeEnv.GEA_DEBUGGER_NATIVE_SOURCE = source
    if (sources) {
      nativeEnv.GEA_MACOS_DEBUG_INFO = 'full'
      nativeEnv.GEA_MACOS_OPT_LEVEL = '-O0'
    }
    const stack = path.resolve(debuggerRoot, '..')
    for (const [key, relative, marker] of [
      ['GEA_APPLE_ROOT', 'apple/packages/geastack-apple', 'targets/macos/build-macos.sh'],
      ['GEA_CORE', 'core/packages/core', 'gea_sources.mjs'],
      ['GEA_COMPILER', 'compiler', 'dist/cli.js'],
      ['GEA_PLUGIN', 'core/packages/geatsc-plugin-gea', 'dist/index.js']
    ]) {
      const directory = path.join(stack, relative)
      if (!nativeEnv[key] && existsSync(path.join(directory, marker))) nativeEnv[key] = directory
    }
    if (!nativeEnv.GEA_GEATSC_BIN && nativeEnv.GEA_COMPILER) nativeEnv.GEA_GEATSC_BIN = path.join(nativeEnv.GEA_COMPILER, 'dist/cli.js')
  } else if (platform === 'esp32') {
    nativeEnv.GEA_DEBUGGER_FPS = String(fps)
    nativeEnv.GEA_GEATSC_DEBUG_INFO = '1'
  }
  return { app: appForNativeDebugger(app, platform), env: nativeEnv, debuggerRoot }
}

function boardDebugContext(ctx, env, debuggerRoot) {
  const debugCtx = { ...ctx, env }
  const stack = path.resolve(debuggerRoot, '..')
  for (const [field, key, relative] of [
    ['targetsRoot', 'GEA_TARGETS_ROOT', 'targets'],
    ['compilerPackageDir', 'GEA_COMPILER_DIR', 'compiler'],
    ...['core', 'engine', 'host', 'chips', 'elements', 'geaos'].map(name => [name + 'PackageDir', 'GEA_' + name.toUpperCase() + (name === 'geaos' ? '_PACKAGE_DIR' : '_DIR'), 'core/packages/' + name]),
    ['pluginPackageDir', 'GEA_PLUGIN_DIR', 'core/packages/geatsc-plugin-gea']
  ]) { const directory = path.join(stack, relative); if (!env[key] && existsSync(path.join(directory, 'package.json'))) debugCtx[field] = directory }
  return debugCtx
}

export async function buildBoardDebug({ ctx, parsed, rest, options, app }) {
  const { selectBoard, buildCommand } = await import('./commands/board.mjs')
  const built = nativeDebugBuildOf(app, 'esp32', options.env, { fps: debugFps(option(parsed, 'debug-fps')) })
  const debugCtx = boardDebugContext(ctx, built.env, built.debuggerRoot)
  const selection = selectBoard(debugCtx, parsed)
  if (selection.adapter !== 'esp32-idf') fail('--debug board support currently requires an ESP32 target.', ExitCode.usage)
  if (sourceDebuggingRequested(parsed, built.env) && (selection.idfTarget || 'esp32s3') !== 'esp32s3')
    fail('--debug-sources requires an ESP32-S3 board with USB JTAG.', ExitCode.usage)
  return buildCommand(debugCtx, parsed, rest, { ...options, env: built.env, debugApp: built.app })
}

// Gea Changes overrides: --overrides applies a saved file once the debugger
// attaches, --save-overrides writes the session's net edits on exit.
function overrideFiles({ overrides, saveOverrides }) {
  const file = (value, name) => {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value) fail(`${name} requires a file path.`, ExitCode.usage)
    return path.resolve(value)
  }
  return { overrides: file(overrides, '--overrides'), saveOverrides: file(saveOverrides, '--save-overrides') }
}

export async function runDebug({ app, env, dryRun = false, stdout, port = 5181, debugPort = 9222, target = 'web', open = true, sources = true, overrides, saveOverrides }) {
  if (app.runtime !== 'gea') fail(`Debugger requires the gea runtime; '${app.id}' uses '${app.runtime}'.`, ExitCode.usage)
  const entry = debuggerEntry(env)
  const overrideOptions = overrideFiles({ overrides, saveOverrides })
  if (target !== 'macos' && (overrideOptions.overrides || overrideOptions.saveOverrides)) fail('--overrides and --save-overrides require --debug with native macOS or an ESP32 board.', ExitCode.usage)
  try {
    const { launchDebugger, chromeArgs, chromeExecutable, portNumber } = await import(pathToFileURL(entry).href)
    port = portNumber(port, '--port')
    debugPort = portNumber(debugPort, '--debug-port')
    if (target === 'macos') {
      if (process.platform !== 'darwin') fail('Native macOS debugging requires a Mac.', ExitCode.usage)
      const built = nativeDebugBuildOf(app, 'macos', env, { sources })
      const { debuggerRoot } = built
      await runMacos({ app: built.app, env: built.env, dryRun, stdout })
      const outputRoot = path.resolve(app.root, env.GEA_MACOS_OUTPUT_DIR || 'dist/macos')
      const subpath = env.GEA_MACOS_OUTPUT_TAG ? path.join('.namespaces', env.GEA_MACOS_OUTPUT_TAG, app.id) : app.id
      const executable = path.join(outputRoot, subpath, `${app.name}.app`, 'Contents/MacOS', app.name)
      if (dryRun) { stdout(formatCommand([executable])); stdout(`Native CDP: ws://127.0.0.1:${debugPort}/devtools/page/gea`); if (sources) stdout('Native Sources: LLDB with full symbols and no optimization.'); return 0 }
      if (!existsSync(executable)) fail(`Built native executable not found: ${executable}`, ExitCode.buildFailed)
      const { launchNativeDebugger } = await import(pathToFileURL(path.join(debuggerRoot, 'src/native.mjs')).href)
      const metadata = path.join(outputRoot, '.generated', subpath, 'gea-debug-source.json')
      return await launchNativeDebugger({ executable, appRoot: app.root, title: app.name, env, debugPort, stdout, open, nativeDebug: sources ? { metadata } : undefined, ...overrideOptions })
    }
    const script = path.join(resolveSimulatorDir(env), 'targets/web/dev-web.mjs')
    if (!existsSync(script)) fail(`Web dev server not found: ${script}`, ExitCode.missingDependency)
    if (port === debugPort) fail('--port and --debug-port must differ.', ExitCode.usage)
    if (dryRun) {
      stdout(formatCommand([process.execPath, script, '--app-dir', app.root, '--port', String(port), '--host', '127.0.0.1']))
      stdout(formatCommand([chromeExecutable(env), ...chromeArgs({ appRoot: app.root, url: `http://127.0.0.1:${port}/`, debugPort })]))
      return 0
    }
    return await launchDebugger({ appRoot: app.root, script, env, port, debugPort, stdout })
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(error.message, ExitCode.generic)
  }
}

// Build/flash through the canonical board adapter, then give one relay exclusive
// ownership of its USB request stream. --attach reuses debug-enabled firmware.
export async function runBoardDebug({ ctx, parsed, rest, options, app }) {
  if (app.runtime !== 'gea') fail(`Debugger requires the gea runtime; '${app.id}' uses '${app.runtime}'.`, ExitCode.usage)
  const { selectBoard, flashCommand } = await import('./commands/board.mjs')
  const { flag, option } = await import('./args.mjs')
  const { openDevice } = await import('./device/device.mjs')
  const { encodePng } = await import('./device/image.mjs')
  const entry = debuggerEntry(options.env, 'device.mjs')
  const fps = debugFps(option(parsed, 'debug-fps'))
  const overrideOptions = overrideFiles({ overrides: option(parsed, 'overrides'), saveOverrides: option(parsed, 'save-overrides') })
  const built = nativeDebugBuildOf(app, 'esp32', options.env, { fps })
  const { env, debuggerRoot: root } = built
  const debugCtx = boardDebugContext(ctx, env, root)
  const selection = selectBoard(debugCtx, parsed, { usb: true })
  if (selection.adapter !== 'esp32-idf') fail('--debug board support currently requires an ESP32 target.', ExitCode.usage)
  const sources = sourceDebuggingRequested(parsed, env)
  if (sources && (selection.idfTarget || 'esp32s3') !== 'esp32s3')
    fail('--debug-sources requires an ESP32-S3 board with USB JTAG.', ExitCode.usage)
  const { portNumber, chromeExecutable } = await import(pathToFileURL(path.join(root, 'src/launch.mjs')).href)
  const debugPort = portNumber(option(parsed, 'debug-port', 9222), '--debug-port')
  if (option(parsed, 'open', true) !== false) chromeExecutable(env)
  const { launchDeviceDebugger } = await import(pathToFileURL(entry).href)
  if (!flag(parsed, 'attach')) await flashCommand(debugCtx, parsed, rest, { ...options, env, debugApp: built.app }, { monitor: false })
  if (flag(parsed, 'dry-run')) { options.stdout(`Device CDP: ws://127.0.0.1:${debugPort}/devtools/page/gea`); if(fps)options.stdout(`Device debug FPS cap: ${fps}`); if(sources)options.stdout('Native Sources: USB JTAG requested.'); return 0 }
  let nativeDebug, listenerSources
  if (sources) {
    const { nativeDebugBuilds } = await import('./debugger-builds.mjs')
    const builds = nativeDebugBuilds(debugCtx, selection, app, env)
    if (builds.length) {
      const { activateEspIdf } = await import('./esp32/idf-env.mjs')
      const idf = activateEspIdf({env})
      nativeDebug = {builds,serial:selection.usbSerial,env:idf.env,
        gdbExecutable:env.GEA_GDB_BIN || 'xtensa-esp32s3-elf-gdb',openocdExecutable:env.GEA_OPENOCD_BIN || 'openocd'}
    } else fail('--debug-sources requires matching local ELF/source metadata. Rebuild without --attach to generate source debugging files.', ExitCode.missingDependency)
  } else {
    options.stdout('Native Sources: read-only; --debug-sources explicitly enables USB JTAG for breakpoints and stepping.')
    // Event Listeners link to TSX through the firmware's ELF; no JTAG needed.
    try {
      const { nativeDebugBuilds } = await import('./debugger-builds.mjs')
      const builds = nativeDebugBuilds(debugCtx, selection, app, env)
      if (builds.length) {
        const { activateEspIdf } = await import('./esp32/idf-env.mjs')
        const idf = activateEspIdf({ env })
        const chip = selection.idfTarget || 'esp32s3'
        if (idf) listenerSources = { builds, env: idf.env, gdbExecutable: env.GEA_GDB_BIN || (['esp32', 'esp32s2', 'esp32s3'].includes(chip) ? `xtensa-${chip}-elf-gdb` : 'riscv32-esp-elf-gdb') }
      }
    } catch {}
  }
  const device = await openDevice({ selection, transport: 'usb', env, stderr: options.stderr, waitSeconds: 15 })
  try { return await launchDeviceDebugger({ serial: device.serial, screenshot: async () => { const shot = await device.screenshot(); return encodePng(shot.width, shot.height, shot.rgb).toString('base64') }, appRoot: app.root, title: app.name, env, debugPort, debugFps: fps, nativeDebug, listenerSources, stdout: options.stdout, open: option(parsed, 'open', true) !== false, ...overrideOptions }) }
  finally { await device.close() }
}
