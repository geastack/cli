import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// partitions.csv is the target project's flash layout; OTA slots and otadata
// are looked up there so images are written where the bootloader expects them.

export function parsePartitionsCsv(text) {
  const rows = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const fields = line.split(',').map((field) => field.trim())
    if (fields.length < 5) continue
    rows.push({ name: fields[0], type: fields[1], subtype: fields[2], offset: fields[3], size: fields[4], flags: fields[5] || '' })
  }
  return rows
}

export function loadPartitions(targetDir, file = 'partitions.csv') {
  const csvPath = path.join(targetDir, file)
  if (!existsSync(csvPath)) throw new Error(`Partition table not found: ${csvPath}`)
  return parsePartitionsCsv(readFileSync(csvPath, 'utf8'))
}

export function normalizeOtaSlot(slot) {
  const value = String(slot || '')
  if (value.startsWith('ota_')) return value
  if (/^\d+$/.test(value)) return `ota_${value}`
  return value
}

export function partitionByName(partitions, name) {
  const found = partitions.find((partition) => partition.name === name)
  if (!found) throw new Error(`Partition '${name}' was not found in partitions.csv.`)
  return found
}

export function sizeToBytes(value) {
  const text = String(value).trim()
  const match = text.match(/^(0x[0-9a-fA-F]+|\d+)\s*([KkMm]?)$/)
  if (!match) throw new Error(`Unrecognised partition size '${value}'.`)
  const base = match[1].toLowerCase().startsWith('0x') ? Number.parseInt(match[1], 16) : Number.parseInt(match[1], 10)
  const unit = match[2].toUpperCase()
  return unit === 'K' ? base * 1024 : unit === 'M' ? base * 1024 * 1024 : base
}

// IDF writes the real offsets of bootloader/partition-table images into
// flash_args once a build has configured; fall back to the chip defaults.
export function flashOffsetForBuildImage(buildDir, imagePath, fallback) {
  const flashArgs = path.join(buildDir, 'flash_args')
  const relative = imagePath.startsWith(`${buildDir}${path.sep}`) ? imagePath.slice(buildDir.length + 1) : imagePath
  if (existsSync(flashArgs)) {
    for (const line of readFileSync(flashArgs, 'utf8').split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/)
      if (fields.length >= 2 && fields[fields.length - 1] === relative) return fields[fields.length - 2]
    }
  }
  return fallback
}
