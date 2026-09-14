import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { CliError, ExitCode } from '../errors.mjs'

// ESP-IDF reads a partition table as CSV, but nothing says a person has to
// write one. Generating it from the manifest keeps a partition's payload on the
// same line as its size, so a payload cannot name a partition that does not
// exist and a table cannot silently outgrow the flash.
const HEADER = '# Generated from package.json gea.targets.esp32.partitions -- do not edit.\n# Name, Type, SubType, Offset, Size, Flags\n'

const UNITS = { K: 1024, M: 1024 * 1024 }

export function parseSize(value, where) {
  const text = String(value).trim()
  const match = /^(0[xX][0-9a-fA-F]+|\d+)\s*([KM])?$/.exec(text)
  if (!match) throw new CliError(`${where}: '${text}' is not a size (12K, 4M, 0x6000 or a byte count)`, ExitCode.usage)
  const base = match[1].toLowerCase().startsWith('0x') ? parseInt(match[1], 16) : Number(match[1])
  return base * (match[2] ? UNITS[match[2]] : 1)
}

// Writes the CSV into the build directory and returns its path plus the
// `partition=payload` pairs the build hands to esptool_py_flash_to_partition.
export function writePartitionTable({ table, appRoot, outDir }) {
  const rows = []
  const payloads = []
  for (const [name, partition] of Object.entries(table)) {
    if (name.length > 16) throw new CliError(`gea.targets.esp32.partitions.${name}: a partition name is at most 16 characters`, ExitCode.usage)
    parseSize(partition.size, `gea.targets.esp32.partitions.${name}.size`)
    if (partition.offset) parseSize(partition.offset, `gea.targets.esp32.partitions.${name}.offset`)
    rows.push([name, partition.type, partition.subtype, partition.offset, partition.size, partition.flags].join(', '))
    if (partition.data) payloads.push(`${name}=${path.join(appRoot, partition.data)}`)
  }
  mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, 'partitions.csv')
  writeFileSync(file, HEADER + rows.join('\n') + '\n')
  return { file, payloads }
}
