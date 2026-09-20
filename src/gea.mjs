import fs from 'node:fs'

import { flag, option, parseArgs } from './args.mjs'
import { runChips } from './chips.mjs'
import { appsCommand, heapReportCommand, targetsCommand } from './commands/apps.mjs'
import { boardsCommand } from './commands/boards.mjs'
import { buildCommand, cleanCommand, devctlCommand, flashCommand, geaosDeviceCommand, logsCommand, monitorCommand, otaCommand, screenshotCommand } from './commands/board.mjs'
import { doctorCommand } from './commands/doctor.mjs'
import { createContext } from './context.mjs'
import { runCreateGeastack } from './create-geastack.mjs'
import { ExitCode, fail } from './errors.mjs'
import { findAppById, findCurrentApp, knownPlatforms } from './manifest.mjs'
import { heading } from './report.mjs'
import { runSetupWizard } from './setup-wizard.mjs'

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

// The platforms board selection serves: an app declaring one of them has a
// board to resolve, which is what a bare `gea build` is asking for.
const boardPlatforms = Object.freeze(['esp32', 'rp2350', 'geaos'])

function declaresBoardTarget(app) {
  return boardPlatforms.some((platform) => Boolean(app?.targets?.[platform]))
}

const geaosDeviceActions = new Set(['bringup', 'probe', 'shell', 'push', 'record', 'tap', 'drag', 'down', 'move', 'up', 'flash-kernel'])

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
  // probeSerialDevice lets tests answer `gea boards discover` without a port;
  // fetchEspIdfLatest likewise lets tests answer the setup wizard's ESP-IDF
  // "latest release" lookup without touching the network.
  const options = { stdout, stderr, env, stdin, output, prompt, probeSerialDevice: io.probeSerialDevice, fetchEspIdfLatest: io.fetchEspIdfLatest }

  // Xbox is both a platform and a concrete built-in UWP target.
  const target = option(parsed, 'target', '')
  // macOS never reaches board selection: it has no alias and no catalog entry,
  // so an app declaring `targets.macos` is the whole configuration -- and on a
  // Mac a bare `gea build` inside such an app's folder is the command a user
  // actually types. It is only the whole configuration when there is no board
  // to pick, though: an app that also declares esp32/rp2350/geaos keeps board
  // selection for a bare `gea build`, so the command still reports which board
  // it needs rather than quietly producing a .app in place of firmware. For those
  // apps the Mac build is the documented `gea build --target macos`.
  if (command === 'build' && (target === 'macos' || (!target && !option(parsed, 'board')))) {
    const app = parsed.options.app || rest[0] ? findAppById(ctx, String(parsed.options.app || rest[0])) : findCurrentApp(cwd)
    if (app?.targets?.macos && (target === 'macos' || (process.platform === 'darwin' && !declaresBoardTarget(app)))) {
      const { runMacos } = await import('./macos/adapter.mjs')
      return runMacos({ app, env, dryRun: flag(parsed, 'dry-run'), stdout })
    }
    if (target === 'macos') {
      fail(app ? `'${app.id}' does not declare gea.targets.macos.` : 'No app selected. Pass --app <id> or run inside a Gea app folder.', ExitCode.usage)
    }
  }
  // Windows mirrors macOS: a platform, not a board, driven by one script that
  // ships inside @geastack/windows. `gea build --target windows` works on any
  // host; a bare `gea build` on a Windows machine means the Windows build for
  // an app whose only desktop target is Windows. `gea run --target windows`
  // builds and then launches the executable.
  if ((command === 'build' || command === 'run') && (target === 'windows' || (command === 'build' && !target && !option(parsed, 'board')))) {
    const app = parsed.options.app || rest[0] ? findAppById(ctx, String(parsed.options.app || rest[0])) : findCurrentApp(cwd)
    if (app?.targets?.windows && (target === 'windows' || (process.platform === 'win32' && !declaresBoardTarget(app)))) {
      const { runWindows } = await import('./windows/adapter.mjs')
      return runWindows({ app, env, dryRun: flag(parsed, 'dry-run'), stdout, run: command === 'run' })
    }
    if (target === 'windows') {
      fail(app ? `'${app.id}' does not declare gea.targets.windows.` : 'No app selected. Pass --app <id> or run inside a Gea app folder.', ExitCode.usage)
    }
    // A bare build of an app whose only native targets are desktop platforms
    // this host is not (a Windows-only app on a Mac, a Mac-only app on Linux)
    // has nothing to select: falling into board selection would report a
    // missing --board for an app that declares no board at all.
    if (command === 'build' && !target && app && !declaresBoardTarget(app) && (app.targets?.macos || app.targets?.windows)) {
      const desktop = ['macos', 'windows'].filter((platform) => app.targets?.[platform])
      fail(`'${app.id}' declares no target that builds on this host by default. Pass --target ${desktop.join(' or --target ')}.`, ExitCode.usage)
    }
  }
  // `web` names two targets, and both are driven by gea, so it leaves the
  // refusal below the way macos does above. `gea simulate` is the WASM device
  // simulator; `gea {dev,build} --target web` is a real DOM/CSS web app. A bare
  // `gea dev` means the latter -- it is the only target with a dev server, and
  // it is what `gea create` scaffolds into a new app's package.json.
  if ((command === 'dev' || command === 'build') && (target === 'web' || (!target && command === 'dev'))) {
    const app = webApp(ctx, parsed, rest, cwd)
    const { runWebBuild, runWebDev } = await import('./web/adapter.mjs')
    const shared = { app, env, dryRun: flag(parsed, 'dry-run'), stdout }
    if (command === 'dev') return runWebDev({ ...shared, port: option(parsed, 'port', '') })
    return runWebBuild({ ...shared, outDir: option(parsed, 'out-dir', '') })
  }
  if (command === 'simulate') {
    const app = webApp(ctx, parsed, rest, cwd)
    const { runSimulate } = await import('./web/adapter.mjs')
    return runSimulate({
      ctx,
      app,
      env,
      dryRun: flag(parsed, 'dry-run'),
      stdout,
      port: option(parsed, 'port', ''),
      open: !flag(parsed, 'no-open'),
      view: {
        width: option(parsed, 'width', ''),
        height: option(parsed, 'height', ''),
        dpr: option(parsed, 'dpr', ''),
        zoom: option(parsed, 'zoom', '')
      }
    })
  }
  if (target && target !== 'xbox' && knownPlatforms.includes(target) && ['build', 'flash', 'run', 'monitor', 'ota'].includes(command)) {
    if (target === 'esp32' || target === 'rp2350' || target === 'geaos') {
      fail(`--target ${target} names a platform; pass --board <alias> (gea boards list) or --target <target id> (gea targets list).`, ExitCode.usage)
    }
    fail(`The ${target} build is not driven by gea; run its build script in the ${target} target project.`, ExitCode.usage)
  }

  switch (command) {
    case 'doctor':
      return doctorCommand(ctx, parsed, rest, options)
    case 'setup':
      return option(parsed, 'board') || option(parsed, 'target')
        ? buildCommand(ctx, { ...parsed, options: { ...parsed.options, 'configure-only': true } }, rest, options)
        : runSetupWizard(ctx, parsed, options)
    case 'chips':
      return runChips(ctx, parsed, rest, options)
    case 'build':
      return buildCommand(ctx, parsed, rest, options)
    case 'clean':
      return cleanCommand(ctx, parsed, rest, options)
    case 'flash':
      return flashCommand(ctx, parsed, rest, options, { monitor: flag(parsed, 'monitor') })
    case 'run':
      return flashCommand(ctx, parsed, rest, options, { monitor: true })
    case 'monitor':
      return monitorCommand(ctx, parsed, rest, options)
    case 'logs':
    case 'tail':
      return logsCommand(ctx, parsed, rest, options)
    case 'screenshot':
      return screenshotCommand(ctx, parsed, rest, options)
    case 'ota':
      return otaCommand(ctx, parsed, rest, options)
    case 'devctl':
      return devctlCommand(ctx, parsed, rest, options)
    case 'apps':
      return appsCommand(ctx, parsed, rest, options)
    case 'boards':
      return boardsCommand(ctx, parsed, rest, options)
    case 'targets':
      return targetsCommand(ctx, parsed, rest, options)
    case 'heap-report':
      return heapReportCommand(ctx, parsed, rest, options)
    case 'list':
      return legacyList(ctx, parsed, rest, options)
    case 'inspect':
      return appsCommand(ctx, parsed, ['inspect', ...rest], options)
    default:
      if (geaosDeviceActions.has(command)) return geaosDeviceCommand(ctx, parsed, [command, ...rest], options)
      stderr(`Unknown command: ${command}`)
      stdout(usage())
      return 1
  }
}

function legacyList(ctx, parsed, rest, options) {
  const subject = rest[0] || 'apps'
  if (subject === 'apps') return appsCommand(ctx, parsed, ['list'], options)
  if (subject === 'targets') return targetsCommand(ctx, parsed, ['list'], options)
  if (subject === 'boards') return boardsCommand(ctx, parsed, ['list'], options)
  fail(`Unknown list subject '${subject}'. Expected apps, targets, or boards.`, ExitCode.usage)
}

// The web target has no board and no catalogue entry, so an app id -- or the
// folder you are standing in -- is the whole selection. Same rule the rest of
// the CLI uses, stated once because three commands share it.
function webApp(ctx, parsed, rest, cwd) {
  const requested = parsed.options.app || rest[0]
  const app = requested ? findAppById(ctx, String(requested)) : findCurrentApp(cwd)
  if (!app) fail('No app selected. Pass --app <id> or run inside a Gea app folder.', ExitCode.usage)
  return app
}

function usage() {
  return `gea ${version}

${heading('Usage:')}
  gea create <name>                              scaffold a new Gea project
  gea setup [--board <alias>]                    guided board setup, or configure a board's build
  gea doctor [--json] [--strict]                 check packages and toolchains

${heading('Run on this machine (no board needed):')}
  gea simulate [app] [--port N]                  build to WASM + open the device simulator  [--no-open] [--width W --height H --dpr D --zoom Z]
  gea dev [app] [--port N]                       real DOM + CSS dev server with HMR  (same as --target web)
  gea build --target web [app] [--out-dir d]     build the app as a real web app

${heading('Build and deploy (device commands take --board <alias>, see gea boards list; with one registered board it can be left out):')}
  gea build --board <alias> [--app <id>]         build firmware (ESP-IDF / Pico SDK / geaos)  [--verbose] [--output file.bin]
  gea flash --board <alias> [--app <id>]         build + flash over USB   [--monitor] [--manual-boot] [--no-reset] [--flash-baud N]
      --slot ota_N [--image file]                stage an app image into an OTA slot only
      --slot-image ota_N=file ...                provision several prebuilt images
      --erase-slot ota_N | --restore-boot        slot maintenance
  gea run --board <alias> [--app <id>]           build + flash + serial monitor
  gea ota --board <alias> [--app <id>]           build + OTA: BLE when the app enables it, else WiFi (transports.ota.host)  [--monitor]
      --transport ble [--device name]            BLE OTA (macOS)
      --slot ota_N [--boot] [--reboot] | --erase-slot ota_N
  gea clean --board <alias> [--app <id>]         remove build artifacts

${heading('Device access:')}
  gea logs --board <alias> [--follow]            log stream (WiFi when the board has an IP, else USB)  [--transport auto|usb|wifi]
  gea monitor --board <alias>                    raw USB serial monitor  [--timestamps] [--log-file f]
  gea screenshot [file.png] --board <alias>      grab the screen  [--transport auto|usb|wifi]
  gea devctl <verb> ... --board <alias>          GEADEV device control (gea devctl help)

${heading('Catalogs:')}
  gea apps list|inspect|pack|index|launcher|icons|icon-sheet|apple-icons
  gea boards list|show|add|set|remove|rename|discover  (gea boards help)
  gea targets list|show <id>
  gea chips ...                                  custom board composition from the chip catalog
  gea heap-report [logs...] [--out file] [--map elf.map]

Global options: --project <dir>  --boards-config <file>  --global|--local (boards writes)  --dry-run  --json  --verbose (or GEA_VERBOSE=1: stream build logs)
Board aliases: ~/.geastack/boards.json (this machine) + <project>/.gea/boards.json (overrides)`
}
