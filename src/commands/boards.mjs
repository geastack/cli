import { flag, option } from '../args.mjs'
import {
  boardConfigOrigins,
  boardConfigPath,
  boardConfigTiers,
  boardConfigWritePath,
  loadBoardConfigWithOrigins,
  readBoardConfigFile,
  writeBoardConfigFile
} from '../boards/config.mjs'
import { normalizedSerial } from '../boards/usb.mjs'
import { SerialDevice, geadev } from '../device/serial.mjs'
import { ExitCode, fail } from '../errors.mjs'
import { exists } from '../fs-utils.mjs'
import { detectSerialDevices } from '../serial-devices.mjs'

export const boardsUsage = `gea boards <subcommand> [--global | --local]

  list [--json]                         every alias, with the file it lives in
  show <alias> [--json]
  add                                   register a board (guided; gea setup)
  set <alias> <key> <value>             edit one field; an empty value removes it
  remove <alias>
  rename <alias> <new-alias>
  discover [--json] [--save]            identify the boards plugged in over USB

Keys for set: host (transports.ota.host), serial (transports.usbSerial.serial),
restart (transports.usbSerial.restartAfterFlash), target, adapter, or any
dotted path such as transports.telnet.port.

Aliases are read from ~/.geastack/boards.json (every board on this machine)
and the project's .gea/boards.json (project overrides), or only from
--boards-config when given. --global / --local choose where a write goes
(the machine-wide file or the project's); by default an existing alias is
edited where it lives and a new one joins the project config when the project
has one.`

const keyShorthands = {
  host: 'transports.ota.host',
  ip: 'transports.ota.host',
  serial: 'transports.usbSerial.serial',
  usb: 'transports.usbSerial.serial',
  restart: 'transports.usbSerial.restartAfterFlash',
  restartAfterFlash: 'transports.usbSerial.restartAfterFlash'
}

// --project is already the global "project directory" option, so the
// project tier is selected with --local.
function writeScope(parsed) {
  if (flag(parsed, 'global') && flag(parsed, 'local')) fail('Pass either --global or --local, not both.', ExitCode.usage)
  return flag(parsed, 'global') ? 'global' : flag(parsed, 'local') ? 'project' : ''
}

function tierLabel(ctx, file) {
  const tier = boardConfigTiers(ctx).find((candidate) => candidate.file === file)
  return tier ? tier.scope : file
}

function requireAlias(boards, alias, verb) {
  if (!alias) fail(`gea boards ${verb} needs a board alias.\n${boardsUsage}`, ExitCode.usage)
  if (!boards[alias]) fail(`Unknown board '${alias}'. Run gea boards list.`, ExitCode.usage)
}

export function boardSummaryLine(alias, board, scope = '') {
  const bits = [board.target || '(no target)']
  if (board.transports?.usbSerial?.serial) bits.push(`usb ${board.transports.usbSerial.serial}`)
  if (board.transports?.ota?.host) bits.push(`wifi ${board.transports.ota.host}`)
  if (board.transports?.telnet?.host) bits.push(`telnet ${board.transports.telnet.host}`)
  if (scope) bits.push(`[${scope}]`)
  return `${alias}\t${bits.join('  ')}`
}

// A value typed on the command line: numbers and booleans become JSON
// values (transports.telnet.port is a number), everything else stays a
// string. IPs, MAC-style serials and hostnames never parse as JSON.
export function parseFieldValue(raw) {
  if (raw === '' || raw === undefined) return undefined
  if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(raw) || /^[[{]/.test(raw)) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

export function setFieldPath(board, keyPath, value) {
  const segments = keyPath.split('.').filter(Boolean)
  if (segments.length === 0) fail('The key to set is empty.', ExitCode.usage)
  let cursor = board
  for (const segment of segments.slice(0, -1)) {
    if (cursor[segment] === undefined || cursor[segment] === null || typeof cursor[segment] !== 'object') {
      if (value === undefined) return board
      cursor[segment] = {}
    }
    cursor = cursor[segment]
  }
  const last = segments[segments.length - 1]
  if (value === undefined) delete cursor[last]
  else cursor[last] = value
  pruneEmptyObjects(board)
  return board
}

function pruneEmptyObjects(value) {
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      pruneEmptyObjects(child)
      if (Object.keys(child).length === 0 && key !== 'transports') delete value[key]
    }
  }
}

function updateBoardFile(file, mutate) {
  const boards = readBoardConfigFile(file)
  const next = mutate(boards)
  writeBoardConfigFile(file, next)
  return next
}

// ---- discover -----------------------------------------------------------------

// Asks a serial device who it is with one GEADEV PING. A board that is mid
// boot, running a firmware without device control, or not a gea board at
// all answers nothing and is reported as such; nothing here resets the port
// (SerialDevice.open never touches DTR/RTS).
export async function probeSerialDevice(device, { baudRate = 115200, timeoutMs = 1500, env = process.env } = {}) {
  let serial = null
  try {
    serial = await SerialDevice.open({ path: device.path, baudRate: Number(env.GEA_SERIAL_BAUD) || baudRate })
    await serial.drainInput(60, 200)
    const reply = await serial.command('GEADEV PING', ['GEADEV:PONG'], timeoutMs)
    const values = parsePong(reply)
    return { ok: true, ...values }
  } catch (error) {
    return { ok: false, error: error.message }
  } finally {
    if (serial) await serial.close().catch(() => {})
  }
}

export function parsePong(reply) {
  const values = {}
  for (const token of String(reply).split(/\s+/).slice(1)) {
    const eq = token.indexOf('=')
    if (eq > 0) values[token.slice(0, eq)] = token.slice(eq + 1)
  }
  return {
    app: values.app || '',
    ip: values.ip && values.ip !== '0.0.0.0' ? values.ip : '',
    mac: values.mac || ''
  }
}

// Pure: pairs detected serial devices with configured aliases by USB serial
// (the MAC on ESP32 boards, so a PONG's mac= confirms the same thing), and
// records what each device answered.
export async function discoverBoards({ devices, boards, probe }) {
  const results = []
  for (const device of devices) {
    const probed = await probe(device)
    const serials = [device.serial, probed.mac].map(normalizedSerial).filter(Boolean)
    const alias = Object.keys(boards).find((name) => {
      const configured = normalizedSerial(boards[name]?.transports?.usbSerial?.serial)
      return configured && serials.includes(configured)
    })
    results.push({
      path: device.path,
      label: device.label || '',
      serial: device.serial || probed.mac || '',
      alias: alias || '',
      target: alias ? boards[alias].target || '' : '',
      configuredHost: alias ? boards[alias].transports?.ota?.host || '' : '',
      responds: probed.ok,
      app: probed.app || '',
      ip: probed.ip || '',
      mac: probed.mac || '',
      error: probed.ok ? '' : probed.error || ''
    })
  }
  return results
}

export function formatDiscovery(result) {
  const who = result.alias ? `${result.alias} (${result.target})` : 'not configured'
  const bits = [result.path, who]
  if (result.serial) bits.push(`serial ${result.serial}`)
  if (result.responds) {
    bits.push(result.app ? `app ${result.app}` : 'app ?')
    bits.push(result.ip ? `ip ${result.ip}` : 'no ip')
  } else {
    bits.push('no GEADEV reply')
  }
  return bits.join('  ')
}

// ---- command --------------------------------------------------------------------

export async function boardsCommand(ctx, parsed, rest, options) {
  const sub = rest[0] || 'list'
  const json = flag(parsed, 'json')
  const { boards, origins } = loadBoardConfigWithOrigins(ctx)

  if (sub === 'help') {
    options.stdout(boardsUsage)
    return 0
  }

  if (sub === 'list') {
    const names = Object.keys(boards).sort()
    if (json) {
      options.stdout(JSON.stringify(boards, null, 2))
      return 0
    }
    if (names.length === 0) {
      const tiers = boardConfigTiers(ctx).map((tier) => `${tier.file}${exists(tier.file) ? '' : ' (missing)'}`)
      options.stdout(`No boards configured. Looked in:\n  ${tiers.join('\n  ')}\nRun gea boards add, or gea boards discover to see what is plugged in.`)
      return 0
    }
    for (const name of names) options.stdout(boardSummaryLine(name, boards[name], tierLabel(ctx, origins.get(name))))
    return 0
  }

  if (sub === 'show') {
    const name = rest[1] || option(parsed, 'board', '')
    requireAlias(boards, name, 'show')
    if (json) options.stdout(JSON.stringify({ [name]: boards[name] }, null, 2))
    else {
      options.stdout(`${name}: ${origins.get(name)}`)
      options.stdout(JSON.stringify(boards[name], null, 2))
    }
    return 0
  }

  if (sub === 'add') {
    const { runSetupWizard } = await import('../setup-wizard.mjs')
    return runSetupWizard(ctx, parsed, options)
  }

  if (sub === 'set') {
    const [, name, key, ...valueParts] = rest
    requireAlias(boards, name, 'set')
    if (!key) fail(`gea boards set needs a key and a value.\n${boardsUsage}`, ExitCode.usage)
    const keyPath = keyShorthands[key] || key
    const value = parseFieldValue(valueParts.join(' '))
    const file = boardConfigWritePath(ctx, { scope: writeScope(parsed), alias: name })
    const scope = writeScope(parsed)
    updateBoardFile(file, (current) => {
      // Moving an alias between tiers with --global/--project copies the
      // merged entry so the edit lands on a complete board, not a fragment.
      const base = current[name] ?? structuredClone(boards[name])
      current[name] = setFieldPath(base, keyPath, value)
      return current
    })
    if (scope && origins.get(name) && origins.get(name) !== file) {
      options.stderr(`Note: '${name}' also exists in ${origins.get(name)}; the project entry is the one commands see.`)
    }
    options.stdout(value === undefined ? `Removed ${keyPath} from '${name}' in ${file}` : `Set ${keyPath}=${JSON.stringify(value)} on '${name}' in ${file}`)
    return 0
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    const name = rest[1]
    requireAlias(boards, name, 'remove')
    const scope = writeScope(parsed)
    const files = scope ? [boardConfigWritePath(ctx, { scope })] : boardConfigTiers(ctx).map((tier) => tier.file)
    let removedFrom = []
    for (const file of files) {
      if (!exists(file)) continue
      const current = readBoardConfigFile(file)
      if (!current[name]) continue
      delete current[name]
      writeBoardConfigFile(file, current)
      removedFrom.push(file)
    }
    if (removedFrom.length === 0) fail(`'${name}' is not defined in ${files.join(' or ')}.`, ExitCode.usage)
    options.stdout(`Removed '${name}' from ${removedFrom.join(', ')}`)
    return 0
  }

  if (sub === 'rename' || sub === 'mv') {
    const [, from, to] = rest
    requireAlias(boards, from, 'rename')
    if (!to || !/^[a-z0-9][a-z0-9._-]*$/i.test(to)) fail(`gea boards rename needs a new alias made of letters, digits, dots, dashes or underscores.`, ExitCode.usage)
    if (boards[to]) fail(`A board named '${to}' already exists. Remove it first.`, ExitCode.usage)
    const file = boardConfigWritePath(ctx, { scope: writeScope(parsed), alias: from })
    updateBoardFile(file, (current) => {
      const entry = current[from] ?? structuredClone(boards[from])
      delete current[from]
      current[to] = entry
      return current
    })
    options.stdout(`Renamed '${from}' to '${to}' in ${file}`)
    return 0
  }

  if (sub === 'discover' || sub === 'scan') {
    const devices = detectSerialDevices({ env: options.env || ctx.env || process.env })
    const timeoutMs = Number(option(parsed, 'timeout', '1500')) || 1500
    const probe = options.probeSerialDevice || ((device) => probeSerialDevice(device, { timeoutMs, env: options.env || ctx.env || process.env }))
    const results = await discoverBoards({ devices, boards, probe: flag(parsed, 'no-probe') ? async () => ({ ok: false, error: 'not probed' }) : probe })
    if (json) {
      options.stdout(JSON.stringify(results, null, 2))
    } else if (results.length === 0) {
      options.stdout('No serial devices detected. Plug a board in over USB and retry.')
    } else {
      for (const result of results) options.stdout(formatDiscovery(result))
      const unconfigured = results.filter((result) => !result.alias && result.serial)
      for (const result of unconfigured) {
        options.stdout(`  -> register it: gea boards add   (USB serial ${result.serial}${result.app ? `, running ${result.app}` : ''})`)
      }
      for (const result of results.filter((entry) => entry.alias && entry.ip && entry.ip !== entry.configuredHost)) {
        options.stdout(`  -> '${result.alias}' is at ${result.ip}${result.configuredHost ? ` (config says ${result.configuredHost})` : ''}: gea boards set ${result.alias} host ${result.ip}, or rerun with --save`)
      }
    }
    if (flag(parsed, 'save')) {
      for (const result of results.filter((entry) => entry.alias && entry.ip && entry.ip !== entry.configuredHost)) {
        const file = boardConfigWritePath(ctx, { scope: writeScope(parsed), alias: result.alias })
        updateBoardFile(file, (current) => {
          const base = current[result.alias] ?? structuredClone(boards[result.alias])
          current[result.alias] = setFieldPath(base, 'transports.ota.host', result.ip)
          return current
        })
        options.stdout(`Saved transports.ota.host=${result.ip} for '${result.alias}' in ${file}`)
      }
    }
    return 0
  }

  fail(`Unknown boards subcommand '${sub}'.\n${boardsUsage}`, ExitCode.usage)
}

export { boardConfigPath, boardConfigOrigins }
