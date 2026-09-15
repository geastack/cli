import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseSize, writePartitionTable } from '../src/esp32/partitions-from-manifest.mjs'

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gea-partitions-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('sizes accept byte counts, K/M suffixes and hex', () => {
  assert.equal(parseSize('4M', 'x'), 4 * 1024 * 1024)
  assert.equal(parseSize('24K', 'x'), 24 * 1024)
  assert.equal(parseSize('0x6000', 'x'), 0x6000)
  assert.equal(parseSize('8192', 'x'), 8192)
  assert.throws(() => parseSize('4 gigs', 'gea.targets.esp32.partitions.a.size'), /is not a size/)
})

test('a manifest table becomes a CSV and yields its payload pairs', (t) => {
  const outDir = scratch(t)
  const { file, payloads } = writePartitionTable({
    table: {
      nvs: { type: 'data', subtype: 'nvs', size: '24K', offset: '0x9000', flags: '', data: '' },
      ota_0: { type: 'app', subtype: 'ota_0', size: '4M', offset: '', flags: '', data: '' },
      models: { type: 'data', subtype: '0x40', size: '6M', offset: '', flags: '', data: 'build/models.bin' }
    },
    appRoot: '/app',
    outDir
  })
  const csv = readFileSync(file, 'utf8')
  assert.match(csv, /^# Generated from package.json/)
  assert.match(csv, /^nvs, data, nvs, 0x9000, 24K, $/m)
  assert.match(csv, /^ota_0, app, ota_0, , 4M, $/m)
  // Only a partition that declares data produces a payload, and it is absolute.
  assert.deepEqual(payloads, [`models=${path.join('/app', 'build/models.bin')}`])
})

test('an over-long partition name is refused before the flash', (t) => {
  assert.throws(
    () =>
      writePartitionTable({
        table: { this_name_is_far_too_long: { type: 'data', subtype: 'nvs', size: '4K', offset: '', flags: '', data: '' } },
        appRoot: '/app',
        outDir: scratch(t)
      }),
    /at most 16 characters/
  )
})
