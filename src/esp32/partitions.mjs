import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// partitions.csv is the target project's flash layout; OTA slots and otadata
// are looked up there so images are written where the bootloader expects them.
// Which CSV that is depends on the app -- a manifest table is generated into
// the build directory and overrides the board's static one -- so the build
// leaves a plan behind naming the table it configured against and the files
// that belong in its data partitions.

const PLAN_FILE = 'gea-flash-plan.json'

export function writeFlashPlan(buildDir, { csv, payloads }) {
  mkdirSync(buildDir, { recursive: true })
  writeFileSync(path.join(buildDir, PLAN_FILE), `${JSON.stringify({ csv, payloads }, null, 2)}\n`)
}

// Missing for a board that has never been built, and for one whose app keeps
// no table of its own; the board's CSV answers for both.
export function readFlashPlan(buildDir) {
  const file = buildDir ? path.join(buildDir, PLAN_FILE) : ''
  if (!file || !existsSync(file)) return { csv: '', payloads: [] }
  let plan
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file} is not readable JSON (${error.message}). Rebuild the app.`)
  }
  return { csv: plan.csv || '', payloads: Array.isArray(plan.payloads) ? plan.payloads : [] }
}

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

export function loadPartitions(targetDir, buildDir = '') {
  const csvPath = readFlashPlan(buildDir).csv || path.join(targetDir, 'partitions.csv')
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

// Flash mode, frequency and size as the build configured them. The board
// catalog's flashSize is only a default: an app that declares a bigger chip in
// its sdkconfig gets a table that reaches past the catalog's size, and esptool
// refuses to write there unless it is told the real size.
export function buildFlashSettings(buildDir, fallbackSize) {
  const settings = { mode: 'dio', freq: '80m', size: fallbackSize }
  const file = buildDir ? path.join(buildDir, 'flasher_args.json') : ''
  if (!file || !existsSync(file)) return settings
  let configured
  try {
    configured = JSON.parse(readFileSync(file, 'utf8')).flash_settings
  } catch {
    return settings
  }
  if (!configured) return settings
  return {
    mode: configured.flash_mode || settings.mode,
    freq: configured.flash_freq || settings.freq,
    size: configured.flash_size || settings.size
  }
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
