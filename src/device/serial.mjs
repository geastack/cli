import { readFileSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { crc32, decodeRgb565Raw, decodeRgb565Rle } from './image.mjs'

// The USB transport: the firmware's GEADEV line protocol over the board's
// serial console. Requests are `GEADEV <VERB> ...` lines; replies are lines
// starting with `GEADEV:` (an ordinary log line may carry one after a
// timestamp prefix, so replies are located by substring, not by column).
//
// The port is opened without ever changing DTR/RTS: native USB-Serial-JTAG
// boards resample GPIO0 on a modem-line pulse and drop into ROM download
// mode, which is exactly what idf_monitor/pyserial's default open does to a
// freshly flashed board. serialport with hupcl off leaves the lines alone.

let serialportModule = null
async function loadSerialport() {
  if (serialportModule) return serialportModule
  try {
    serialportModule = await import('serialport')
  } catch (error) {
    throw new Error(`The 'serialport' package is required for USB device access (npm i serialport): ${error.message}`)
  }
  return serialportModule
}

export function geadevFragment(line) {
  const index = line.indexOf('GEADEV:')
  return index >= 0 ? line.slice(index) : line
}

export function parseKeyValues(line) {
  const values = {}
  for (const token of line.split(/\s+/).slice(1)) {
    const eq = token.indexOf('=')
    if (eq < 0) continue
    values[token.slice(0, eq)] = token.slice(eq + 1)
  }
  return values
}

export class SerialDevice {
  constructor(port, { path: devicePath, trace = false, stderr = () => {} }) {
    this.port = port
    this.path = devicePath
    this.trace = trace
    this.stderr = stderr
    this.buffer = Buffer.alloc(0)
    this.waiters = []
    this.closed = false
    port.on('data', (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk)
      this.notify()
    })
    port.on('close', () => {
      this.closed = true
      this.notify()
    })
    port.on('error', (error) => {
      this.error = error
      this.notify()
    })
  }

  static async open({ path: devicePath, baudRate = 115200, trace = false, stderr }) {
    const { SerialPort } = await loadSerialport()
    const port = new SerialPort({ path: devicePath, baudRate, autoOpen: false, hupcl: false, lock: false })
    await new Promise((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())))
    return new SerialDevice(port, { path: devicePath, trace, stderr })
  }

  notify() {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  waitForData(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== done)
        resolve(false)
      }, Math.max(0, timeoutMs))
      const done = () => {
        clearTimeout(timer)
        resolve(true)
      }
      this.waiters.push(done)
    })
  }

  async writeLine(line) {
    const data = `${line.replace(/[\r\n]+$/, '')}\n`
    await new Promise((resolve, reject) => this.port.write(data, (error) => (error ? reject(error) : resolve())))
    await new Promise((resolve) => this.port.drain(() => resolve()))
  }

  async writeRaw(data) {
    await new Promise((resolve, reject) => this.port.write(data, (error) => (error ? reject(error) : resolve())))
    await new Promise((resolve) => this.port.drain(() => resolve()))
  }

  async readLine(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline >= 0) {
        const raw = this.buffer.subarray(0, newline)
        this.buffer = this.buffer.subarray(newline + 1)
        return raw.toString('utf8').replace(/\r$/, '')
      }
      if (this.error) throw this.error
      if (this.closed) return null
      const remaining = deadline - Date.now()
      if (remaining <= 0) return null
      await this.waitForData(remaining)
    }
  }

  async readExact(size, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (this.buffer.length < size) {
      if (this.error) throw this.error
      const remaining = deadline - Date.now()
      if (remaining <= 0 || this.closed) throw new Error(`timed out reading ${size} bytes`)
      await this.waitForData(remaining)
    }
    const out = Buffer.from(this.buffer.subarray(0, size))
    this.buffer = this.buffer.subarray(size)
    return out
  }

  async drainInput(quietMs = 80, maxMs = 600) {
    this.buffer = Buffer.alloc(0)
    const deadline = Date.now() + maxMs
    let quietDeadline = Date.now() + quietMs
    while (Date.now() < deadline && Date.now() < quietDeadline) {
      const got = await this.waitForData(Math.min(deadline, quietDeadline) - Date.now())
      if (got) {
        this.buffer = Buffer.alloc(0)
        quietDeadline = Date.now() + quietMs
      }
    }
  }

  async command(line, prefixes, timeoutMs = 5000) {
    await this.writeLine(line)
    const deadline = Date.now() + timeoutMs
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`timed out waiting for response to ${JSON.stringify(line)}`)
      const received = await this.readLine(remaining)
      if (received === null) throw new Error(`timed out waiting for response to ${JSON.stringify(line)}`)
      if (this.trace) this.stderr(received)
      const frame = geadevFragment(received)
      if (frame.startsWith('GEADEV:ERR')) throw new Error(frame)
      if (prefixes.some((prefix) => frame.startsWith(prefix))) return frame
    }
  }

  async collect(line, { begin = null, data = 'GEADEV:DATA ', end, error = ['GEADEV:ERR'], timeoutMs = 8000 }) {
    await this.writeLine(line)
    const deadline = Date.now() + timeoutMs
    const chunks = []
    const lines = []
    let beginFrame = null
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`timed out waiting for ${line}`)
      const received = await this.readLine(remaining)
      if (received === null) throw new Error(`timed out waiting for ${line}`)
      const frame = geadevFragment(received)
      if (this.trace && !frame.startsWith(data)) this.stderr(received)
      if (error.some((prefix) => frame.startsWith(prefix))) throw new Error(frame)
      if (begin && beginFrame === null) {
        if (frame.startsWith(begin)) beginFrame = frame
        continue
      }
      if (frame.startsWith(data)) {
        chunks.push(frame.slice(data.length).trim())
        continue
      }
      lines.push(frame)
      if (frame.startsWith(end)) return { begin: beginFrame, end: frame, chunks, lines }
    }
  }

  async close() {
    if (this.closed) return
    await new Promise((resolve) => this.port.close(() => resolve()))
    this.closed = true
  }
}

// ---- GEADEV verbs -----------------------------------------------------------

export const geadev = {
  ping: (d) => d.command('GEADEV PING', ['GEADEV:PONG']),
  app: async (d) => parseKeyValues(await d.command('GEADEV APP', ['GEADEV:APP'])).id || '',
  state: (d) => d.command('GEADEV STATE', ['GEADEV:STATE']),
  mem: (d) => d.command('GEADEV MEM', ['GEADEV:MEM']),
  node: (d, className) => d.command(`GEADEV NODE ${className}`, ['GEADEV:NODE']),
  hit: (d, x, y) => d.command(`GEADEV HITTEST ${x} ${y}`, ['GEADEV:HITTEST', 'GEADEV:ERR HITTEST']),
  tap: (d, x, y, holdMs = 80) => d.command(`GEADEV TAP ${x} ${y} ${holdMs}`, ['GEADEV:OK TAP'], 8000),
  drag: (d, x1, y1, x2, y2, steps = 6, delayMs = 24) =>
    d.command(`GEADEV DRAG ${x1} ${y1} ${x2} ${y2} ${steps} ${delayMs}`, ['GEADEV:OK DRAG'], 8000),
  swipe: (d, x, y1, y2) => d.command(`GEADEV SWIPE ${x} ${y1} ${y2}`, ['GEADEV:OK SWIPE', 'GEADEV:ERR SWIPE'], 8000),
  back: (d) => d.command('GEADEV BACK', ['GEADEV:OK BACK'], 8000),
  key: (d, keyCode) => d.command(`GEADEV KEY ${keyCode}`, ['GEADEV:OK KEY', 'GEADEV:ERR KEY']),
  storageSet: (d, key, value) => d.command(`GEADEV STORAGE SET ${key} ${value}`, ['GEADEV:OK STORAGE', 'GEADEV:ERR STORAGE']),
  setDefault: (d, appId) => d.command(`GEADEV SETDEFAULT ${appId}`, ['GEADEV:OK SETDEFAULT', 'GEADEV:ERR SETDEFAULT']),
  setTime: (d, epoch) => d.command(`GEADEV SETTIME ${epoch}`, ['GEADEV:OK SETTIME', 'GEADEV:ERR SETTIME']),
  reboot: (d) => d.command('GEADEV REBOOT', ['GEADEV:OK REBOOT']),
  notify: (d, text) => d.command(`GEADEV NOTIFY ${text}`, ['GEADEV:OK NOTIFY']),
  rm: (d, devicePath) => d.command(`GEADEV RM ${devicePath}`, ['GEADEV:RM OK', 'GEADEV:RM ERR']),
  playFile: (d, devicePath) => d.command(`GEADEV PLAYFILE ${devicePath}`, ['GEADEV:PLAYFILE OK', 'GEADEV:PLAYFILE ERR'], 30000),

  async brightness(d, value) {
    const raw = await d.command(`GEADEV BRIGHTNESS${value === undefined ? '' : ` ${value}`}`, ['GEADEV:OK BRIGHTNESS', 'GEADEV:ERR BRIGHTNESS'])
    return value === undefined ? parseKeyValues(raw).value ?? '' : raw
  },

  async i2cScan(d) {
    const { lines } = await d.collect('GEADEV I2CSCAN', { data: ' ', end: 'GEADEV:I2CSCAN END', timeoutMs: 8000 })
    return lines.filter((line) => line.startsWith('GEADEV:I2CSCAN')).join('\n')
  },

  async storageGet(d, key) {
    const { chunks, lines } = await d.collect(`GEADEV STORAGE GET ${key}`, {
      end: 'GEADEV:STORAGE GET END',
      error: ['GEADEV:STORAGE GET ERR', 'GEADEV:ERR STORAGE'],
      timeoutMs: 5000
    })
    return { value: Buffer.from(chunks.join(''), 'base64').toString('utf8'), lines }
  },

  async ls(d, devicePath = '/sdcard') {
    const { lines } = await d.collect(`GEADEV LS ${devicePath}`, { data: ' ', end: 'GEADEV:LS END', error: ['GEADEV:LS ERR'], timeoutMs: 5000 })
    return lines.join('\n')
  },

  async summary(d) {
    const app = await geadev.app(d)
    const state = parseKeyValues(await geadev.state(d))
    const mem = parseKeyValues(await geadev.mem(d))
    const kb = (v) => (Number.isFinite(Number(v)) && v !== undefined ? `${Math.floor(Number(v) / 1024)} KB` : '?')
    const mb = (v) => (Number.isFinite(Number(v)) && v !== undefined ? `${(Number(v) / 1048576).toFixed(1)} MB` : '?')
    return [
      `app ${app || '?'}`,
      `${state.nodes ?? '?'} nodes`,
      `${state.width ?? '?'}x${state.height ?? '?'}`,
      `int ${kb(mem.internal_free)} free`,
      `psram ${mb(mem.psram_free)} free`,
      `batt ${state.battery ?? '?'}%`
    ].join(' · ')
  },

  async waitForApp(d, appId, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
      last = await geadev.app(d)
      if (last === appId) return true
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`timed out waiting for app ${JSON.stringify(appId)}; last app was ${JSON.stringify(last)}`)
  },

  async screenshotBinary(d, timeoutMs = 12000) {
    await d.writeLine('GEADEV SCREENSHOTBIN')
    const deadline = Date.now() + timeoutMs
    let begin = null
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('timed out waiting for binary screenshot')
      const line = await d.readLine(remaining)
      if (line === null) throw new Error('timed out waiting for binary screenshot')
      if (d.trace) d.stderr(line)
      const frame = geadevFragment(line)
      if (frame.startsWith('GEADEV:ERR') || frame.startsWith('GEADEV:SCREENSHOTBIN ERR')) throw new Error(frame)
      if (frame.startsWith('GEADEV:SCREENSHOTBIN BEGIN')) {
        begin = frame
        break
      }
    }
    const meta = parseKeyValues(begin)
    const width = Number(meta.width)
    const height = Number(meta.height)
    const size = Number(meta.bytes)
    if (meta.encoding !== 'rgb565-raw-v1') throw new Error(`unsupported binary screenshot encoding: ${meta.encoding}`)
    const payload = await d.readExact(size, Math.max(100, deadline - Date.now()))
    let end = null
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('timed out waiting for binary screenshot footer')
      const line = await d.readLine(remaining)
      if (line === null) throw new Error('timed out waiting for binary screenshot footer')
      const frame = geadevFragment(line)
      if (frame.startsWith('GEADEV:ERR') || frame.startsWith('GEADEV:SCREENSHOTBIN ERR')) throw new Error(frame)
      if (frame.startsWith('GEADEV:SCREENSHOTBIN END')) {
        end = frame
        break
      }
    }
    const expectedCrc = parseKeyValues(end).crc
    const actualCrc = crc32(payload)
    if (expectedCrc !== undefined && actualCrc !== Number.parseInt(expectedCrc, 16)) {
      throw new Error(`binary screenshot crc mismatch: got 0x${actualCrc.toString(16).padStart(8, '0')} want ${expectedCrc}`)
    }
    return { width, height, rgb: decodeRgb565Raw(payload, width * height) }
  },

  async screenshotRle(d, timeoutMs = 30000) {
    const { begin, chunks } = await d.collect('GEADEV SCREENSHOT', {
      begin: 'GEADEV:SCREENSHOT BEGIN',
      end: 'GEADEV:SCREENSHOT END',
      timeoutMs
    })
    const meta = parseKeyValues(begin)
    const width = Number(meta.width)
    const height = Number(meta.height)
    if (meta.encoding !== 'rgb565-rle-v1') throw new Error(`unsupported screenshot encoding: ${meta.encoding}`)
    return { width, height, rgb: decodeRgb565Rle(Buffer.from(chunks.join(''), 'base64'), width * height) }
  },

  async screenshot(d, { timeoutMs = 12000, fallbackTimeoutMs = 30000, attempts = 3, legacy = false } = {}) {
    if (legacy) return geadev.screenshotRle(d, fallbackTimeoutMs)
    let lastError = null
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
      try {
        return await geadev.screenshotBinary(d, timeoutMs)
      } catch (error) {
        lastError = error
        await d.drainInput()
        if (d.trace) d.stderr(`binary screenshot attempt ${attempt + 1} failed: ${error.message}`)
      }
    }
    if (d.trace) d.stderr(`binary screenshot unavailable, falling back to RLE: ${lastError?.message}`)
    return geadev.screenshotRle(d, fallbackTimeoutMs)
  },

  // Streams a file onto the device's storage over USB. Throttled bursts keep
  // the transfer under the device's continuous drain rate: its RX buffer is
  // tiny and has no flow control, and per-chunk ACK round-trips stalled.
  async pushFile(d, source, destination, { timeoutMs = 300000, base64 = false, stderr = () => {} } = {}) {
    const data = readFileSync(source)
    const crc = crc32(data)
    const verb = base64 ? 'PUSH64' : 'PUSH'
    await d.writeLine(`GEADEV ${verb} ${destination} ${data.length} ${crc}`)
    await waitFor(d, `GEADEV:${verb} READY`, `GEADEV:${verb} ERR`, 15000, `${verb} READY`)
    const startedAt = Date.now()
    if (base64) {
      const encoded = data.toString('base64')
      for (let offset = 0; offset < encoded.length; offset += 512) {
        await d.writeLine(encoded.slice(offset, offset + 512))
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 300))
      const burst = 2048
      for (let offset = 0; offset < data.length; offset += burst) {
        await d.writeRaw(data.subarray(offset, Math.min(offset + burst, data.length)))
        await new Promise((resolve) => setTimeout(resolve, 4))
        if (((offset / burst) | 0) % 256 === 0) stderr(`  push ${Math.floor((offset * 100) / data.length)}% (${offset}/${data.length})`)
      }
    }
    const line = await waitFor(d, `GEADEV:${verb} OK`, `GEADEV:${verb} ERR`, timeoutMs, `${verb} OK`)
    const seconds = (Date.now() - startedAt) / 1000
    return `${line}  (${data.length} bytes in ${seconds.toFixed(1)}s, ${Math.round(data.length / Math.max(seconds, 0.001) / 1024)} KiB/s)`
  },

  async pullFile(d, source, destination, { timeoutMs = 300000 } = {}) {
    const { chunks, end, lines } = await d.collect(`GEADEV PULL ${source}`, {
      begin: null,
      end: 'GEADEV:PULL END',
      error: ['GEADEV:PULL ERR'],
      timeoutMs
    })
    const values = parseKeyValues(end)
    const data = chunks.length ? Buffer.from(chunks.join(''), 'base64') : Buffer.alloc(0)
    const expectedSize = values.bytes !== undefined ? Number(values.bytes) : parseKeyValues(lines.find((l) => l.startsWith('GEADEV:PULL BEGIN')) || '').bytes
    if (expectedSize !== undefined && Number(expectedSize) !== data.length) {
      throw new Error(`pull size mismatch for ${source}: got ${data.length} want ${expectedSize}`)
    }
    const actualCrc = crc32(data)
    if (values.crc !== undefined && actualCrc !== Number.parseInt(values.crc, 16)) {
      throw new Error(`pull crc mismatch for ${source}: got 0x${actualCrc.toString(16)} want 0x${values.crc}`)
    }
    mkdirSync(path.dirname(path.resolve(destination)), { recursive: true })
    writeFileSync(destination, data)
    return `pulled ${source} -> ${destination} bytes=${data.length} crc=0x${actualCrc.toString(16).padStart(8, '0')}`
  }
}

async function waitFor(d, okPrefix, errPrefix, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`timed out waiting for ${what}`)
    const line = await d.readLine(remaining)
    if (line === null) throw new Error(`timed out waiting for ${what}`)
    if (d.trace) d.stderr(line)
    if (line.startsWith(errPrefix)) throw new Error(line)
    if (line.startsWith(okPrefix)) return line
  }
}

// Prints every serial line until interrupted. Nothing is written to the
// port and the modem lines are never touched, so the app keeps running.
export async function streamSerialMonitor(d, { write, timestamps = false, logFile = '', signal }) {
  let log = null
  if (logFile) {
    mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true })
    const { openSync, writeSync, closeSync } = await import('node:fs')
    const fd = openSync(logFile, 'w')
    log = { write: (text) => writeSync(fd, text), close: () => closeSync(fd) }
  }
  try {
    while (!signal?.aborted && !d.closed) {
      const line = await d.readLine(1000)
      if (line === null) continue
      const output = timestamps ? `${new Date().toTimeString().slice(0, 8)} ${line}` : line
      write(output)
      if (log) log.write(`${output}\n`)
    }
  } finally {
    if (log) log.close()
  }
}
