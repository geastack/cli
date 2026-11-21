#!/usr/bin/env node
// On-device check of the built-in on-screen keyboard (the wide, LVGL-style
// layout landscape panels get), driven over the GEADEV serial console.
//
// Every key is pressed with GEADEV TAP and its effect read back with
// GEADEV NODE, which prints each input's value, caret and drawn text. The key
// positions are computed from the layout tables in
// core/packages/engine/ui/virtual_keyboard.cpp (kWide*Rows); keep them in step.
//
//   node cli/scripts/keyboard-check.mjs --port <dev> --field X,Y [--password X,Y]
//        [--shots dir] [--stress N] [--input-class text-input] [--width 800] [--height 480]
//
// --field is a point inside a plain text input, --password one inside a
// password input. --shots <dir> also saves a screenshot of each layout and
// of the password field before and after its characters are masked.
// Exits non-zero when any check fails.

import path from 'node:path'
import { SerialPort } from 'serialport'

import { decodeRgb565Rle, writeImage } from '../src/device/image.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const point = (text) => text && text.split(',').map(Number)
const portPath = opt('port')
const field = point(opt('field'))
const password = point(opt('password'))
const inputClass = opt('input-class', 'text-input')
const shotsDir = opt('shots')
const W = Number(opt('width', 800))
const H = Number(opt('height', 480))
if (!portPath || !field) {
  console.error('usage: keyboard-check.mjs --port <dev> --field X,Y [--password X,Y]')
  process.exit(2)
}

// ---- layout (mirrors kWideLowerRows / kWideUpperRows / kWideSpecialRows) ----

const PAD = 11
const GAP = 11
const ROWS = 4
const kbHeight = Math.floor(H / 2)
const kbTop = H - kbHeight
const rowsSpace = kbHeight - 2 * PAD - (ROWS - 1) * GAP
const keyH = Math.floor(rowsSpace / ROWS)
const rowY = (r) => kbTop + PAD + r * (keyH + GAP) + Math.floor(keyH / 2)
const bottom = [['kb', 2], ['left', 2], [' ', 6], ['right', 2], ['ok', 2]]
const layouts = {
  lower: [
    [['1#', 5], ...'qwertyuiop'.split('').map((k) => [k, 4]), ['del', 7]],
    [['ABC', 6], ...'asdfghjkl'.split('').map((k) => [k, 3]), ['ret', 7]],
    [...'_-zxcvbnm.,:'.split('').map((k) => [k, 1])],
    bottom
  ],
  upper: [
    [['1#', 5], ...'QWERTYUIOP'.split('').map((k) => [k, 4]), ['del', 7]],
    [['abc', 6], ...'ASDFGHJKL'.split('').map((k) => [k, 3]), ['ret', 7]],
    [...'_-ZXCVBNM.,:'.split('').map((k) => [k, 1])],
    bottom
  ],
  special: [
    [...'1234567890'.split('').map((k) => [k, 1]), ['del', 2]],
    [['abc', 2], ...'+&/*=%!?#<>'.split('').map((k) => [k, 1])],
    [...'\\@$(){}[];"\''.split('').map((k) => [k, 1])],
    bottom
  ]
}

function keyCenters(layout) {
  const centers = new Map()
  layouts[layout].forEach((row, r) => {
    const units = row.reduce((sum, [, u]) => sum + u, 0)
    const avail = W - 2 * PAD - GAP * (row.length - 1)
    let x = PAD
    for (const [label, u] of row) {
      const w = (avail * u) / units
      centers.set(label, [Math.round(x + w / 2), rowY(r)])
      x += w + GAP
    }
  })
  return centers
}
const centers = Object.fromEntries(Object.keys(layouts).map((l) => [l, keyCenters(l)]))

// ---- serial ----

const port = new SerialPort({ path: portPath, baudRate: 115200, hupcl: false, autoOpen: false })
await new Promise((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())))
let buffer = ''
let waiters = []
port.on('data', (d) => {
  buffer += d.toString('latin1')
  const w = waiters
  waiters = []
  for (const f of w) f()
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nextLine = async (deadline) => {
  while (true) {
    const i = buffer.indexOf('\n')
    if (i >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '')
      buffer = buffer.slice(i + 1)
      return line
    }
    const left = deadline - Date.now()
    if (left <= 0) return null
    await new Promise((r) => {
      waiters.push(r)
      setTimeout(r, left)
    })
  }
}
const frag = (line) => {
  const i = line.indexOf('GEADEV:')
  return i >= 0 ? line.slice(i) : line
}
// The P4 console UART drains its TX ring only when a byte comes IN (its
// TX-empty interrupt does not fire): a reply longer than the 128-byte FIFO
// stalls until the host writes again, and output from an earlier command can
// still be queued when the next one is sent. So empty lines keep flowing
// while a command is outstanding (the console ignores them), the line is
// drained until quiet before each command, and a reply ends at its own end
// marker -- or, for NODE's open-ended list, after a quiet gap.
let lastData = Date.now()
port.on('data', () => { lastData = Date.now() })
async function drainQuiet(quietMs, maxMs) {
  const stop = Date.now() + maxMs
  while (Date.now() < stop) {
    if (Date.now() - lastData >= quietMs) break
    await sleep(10)
  }
  buffer = ''
}
// Timed reads (the password's 1.5 s window) cut the pre-command drain short:
// the newline pump keeps a trickle coming, so the drain often runs its full 4 s.
let drainMaxMs = 4000
async function command(line, until, timeoutMs = 8000) {
  const pump = setInterval(() => port.write('\n'), 40)
  try {
    await drainQuiet(120, drainMaxMs)
    port.write(`${line}\n`)
    const deadline = Date.now() + timeoutMs
    const lines = []
    while (true) {
      const quietEnd = lines.length ? Math.min(deadline, lastData + 250) : deadline
      const got = await nextLine(quietEnd)
      if (got === null) {
        if (Date.now() >= deadline || lines.length) return lines
        continue
      }
      const f = frag(got)
      if (!f.startsWith('GEADEV:')) continue
      lines.push(f)
      if (until(f, lines)) return lines
    }
  } finally {
    clearInterval(pump)
  }
}
port.write('\n')
await sleep(300)

// Start from a fresh boot: a previous run leaves fields typed, the page
// scrolled and maybe the keyboard open, which shifts every position.
async function reboot() {
  port.write('GEADEV REBOOT\n')
  await sleep(12000)
  for (let i = 0; i < 20; i++) {
    const lines = await command(`GEADEV NODE ${inputClass}`, () => false)
    if (lines.some((l) => l.startsWith('GEADEV:NODETEXT'))) break
    await sleep(1000)
  }
}
const rebootAllowed = opt('no-reboot') === undefined && !args.includes('--no-reboot')
if (rebootAllowed) await reboot()

const unescape = (s) => s.replace(/\\x([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
const utf8 = (s) => Buffer.from(s, 'latin1').toString('utf8')

let unackedTaps = 0
async function tap(x, y) {
  const lines = await command(`GEADEV TAP ${x} ${y} 60`, (f) => f.startsWith('GEADEV:OK TAP') || f.startsWith('GEADEV:ERR'))
  if (!lines.some((l) => l.startsWith('GEADEV:OK TAP'))) {
    unackedTaps++
    console.log(`(tap ${x},${y} not acknowledged by the board)`)
  }
  await sleep(140)
}

// Every input of the class: { id, focused, caret, value, text }. A log line
// printed mid-reply can split a NODETEXT line; such a read is retried.
let readAttempts = 0
async function inputs() {
  readAttempts = 0
  for (let attempt = 0; attempt < 4; attempt++) {
    readAttempts++
    const lines = await command(`GEADEV NODE ${inputClass}`, () => false)
    const nodeCount = lines.filter((l) => l.startsWith('GEADEV:NODE class=')).length
    const parsed = lines
      .filter((l) => l.startsWith('GEADEV:NODETEXT'))
      .map((l) => {
        const m = l.match(/^GEADEV:NODETEXT id=(\d+) focused=(\d) caret=(-?\d+) value=(\S*) text=(\S*)$/)
        return m && { id: +m[1], focused: m[2] === '1', caret: +m[3], value: utf8(unescape(m[4])), text: utf8(unescape(m[5])) }
      })
    // A password input inside its reveal window also prints the window.
    for (const l of lines.filter((l) => l.startsWith('GEADEV:NODEREVEAL'))) {
      const m = l.match(/id=(\d+) (.*)$/)
      const input = m && parsed.find((i) => i && i.id === +m[1])
      if (input) input.reveal = m[2]
    }
    if (nodeCount > 0 && parsed.length > 0 && parsed.every(Boolean)) return parsed
  }
  return []
}
const focused = async () => (await inputs()).find((i) => i.focused) || null

// A log line printed into the middle of the base64 stream corrupts it; the
// capture is checked (every data line clean base64, the runs filling exactly
// the frame) and retried.
async function shot(name, { force = false } = {}) {
  if (!shotsDir && !force) return null
  for (let attempt = 0; attempt < 4; attempt++) {
    const lines = await command('GEADEV SCREENSHOT', (f) => f.startsWith('GEADEV:SCREENSHOT END') || f.startsWith('GEADEV:ERR'), 180000)
    const begin = lines.find((l) => l.startsWith('GEADEV:SCREENSHOT BEGIN'))
    if (!begin) continue
    const width = Number(begin.match(/width=(\d+)/)[1])
    const height = Number(begin.match(/height=(\d+)/)[1])
    const data = lines.filter((l) => l.startsWith('GEADEV:DATA ')).map((l) => l.slice(12).trim())
    if (!data.every((d) => /^[A-Za-z0-9+/]+=*$/.test(d))) continue
    try {
      const rgb = decodeRgb565Rle(Buffer.from(data.join(''), 'base64'), width * height)
      if (shotsDir) {
        const file = path.join(shotsDir, `keyboard-${name}.png`)
        writeImage(file, width, height, rgb)
        console.log(`(saved ${file})`)
      }
      return { width, height, rgb }
    } catch {}
  }
  console.log(`(screenshot ${name} failed)`)
  return null
}

// Pixels of `rect` that differ between two captures.
function changedPixels(a, b, [x0, y0, x1, y1]) {
  let changed = 0
  for (let y = Math.max(0, y0); y < Math.min(a.height, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(a.width, x1); x++) {
      const i = (y * a.width + x) * 3
      if (a.rgb[i] !== b.rgb[i] || a.rgb[i + 1] !== b.rgb[i + 1] || a.rgb[i + 2] !== b.rgb[i + 2]) changed++
    }
  return changed
}

// Each input's box: { id, x, y, w, h }.
async function nodes() {
  const lines = await command(`GEADEV NODE ${inputClass}`, () => false)
  return lines
    .map((l) => l.match(/^GEADEV:NODE class=\S+ id=(\d+) .* layout=(-?\d+),(-?\d+),(\d+),(\d+)/))
    .filter(Boolean)
    .map((m) => ({ id: +m[1], x: +m[2], y: +m[3], w: +m[4], h: +m[5] }))
}

// True when a keyboard key is what the point hits (keys carry press ids
// 30000..30051, the label inside a key is hit with the key's id on its parent).
async function keyboardUnder([x, y]) {
  const hit = await command(`GEADEV HITTEST ${x} ${y}`, (l) => l.startsWith('GEADEV:HITTEST') || l.startsWith('GEADEV:ERR'))
  const line = hit.find((l) => l.startsWith('GEADEV:HITTEST')) || ''
  const press = Number((line.match(/press_id=(-?\d+)/) || [])[1])
  const layout = (line.match(/layout=(\S+)/) || [])[1] || ''
  return (press >= 30000 && press < 30052) || layout.startsWith(`${PAD},`)
}

// ---- checks ----

let failures = 0
let passes = 0
function check(name, ok, detail = '') {
  if (ok) passes++
  else failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -- ${detail}`}`)
}
const show = (i) =>
  i ? `value=${JSON.stringify(i.value)} caret=${i.caret} text=${JSON.stringify(i.text)}${i.reveal ? ` reveal=[${i.reveal}]` : ''}` : 'no focused input'

let mode = 'lower'
async function press(label) {
  const c = centers[mode].get(label)
  if (!c) throw new Error(`no key ${JSON.stringify(label)} in ${mode}`)
  await tap(c[0], c[1])
}
async function clearField() {
  let f = await focused()
  if (!f) return
  // Caret to the end, then delete everything.
  for (let i = 0; i < f.value.length - f.caret; i++) await press('right')
  for (let guard = 0; guard < 4; guard++) {
    f = await focused()
    if (!f || !f.value.length) return
    for (let i = 0; i < f.value.length; i++) await press('del')
  }
}
async function typeSeq(keys) {
  for (const k of keys) await press(k)
}
// Inputs are tapped where they are now: closing the keyboard leaves the page
// scrolled, so a field's first position is not where it stays. The first open
// finds the input under the given point; later opens follow that input's box.
const fieldIds = new Map()
let startBoxes = null
async function openField(p) {
  if (!startBoxes) startBoxes = await nodes()
  if (!fieldIds.has(p)) {
    const box = startBoxes.find((n) => p[0] >= n.x && p[0] < n.x + n.w && p[1] >= n.y && p[1] < n.y + n.h)
    if (box) fieldIds.set(p, box.id)
  }
  const known = fieldIds.get(p)
  let target = p
  if (known !== undefined) {
    const box = (await nodes()).find((n) => n.id === known)
    if (box) target = [box.x + Math.floor(box.w / 2), box.y + Math.floor(box.h / 2)]
  }
  mode = 'lower'
  // A tap that lands while the app is still starting is dropped; try again.
  for (let attempt = 0; attempt < 3; attempt++) {
    await tap(target[0], target[1])
    await sleep(300)
    const f = await focused()
    if (f) return f
  }
  return null
}

// --stress N: tap one key N times and count what arrived, nothing else.
const stress = Number(opt('stress', 0))
if (stress > 0) {
  let f = await openField(field)
  await clearField()
  for (let i = 0; i < stress; i++) await press('q')
  f = await focused()
  const typed = f ? f.value.length : -1
  check(`${stress} taps type ${stress} characters`, typed === stress, `${typed} arrived, ${unackedTaps} taps not acknowledged`)
  await clearField()
  console.log(`\n${passes} passed, ${failures} failed`)
  port.close()
  process.exit(failures ? 1 : 0)
}

// --only-password runs just the password checks (9).
const onlyPassword = args.includes('--only-password')
let f = null
if (!onlyPassword) {
// 1. Focus opens the keyboard.
f = await openField(field)
check('tap on the text field focuses it', !!f, show(f))
if (!f) {
  console.log(`${passes} passed, ${failures} failed`)
  process.exit(1)
}
await clearField()
await shot('lower')
f = await focused()
check('field clears with del', f && f.value === '', show(f))

// 2. Every lowercase key.
const lowerKeys = [...'qwertyuiop', ...'asdfghjkl', ...'_-zxcvbnm.,:']
for (const k of lowerKeys) {
  const before = await focused()
  await press(k)
  const after = await focused()
  check(`key ${JSON.stringify(k)} types it`, before && after && after.value === `${before.value}${k}`, show(after))
}

// 3. del removes the last character.
await press('del')
f = await focused()
check('del removes the character before the caret', f && f.value === lowerKeys.slice(0, -1).join(''), show(f))
await clearField()

// 4. ABC: upper case, then abc back.
await press('ABC')
mode = 'upper'
await shot('upper')
for (const k of [...'QWERTYUIOP', ...'ASDFGHJKL', ...'ZXCVBNM']) {
  const before = await focused()
  await press(k)
  const after = await focused()
  check(`upper key ${k}`, before && after && after.value === `${before.value}${k}`, show(after))
}
await press('abc')
mode = 'lower'
await press('q')
f = await focused()
check('abc returns to lower case', f && f.value.endsWith('q'), show(f))
await clearField()

// 5. 1#: numbers and symbols, then abc back.
await press('1#')
mode = 'special'
await shot('special')
for (const k of [...'1234567890', ...'+&/*=%!?#<>', ...'\\@$(){}[];"\'']) {
  const before = await focused()
  await press(k)
  const after = await focused()
  check(`symbol key ${JSON.stringify(k)}`, before && after && after.value === `${before.value}${k}`, show(after))
}
await press('del')
f = await focused()
check('del on the symbol layout', f && !f.value.endsWith("'") && f.value.endsWith('"'), show(f))
await press('abc')
mode = 'lower'
await clearField()

// 6. Space.
await typeSeq(['a', ' ', 'b'])
f = await focused()
check('space key', f && f.value === 'a b', show(f))

// 7. Arrows move the caret; typing and del act at the caret.
await press('left')
f = await focused()
check('left arrow moves the caret back one', f && f.caret === 2, show(f))
await press('left')
await press('x')
f = await focused()
check('typing inserts at the caret', f && f.value === 'ax b' && f.caret === 2, show(f))
await press('right')
f = await focused()
check('right arrow moves the caret on one', f && f.caret === 3, show(f))
await press('del')
f = await focused()
check('del deletes before the caret, mid-text', f && f.value === 'axb' && f.caret === 2, show(f))
for (let i = 0; i < 5; i++) await press('left')
f = await focused()
check('left arrow stops at the start', f && f.caret === 0, show(f))
for (let i = 0; i < 6; i++) await press('right')
f = await focused()
check('right arrow stops at the end', f && f.caret === 3, show(f))

// 8. Keys that close the keyboard.
for (const [key, name] of [['ret', 'return'], ['kb', 'keyboard'], ['ok', 'ok']]) {
  f = await openField(field)
  if (!f) {
    check(`${name} key closes the keyboard`, false, 'field did not refocus')
    continue
  }
  await press(key)
  await sleep(200)
  f = await focused()
  check(`${name} key closes the keyboard`, !f, show(f))
  // A key position must now hit the app, not a dead keyboard bound to no input.
  check(`${name} key leaves no keyboard on screen`, !(await keyboardUnder(centers.lower.get('q'))))
}
f = await openField(field)
check('the field refocuses after closing', !!f, show(f))
check('closing keeps the typed text', f && f.value === 'axb', show(f))
// The field's label: inert, and on screen while the keyboard is up.
const fieldNode = (await nodes()).find((n) => n.id === f?.id)
if (fieldNode) await tap(fieldNode.x + 4, fieldNode.y - 10)
await sleep(300)
f = await focused()
check('a tap outside the keyboard and inputs closes it', !f && !(await keyboardUnder(centers.lower.get('q'))), show(f))

}

// 9. Password masking.
if (password) {
  // The P4's UART console slows to seconds per reply after the hundred-odd
  // commands and screenshots above (its TX drains only as input arrives), and
  // these checks time a 1.5 s window: start them from a fresh boot.
  if (rebootAllowed && !onlyPassword) {
    await reboot()
    startBoxes = null
    fieldIds.clear()
  }
  f = await openField(password)
  check('tap on the password field focuses it', !!f, show(f))
  if (f) {
    await clearField()
    // The clear characters show for 1.5 s, and a read over this UART can take
    // seconds when it lands on the board's periodic perf dump. A read that
    // finished too late says nothing about the window: undo and try again.
    const kWindowMs = 1300
    async function typeAndRead(keys, undo) {
      let last = null
      for (let attempt = 0; attempt < 6; attempt++) {
        drainMaxMs = 200
        let elapsed
        try {
          const marks = []
          for (const k of keys) { const t = Date.now(); await press(k); marks.push(`${k}:${Date.now() - t}`) }
          const typedAt = Date.now() - 140 // tap() sleeps 140 ms after the ack
          last = await focused()
          elapsed = Date.now() - typedAt
          if (elapsed > kWindowMs) console.log(`(taps ${marks.join(' ')} read ${elapsed} ms, ${readAttempts} NODE attempts)`)
        } finally {
          drainMaxMs = 4000
        }
        if (elapsed <= kWindowMs) return { f: last, elapsed }
        console.log(`(read ${elapsed} ms after the tap: too late for the 1.5 s window, again)`)
        if (attempt === 5) break
        await sleep(1600)
        for (let i = 0; i < undo; i++) await press('del')
      }
      return { f: last, elapsed: -1 }
    }
    let r = await typeAndRead(['a', 'b'], 2)
    f = r.f
    check('password keeps the typed value', f && f.value === 'ab', show(f))
    check('password shows the characters just typed', r.elapsed >= 0 && f && f.text === 'ab', `${show(f)} read ${r.elapsed} ms after the tap`)
    await sleep(2000)
    f = await focused()
    check('password turns them into bullets after 1.5 s', f && f.text === '\u2022\u2022', show(f))
    r = await typeAndRead(['c'], 1)
    f = r.f
    check('password shows only the new character', r.elapsed >= 0 && f && f.text === '\u2022\u2022c', `${show(f)} read ${r.elapsed} ms after the tap`)
    await sleep(2000)
    // Screenshots last: one leaves the console slow for the timed reads.
    await shot('password-masked')
    await press('ok')
  }
}

if (!onlyPassword) {
// 10 (after the password: its screenshots leave the console slow, and the
// password checks time a 1.5 s window). Text longer than the field stays on one line
// inside the box, scrolled so the end (where the caret is) shows.
{
  f = await openField(field)
  if (f) {
    await clearField()
    const box = (await nodes()).find((n) => n.id === f.id)
    const before = await shot('long-empty', { force: true })
    const long = [...'abcdefghijklmnopqrstuvwxyzabcdefghij']
    await typeSeq(long)
    f = await focused()
    check('a long value is typed in full', f && f.value === long.join(''), show(f))
    const after = await shot('long-text', { force: true })
    const boxAfter = (await nodes()).find((n) => n.id === f.id)
    check('the field keeps its size with a long value', box && boxAfter && box.w === boxAfter.w && box.h === boxAfter.h,
      `${JSON.stringify(box)} -> ${JSON.stringify(boxAfter)}`)
    if (box && before && after) {
      const below = changedPixels(before, after, [box.x - 2, box.y + box.h + 1, box.x + box.w + 2, box.y + box.h + 14])
      const right = changedPixels(before, after, [box.x + box.w + 1, box.y - 2, box.x + box.w + 6, box.y + box.h + 2])
      check('no text drawn below the field (no second line)', below === 0, `${below} pixels changed`)
      check('no text drawn past the right edge', right === 0, `${right} pixels changed`)
      // The caret end: the right part of the box holds the last letters.
      const tail = changedPixels(before, after, [box.x + box.w - 40, box.y + 4, box.x + box.w - 4, box.y + box.h - 4])
      check('the end of the text (at the caret) is in view', tail > 20, `${tail} pixels changed in the right of the box`)
    }
    await press('left')
    for (let i = 0; i < long.length; i++) await press('left')
    const home = await shot('long-home', { force: true })
    if (box && home && before) {
      const head = changedPixels(before, home, [box.x + 4, box.y + 4, box.x + 40, box.y + box.h - 4])
      check('caret at the start scrolls the start into view', head > 20, `${head} pixels changed in the left of the box`)
      const below = changedPixels(before, home, [box.x - 2, box.y + box.h + 1, box.x + box.w + 2, box.y + box.h + 14])
      check('scrolled back: still nothing below the field', below === 0, `${below} pixels changed`)
    }
    await clearField()
    await press('ok')
  }
}

}

console.log(`\n${passes} passed, ${failures} failed${unackedTaps ? ` (${unackedTaps} taps not acknowledged)` : ''}`)
port.close()
process.exit(failures ? 1 : 0)
