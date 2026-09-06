import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// The one decoder for every screenshot wire format the firmware emits:
// rgb565-raw-v1 (GEADEV SCREENSHOTBIN and GET /screenshot) and the older
// rgb565-rle-v1 text protocol. Output is packed 8-bit RGB.

function expand565(value, rgb, out) {
  const r5 = (value >> 11) & 0x1f
  const g6 = (value >> 5) & 0x3f
  const b5 = value & 0x1f
  rgb[out] = (r5 << 3) | (r5 >> 2)
  rgb[out + 1] = (g6 << 2) | (g6 >> 4)
  rgb[out + 2] = (b5 << 3) | (b5 >> 2)
}

export function decodeRgb565Raw(payload, expectedPixels) {
  if (payload.length !== expectedPixels * 2) {
    throw new Error(`raw screenshot payload has ${payload.length} bytes, expected ${expectedPixels * 2}`)
  }
  const rgb = Buffer.alloc(expectedPixels * 3)
  let out = 0
  for (let pos = 0; pos < payload.length; pos += 2) {
    expand565(payload[pos] | (payload[pos + 1] << 8), rgb, out)
    out += 3
  }
  return rgb
}

export function decodeRgb565Rle(payload, expectedPixels) {
  const rgb = Buffer.alloc(expectedPixels * 3)
  let out = 0
  let pos = 0
  const pixel = Buffer.alloc(3)
  while (pos < payload.length) {
    if (pos + 4 > payload.length) throw new Error('truncated RLE screenshot payload')
    const count = payload[pos] | (payload[pos + 1] << 8)
    const value = payload[pos + 2] | (payload[pos + 3] << 8)
    pos += 4
    expand565(value, pixel, 0)
    for (let i = 0; i < count; i += 1) {
      if (out + 3 > rgb.length) throw new Error('RLE screenshot payload exceeds expected size')
      pixel.copy(rgb, out)
      out += 3
    }
  }
  if (out !== rgb.length) throw new Error(`RLE screenshot decoded ${out / 3} pixels, expected ${expectedPixels}`)
  return rgb
}

const crcTable = new Uint32Array(256)
for (let i = 0; i < 256; i += 1) {
  let c = i
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[i] = c >>> 0
}

export function crc32(buffer, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(kind, data) {
  const body = Buffer.concat([Buffer.from(kind, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

export function encodePng(width, height, rgb) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

export function encodePpm(width, height, rgb) {
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii'), rgb])
}

export function writeImage(file, width, height, rgb) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  writeFileSync(file, file.toLowerCase().endsWith('.png') ? encodePng(width, height, rgb) : encodePpm(width, height, rgb))
  return file
}

export function nonblackRatio(rgb) {
  const total = rgb.length / 3
  if (total === 0) return 0
  let nonblack = 0
  for (let i = 0; i < rgb.length; i += 3) {
    if (rgb[i] || rgb[i + 1] || rgb[i + 2]) nonblack += 1
  }
  return nonblack / total
}
