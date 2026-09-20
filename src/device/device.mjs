import { waitForSerialPort } from '../boards/usb.mjs'
import { ExitCode, fail } from '../errors.mjs'
import { writeImage } from './image.mjs'
import { SerialDevice, geadev, parseKeyValues, streamSerialMonitor } from './serial.mjs'
import { fetchScreenshot, setDisplayBrightness, setDisplayVSync, setHighBrightnessMode, tailLogs } from './wifi.mjs'

// One handle for "the board", whichever cable (or no cable) reaches it. Logs
// and screenshots are written once against this interface; the transport
// decides how the bytes travel.

export const transports = Object.freeze(['auto', 'usb', 'wifi', 'ble'])

// 'auto' prefers WiFi whenever the board can be addressed by IP: that works
// whether or not a cable is attached, and a dropped USB enumeration is the
// exact situation where you most want to see the screen or the log.
export function chooseTransport(requested, selection, { host = '' } = {}) {
  const wanted = requested || 'auto'
  if (!transports.includes(wanted)) fail(`--transport must be one of ${transports.join(', ')}.`, ExitCode.usage)
  if (wanted === 'ble') fail('BLE device access is not available yet; use --transport usb or wifi.', ExitCode.usage)
  if (wanted !== 'auto') return wanted
  if (host || selection.otaHost) return 'wifi'
  return 'usb'
}

export function serialBaudRate(selection, env = process.env) {
  if (env.GEA_SERIAL_BAUD) return Number(env.GEA_SERIAL_BAUD)
  return (selection.idfTarget || '') === 'esp32p4' ? 921600 : 115200
}

export async function openDevice({ selection, transport, host = '', port = '', env = process.env, trace = false, stderr = () => {}, waitSeconds = 0 }) {
  if (transport === 'wifi') {
    const address = host || selection.otaHost
    if (!address) fail(`Board '${selection.boardName || selection.target}' has no transports.ota.host and no --host was passed.`, ExitCode.usage)
    return new WifiDevice(address, { stderr })
  }
  if (!selection.usbSerial && !port) {
    fail(`Board '${selection.boardName || selection.target}' has no transports.usbSerial.serial; use --transport wifi or add the USB serial.`, ExitCode.usage)
  }
  const devicePath = await waitForSerialPort({ port, serial: selection.usbSerial, timeoutSeconds: waitSeconds, label: 'USB serial port', log: stderr })
  const serial = await SerialDevice.open({ path: devicePath, baudRate: serialBaudRate(selection, env), trace, stderr })
  return new UsbDevice(serial, { stderr })
}

export class WifiDevice {
  constructor(host, { stderr }) {
    this.kind = 'wifi'
    this.host = host
    this.stderr = stderr
    this.description = `${host} (WiFi)`
  }

  async logs({ follow = false, write, timeoutMs, signal }) {
    await tailLogs({ host: this.host, follow, timeoutMs, write, stderr: this.stderr, signal })
  }

  async screenshot() {
    return fetchScreenshot({ host: this.host })
  }

  async hbm(enabled) {
    const reply = await setHighBrightnessMode({ host: this.host, enabled })
    return { hbm: reply.hbm === true, supported: reply.ok !== false }
  }

  async brightness(percent) {
    const reply = await setDisplayBrightness({ host: this.host, percent })
    return { brightness: Number(reply.brightness) }
  }

  async vsync(enabled) {
    const reply = await setDisplayVSync({ host: this.host, enabled })
    return { vsync: reply.vsync === true }
  }

  async close() {}
}

export class UsbDevice {
  constructor(serial, { stderr }) {
    this.kind = 'usb'
    this.serial = serial
    this.stderr = stderr
    this.description = `${serial.path} (USB)`
  }

  async logs({ write, timestamps = false, logFile = '', signal }) {
    await streamSerialMonitor(this.serial, { write, timestamps, logFile, signal })
  }

  async screenshot(options = {}) {
    return geadev.screenshot(this.serial, options)
  }

  async hbm(enabled) {
    return geadev.hbm(this.serial, enabled)
  }

  async brightness(percent) {
    const raw = await geadev.brightness(this.serial, percent)
    // Reading answers with the value alone; setting answers with the full
    // GEADEV line, whose readback is what the panel actually took.
    const values = typeof raw === 'string' && raw.startsWith('GEADEV:') ? parseKeyValues(raw) : { value: raw }
    return { brightness: Number(values.readback ?? values.value) }
  }

  async vsync(enabled) {
    return geadev.vsync(this.serial, enabled)
  }

  async close() {
    await this.serial.close()
  }
}

export async function saveScreenshot(device, file, options = {}) {
  const shot = await device.screenshot(options)
  writeImage(file, shot.width, shot.height, shot.rgb)
  return shot
}
