import { readFileSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'

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
export async function loadSerialport() {
  if (serialportModule) return serialportModule
  if (process.platform === 'win32') settleWindowsSerialCallbacks()
  try {
    serialportModule = await import('serialport')
  } catch (error) {
    throw new Error(`The 'serialport' package is required for USB device access (npm i serialport): ${error.message}`)
  }
  return serialportModule
}

// @serialport/bindings-cpp completes Windows reads and writes on its own
// thread and calls back into JavaScript from a uv_async handle with a plain
// napi Call. Since Node.js 26.4 nothing drains the microtask queue after such a
// call (nodejs/node#66158), so the promise the binding resolves only continues
// when some other macrotask runs: every write and read waited for the next
// timer or console line, GEADEV commands timed out, and a chatty app stalled
// on a console the host stopped draining. Until the binding scopes its
// callbacks (serialport/bindings-cpp#243), each native read/write callback
// queues a setImmediate, after which Node drains microtasks. This must run
// before load-bindings.js promisifies the native functions, i.e. before
// anything imports serialport.
let windowsCallbacksSettled = false
function settleWindowsSerialCallbacks() {
  if (windowsCallbacksSettled) return
  windowsCallbacksSettled = true
  let binding
  try {
    const fromSerialport = createRequire(createRequire(import.meta.url).resolve('serialport/package.json'))
    binding = fromSerialport('@serialport/bindings-cpp/dist/serialport-bindings').binding
  } catch {
    return
  }
  const settle = () => {}
  for (const name of ['read', 'write']) {
    const native = binding?.[name]
    if (typeof native !== 'function') continue
    binding[name] = (...args) => {
      const callback = args.pop()
      return native(...args, (...result) => {
        callback(...result)
        setImmediate(settle)
      })
    }
  }
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
    // Older clients and serial monitors may not take an advisory lock. On macOS,
    // check both names of the device before opening; flock handles racing clients.
    if (process.platform === 'darwin' && /^\/dev\/(cu|tty)\./.test(devicePath)) {
      let owners = ''
      try {
        owners = execFileSync('/usr/sbin/lsof', [
          '-t',
          '-nP',
          devicePath.replace('/dev/tty.', '/dev/cu.'),
          devicePath.replace('/dev/cu.', '/dev/tty.')
        ], {
          encoding: 'utf8',
          timeout: 15000,
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim()
      } catch (error) {
        // A loaded host can take seconds to list open files; a timed-out
        // check is not a busy port, and the flock below still catches one.
        if (error.status !== 1 && error.code !== 'ENOENT' && error.code !== 'ETIMEDOUT' && error.signal !== 'SIGTERM') {
          throw new Error(`Could not check serial ownership for ${devicePath}`, { cause: error })
        }
        owners = error.stdout?.toString().trim() || ''
      }
      if (owners) {
        const pids = [...new Set(owners.split(/\s+/))].join(', ')
        throw new Error(`Serial port ${devicePath} is already in use (PID ${pids}). Close its debugger or serial monitor before attaching.`)
      }
    }
    const { SerialPort } = await loadSerialport()
    const port = new SerialPort({ path: devicePath, baudRate, autoOpen: false, hupcl: false, lock: true })
    try {
      await new Promise((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())))
    } catch (error) {
      if (/cannot lock port|resource (?:temporarily unavailable|busy)|sharing violation/i.test(error.message)) {
        throw new Error(`Serial port ${devicePath} is already in use. Close its debugger or serial monitor before attaching.`, { cause: error })
      }
      throw error
    }
    return new SerialDevice(port, { path: devicePath, trace, stderr })
  }

  notify() {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  waitForData(timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted()
      const abort = () => { clearTimeout(timer); this.waiters = this.waiters.filter(waiter => waiter !== done); reject(signal.reason) }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort)
        this.waiters = this.waiters.filter((waiter) => waiter !== done)
        resolve(false)
      }, Math.max(0, timeoutMs))
      const done = () => {
        signal?.removeEventListener('abort', abort)
        clearTimeout(timer)
        resolve(true)
      }
      this.waiters.push(done)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  async writeLine(line) {
    const data = `${line.replace(/[\r\n]+$/, '')}\n`
    await this.writeRaw(data)
  }

  async writeRaw(data) {
    if (this.error) throw this.error
    if (this.closed) throw new Error(`serial device ${this.path} is closed`)
    // A USB removal can leave write/drain callbacks permanently pending.
    // Keep a referenced deadline and reject on lifecycle events so callers can
    // still release remote resources when the physical transport disappears.
    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.port.removeListener('close', closed)
        this.port.removeListener('error', failed)
        if (error) reject(error)
        else resolve()
      }
      const closed = () => finish(new Error(`serial device ${this.path} closed during write`))
      const failed = (error) => finish(error)
      const timer = setTimeout(() => finish(new Error(`serial write timed out for ${this.path}`)), 5000)
      this.port.once('close', closed)
      this.port.once('error', failed)
      try {
        this.port.write(data, (error) => {
          if (settled) return
          if (error) finish(error)
          else {
            try {
              this.port.drain((error) => finish(error))
            } catch (error) {
              finish(error)
            }
          }
        })
      } catch (error) {
        finish(error)
      }
    })
  }

  async readLine(timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs
    while (true) {
      signal?.throwIfAborted()
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
      await this.waitForData(remaining, signal)
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

  async command(line, prefixes, timeoutMs = 5000, signal) {
    await this.writeLine(line)
    const deadline = Date.now() + timeoutMs
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`timed out waiting for response to ${JSON.stringify(line)}`)
      const received = await this.readLine(remaining, signal)
      if (received === null) throw new Error(`timed out waiting for response to ${JSON.stringify(line)}`)
      if (this.trace) this.stderr(received)
      const frame = geadevFragment(received)
      if (frame.startsWith('GEADEV:ERR')) throw new Error(frame)
      if (prefixes.some((prefix) => frame.startsWith(prefix))) return frame
    }
  }

  async collect(line, { begin = null, data = 'GEADEV:DATA ', end, error = ['GEADEV:ERR'], timeoutMs = 8000, signal }) {
    await this.writeLine(line)
    const deadline = Date.now() + timeoutMs
    const chunks = []
    const lines = []
    let beginFrame = null
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`timed out waiting for ${line}`)
      const received = await this.readLine(remaining, signal)
      if (received === null) throw new Error(`timed out waiting for ${line}`)
      const frame = geadevFragment(received)
      if (this.trace && !frame.startsWith(data)) this.stderr(received)
      if (error.some((prefix) => frame.startsWith(prefix))) throw new Error(frame)
      if (begin && beginFrame === null) {
        if (typeof begin === 'function' ? begin(frame) : frame.startsWith(begin)) beginFrame = frame
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
  // Erases and re-formats a board's file volume (everything on it is lost); a chip erase takes a while.
  format: (d, mount) => d.command(`GEADEV FORMAT ${mount}`, ['GEADEV:FORMAT OK', 'GEADEV:FORMAT ERR'], 180000),
  playFile: (d, devicePath) => d.command(`GEADEV PLAYFILE ${devicePath}`, ['GEADEV:PLAYFILE OK', 'GEADEV:PLAYFILE ERR'], 30000),

  async brightness(d, value) {
    const raw = await d.command(`GEADEV BRIGHTNESS${value === undefined ? '' : ` ${value}`}`, ['GEADEV:OK BRIGHTNESS', 'GEADEV:ERR BRIGHTNESS'])
    return value === undefined ? parseKeyValues(raw).value ?? '' : raw
  },

  async hbm(d, enabled) {
    const raw = await d.command(`GEADEV HBM${enabled === undefined ? '' : ` ${enabled ? 'on' : 'off'}`}`, ['GEADEV:OK HBM', 'GEADEV:ERR HBM'])
    const values = parseKeyValues(raw)
    return { hbm: values.value === '1', supported: values.supported === undefined ? true : values.supported === '1' }
  },

  async vsync(d, enabled) {
    const raw = await d.command(`GEADEV VSYNC${enabled === undefined ? '' : ` ${enabled ? 'on' : 'off'}`}`, ['GEADEV:OK VSYNC', 'GEADEV:ERR VSYNC'])
    return { vsync: parseKeyValues(raw).value === '1' }
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

  // Installs an app image through the running app (GEADEV OTA): it lands in
  // the next OTA slot and the board restarts into it. Same throttled raw
  // stream as pushFile.
  //
  // An interrupted install (host killed mid-upload, BOOT pressed) must not
  // poison the next one. Two leftovers can greet the next host: the dead
  // transfer's receive loop may still be running and swallow whatever is sent
  // as payload, and its `OTA ERR transfer-failed` line -- printed after the
  // host vanished -- waits in the TinyUSB TX FIFO (kept while DTR is low) and
  // is delivered the moment the port opens. So every attempt resyncs the
  // console first, streams only after a READY for this size, and takes as its
  // result only a reply that can belong to this transfer. A failed attempt is
  // retried once after another resync.
  async otaUpdate(d, source, { timeoutMs = 120000, stderr = () => {}, attempts = 2 } = {}) {
    const data = Buffer.isBuffer(source) ? source : readFileSync(source)
    const crc = crc32(data)
    for (let attempt = 1; ; attempt++) {
      try {
        return await otaAttempt(d, data, crc, { timeoutMs, stderr })
      } catch (error) {
        // uploaded: the image went out and the board may be restarting into it;
        // noApp: nothing answers the console. Neither is helped by a retry here.
        if (error.uploaded || error.noApp || attempt >= attempts) throw error
        stderr(`  in-app install attempt ${attempt} failed (${error.message}); resyncing the console and retrying`)
      }
    }
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Brings the console to a state where the next line it reads is a command:
// ends any partial line (a failed ROM-downloader attempt leaves esptool's sync
// bytes without a newline, and the command appended to them is refused as
// line-too-long), drops whatever output was queued before the port opened, and
// waits for a PONG to a fresh ping. Firmware that echoes `nonce=` is matched
// exactly; older firmware's PONG carries none and any PONG after the drain is
// taken. A board that stays silent is most likely still inside an earlier
// OTA/PUSH receive loop that took the ping as payload: it gives up after a
// silence (~3 s on current firmware, ~10 s on older), so stay silent that long
// and ping again.
export async function resyncConsole(d, { timeoutMs = 35000, pingTimeoutMs = 2500, quietMs = 12000, stderr = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs
  let waited = false
  while (Date.now() < deadline) {
    await d.writeRaw(Buffer.from('\n'))
    await d.drainInput(150, 1500)
    const nonce = randomBytes(4).toString('hex')
    await d.writeLine(`GEADEV PING ${nonce}`)
    let transferEnded = false
    const pong = await readFrame(d, Math.min(pingTimeoutMs, Math.max(0, deadline - Date.now())), (frame) => {
      if (transferEndPattern.test(frame)) transferEnded = true
      if (!frame.startsWith('GEADEV:PONG')) return false
      const echoed = parseKeyValues(frame).nonce
      return echoed === undefined || echoed === nonce
    })
    if (pong) {
      // A PONG to a ping swallowed earlier can trail this one; drop it.
      await d.drainInput(100, 500)
      return pong
    }
    if (Date.now() >= deadline) break
    // The dead transfer gave up while we waited for the PONG: ping again now.
    if (transferEnded) continue
    if (!waited) stderr('  the board is still inside an interrupted transfer; waiting for it to give up...')
    waited = true
    // Send nothing: every byte restarts the dead transfer's silence timer. Its
    // closing ERR line means the command loop is back.
    await readFrame(d, Math.min(quietMs, Math.max(0, deadline - Date.now())), (frame) => transferEndPattern.test(frame))
    await sleep(200)
  }
  const error = new Error('no running gea app answered GEADEV PING on USB')
  error.noApp = true
  throw error
}

// The closing line of a receive loop that gave up (OTA, PUSH, PUSH64).
const transferEndPattern = /^GEADEV:(?:OTA|PUSH|PUSH64) ERR\b/

// Reads lines until one whose GEADEV frame satisfies `match`; null on timeout.
async function readFrame(d, timeoutMs, match) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    const line = await d.readLine(remaining)
    if (line === null) return null
    if (d.trace) d.stderr(line)
    const frame = geadevFragment(line)
    if (match(frame)) return frame
  }
}

// Whether an `OTA ERR` line can be this transfer's reply. transfer-failed and
// crc-mismatch only follow a payload, so before READY they are leftovers of an
// earlier transfer; after it, their want= must match this image when present.
function otaErrorIsOurs(frame, { size, crc, streamed }) {
  const values = parseKeyValues(frame)
  const kind = frame.slice('GEADEV:OTA ERR'.length).trim().split(/\s+/)[0] || ''
  if (kind.startsWith('transfer-failed')) return streamed && (values.want === undefined || Number(values.want) === size)
  if (kind.startsWith('crc-mismatch')) return streamed && (values.want === undefined || Number.parseInt(values.want, 16) === crc)
  return true
}

async function otaAttempt(d, data, crc, { timeoutMs, stderr }) {
  const size = data.length
  await resyncConsole(d, { stderr })
  await d.writeLine(`GEADEV OTA ${size} ${crc}`)
  const readyDeadline = Date.now() + 15000
  let ready = null
  while (!ready) {
    const frame = await readFrame(d, readyDeadline - Date.now(), (f) => f.startsWith('GEADEV:OTA ') || f.startsWith('GEADEV:ERR'))
    if (frame === null) throw new Error('timed out waiting for OTA READY')
    if (frame.startsWith('GEADEV:ERR')) throw new Error(frame)
    if (frame.startsWith('GEADEV:OTA READY')) {
      const bytes = parseKeyValues(frame).bytes
      if (bytes === undefined || Number(bytes) === size) ready = frame
      continue
    }
    if (frame.startsWith('GEADEV:OTA ERR')) {
      if (otaErrorIsOurs(frame, { size, crc, streamed: false })) throw new Error(frame)
      stderr(`  ignoring a stale reply from an earlier transfer: ${frame}`)
    }
  }
  const startedAt = Date.now()
  await sleep(300)
  const burst = 2048
  for (let offset = 0; offset < size; offset += burst) {
    await d.writeRaw(data.subarray(offset, Math.min(offset + burst, size)))
    await sleep(4)
    if (((offset / burst) | 0) % 128 === 0) stderr(`  upload ${Math.floor((offset * 100) / size)}%`)
  }
  const doneDeadline = Date.now() + timeoutMs
  while (true) {
    let frame
    try {
      frame = await readFrame(d, doneDeadline - Date.now(), (f) => f.startsWith('GEADEV:OTA OK') || f.startsWith('GEADEV:OTA ERR'))
    } catch (error) {
      error.uploaded = true
      throw error
    }
    if (frame === null) {
      // The board restarts right after the reply, and firmware whose console
      // drops output on a full TX FIFO can lose it; the caller decides from
      // what boots.
      const error = new Error('timed out waiting for OTA OK')
      error.uploaded = true
      throw error
    }
    if (frame.startsWith('GEADEV:OTA OK')) {
      const values = parseKeyValues(frame)
      const okCrc = values.crc === undefined ? crc : Number.parseInt(values.crc, 16)
      if ((values.bytes === undefined || Number(values.bytes) === size) && okCrc === crc) {
        return { ready, line: frame, bytes: size, seconds: (Date.now() - startedAt) / 1000 }
      }
    } else if (otaErrorIsOurs(frame, { size, crc, streamed: true })) {
      throw new Error(frame)
    }
    stderr(`  ignoring a stale reply from an earlier transfer: ${frame}`)
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
