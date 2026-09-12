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
import { knownPlatforms } from './manifest.mjs'
import { runSetupWizard } from './setup-wizard.mjs'

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

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

function usage() {
  return `gea ${version}

Usage:
  gea create <name>                              scaffold a new Gea project
  gea setup [--board <alias>]                    guided board setup, or configure a board's build
  gea doctor [--json] [--strict]                 check packages and toolchains

Build and deploy (device commands take --board <alias>, see gea boards list; with one registered board it can be left out):
  gea build --board <alias> [--app <id>]         build firmware (ESP-IDF / Pico SDK / geaos)
  gea flash --board <alias> [--app <id>]         build + flash over USB   [--monitor] [--manual-boot] [--no-reset] [--flash-baud N]
      --slot ota_N [--image file]                stage an app image into an OTA slot only
      --slot-image ota_N=file ...                provision several prebuilt images
      --erase-slot ota_N | --restore-boot        slot maintenance
  gea run --board <alias> [--app <id>]           build + flash + serial monitor
  gea ota --board <alias> [--app <id>]           build + OTA: BLE when the app enables it, else WiFi (transports.ota.host)  [--monitor]
      --transport ble [--device name]            BLE OTA (macOS)
      --slot ota_N [--boot] [--reboot] | --erase-slot ota_N
  gea clean --board <alias> [--app <id>]         remove build artifacts

Device access:
  gea logs --board <alias> [--follow]            log stream (WiFi when the board has an IP, else USB)  [--transport auto|usb|wifi]
  gea monitor --board <alias>                    raw USB serial monitor  [--timestamps] [--log-file f]
  gea screenshot [file.png] --board <alias>      grab the screen  [--transport auto|usb|wifi]
  gea devctl <verb> ... --board <alias>          GEADEV device control (gea devctl help)

Catalogs:
  gea apps list|inspect|pack|index|launcher|icons|icon-sheet|apple-icons
  gea boards list|show|add|set|remove|rename|discover  (gea boards help)
  gea targets list|show <id>
  gea chips ...                                  custom board composition from the chip catalog
  gea heap-report [logs...] [--out file] [--map elf.map]

Global options: --project <dir>  --boards-config <file>  --global|--local (boards writes)  --dry-run  --json
Board aliases: ~/.geastack/boards.json (this machine) + <project>/.gea/boards.json (overrides)`
}
