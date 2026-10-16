import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { listMacUsbCalloutPorts } from './boards/usb.mjs'

// Serial devices with, where the OS can tell, the USB serial that identifies
// the board and the USB vendor/product IDs that say what kind of device it is
// (four lowercase hex digits each). A /dev name is never that identity --
// `cu.usbmodem1101` is a slot number that changes on every enumeration -- so a
// device whose serial the registry does not know reports an empty one and the
// caller asks.
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
      const [devicePath, label = '', serial = '', usbId = ''] = entry.split('|').map((part) => part.trim())
      const [vendorId, productId] = usbId.split(':')
      return normalizeDevice({ path: devicePath, label, serial, vendorId, productId })
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
      serial: entry.serial || known?.serial || '',
      vendorId: entry.vendorId || known?.vendorId,
      productId: entry.productId || known?.productId
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
      serial: serialFromLinuxById(name),
      ...linuxUsbIds(devicePath)
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
        // Windows PowerShell writes in the console's OEM code page, so a port
        // label like "Serielles USB-Gerät" arrives mangled when read as UTF-8.
        // Setting the output encoding first makes the pipe match the decoding.
        // A composite device (an ESP32's native USB CDC) puts the port on an
        // interface (`...&MI_00\<synthesised>`); the serial is on its parent.
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
          'Get-CimInstance Win32_SerialPort | ForEach-Object { $parent = ""; ' +
          'try { $parent = (Get-PnpDeviceProperty -InstanceId $_.PNPDeviceID -KeyName DEVPKEY_Device_Parent -ErrorAction Stop).Data } catch {}; ' +
          '[pscustomobject]@{ DeviceID = $_.DeviceID; Name = $_.Name; PNPDeviceID = $_.PNPDeviceID; Parent = $parent } } | ConvertTo-Json -Compress'
      ],
      { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim()
    if (!output) return []
    const parsed = JSON.parse(output)
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map(windowsSerialPortDevice)
      .filter((device) => device.path)
      .sort((a, b) => a.path.localeCompare(b.path))
  } catch {
    return []
  }
}

// One Win32_SerialPort row (plus its PnP parent) as a device. A port on an
// interface of a composite device (`&MI_xx`) carries a synthesised instance
// ID; the serial is the parent device's.
export function windowsSerialPortDevice(entry) {
  const id = entry.PNPDeviceID || ''
  const usbIds = id.match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i) || []
  return normalizeDevice({
    path: entry.DeviceID || '',
    label: entry.Name || '',
    serial: serialFromDeviceName(id) || (/&MI_[0-9A-F]{2}\\/i.test(id) ? serialFromDeviceName(entry.Parent || '') : ''),
    vendorId: usbIds[1],
    productId: usbIds[2]
  })
}

function normalizeDevice(input) {
  if (typeof input === 'string') return normalizeDevice({ path: input })
  const devicePath = String(input.path || '').trim()
  const label = String(input.label || devicePath).trim()
  const serial = String(input.serial || '').trim()
  const vendorId = String(input.vendorId || '').trim().toLowerCase()
  const productId = String(input.productId || '').trim().toLowerCase()
  return {
    path: devicePath,
    label,
    serial,
    vendorId,
    productId
  }
}

// A tty's sysfs `device` is its USB interface; the USB device holding the
// vendor and product IDs is the directory above it.
function linuxUsbIds(devicePath) {
  try {
    const tty = path.basename(fs.realpathSync(devicePath))
    const usbInterface = fs.realpathSync(path.join('/sys/class/tty', tty, 'device'))
    const usbDevice = path.dirname(usbInterface)
    const vendorId = fs.readFileSync(path.join(usbDevice, 'idVendor'), 'utf8')
    const productId = fs.readFileSync(path.join(usbDevice, 'idProduct'), 'utf8')
    return { vendorId, productId }
  } catch {
    return {}
  }
}

export function serialFromLinuxById(name) {
  const cleaned = name.replace(/-if\d+.*$/i, '')
  const parts = cleaned.split('_').map((part) => part.trim()).filter(Boolean)
  return parts.at(-1) || ''
}

// A Windows instance ID is `USB\VID_xxxx&PID_yyyy[&MI_zz]\<instance>`, and the
// last field is the device's USB serial only when the device reports one.
// Otherwise Windows synthesises it from the bus position, and those always
// carry `&` -- as an ESP32-S3's native USB does with `9&1099E41D&0&0000`.
// Taking the trailing run of that yields `0000`, which is not a serial and
// identifies nothing: two such boards would claim the same identity.
function serialFromDeviceName(name) {
  const fields = String(name || '').split('\\')
  if (fields.length < 3) return ''
  const instance = fields.at(-1).trim()
  if (!instance || instance.includes('&')) return ''
  return instance
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
