// The board catalog and the firmware-stem mapping are this package's: the gea
// CLI is what resolves an alias to a target and a firmware image.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { knownBoards } from '../src/board-catalog.mjs'
import { firmwareTarget } from '../src/stm32/adapter.mjs'

test('the catalog knows the STM32F746G-Discovery', () => {
  const disco = knownBoards.find((board) => board.target === 'stm32f746g-disco')
  assert.equal(disco.adapter, 'stm32-cube')
  assert.equal(disco.mcu, 'STM32F746NG')
  assert.match(disco.capabilities.display, /480x272/)
})

test('the STM32 adapter knows the Discovery firmware stems', () => {
  const selection = { target: 'stm32f746g-disco' }
  assert.equal(firmwareTarget(selection, { id: 'watch' }), 'gea_stm32f746g_disco_app')
  assert.equal(firmwareTarget(selection, null), 'gea_stm32f746g_disco_bringup')
})
