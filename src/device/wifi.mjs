import { createReadStream, statSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'

import { decodeRgb565Raw } from './image.mjs'

// The cable-free transport. Two services on the board:
//   TCP 8081 -- diagnostics stream, framed [channel, type, len_lo, len_hi] + payload;
//               channel 1 is the console/ESP_LOG stream (8 KiB ring replayed on connect).
//   HTTP 8080 -- the OTA server: POST /ota, /ota/erase, GET /ota/status,
//               GET /screenshot (rgb565-raw-v1 with X-Gea-* geometry headers),
//               POST /display/hbm.

export const diagnosticsPort = 8081
export const otaPort = 8080
const channelLog = 1
const headerBytes = 4

export function otaBaseUrl(host) {
  const text = String(host)
  if (/^https?:\/\//.test(text)) return text.replace(/\/$/, '')
  if (text.includes(':')) return `http://${text}`
  return `http://${text}:${otaPort}`
}

function enableKeepalive(socket) {
  // A board that reboots never closes the connection; it just stops
  // existing. Keepalive probes turn that into an error instead of a hang.
  socket.setKeepAlive(true, 5000)
}

// Streams channel-1 payloads to `write` until the board goes away. Resolves
// { connected } so a follow loop can tell "rebooted mid-stream" apart from
// "nothing is listening".
export function streamLogsOnce({ host, port = diagnosticsPort, timeoutMs = 10000, write, onConnect }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    let connected = false
    let buffer = Buffer.alloc(0)
    socket.setTimeout(timeoutMs)
    socket.on('timeout', () => {
      if (!connected) {
        socket.destroy()
        const error = new Error(`Timed out connecting to ${host}:${port}.`)
        error.code = 'ETIMEDOUT'
        reject(error)
      }
    })
    socket.on('connect', () => {
      connected = true
      socket.setTimeout(0)
      enableKeepalive(socket)
      if (onConnect) onConnect()
    })
    socket.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      let offset = 0
      while (buffer.length - offset >= headerBytes) {
        const channel = buffer[offset]
        const payloadLength = buffer[offset + 2] | (buffer[offset + 3] << 8)
        const frameLength = headerBytes + payloadLength
        if (buffer.length - offset < frameLength) break
        if (channel === channelLog && payloadLength > 0) write(buffer.subarray(offset + headerBytes, offset + frameLength))
        offset += frameLength
      }
      buffer = offset ? buffer.subarray(offset) : buffer
    })
    socket.on('error', (error) => {
      error.connected = connected
      reject(error)
    })
    socket.on('close', () => resolve({ connected }))
  })
}

const transientErrors = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTDOWN'])

export async function tailLogs({ host, port = diagnosticsPort, follow = false, timeoutMs = 10000, write, stderr, signal }) {
  let connectedBefore = false
  let firstAttempt = true
  while (true) {
    let connected = false
    try {
      const result = await streamLogsOnce({ host, port, timeoutMs, write, onConnect: () => { connected = true } })
      connected = result.connected
    } catch (error) {
      connected = error.connected || connected
      if (error.code === 'ECONNREFUSED' && !connected && firstAttempt) {
        throw new Error(
          `${host}:${port} refused the connection. The board is reachable but its firmware has no diagnostics server -- rebuild the target with GEA_EMBEDDED_DIAGNOSTICS_ENABLED=1.`
        )
      }
      if (!transientErrors.has(error.code)) throw error
      if (!connected && !follow) throw new Error(`Could not reach ${host}:${port}: ${error.message}`)
    }
    firstAttempt = false
    if (!follow || signal?.aborted) return
    if (connected) {
      stderr(`-- reconnecting to ${host}:${port} --`)
      connectedBefore = true
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (signal?.aborted) return
  }
}

function httpRequest(url, { method = 'GET', body = null, headers = {}, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers, timeout: timeoutMs }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${url}`)))
    request.on('error', (error) => reject(new Error(`Could not reach ${url}: ${error.message}`)))
    if (body && typeof body.pipe === 'function') body.pipe(request)
    else request.end(body || undefined)
  })
}

export async function fetchScreenshot({ host, port = otaPort, timeoutMs = 30000 }) {
  const url = `http://${host}:${port}/screenshot`
  const response = await httpRequest(url, { timeoutMs })
  if (response.status !== 200) throw new Error(`${url} returned HTTP ${response.status}`)
  const width = Number(response.headers['x-gea-width'] || 0)
  const height = Number(response.headers['x-gea-height'] || 0)
  const encoding = response.headers['x-gea-encoding'] || ''
  const app = response.headers['x-gea-app'] || ''
  if (encoding !== 'rgb565-raw-v1') throw new Error(`Unexpected screenshot encoding '${encoding}' (expected rgb565-raw-v1)`)
  if (width <= 0 || height <= 0) throw new Error(`Board reported an unusable size: ${width}x${height}`)
  return { width, height, app, rgb: decodeRgb565Raw(response.body, width * height) }
}

export async function otaStatus(host) {
  const response = await httpRequest(`${otaBaseUrl(host)}/ota/status`, { timeoutMs: 5000 })
  if (response.status !== 200) throw new Error(`OTA status returned HTTP ${response.status}`)
  return JSON.parse(response.body.toString('utf8'))
}

export async function otaUpload({ host, image, slot = '', boot = false, reboot = false, timeoutMs = 600000, stdout }) {
  const query = slot ? `?slot=${encodeURIComponent(slot)}&boot=${boot ? 1 : 0}&reboot=${reboot ? 1 : 0}` : ''
  const url = `${otaBaseUrl(host)}/ota${query}`
  const size = statSync(image).size
  const startedAt = Date.now()
  const response = await httpRequest(url, {
    method: 'POST',
    body: createReadStream(image),
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    timeoutMs
  })
  const seconds = (Date.now() - startedAt) / 1000
  if (response.status !== 200) {
    throw new Error(`OTA upload to ${url} failed with HTTP ${response.status}: ${response.body.toString('utf8').trim()}`)
  }
  const text = response.body.toString('utf8').trim()
  if (text) stdout(text)
  stdout(`WiFi OTA transfer: ${size} bytes in ${seconds.toFixed(3)}s (${Math.round(size / Math.max(seconds, 0.001))} bytes/s)`)
  return { size, seconds }
}

export async function otaErase({ host, slot }) {
  const url = `${otaBaseUrl(host)}/ota/erase?slot=${encodeURIComponent(slot)}`
  const response = await httpRequest(url, { method: 'POST', timeoutMs: 120000 })
  if (response.status !== 200) throw new Error(`Erase via ${url} failed with HTTP ${response.status}`)
  return response.body.toString('utf8').trim()
}

export async function setHighBrightnessMode({ host, enabled }) {
  const url = `${otaBaseUrl(host)}/display/hbm?on=${enabled ? 1 : 0}`
  const response = await httpRequest(url, { method: 'POST', timeoutMs: 10000 })
  if (response.status === 501) throw new Error('This board has no high-brightness mode.')
  if (response.status !== 200) throw new Error(`${url} returned HTTP ${response.status}`)
  return JSON.parse(response.body.toString('utf8'))
}

export function waitForOtaServer({ host, timeoutMs = 120000, pollMs = 2000 }) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        resolve(await otaStatus(host))
      } catch (error) {
        if (Date.now() >= deadline) reject(new Error(`Board at ${host} did not come back within ${timeoutMs / 1000}s: ${error.message}`))
        else setTimeout(attempt, pollMs)
      }
    }
    attempt()
  })
}
