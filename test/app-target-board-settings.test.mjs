import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeApp, appTargetConfig } from '../src/manifest.mjs'

const app = normalizeApp('/app', {
  name: 'demo',
  gea: {
    id: 'demo',
    entry: 'index.tsx',
    targets: {
      esp32: {
        psram: { speed: 80, mode: 'octal' },
        display: { bounceRows: 4 },
        boards: {
          'esp32-s3-board': { psram: { speed: 120 }, flashFreq: 40, display: { copyBack: 'dma' } }
        }
      }
    }
  }
})

test('a board block overrules psram, flashFreq and display for that board only', () => {
  const board = appTargetConfig(app, 'esp32', 'esp32-s3-board')
  assert.deepEqual(board.psram, { speed: 120, mode: 'octal' })
  assert.equal(board.flashFreq, 40)
  assert.deepEqual(board.display, { bounceRows: 4, copyBack: 'dma' })

  const other = appTargetConfig(app, 'esp32', 'esp32-p4-board')
  assert.deepEqual(other.psram, { speed: 80, mode: 'octal' })
  assert.equal(other.flashFreq, 0)
  assert.deepEqual(other.display, { bounceRows: 4 })
})
