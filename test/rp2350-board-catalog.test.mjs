// The board catalog and the firmware-stem mapping are this package's: the gea
// CLI is what resolves an alias to a target and a firmware image.
//
// These assertions came from geastack/targets, which was reading cli/src
// through a sibling-checkout path. The board tests over there assert the
// target's own sources; this asserts that the CLI knows about them.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = (rel) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

const cliCatalog = source('board-catalog.mjs')

test('the catalog knows the Tufty RP2350', () => {
  assert.match(cliCatalog, /pimoroni-tufty-2350/, 'CLI catalog should include Tufty')
  assert.match(cliCatalog, /8 MB PSRAM/, 'CLI catalog should advertise Tufty PSRAM')
  assert.match(source('rp2350/adapter.mjs'), /rp2350-tufty-2350/, 'the gea CLI should know the Tufty RP2350 firmware stem')
})

test('the catalog knows the Waveshare RP2350 AMOLED 2.41', () => {
  assert.match(cliCatalog, /waveshare-rp2350-amoled-2\.41/, 'CLI catalog should include the RP2350 alias')
  assert.match(cliCatalog, /QMI8658 IMU/, 'CLI catalog should advertise the IMU')
})
