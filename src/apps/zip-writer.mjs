import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < CRC_TABLE.length; i += 1) {
  let c = i
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[i] = c >>> 0
}

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTimeDate(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = (year - 1980) << 9 | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

function u16(value) {
  const out = Buffer.allocUnsafe(2)
  out.writeUInt16LE(value)
  return out
}

function u32(value) {
  const out = Buffer.allocUnsafe(4)
  out.writeUInt32LE(value >>> 0)
  return out
}

export function createZipBuffer(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  const { time, day } = dosTimeDate()

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const crc = crc32(data)
    const mode = entry.executable ? 0o100755 : 0o100644
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(time),
      u16(day),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name
    ])
    localParts.push(localHeader, data)

    centralParts.push(Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(time),
      u16(day),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(mode << 16),
      u32(offset),
      name
    ]))

    offset += localHeader.length + data.length
  }

  const central = Buffer.concat(centralParts)
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0)
  ])
  return Buffer.concat([...localParts, central, eocd])
}

export function writeZip(outputPath, entries) {
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, createZipBuffer(entries))
}
