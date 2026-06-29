import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export function detectSerialDevices({ env = process.env, platform = process.platform } = {}) {
  if (env.GEA_SERIAL_DEVICES) return parseSerialDevices(env.GEA_SERIAL_DEVICES)
  if (platform === 'win32') return detectWindowsSerialDevices(env)
  return detectUnixSerialDevices()
}

export function formatSerialDevice(device) {
  const bits = [device.path]
  if (device.label && device.label !== device.path) bits.push(device.label)
  if (device.serial) bits.push(`serial ${device.serial}`)
  return bits.join(' - ')
}

function parseSerialDevices(value) {
  const text = String(value || '').trim()
  if (!text) return []
  if (text.startsWith('[')) {
    return JSON.parse(text).map(normalizeDevice).filter((device) => device.path)
  }
  return text
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [devicePath, label = '', serial = ''] = entry.split('|').map((part) => part.trim())
      return normalizeDevice({ path: devicePath, label, serial })
    })
    .filter((device) => device.path)
}

function detectUnixSerialDevices() {
  const devices = new Map()
  addLinuxByIdDevices(devices)
  addDevPatternDevices(devices)
  return [...devices.values()].sort((a, b) => a.path.localeCompare(b.path))
}

function addLinuxByIdDevices(devices) {
  const byId = '/dev/serial/by-id'
  if (!isDirectory(byId)) return
  for (const name of safeReaddir(byId)) {
    const devicePath = path.join(byId, name)
    devices.set(devicePath, normalizeDevice({
      path: devicePath,
      label: name,
      serial: serialFromLinuxById(name)
    }))
  }
}

function addDevPatternDevices(devices) {
  const dev = '/dev'
  if (!isDirectory(dev)) return
  const patterns = [
    /^cu\.usbmodem/,
    /^tty\.usbmodem/,
    /^cu\.usbserial/,
    /^tty\.usbserial/,
    /^cu\.SLAB_USBtoUART/,
    /^tty\.SLAB_USBtoUART/,
    /^ttyACM/,
    /^ttyUSB/
  ]
  for (const name of safeReaddir(dev)) {
    if (!patterns.some((pattern) => pattern.test(name))) continue
    const devicePath = path.join(dev, name)
    devices.set(devicePath, normalizeDevice({
      path: devicePath,
      label: name,
      serial: serialFromDeviceName(name)
    }))
  }
}

function detectWindowsSerialDevices(env) {
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_SerialPort | Select-Object DeviceID,Name,PNPDeviceID | ConvertTo-Json -Compress'
      ],
      { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim()
    if (!output) return []
    const parsed = JSON.parse(output)
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((entry) => normalizeDevice({
        path: entry.DeviceID || '',
        label: entry.Name || '',
        serial: serialFromDeviceName(entry.PNPDeviceID || '')
      }))
      .filter((device) => device.path)
      .sort((a, b) => a.path.localeCompare(b.path))
  } catch {
    return []
  }
}

function normalizeDevice(input) {
  if (typeof input === 'string') return normalizeDevice({ path: input })
  const devicePath = String(input.path || '').trim()
  const label = String(input.label || devicePath).trim()
  const serial = String(input.serial || '').trim()
  return {
    path: devicePath,
    label,
    serial
  }
}

function serialFromLinuxById(name) {
  const cleaned = name.replace(/-if\d+.*$/i, '')
  const parts = cleaned.split('_').map((part) => part.trim()).filter(Boolean)
  return parts.at(-1) || ''
}

function serialFromDeviceName(name) {
  const text = String(name || '')
  const candidates = text.match(/[A-Za-z0-9:-]{4,}/g) || []
  return candidates.at(-1) || ''
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}
