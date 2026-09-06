import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { listMacUsbCalloutPorts } from './boards/usb.mjs'

// Serial devices with, where the OS can tell, the USB serial that identifies
// the board. A /dev name is never that identity -- `cu.usbmodem1101` is a
// slot number that changes on every enumeration -- so a device whose serial
// the registry does not know reports an empty one and the caller asks.
export function detectSerialDevices({ env = process.env, platform = process.platform, ioreg = undefined } = {}) {
  if (env.GEA_SERIAL_DEVICES) return parseSerialDevices(env.GEA_SERIAL_DEVICES)
  if (platform === 'win32') return detectWindowsSerialDevices(env)
  return detectUnixSerialDevices({ platform, ioreg })
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

function detectUnixSerialDevices({ platform, ioreg }) {
  const devices = new Map()
  addLinuxByIdDevices(devices)
  addDevPatternDevices(devices, platform)
  if (platform === 'darwin') mergeRegistryDevices(devices, ioreg ? listMacUsbCalloutPorts(ioreg) : listMacUsbCalloutPorts())
  return [...devices.values()].sort((a, b) => a.path.localeCompare(b.path))
}

// Overlays what the USB registry knows (serial, product name) on the ports
// found under /dev, and adds callout ports /dev scanning did not match.
export function mergeRegistryDevices(devices, registry) {
  for (const entry of registry) {
    const known = devices.get(entry.path)
    devices.set(entry.path, normalizeDevice({
      path: entry.path,
      label: entry.label || known?.label || entry.path,
      serial: entry.serial || known?.serial || ''
    }))
  }
  return devices
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

// On macOS only the call-up (`cu.`) device is listed: `tty.` is the same
// port waiting for carrier, and opening it blocks.
function addDevPatternDevices(devices, platform) {
  const dev = '/dev'
  if (!isDirectory(dev)) return
  const patterns = platform === 'darwin'
    ? [/^cu\.usbmodem/, /^cu\.usbserial/, /^cu\.SLAB_USBtoUART/, /^cu\.wchusbserial/]
    : [/^ttyACM/, /^ttyUSB/]
  for (const name of safeReaddir(dev)) {
    if (!patterns.some((pattern) => pattern.test(name))) continue
    const devicePath = path.join(dev, name)
    devices.set(devicePath, normalizeDevice({ path: devicePath, label: name, serial: '' }))
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
