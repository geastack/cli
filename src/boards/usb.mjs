import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { detectSerialDevices, serialFromLinuxById } from '../serial-devices.mjs'

// A board is identified by its USB SERIAL, never by a /dev path: enumerated
// paths change on every plug-in and identical boards routinely share one.
// Everything here maps a stable serial to whatever port the OS gave it today.

const serialPatterns = [
  /^cu\.usbmodem/,
  /^tty\.usbmodem/,
  /^cu\.usbserial/,
  /^tty\.usbserial/,
  /^cu\.SLAB_USBtoUART/,
  /^tty\.SLAB_USBtoUART/,
  /^ttyACM/,
  /^ttyUSB/
]

export function serialPortCandidates() {
  // Windows has no /dev: a port is `COM3`, enumerated through the OS rather
  // than listed in a directory. Everything below that asks "is this port here?"
  // has to go through the same enumeration, because existsSync('COM3') is
  // always false and made every Windows wait time out.
  if (process.platform === 'win32') return detectSerialDevices({}).map((device) => device.path).sort()
  const dev = '/dev'
  if (!existsSync(dev)) return []
  return readdirSync(dev)
    .filter((name) => serialPatterns.some((pattern) => pattern.test(name)))
    .map((name) => path.join(dev, name))
    .sort()
}

// Windows port names are case-insensitive, so compare them that way.
export function serialPortPresent(port) {
  if (!port) return false
  if (process.platform !== 'win32') return existsSync(port)
  return serialPortCandidates().some((candidate) => candidate.toUpperCase() === port.toUpperCase())
}

export function resolveAutoUsbPort() {
  const candidates = serialPortCandidates()
  const callout = candidates.filter((candidate) => path.basename(candidate).startsWith('cu.'))
  const usable = callout.length > 0 ? callout : candidates
  if (usable.length <= 1) return usable[0] || ''
  throw new Error(
    ['Multiple USB serial ports are present; use --board <alias> with a registered USB serial.', ...usable.map((c) => `  ${c}`)].join('\n')
  )
}

export function normalizedSerial(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function linuxSerialByIdCandidates(serial) {
  const dir = '/dev/serial/by-id'
  if (!existsSync(dir)) return []
  const needle = normalizedSerial(serial)
  return readdirSync(dir)
    .filter((name) => {
      const deviceSerial = serialFromLinuxById(name)
      return normalizedSerial(deviceSerial) === needle
    })
    .map((name) => path.join(dir, name))
}

function ioregStringProperty(line, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return line.match(new RegExp(`"${escaped}"\\s*=\\s*"([^"]*)"`))?.[1] || ''
}

function ioregNumberProperty(line, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const value = line.match(new RegExp(`"${escaped}"\\s*=\\s*(\\d+)`))?.[1] || ''
  return value ? Number(value) : 0
}

function macUsbDeviceForSerial(serial, ioreg = runIoreg) {
  const output = ioreg(['-p', 'IOUSB', '-l', '-w0'])
  let current = null
  const devices = []
  for (const line of output.split(/\r?\n/)) {
    // One `| ` per nesting level -- devices behind hubs carry several.
    const node = line.match(/^([\s|]*)[+\\-]*o .*@([0-9a-fA-F]+)\s+<class IOUSBHostDevice/)
    if (node) {
      if (current) devices.push(current)
      current = { locationHex: node[2], text: line }
      continue
    }
    if (current) current.text += `\n${line}`
  }
  if (current) devices.push(current)
  const needle = normalizedSerial(serial)
  return devices.find((device) =>
    device.text.split(/\r?\n/).some((line) => {
      const value = ioregStringProperty(line, 'kUSBSerialNumberString') || ioregStringProperty(line, 'USB Serial Number')
      return value && normalizedSerial(value) === needle
    })
  ) || null
}

function macUsbCalloutPortsForSerial(serial, ioreg = runIoreg) {
  const output = ioreg(['-p', 'IOService', '-l', '-w0'], { maxBuffer: 64 * 1024 * 1024 })
  const stack = []
  const matches = new Set()
  const needle = normalizedSerial(serial)
  for (const line of output.split(/\r?\n/)) {
    const node = line.match(/^([\s|]*)[+\\-]*o\s+/)
    if (node) {
      // The column of `+-o` is the depth. Counting `|` is not: ioreg draws the
      // last child's subtree with spaces, so a callout under a device's last
      // interface would look shallower than the device holding its serial.
      const depth = node[1].length
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop()
      stack.push({ depth, serial: '' })
      continue
    }
    if (stack.length === 0) continue
    const current = stack[stack.length - 1]
    const serialValue = ioregStringProperty(line, 'kUSBSerialNumberString') || ioregStringProperty(line, 'USB Serial Number')
    if (serialValue) current.serial = serialValue
    const callout = ioregStringProperty(line, 'IOCalloutDevice')
    if (!callout || !path.basename(callout).startsWith('cu.')) continue
    const inherited = [...stack].reverse().find((entry) => entry.serial)?.serial || ''
    if (normalizedSerial(inherited) === needle) matches.add(callout)
  }
  return [...matches].sort()
}

// Every USB callout port the registry knows, with the serial and product
// name inherited from the enclosing USB device: the inverse of
// macUsbCalloutPortsForSerial, for `gea boards discover` and the setup
// wizard. The /dev name carries no identity (the usbmodem number changes on
// every enumeration and identical boards share it), so this is the only
// place a port's serial can come from on macOS.
export function listMacUsbCalloutPorts(ioreg = runIoreg) {
  let output = ''
  try {
    output = ioreg(['-p', 'IOService', '-l', '-w0'], { maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return []
  }
  const stack = []
  const ports = new Map()
  for (const line of output.split(/\r?\n/)) {
    const node = line.match(/^([\s|]*)[+\\-]*o\s+/)
    if (node) {
      // The column of `+-o` is the depth. Counting `|` is not: ioreg draws the
      // last child's subtree with spaces, so a callout under a device's last
      // interface would look shallower than the device holding its serial.
      const depth = node[1].length
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop()
      stack.push({ depth, serial: '', product: '' })
      continue
    }
    if (stack.length === 0) continue
    const current = stack[stack.length - 1]
    const serialValue = ioregStringProperty(line, 'kUSBSerialNumberString') || ioregStringProperty(line, 'USB Serial Number')
    if (serialValue) current.serial = serialValue
    const productValue = ioregStringProperty(line, 'kUSBProductString') || ioregStringProperty(line, 'USB Product Name')
    if (productValue) current.product = productValue
    const callout = ioregStringProperty(line, 'IOCalloutDevice')
    if (!callout || !path.basename(callout).startsWith('cu.')) continue
    // A callout with no USB serial above it is not a USB device at all
    // (Bluetooth SPP, the debug console); probing those is a wasted timeout.
    const serial = [...stack].reverse().find((entry) => entry.serial)?.serial || ''
    if (!serial) continue
    const label = [...stack].reverse().find((entry) => entry.product)?.product || ''
    ports.set(callout, { path: callout, serial, label })
  }
  return [...ports.values()].sort((a, b) => a.path.localeCompare(b.path))
}

function runIoreg(args, options = {}) {
  return execFileSync('ioreg', args, { encoding: 'utf8', ...options })
}

function resolveMacUsbSerialPort(serial, ioreg = runIoreg) {
  // A location fragment is not an identity: "1" also matches usbmodem21301.
  // During re-enumeration that heuristic selected a different connected board.
  // Only accept the callout inherited from this exact serial in IORegistry.
  const registryMatches = macUsbCalloutPortsForSerial(serial, ioreg)
  if (registryMatches.length === 1) return registryMatches[0]
  if (registryMatches.length > 1) {
    throw new Error([`USB serial ${serial} maps to multiple /dev/cu.* ports:`, ...registryMatches.map((c) => `  ${c}`)].join('\n'))
  }
  throw new Error(`Could not map USB serial ${serial} to a /dev/cu.* port. Check that the board is attached.`)
}

export function resolveUsbSerialPort({ serial }, { platform = process.platform, ioreg = runIoreg, env = process.env } = {}) {
  if (!serial) throw new Error('A USB serial number is required to locate the board; /dev paths are not accepted.')
  // GEA_SERIAL_DEVICES replaces OS enumeration everywhere (see detectSerialDevices);
  // resolution honors it with the same exact-serial rule, so a declared device list
  // can never map one board's serial onto another's port.
  if (env.GEA_SERIAL_DEVICES) {
    const needle = normalizedSerial(serial)
    const matches = detectSerialDevices({ env }).filter((device) => device.serial && normalizedSerial(device.serial) === needle)
    if (matches.length === 1) return matches[0].path
    if (matches.length > 1) throw new Error([`USB serial ${serial} maps to multiple ports:`, ...matches.map((device) => `  ${device.path}`)].join('\n'))
    throw new Error(`Could not map USB serial ${serial} to a port in GEA_SERIAL_DEVICES. Check that the board is attached.`)
  }
  if (platform === 'linux') {
    const matches = linuxSerialByIdCandidates(serial)
    if (matches.length === 1) return realpathSync(matches[0])
    throw new Error(`Could not map USB serial ${serial} to a /dev/serial/by-id entry. Check that the board is attached.`)
  }
  if (platform === 'darwin') return resolveMacUsbSerialPort(serial, ioreg)
  throw new Error(`USB serial lookup is not implemented on ${platform}.`)
}

// picotool selects by bus/address on macOS (its --ser matching is unreliable
// there); everywhere else the serial itself is the selector.
export function resolvePicotoolSelection({ serial }, { platform = process.platform, ioreg = runIoreg } = {}) {
  if (!serial) return []
  if (platform !== 'darwin') return ['--ser', serial]
  let device = null
  try {
    device = macUsbDeviceForSerial(serial, ioreg)
  } catch {
    device = null
  }
  if (!device?.locationHex) return ['--ser', serial]
  const bus = Number.parseInt(device.locationHex.slice(0, 2), 16)
  const address = device.text
    .split(/\r?\n/)
    .map((line) => ioregNumberProperty(line, 'USB Address') || ioregNumberProperty(line, 'kUSBAddress'))
    .find(Boolean) || 0
  if (!bus || !address) return ['--ser', serial]
  return ['--bus', String(bus), '--address', String(address)]
}

// Poll until the board's port exists. A board reboots (and re-enumerates)
// after a flash, so callers retry on the SERIAL, not on a cached path.
export async function waitForSerialPort({
  port = '',
  serial = '',
  timeoutSeconds = 300,
  label = 'USB serial port',
  pollSeconds = 1,
  log = (line) => process.stderr.write(`${line}\n`),
  resolver = resolveUsbSerialPort,
  portPresent = serialPortPresent,
  env = process.env
} = {}) {
  const startedAt = Date.now()
  let nextLog = startedAt
  while (true) {
    if (port) {
      if (portPresent(port)) {
        if (!serial) return port
        try {
          if (resolver({ serial }, { env }) === port) return port
        } catch {
          // An explicit path does not override the registered board identity.
        }
      }
    } else if (serial) {
      try {
        const resolved = resolver({ serial }, { env })
        if (resolved && portPresent(resolved)) return resolved
      } catch {
        // not attached yet
      }
    } else {
      const candidate = serialPortCandidates()[0]
      if (candidate) return candidate
    }
    const elapsed = (Date.now() - startedAt) / 1000
    if (timeoutSeconds > 0 && elapsed >= timeoutSeconds) {
      const where = port ? ` at ${port}` : serial ? ` with USB serial ${serial}` : ''
      throw new Error(`Timed out waiting for ${label}${where}.`)
    }
    if (Date.now() >= nextLog) {
      const where = port ? ` at ${port}` : serial ? ` with USB serial ${serial}` : ''
      log(`Waiting for ${label}${where}...`)
      nextLog = Date.now() + 5000
    }
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000))
  }
}
