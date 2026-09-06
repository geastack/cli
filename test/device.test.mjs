import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'

import { UsbDevice, WifiDevice, chooseTransport } from '../src/device/device.mjs'
import { crc32, decodeRgb565Raw, decodeRgb565Rle, encodePng, nonblackRatio } from '../src/device/image.mjs'
import { SerialDevice, geadev, geadevFragment, parseKeyValues } from '../src/device/serial.mjs'
import { fetchScreenshot, otaBaseUrl, otaUpload, setHighBrightnessMode, tailLogs } from '../src/device/wifi.mjs'

function rgb565(r, g, b) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
}

function rawFrame(pixels) {
  const buffer = Buffer.alloc(pixels.length * 2)
  pixels.forEach((value, index) => buffer.writeUInt16LE(value, index * 2))
  return buffer
}

test('rgb565 raw and RLE payloads decode to the same RGB image, and PNGs are well-formed', () => {
  const red = rgb565(255, 0, 0)
  const black = 0
  const raw = decodeRgb565Raw(rawFrame([red, red, black, black]), 4)
  assert.deepEqual([...raw.subarray(0, 3)], [255, 0, 0])
  assert.deepEqual([...raw.subarray(9, 12)], [0, 0, 0])
  const rle = Buffer.alloc(8)
  rle.writeUInt16LE(2, 0)
  rle.writeUInt16LE(red, 2)
  rle.writeUInt16LE(2, 4)
  rle.writeUInt16LE(black, 6)
  assert.deepEqual(decodeRgb565Rle(rle, 4), raw)
  assert.equal(nonblackRatio(raw), 0.5)
  assert.throws(() => decodeRgb565Raw(Buffer.alloc(3), 4), /expected 8/)
  assert.throws(() => decodeRgb565Rle(rle, 3), /exceeds/)

  const png = encodePng(2, 2, raw)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR')
  assert.equal(png.readUInt32BE(16), 2)
  assert.equal(png.readUInt32BE(20), 2)
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('auto transport prefers WiFi when the board has an address', () => {
  assert.equal(chooseTransport('auto', { otaHost: '10.0.0.5' }), 'wifi')
  assert.equal(chooseTransport('auto', { otaHost: '' }), 'usb')
  assert.equal(chooseTransport('auto', { otaHost: '' }, { host: '10.0.0.9' }), 'wifi')
  assert.equal(chooseTransport('usb', { otaHost: '10.0.0.5' }), 'usb')
  assert.throws(() => chooseTransport('serial', {}), /--transport must be one of/)
  assert.equal(otaBaseUrl('10.0.0.5'), 'http://10.0.0.5:8080')
  assert.equal(otaBaseUrl('10.0.0.5:9000'), 'http://10.0.0.5:9000')
  assert.equal(otaBaseUrl('https://board.local/'), 'https://board.local')
})

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

test('the WiFi transport streams channel-1 diagnostics frames and detects a missing server', async (t) => {
  const server = net.createServer((socket) => {
    const frame = (channel, text) => {
      const payload = Buffer.from(text)
      socket.write(Buffer.from([channel, 0, payload.length & 0xff, payload.length >> 8]))
      socket.write(payload)
    }
    frame(1, 'boot ok\n')
    frame(2, 'ignored channel')
    frame(1, 'frame 2\n')
    socket.end()
  })
  const port = await listen(server)
  t.after(() => server.close())
  const chunks = []
  await tailLogs({ host: '127.0.0.1', port, write: (chunk) => chunks.push(chunk.toString()), stderr: () => {} })
  assert.equal(chunks.join(''), 'boot ok\nframe 2\n')

  const closed = net.createServer()
  const closedPort = await listen(closed)
  await new Promise((resolve) => closed.close(resolve))
  await assert.rejects(tailLogs({ host: '127.0.0.1', port: closedPort, write: () => {}, stderr: () => {} }), /no diagnostics server/)
})

test('the OTA server client uploads images, fetches screenshots and toggles HBM', async (t) => {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks) })
      if (req.url === '/screenshot') {
        res.writeHead(200, { 'X-Gea-Width': '2', 'X-Gea-Height': '1', 'X-Gea-Encoding': 'rgb565-raw-v1', 'X-Gea-App': 'watch' })
        res.end(rawFrame([rgb565(0, 255, 0), 0]))
        return
      }
      if (req.url.startsWith('/display/hbm')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, hbm: req.url.endsWith('on=1') }))
        return
      }
      res.writeHead(200)
      res.end('OTA OK')
    })
  })
  const port = await listen(server)
  t.after(() => server.close())
  const host = `127.0.0.1:${port}`

  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const path = await import('node:path')
  const os = await import('node:os')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gea-ota-'))
  const image = path.join(dir, 'app.bin')
  writeFileSync(image, Buffer.from('firmware-bytes'))
  const lines = []
  await otaUpload({ host, image, slot: 'ota_1', boot: true, stdout: (line) => lines.push(line) })
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].url, '/ota?slot=ota_1&boot=1&reboot=0')
  assert.equal(requests[0].body.toString(), 'firmware-bytes')
  assert.match(lines.join('\n'), /WiFi OTA transfer: 14 bytes in [\d.]+s \(\d+ bytes\/s\)/)

  const shot = await fetchScreenshot({ host: '127.0.0.1', port })
  assert.equal(shot.width, 2)
  assert.equal(shot.app, 'watch')
  assert.deepEqual([...shot.rgb.subarray(0, 3)], [0, 255, 0])

  assert.deepEqual(await setHighBrightnessMode({ host, enabled: true }), { ok: true, hbm: true })
  assert.deepEqual(await setHighBrightnessMode({ host, enabled: false }), { ok: true, hbm: false })
})

// A scripted serial port: the test decides what the "board" answers to each
// line the CLI writes.
function fakePort(replies) {
  const port = new EventEmitter()
  port.path = '/dev/fake'
  port.write = (data, callback) => {
    const line = data.toString().trim()
    const reply = replies(line)
    if (reply) setImmediate(() => port.emit('data', Buffer.isBuffer(reply) ? reply : Buffer.from(reply)))
    callback()
  }
  port.drain = (callback) => callback()
  port.close = (callback) => {
    port.emit('close')
    callback()
  }
  return port
}

test('GEADEV replies are located inside log lines and parsed as key=value', () => {
  assert.equal(geadevFragment('I (1234) diag: GEADEV:APP id=watch'), 'GEADEV:APP id=watch')
  assert.deepEqual(parseKeyValues('GEADEV:STATE nodes=12 width=410 height=502'), { nodes: '12', width: '410', height: '502' })
})

test('the USB transport speaks GEADEV: commands, binary screenshots with CRC, and the RLE fallback', async () => {
  const frame = rawFrame([rgb565(255, 255, 255), 0])
  let binaryAttempts = 0
  const device = new SerialDevice(fakePort((line) => {
    if (line === 'GEADEV PING') return 'GEADEV:PONG\n'
    if (line === 'GEADEV APP') return 'I (10) diag: GEADEV:APP id=watch\n'
    if (line === 'GEADEV BRIGHTNESS 40') return 'GEADEV:OK BRIGHTNESS value=40\n'
    if (line === 'GEADEV SCREENSHOTBIN') {
      binaryAttempts += 1
      if (binaryAttempts === 1) return Buffer.concat([Buffer.from(`GEADEV:SCREENSHOTBIN BEGIN width=2 height=1 bytes=4 encoding=rgb565-raw-v1\n`), frame, Buffer.from(`GEADEV:SCREENSHOTBIN END crc=${crc32(frame).toString(16).padStart(8, '0')}\n`)])
      return 'GEADEV:ERR SCREENSHOTBIN unavailable\n'
    }
    if (line === 'GEADEV SCREENSHOT') {
      const rle = Buffer.alloc(8)
      rle.writeUInt16LE(1, 0)
      rle.writeUInt16LE(rgb565(255, 255, 255), 2)
      rle.writeUInt16LE(1, 4)
      rle.writeUInt16LE(0, 6)
      return `GEADEV:SCREENSHOT BEGIN width=2 height=1 encoding=rgb565-rle-v1\nGEADEV:DATA ${rle.toString('base64')}\nGEADEV:SCREENSHOT END\n`
    }
    return null
  }), { path: '/dev/fake' })

  assert.equal(await geadev.ping(device), 'GEADEV:PONG')
  assert.equal(await geadev.app(device), 'watch')
  assert.equal(await geadev.brightness(device, 40), 'GEADEV:OK BRIGHTNESS value=40')

  const binary = await geadev.screenshot(device, { timeoutMs: 500 })
  assert.equal(binary.width, 2)
  assert.deepEqual([...binary.rgb], [255, 255, 255, 0, 0, 0])

  const fallback = await geadev.screenshot(device, { timeoutMs: 200, fallbackTimeoutMs: 500, attempts: 1 })
  assert.deepEqual([...fallback.rgb], [255, 255, 255, 0, 0, 0])
  assert.equal(binaryAttempts, 2)

  await assert.rejects(device.command('GEADEV NOPE', ['GEADEV:OK'], 100), /timed out/)
  await device.close()
})

test('every display knob answers on both transports through one device interface', async (t) => {
  // USB: the GEADEV verbs. Reading takes no argument; setting reads back.
  let hbmState = false
  const serial = new SerialDevice(fakePort((line) => {
    if (line === 'GEADEV BRIGHTNESS') return 'GEADEV:OK BRIGHTNESS value=70\n'
    if (line === 'GEADEV BRIGHTNESS 40') return 'GEADEV:OK BRIGHTNESS value=40 readback=39\n'
    if (line === 'GEADEV HBM') return `GEADEV:OK HBM value=${hbmState ? 1 : 0}\n`
    if (line === 'GEADEV HBM on') {
      hbmState = true
      return 'GEADEV:OK HBM value=1 supported=1\n'
    }
    if (line === 'GEADEV HBM off') {
      hbmState = false
      return 'GEADEV:OK HBM value=0 supported=1\n'
    }
    if (line === 'GEADEV VSYNC on') return 'GEADEV:OK VSYNC value=1\n'
    return null
  }), { path: '/dev/fake' })
  const usb = new UsbDevice(serial, { stderr: () => {} })

  assert.deepEqual(await usb.brightness(), { brightness: 70 })
  assert.deepEqual(await usb.brightness(40), { brightness: 39 }, 'a set reports what the panel took, not what was asked')
  assert.deepEqual(await usb.hbm(true), { hbm: true, supported: true })
  assert.deepEqual(await usb.hbm(), { hbm: true, supported: true })
  assert.deepEqual(await usb.hbm(false), { hbm: false, supported: true })
  assert.deepEqual(await usb.vsync(true), { vsync: true })
  await usb.close()

  // WiFi: the same three knobs over /display/*, same shapes back.
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    res.setHeader('content-type', 'application/json')
    if (req.url.startsWith('/display/brightness')) return res.end('{"ok":true,"brightness":55}\n')
    if (req.url.startsWith('/display/vsync')) return res.end('{"ok":true,"vsync":true}\n')
    if (req.url.startsWith('/display/hbm')) return res.end('{"ok":true,"hbm":true}\n')
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const wifi = new WifiDevice(`127.0.0.1:${server.address().port}`, { stderr: () => {} })

  assert.deepEqual(await wifi.brightness(55), { brightness: 55 })
  assert.deepEqual(await wifi.hbm(true), { hbm: true, supported: true })
  assert.deepEqual(await wifi.vsync(false), { vsync: true })
  assert.deepEqual(requests, [
    'POST /display/brightness?value=55',
    'POST /display/hbm?on=1',
    'POST /display/vsync?on=0'
  ])
})

test('a panel without high-brightness mode reports it, and old firmware says so instead of timing out', async (t) => {
  const serial = new SerialDevice(fakePort((line) => (line === 'GEADEV HBM on' ? 'GEADEV:OK HBM value=0 supported=0\n' : null)), { path: '/dev/fake' })
  const usb = new UsbDevice(serial, { stderr: () => {} })
  assert.deepEqual(await usb.hbm(true), { hbm: false, supported: false })
  await usb.close()

  const server = http.createServer((req, res) => {
    res.statusCode = req.url.startsWith('/display/hbm') ? 501 : 404
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const wifi = new WifiDevice(`127.0.0.1:${server.address().port}`, { stderr: () => {} })
  await assert.rejects(wifi.hbm(true), /no high-brightness mode/)
  await assert.rejects(wifi.vsync(true), /has no \/display\/vsync endpoint.*--transport usb/s)
})
