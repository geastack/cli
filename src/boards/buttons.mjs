import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Physical buttons are JSON, never C++. A board lists its own under `buttons`
// (its targets.json entry, its composed definition, or its alias in
// boards.json), and an app adds or replaces entries by name under
// gea.targets.<platform>.buttons or gea.targets.<platform>.boards.<id>.buttons:
//
//   { "code": "Boot",  "pin": 0,  "activeLevel": 0, "key": "Escape" }
//   { "code": "Power", "source": "pmu", "key": "Enter" }
//
// The build turns the merged list into the native table the firmware reads.

export const maxButtons = 8

// Web key names a button may stand in for, with their legacy keyCodes. A key
// outside this list states its keyCode explicitly.
const keyCodes = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, Space: 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123
}

function keyCodeFor(key) {
  if (key in keyCodes) return keyCodes[key]
  if (/^[A-Za-z]$/.test(key)) return key.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0)
  return null
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// One entry, checked and filled in. `partial` allows an app entry that only
// changes some fields of a board button it names.
function normalizeButton(raw, where, { partial = false } = {}) {
  if (!isObject(raw)) throw new Error(`${where} must be an object.`)
  const known = ['code', 'key', 'keyCode', 'source', 'pin', 'activeLevel', 'poll', 'remove']
  for (const name of Object.keys(raw)) {
    if (!known.includes(name) && !name.startsWith('_')) throw new Error(`${where}.${name} is not a button setting (${known.join(', ')}).`)
  }
  if (typeof raw.code !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(raw.code)) {
    throw new Error(`${where}.code must be a name like "Boot" or "Key1" (letters and digits, starting with a letter).`)
  }
  const out = { code: raw.code }
  if (raw.remove !== undefined) {
    if (raw.remove !== true) throw new Error(`${where}.remove can only be true.`)
    return { code: raw.code, remove: true }
  }
  if (raw.source !== undefined) {
    if (!['gpio', 'pmu'].includes(raw.source)) throw new Error(`${where}.source must be "gpio" or "pmu".`)
    out.source = raw.source
  }
  if (raw.pin !== undefined) {
    if (!Number.isInteger(raw.pin) || raw.pin < 0 || raw.pin > 63) throw new Error(`${where}.pin must be a GPIO number.`)
    out.pin = raw.pin
  }
  if (raw.activeLevel !== undefined) {
    if (raw.activeLevel !== 0 && raw.activeLevel !== 1) throw new Error(`${where}.activeLevel must be 0 (pressed reads low) or 1.`)
    out.activeLevel = raw.activeLevel
  }
  if (raw.poll !== undefined) {
    if (typeof raw.poll !== 'boolean') throw new Error(`${where}.poll must be true or false.`)
    out.poll = raw.poll
  }
  if (raw.key !== undefined) {
    if (typeof raw.key !== 'string') throw new Error(`${where}.key must be a web key name such as "Escape", or "" for none.`)
    out.key = raw.key
  }
  if (raw.keyCode !== undefined) {
    if (!Number.isInteger(raw.keyCode) || raw.keyCode < 0 || raw.keyCode > 0xfffe) throw new Error(`${where}.keyCode must be a key code.`)
    out.keyCode = raw.keyCode
  }
  if (partial) return out
  return complete(out, where)
}

function complete(button, where) {
  const source = button.source || 'gpio'
  if (source === 'gpio' && button.pin === undefined) throw new Error(`${where} (${button.code}) needs a pin, or "source": "pmu".`)
  if (source === 'pmu' && (button.pin !== undefined || button.poll !== undefined)) {
    throw new Error(`${where} (${button.code}) is the PMU's power key; it takes no pin or poll.`)
  }
  const key = button.key || ''
  let keyCode = button.keyCode
  if (keyCode === undefined) {
    keyCode = key ? keyCodeFor(key) : 0
    if (keyCode === null) throw new Error(`${where} (${button.code}): no keyCode is known for key "${key}"; state "keyCode".`)
  }
  return {
    code: button.code,
    key,
    keyCode,
    source,
    pin: source === 'gpio' ? button.pin : -1,
    activeLevel: button.activeLevel ?? 0,
    poll: Boolean(button.poll)
  }
}

export function normalizeButtons(raw, where) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error(`${where} must be an array of buttons.`)
  const buttons = raw.map((entry, index) => normalizeButton(entry, `${where}[${index}]`))
  return validated(buttons, where)
}

// Later layers win by name: an entry naming an existing button replaces the
// fields it states, `"remove": true` drops it, and a new name is appended.
export function mergeButtons(base, layers) {
  let buttons = base.map((button) => ({ ...button }))
  for (const { raw, where } of layers) {
    if (raw === undefined || raw === null) continue
    if (!Array.isArray(raw)) throw new Error(`${where} must be an array of buttons.`)
    raw.forEach((entry, index) => {
      const label = `${where}[${index}]`
      const change = normalizeButton(entry, label, { partial: true })
      const at = buttons.findIndex((button) => button.code === change.code)
      if (change.remove) {
        if (at >= 0) buttons.splice(at, 1)
        return
      }
      if (at < 0) {
        buttons.push(complete(change, label))
        return
      }
      const merged = { ...buttons[at], ...change }
      if (change.source === 'pmu') delete merged.pin
      if (change.key !== undefined && change.keyCode === undefined) delete merged.keyCode
      buttons[at] = complete(merged, label)
    })
  }
  return validated(buttons, layers.at(-1)?.where || 'buttons')
}

function validated(buttons, where) {
  if (buttons.length > maxButtons) throw new Error(`${where}: at most ${maxButtons} buttons.`)
  const names = new Set()
  const pins = new Map()
  let pmu = 0
  for (const button of buttons) {
    if (names.has(button.code)) throw new Error(`${where}: button "${button.code}" is declared twice.`)
    names.add(button.code)
    if (button.source === 'pmu' && ++pmu > 1) throw new Error(`${where}: only one button can be the PMU's power key.`)
    if (button.pin >= 0) {
      if (pins.has(button.pin)) throw new Error(`${where}: GPIO ${button.pin} is both "${pins.get(button.pin)}" and "${button.code}".`)
      pins.set(button.pin, button.code)
    }
  }
  return buttons
}

// The board's list, then the app's platform-wide and board-specific changes.
export function resolveButtons({ board = [], app = null, platform = 'esp32', boardId = '' }) {
  const target = isObject(app?.manifest?.targets?.[platform]) ? app.manifest.targets[platform] : {}
  const where = `gea.targets.${platform}`
  return mergeButtons(board, [
    { raw: target.buttons, where: `${where}.buttons` },
    { raw: target.boards?.[boardId]?.buttons, where: `${where}.boards.${boardId}.buttons` }
  ])
}

function cString(value) {
  return JSON.stringify(value)
}

export function renderButtonsHeader(buttons) {
  const rows = buttons.map((button) => {
    const source = button.source === 'pmu' ? 'Pmu' : 'Gpio'
    return `\t{${cString(button.code)}, ${cString(button.key)}, ${button.keyCode}, Source::${source}, ${button.pin}, ${button.activeLevel}, ${button.poll}},`
  })
  return `// Generated by gea from the board's and the app's "buttons". Do not edit.
#pragma once

#include "services/buttons.h"

#define GEA_BOARD_BUTTON_COUNT ${buttons.length}

namespace gea::platform::board {
${buttons.length ? `using gea::platform::esp32::buttons::Source;
inline constexpr gea::platform::esp32::buttons::Button buttons[] = {
${rows.join('\n')}
};` : ''}
}  // namespace gea::platform::board
`
}

// Writes gea_board_buttons.h into `outDir` (only when it changed, so an
// unchanged list does not rebuild the firmware) and returns the directory.
export function writeButtonsHeader(outDir, buttons) {
  mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, 'gea_board_buttons.h')
  const contents = renderButtonsHeader(buttons)
  if (!existsSync(file) || readFileSync(file, 'utf8') !== contents) writeFileSync(file, contents)
  return outDir
}
