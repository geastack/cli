import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { boardConfigTiers, boardConfigWritePath, loadBoardConfigWithOrigins } from '../src/boards/config.mjs'
import { discoverBoards, parseFieldValue, parsePong, setFieldPath } from '../src/commands/boards.mjs'
import { createContext } from '../src/context.mjs'
import { parseArgs } from '../src/args.mjs'
import { runGea } from '../src/gea.mjs'
import { capture, createFixture, readJson, writeJson } from './helpers/fixture.mjs'

function gea(args, fixture, extra = {}) {
  const out = capture()
  return runGea(args, { ...out.io, cwd: fixture.appDir, env: fixture.env, ...extra }).then((code) => ({ code, out: out.out.join('\n'), err: out.err.join('\n') }))
}

const homeFile = (fixture) => path.join(fixture.root, '.geastack', 'boards.json')
const projectFile = (fixture) => path.join(fixture.appDir, '.gea', 'boards.json')

test('aliases merge home under project, and nothing is read from an installed package', (t) => {
  const fixture = createFixture(t)
  writeJson(path.join(fixture.installed('targets'), 'boards.json'), { stale: { target: 'esp32-s3', adapter: 'esp32-idf' } })
  writeJson(projectFile(fixture), {
    amoled: { target: 'esp32-s3-touch-amoled-2.06', adapter: 'esp32-idf', transports: { usbSerial: { serial: 'PROJECT1' } } },
    bench: { target: 'rp2350-tufty-2350', adapter: 'rp2350-pico' }
  })
  const ctx = createContext(parseArgs([]), fixture.env, fixture.appDir)
  assert.deepEqual(boardConfigTiers(ctx).map((tier) => tier.scope), ['home', 'project'])

  const { boards, origins } = loadBoardConfigWithOrigins(ctx)
  assert.equal(boards.stale, undefined)
  assert.equal(boards.amoled.transports.usbSerial.serial, 'PROJECT1', 'project overrides home')
  assert.equal(origins.get('amoled'), projectFile(fixture))
  assert.equal(origins.get('tufty'), homeFile(fixture))
  assert.equal(origins.get('bench'), projectFile(fixture))

  // Writes: an existing alias is edited where it lives; a new one joins the
  // project when it has a config; --global/--project override both.
  assert.equal(boardConfigWritePath(ctx, { alias: 'tufty' }), homeFile(fixture))
  assert.equal(boardConfigWritePath(ctx, { alias: 'amoled' }), projectFile(fixture))
  assert.equal(boardConfigWritePath(ctx, { alias: 'new-one' }), projectFile(fixture))
  assert.equal(boardConfigWritePath(ctx, { scope: 'global', alias: 'amoled' }), homeFile(fixture))
  assert.equal(boardConfigWritePath(ctx, { scope: 'project', alias: 'tufty' }), projectFile(fixture))

  const explicit = createContext(parseArgs(['--boards-config', 'mine.json']), fixture.env, fixture.appDir)
  assert.deepEqual(boardConfigTiers(explicit), [{ scope: 'explicit', file: path.join(fixture.appDir, 'mine.json') }])
})

test('boards list, show, set, rename and remove edit the tier an alias lives in', async (t) => {
  const fixture = createFixture(t)
  writeJson(projectFile(fixture), { desk: { target: 'esp32-s3-touch-amoled-2.06', adapter: 'esp32-idf', transports: {} } })

  const listed = await gea(['boards', 'list'], fixture)
  assert.equal(listed.code, 0, listed.err)
  assert.match(listed.out, /^amoled\tesp32-s3-touch-amoled-2\.06  usb USB123  \[home\]$/m)
  assert.match(listed.out, /^desk\tesp32-s3-touch-amoled-2\.06  \[project\]$/m)

  const set = await gea(['boards', 'set', 'amoled', 'host', '192.168.1.100'], fixture)
  assert.equal(set.code, 0, set.err)
  assert.equal(readJson(homeFile(fixture)).amoled.transports.ota.host, '192.168.1.100')
  assert.equal(fs.existsSync(projectFile(fixture)) && readJson(projectFile(fixture)).amoled, undefined, 'edited in the home tier where it lives')

  const port = await gea(['boards', 'set', 'desk', 'transports.telnet.port', '2323'], fixture)
  assert.equal(port.code, 0, port.err)
  assert.deepEqual(readJson(projectFile(fixture)).desk.transports.telnet, { port: 2323 })

  const unset = await gea(['boards', 'set', 'desk', 'transports.telnet.port', ''], fixture)
  assert.equal(unset.code, 0, unset.err)
  assert.equal(readJson(projectFile(fixture)).desk.transports.telnet, undefined, 'an empty value removes the key and its empty parent')

  const moved = await gea(['boards', 'set', 'amoled', 'restart', 'manual', '--local'], fixture)
  assert.equal(moved.code, 0, moved.err)
  const projectAmoled = readJson(projectFile(fixture)).amoled
  assert.equal(projectAmoled.transports.usbSerial.serial, 'USB123', 'a tier move copies the whole merged entry')
  assert.equal(projectAmoled.transports.usbSerial.restartAfterFlash, 'manual')
  assert.equal(readJson(homeFile(fixture)).amoled.transports.usbSerial.restartAfterFlash, undefined)

  const shown = await gea(['boards', 'show', 'amoled', '--json'], fixture)
  assert.equal(JSON.parse(shown.out).amoled.transports.usbSerial.restartAfterFlash, 'manual', 'show reads the merged view')

  const renamed = await gea(['boards', 'rename', 'desk', 'desk-2'], fixture)
  assert.equal(renamed.code, 0, renamed.err)
  assert.equal(readJson(projectFile(fixture)).desk, undefined)
  assert.equal(readJson(projectFile(fixture))['desk-2'].target, 'esp32-s3-touch-amoled-2.06')

  await assert.rejects(gea(['boards', 'rename', 'desk-2', 'tufty'], fixture), /already exists/)

  const removed = await gea(['boards', 'remove', 'amoled'], fixture)
  assert.equal(removed.code, 0, removed.err)
  assert.equal(readJson(projectFile(fixture)).amoled, undefined)
  assert.equal(readJson(homeFile(fixture)).amoled, undefined, 'remove without a scope clears every tier')

  await assert.rejects(gea(['boards', 'set', 'nope', 'host', '1.2.3.4'], fixture), /Unknown board 'nope'/)
})

test('a project without any config lists the files it looked in', async (t) => {
  const fixture = createFixture(t)
  fs.rmSync(homeFile(fixture))
  const listed = await gea(['boards', 'list'], fixture)
  assert.equal(listed.code, 0, listed.err)
  assert.match(listed.out, /No boards configured/)
  assert.match(listed.out, new RegExp(`${homeFile(fixture).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(missing\\)`))
})

test('discover pairs USB devices with aliases by serial and reports what each answers', async (t) => {
  const fixture = createFixture(t)
  const env = { ...fixture.env, GEA_SERIAL_DEVICES: '/dev/cu.usbmodem101|ESP32-S3|USB123,/dev/cu.usbmodem102|ESP32-S3|AA:BB:CC:DD:EE:FF,/dev/cu.usbmodem103' }
  const replies = {
    '/dev/cu.usbmodem101': { ok: true, app: 'weather', ip: '192.168.1.100', mac: 'USB123' },
    '/dev/cu.usbmodem102': { ok: true, app: 'tetris', ip: '', mac: 'AA:BB:CC:DD:EE:FF' },
    '/dev/cu.usbmodem103': { ok: false, error: 'timed out' }
  }
  const probeSerialDevice = async (device) => replies[device.path]

  const found = await gea(['boards', 'discover', '--json'], fixture, { env, probeSerialDevice })
  assert.equal(found.code, 0, found.err)
  const results = JSON.parse(found.out)
  assert.equal(results.length, 3)
  assert.equal(results[0].alias, 'amoled')
  assert.equal(results[0].app, 'weather')
  assert.equal(results[0].ip, '192.168.1.100')
  assert.equal(results[1].alias, '', 'an unregistered board is reported, not guessed')
  assert.equal(results[2].responds, false)

  const text = await gea(['boards', 'discover'], fixture, { env, probeSerialDevice })
  assert.match(text.out, /amoled \(esp32-s3-touch-amoled-2\.06\).*app weather.*ip 192\.168\.1\.100/)
  assert.match(text.out, /gea boards set amoled host 192\.168\.1\.100/)
  assert.match(text.out, /register it: gea boards add {3}\(USB serial AA:BB:CC:DD:EE:FF, running tetris\)/)
  assert.match(text.out, /usbmodem103.*no GEADEV reply/)

  const saved = await gea(['boards', 'discover', '--save'], fixture, { env, probeSerialDevice })
  assert.equal(saved.code, 0, saved.err)
  assert.equal(readJson(homeFile(fixture)).amoled.transports.ota.host, '192.168.1.100')
})

test('discovery matches the PONG mac when the port enumerates without a serial, and the field helpers parse values', async () => {
  const results = await discoverBoards({
    devices: [{ path: '/dev/ttyACM0', serial: '' }],
    boards: { desk: { target: 'esp32-s3', transports: { usbSerial: { serial: '80:b5:4e:da:73:88' } } } },
    probe: async () => ({ ok: true, app: 'watch', ip: '', mac: '80:B5:4E:DA:73:88' })
  })
  assert.equal(results[0].alias, 'desk')
  assert.equal(results[0].serial, '80:B5:4E:DA:73:88')

  assert.deepEqual(parsePong('GEADEV:PONG app=weather ip=0.0.0.0 mac=80:B5:4E:DA:73:88'), { app: 'weather', ip: '', mac: '80:B5:4E:DA:73:88' })
  assert.deepEqual(parsePong('GEADEV:PONG app=tetris'), { app: 'tetris', ip: '', mac: '' })
  assert.equal(parseFieldValue('2323'), 2323)
  assert.equal(parseFieldValue('true'), true)
  assert.equal(parseFieldValue('192.168.1.100'), '192.168.1.100')
  assert.equal(parseFieldValue('80:B5:4E:DA:73:88'), '80:B5:4E:DA:73:88')
  assert.equal(parseFieldValue(''), undefined)
  assert.deepEqual(setFieldPath({ target: 't', transports: { ota: { host: 'x' } } }, 'transports.ota.host', undefined), { target: 't', transports: {} })
})
