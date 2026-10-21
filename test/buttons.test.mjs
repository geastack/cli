import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergeButtons, normalizeButtons, renderButtonsHeader, resolveButtons } from '../src/boards/buttons.mjs'

const board = normalizeButtons([
  { code: 'Boot', pin: 0, activeLevel: 0, key: 'Escape' },
  { code: 'Power', source: 'pmu', key: 'Enter' }
], 'board')

test('board buttons fill in sources, key codes and defaults', () => {
  assert.deepEqual(board, [
    { code: 'Boot', key: 'Escape', keyCode: 27, source: 'gpio', pin: 0, activeLevel: 0, poll: false },
    { code: 'Power', key: 'Enter', keyCode: 13, source: 'pmu', pin: -1, activeLevel: 0, poll: false }
  ])
})

test('an app adds, changes and removes buttons by name', () => {
  const app = { manifest: { targets: { esp32: {
    buttons: [
      { code: 'Boot', key: 'ArrowDown' },
      { code: 'Key1', pin: 14, activeLevel: 1, poll: true }
    ],
    boards: { 'my-board': { buttons: [{ code: 'Power', remove: true }] } }
  } } } }
  const buttons = resolveButtons({ board, app, boardId: 'my-board' })
  assert.deepEqual(buttons.map((button) => [button.code, button.keyCode, button.pin, button.poll]), [
    ['Boot', 40, 0, false],
    ['Key1', 0, 14, true]
  ])
  // Another board keeps Power.
  assert.equal(resolveButtons({ board, app, boardId: 'other' }).length, 3)
})

test('bad declarations name the field that is wrong', () => {
  assert.throws(() => normalizeButtons([{ code: 'Boot' }], 'b'), /needs a pin/)
  assert.throws(() => normalizeButtons([{ code: 'boot key', pin: 0 }], 'b'), /b\[0\]\.code/)
  assert.throws(() => normalizeButtons([{ code: 'A', pin: 1 }, { code: 'B', pin: 1 }], 'b'), /GPIO 1 is both "A" and "B"/)
  assert.throws(() => normalizeButtons([{ code: 'A', pin: 1, key: 'Hyper' }], 'b'), /state "keyCode"/)
  assert.throws(() => normalizeButtons([{ code: 'A', pin: 1, level: 0 }], 'b'), /b\[0\]\.level is not a button setting/)
  assert.throws(() => mergeButtons(board, [{ raw: [{ code: 'Power', pin: 3 }], where: 'app' }]), /PMU's power key/)
})

test('the generated header is the native table, and is empty without buttons', () => {
  const header = renderButtonsHeader(board)
  assert.match(header, /#define GEA_BOARD_BUTTON_COUNT 2/)
  assert.match(header, /\{"Boot", "Escape", 27, Source::Gpio, 0, 0, false\},/)
  assert.match(header, /\{"Power", "Enter", 13, Source::Pmu, -1, 0, false\},/)
  assert.doesNotMatch(renderButtonsHeader([]), /buttons\[\]/)
})
