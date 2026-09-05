import path from 'node:path'
import fs from 'node:fs'

import { flag, option, parseArgs } from './args.mjs'
import { runCreateGeastack } from './create-geastack.mjs'
import { runChips } from './chips.mjs'
import { createChildEnv, createContext } from './context.mjs'
import { ExitCode, fail } from './errors.mjs'
import { exists, readJson } from './fs-utils.mjs'
import {
  assertTargetEnabled,
  boardConfigPath,
  assertValidApp,
  discoverApps,
  loadBoardConfig,
  loadTargetMetadata,
  resolveRequestedApp,
  validateApp
} from './manifest.mjs'
import { runExternal } from './run.mjs'
import { runSetupWizard } from './setup-wizard.mjs'
import { commandVersion, nodeAtLeast } from './toolchain.mjs'

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

export async function runGea(argv, io = {}) {
  const parsed = parseArgs(argv)
  const stdout = io.stdout || console.log
  const stderr = io.stderr || console.error
  const env = io.env || process.env
  const cwd = io.cwd || process.cwd()
  const stdin = io.stdin || process.stdin
  const output = io.output || process.stdout
  const prompt = io.prompt
  const command = parsed.positionals[0]

  if (flag(parsed, 'version')) {
    stdout(version)
    return 0
  }
  if (command === 'create') {
    const createArgs = argv.slice(1)
    if (option(parsed, 'install') === undefined) createArgs.push('--install')
    return runCreateGeastack(createArgs, { ...io, commandName: 'gea create' })
  }
  if (!command || command === 'help' || flag(parsed, 'help')) {
    stdout(usage())
    return 0
  }

  const ctx = createContext(parsed, env, cwd)
  const rest = parsed.positionals.slice(1)

  switch (command) {
    case 'doctor':
      return doctor(ctx, parsed, { stdout, env })
    case 'dev':
      return dev(ctx, parsed, rest, { stdout, env })
    case 'build':
      return build(ctx, parsed, rest, { stdout, env })
    case 'setup':
      return setup(ctx, parsed, { stdout, env, stdin, output, prompt })
    case 'chips':
      return runChips(ctx, parsed, rest, { stdout, env, stdin, output, prompt })
    case 'flash':
      return flash(ctx, parsed, rest, { stdout, env })
    case 'monitor':
      return monitor(ctx, parsed, rest, { stdout, env })
    case 'ota':
      return ota(ctx, parsed, rest, { stdout, env })
    case 'list':
      return list(ctx, parsed, rest, { stdout })
    case 'inspect':
      return inspect(ctx, parsed, rest, { stdout })
    default:
      stderr(`Unknown command: ${command}`)
      stdout(usage())
      return 1
  }
}

function dev(ctx, parsed, rest, io) {
  const app = resolveRequestedApp(ctx, parsed, rest)
  assertValidApp(app)
  const target = option(parsed, 'target', 'web')
  assertTargetEnabled(ctx, app, target)

  if (target !== 'web') {
    io.stdout(`No live dev loop is registered for target '${target}' yet. Use 'gea flash --app ${app.id} --board <alias> --monitor'.`)
    return 0
  }

  requirePath(ctx.scripts.webDev, 'web dev script')
  const args = [ctx.scripts.webDev, app.id]
  const port = option(parsed, 'port')
  if (port) args.push('--port', String(port))
  return runExternal('node', args, {
    cwd: ctx.simulatorRoot,
    env: createChildEnv(ctx, io.env),
    dryRun: flag(parsed, 'dry-run'),
    failureCode: ExitCode.buildFailed,
    stdout: io.stdout
  })
}

function build(ctx, parsed, rest, io) {
  const app = resolveRequestedApp(ctx, parsed, rest)
  assertValidApp(app)
  const board = option(parsed, 'board', '')
  const target = option(parsed, 'target', board ? '' : 'web')
  assertTargetEnabled(ctx, app, board || target)

  if (target === 'web' && !board) {
    requirePath(ctx.scripts.webBuild, 'web build script')
    return runExternal(ctx.scripts.webBuild, [app.id], {
      cwd: ctx.simulatorRoot,
      env: createChildEnv(ctx, io.env),
      dryRun: flag(parsed, 'dry-run'),
      failureCode: ExitCode.buildFailed,
      stdout: io.stdout
    })
  }

  if (target === 'macos') {
    requirePath(ctx.scripts.macosBuild, 'macOS build script')
    const outputTag = option(parsed, 'output-tag')
    if (outputTag !== undefined && (typeof outputTag !== 'string' || outputTag.length === 0)) {
      fail('--output-tag requires a non-empty value.', ExitCode.usage)
    }
    const args = [app.id]
    if (outputTag !== undefined) args.push('--output-tag', outputTag)
    return runExternal(ctx.scripts.macosBuild, args, {
      cwd: ctx.appleRoot,
      env: createChildEnv(ctx, io.env),
      dryRun: flag(parsed, 'dry-run'),
      failureCode: ExitCode.buildFailed,
      stdout: io.stdout
    })
  }

  if (target === 'ios') {
    requirePath(ctx.scripts.iosBuild, 'iOS build script')
    const mode = option(parsed, 'mode', 'simulator')
    return runExternal(ctx.scripts.iosBuild, [app.id, mode], {
      cwd: ctx.appleRoot,
      env: createChildEnv(ctx, io.env),
      dryRun: flag(parsed, 'dry-run'),
      failureCode: ExitCode.buildFailed,
      stdout: io.stdout
    })
  }

  if (target === 'android') {
    return runAndroid(ctx, parsed, {
      appId: app.id,
      mode: option(parsed, 'mode', 'debug'),
      failureCode: ExitCode.buildFailed,
      stdout: io.stdout,
      env: io.env
    })
  }

  return runBoard(ctx, 'build', parsed, {
    app,
    appId: app.id,
    board,
    target,
    failureCode: ExitCode.buildFailed,
    stdout: io.stdout,
    env: io.env
  })
}

function setup(ctx, parsed, io) {
  const board = option(parsed, 'board', '')
  const target = option(parsed, 'target', '')
  if (!board && !target) {
    return runSetupWizard(ctx, parsed, io)
  }
  return runBoard(ctx, 'setup', parsed, {
    board,
    target,
    failureCode: ExitCode.buildFailed,
    stdout: io.stdout,
    env: io.env
  })
}

function flash(ctx, parsed, rest, io) {
  const board = option(parsed, 'board', '')
  const target = option(parsed, 'target', '')
  if (!board && !target) fail('flash requires --board <alias> or --target <target>.', ExitCode.usage)
  if (flag(parsed, 'bringup')) {
    return runBoard(ctx, flag(parsed, 'monitor') ? 'flash-monitor' : 'flash', parsed, {
      board,
      target,
      failureCode: ExitCode.deployFailed,
      stdout: io.stdout,
      env: io.env
    })
  }

  const app = resolveRequestedApp(ctx, parsed, rest)
  assertValidApp(app)
  assertTargetEnabled(ctx, app, board || target)

  if (!board && target === 'android') {
    return runAndroid(ctx, parsed, {
      appId: app.id,
      mode: 'device',
      failureCode: ExitCode.deployFailed,
      stdout: io.stdout,
      env: io.env
    })
  }

  return runBoard(ctx, flag(parsed, 'monitor') ? 'flash-monitor' : 'flash', parsed, {
    app,
    appId: app.id,
    board,
    target,
    failureCode: ExitCode.deployFailed,
    stdout: io.stdout,
    env: io.env
  })
}

function ota(ctx, parsed, rest, io) {
  const board = option(parsed, 'board', '')
  const target = option(parsed, 'target', '')
  if (!board && !target) fail('ota requires --board <alias> or --target <target>.', ExitCode.usage)

  const app = resolveRequestedApp(ctx, parsed, rest)
  assertValidApp(app)
  assertTargetEnabled(ctx, app, board || target)

  const transport = option(parsed, 'transport', 'wifi')
  if (transport !== 'wifi' && transport !== 'ble') {
    fail("--transport must be 'wifi' or 'ble'.", ExitCode.usage)
  }
  return runBoard(ctx, transport === 'ble' ? 'ble-ota' : 'ota', parsed, {
    app,
    appId: app.id,
    board,
    target,
    failureCode: ExitCode.deployFailed,
    stdout: io.stdout,
    env: io.env
  })
}

function monitor(ctx, parsed, rest, io) {
  const board = option(parsed, 'board', '')
  const target = option(parsed, 'target', '')
  if (!board && !target) fail('monitor requires --board <alias> or --target <target>.', ExitCode.usage)
  if (!board && target === 'android') {
    return runAndroid(ctx, parsed, {
      appId: 'css-3d-cube',
      mode: 'monitor',
      failureCode: ExitCode.deployFailed,
      stdout: io.stdout,
      env: io.env
    })
  }
  return runBoard(ctx, 'monitor', parsed, {
    board,
    target,
    failureCode: ExitCode.deployFailed,
    stdout: io.stdout,
    env: io.env
  })
}

function runBoard(ctx, action, parsed, opts) {
  requirePath(ctx.scripts.board, 'board script')
  const args = [action]
  if (opts.board) args.push(`--board=${opts.board}`)
  if (opts.target) args.push(`--target=${opts.target}`)
  if (opts.appId) args.push(`--app=${opts.appId}`)
  const port = option(parsed, 'port')
  if (port) args.push(String(port))
  if (flag(parsed, 'manual-boot')) args.push('--manual-boot')
  if (option(parsed, 'reset') === false) args.push('--no-reset')
  const flashBaud = option(parsed, 'flash-baud')
  if (flashBaud !== undefined) args.push(`--flash-baud=${flashBaud}`)
  args.push(...parsed.passthrough)
  const childEnv = createChildEnv(ctx, opts.env)
  if (opts.app?.manifest?.ota?.ble === true) childEnv.GEA_EMBEDDED_BLE_OTA = '1'
  return runExternal(ctx.scripts.board, args, {
    cwd: ctx.targetsRoot,
    env: childEnv,
    dryRun: flag(parsed, 'dry-run'),
    failureCode: opts.failureCode,
    stdout: opts.stdout
  })
}

function runAndroid(ctx, parsed, opts) {
  requirePath(ctx.scripts.androidBuild, 'Android build script')
  return runExternal(ctx.scripts.androidBuild, [opts.appId, opts.mode, ...parsed.passthrough], {
    cwd: ctx.androidRoot,
    env: createChildEnv(ctx, opts.env),
    dryRun: flag(parsed, 'dry-run'),
    failureCode: opts.failureCode,
    stdout: opts.stdout
  })
}

function list(ctx, parsed, rest, io) {
  const subject = rest[0] || 'apps'
  if (subject === 'apps') {
    const target = option(parsed, 'target')
    const apps = discoverApps(ctx)
      .filter((app) => !target || app.targets?.[target] === true)
      .map((app) => ({ id: app.id, name: app.name, targets: app.targets, root: app.root }))
    if (flag(parsed, 'json')) io.stdout(JSON.stringify(apps, null, 2))
    else for (const app of apps) io.stdout(app.id)
    return 0
  }
  if (subject === 'targets') {
    const targets = loadTargetMetadata(ctx)
    if (flag(parsed, 'json')) io.stdout(JSON.stringify(targets, null, 2))
    else for (const id of Object.keys(targets).sort()) io.stdout(id)
    return 0
  }
  if (subject === 'boards') {
    const boards = loadBoardConfig(ctx)
    if (flag(parsed, 'json')) io.stdout(JSON.stringify(boards, null, 2))
    else for (const id of Object.keys(boards).sort()) io.stdout(id)
    return 0
  }
  fail(`Unknown list subject '${subject}'. Expected apps, targets, or boards.`, ExitCode.usage)
}

function inspect(ctx, parsed, rest, io) {
  const app = resolveRequestedApp(ctx, parsed, rest)
  assertValidApp(app)
  const payload = {
    id: app.id,
    name: app.name,
    root: app.root,
    entry: app.entry,
    runtime: app.runtime,
    targets: app.targets,
    icons: app.icons,
    launcher: app.launcher
  }
  if (flag(parsed, 'json')) io.stdout(JSON.stringify(payload, null, 2))
  else io.stdout(`${app.id}\t${app.name}\t${app.root}\t${app.entry}`)
  return 0
}

function doctor(ctx, parsed, io) {
  const checks = []
  addCheck(checks, '@geastack/targets', packageExists(ctx.targetsRoot), ctx.targetsRoot, true)
  addCheck(checks, '@geastack/core', packageExists(ctx.corePackageDir), ctx.corePackageDir, true)
  addCheck(checks, '@geastack/compiler', packageExists(ctx.compilerPackageDir), ctx.compilerPackageDir, true)
  addCheck(checks, 'project root', exists(ctx.projectRoot), ctx.projectRoot, true)
  addCheck(checks, 'web dev adapter', exists(ctx.scripts.webDev), ctx.scripts.webDev, false)
  addCheck(checks, 'web build adapter', exists(ctx.scripts.webBuild), ctx.scripts.webBuild, false)
  addCheck(checks, 'Android build adapter', exists(ctx.scripts.androidBuild), ctx.scripts.androidBuild, false)
  addCheck(checks, 'board script', exists(ctx.scripts.board), ctx.scripts.board, true)
  addCheck(checks, 'Node >= 20.19', nodeAtLeast(20, 19), process.version, true)
  const npmVersion = commandVersion('npm', ['--version'], io.env)
  const pythonCommand = commandVersion('python3', ['--version'], io.env) ? 'python3' : 'python'
  const pythonVersion = commandVersion(pythonCommand, ['--version'], io.env)
  const idfVersion = commandVersion('idf.py', ['--version'], io.env)
  const emccVersion = commandVersion('emcc', ['--version'], io.env)
  const xcodeVersion = commandVersion('xcodebuild', ['-version'], io.env)
  const adbVersion = commandVersion('adb', ['version'], io.env)
  const javacVersion = commandVersion('javac', ['--version'], io.env)
  const androidSdk = io.env.ANDROID_HOME || io.env.ANDROID_SDK_ROOT || path.join(process.env.HOME || '', 'Library', 'Android', 'sdk')
  addCheck(checks, 'npm', Boolean(npmVersion), npmVersion, false)
  addCheck(checks, 'Python', Boolean(pythonVersion), pythonVersion, false)
  addCheck(checks, 'ESP-IDF', Boolean(idfVersion) || Boolean(io.env.IDF_PATH), io.env.IDF_PATH || idfVersion, false)
  addCheck(checks, 'Emscripten', Boolean(emccVersion), emccVersion.split('\n')[0], false)
  addCheck(checks, 'Xcode', Boolean(xcodeVersion), xcodeVersion.split('\n')[0], false)
  addCheck(checks, 'Android SDK', exists(androidSdk), androidSdk, false)
  addCheck(checks, 'adb', Boolean(adbVersion), adbVersion.split('\n')[0], false)
  addCheck(checks, 'javac', Boolean(javacVersion), javacVersion.split('\n')[0], false)

  const boardFile = boardConfigPath(ctx)
  try {
    if (exists(boardFile)) readJson(boardFile)
    addCheck(checks, 'boards.json', exists(boardFile), exists(boardFile) ? boardFile : 'not configured', false)
  } catch (error) {
    addCheck(checks, 'boards.json', false, error.message, true)
  }

  const apps = discoverApps(ctx)
  addCheck(checks, 'app catalog', apps.length > 0, `${apps.length} app(s)`, true)

  const currentApp = (() => {
    try {
      return resolveRequestedApp(ctx, parsed, [])
    } catch {
      return null
    }
  })()
  if (currentApp) {
    const errors = validateApp(currentApp)
    addCheck(checks, `app manifest (${currentApp.id})`, errors.length === 0, errors.length === 0 ? currentApp.root : errors.join('; '), true)
  }

  const failedRequired = checks.filter((check) => check.required && !check.ok)
  const failedOptional = checks.filter((check) => !check.required && !check.ok)

  if (flag(parsed, 'json')) {
    io.stdout(JSON.stringify({ ok: failedRequired.length === 0, checks }, null, 2))
  } else {
    for (const check of checks) {
      const marker = check.ok ? '[ok]' : check.required ? '[fail]' : '[warn]'
      io.stdout(`${marker} ${check.name}: ${check.detail}`)
    }
    if (failedRequired.length > 0 || failedOptional.length > 0) {
      io.stdout('Setup guide: cli/docs/SETUP.md')
    }
  }

  if (failedRequired.length > 0) return ExitCode.missingDependency
  if (failedOptional.length > 0 && flag(parsed, 'strict')) return ExitCode.missingDependency
  return 0
}

function addCheck(checks, name, ok, detail, required) {
  checks.push({ name, ok: Boolean(ok), detail: detail || (ok ? 'ok' : 'missing'), required: Boolean(required) })
}

function packageExists(packageDir) {
  return Boolean(packageDir) && exists(path.join(packageDir, 'package.json'))
}

function requirePath(filePath, label) {
  if (!exists(filePath)) fail(`Missing ${label}: ${filePath}`, ExitCode.missingDependency)
}

function usage() {
  return `Usage:
  gea create <name> [--starter counter|empty|example] [--targets <list>]
  gea doctor [--strict] [--json]
  gea setup --board <alias>
  gea chips list [--json]
  gea chips info <chip> [--json]
  gea chips add <chip...> [--board <alias>] [--set chip.path=value]
  gea chips remove <chip...> [--board <alias>]
  gea dev [app] [--target web] [--port 5181]
  gea build [app] [--target web|macos|ios|android|<target>] [--board <alias>] [--output-tag <tag>]
  gea flash [app] --board <alias> [--monitor] [--port auto] [--manual-boot] [--no-reset] [--flash-baud <rate>]
  gea flash [app] --target android
  gea flash --bringup --board <alias> [--monitor] [--port auto]
  gea monitor --board <alias>
  gea monitor --target android
  gea ota [app] --board <alias> [--transport wifi|ble]
  gea list [apps|targets|boards] [--json]
  gea inspect [app] [--json]

Global options:
  --boards-config <file>
  --dry-run
`
}
