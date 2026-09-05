import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CliError, ExitCode } from '../src/errors.mjs'
import { runGea } from '../src/gea.mjs'
import { capture, createFakeToolchain, createFixture, readJson, scriptedPrompt, writeJson } from './helpers/fixture.mjs'

test('help, version, and unknown command behavior are stable', async () => {
  const help = capture()
  assert.equal(await runGea(['help'], help.io), 0)
  assert.match(help.out.join('\n'), /gea doctor/)

  const version = capture()
  assert.equal(await runGea(['--version'], version.io), 0)
  assert.match(version.out[0], /^\d+\.\d+\.\d+$/)

  const unknown = capture()
  assert.equal(await runGea(['nope'], unknown.io), 1)
  assert.match(unknown.err.join('\n'), /Unknown command: nope/)
})

test('gea create scaffolds and installs through the main CLI', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-main-create-'))
  const out = capture()

  assert.equal(await runGea([
    'create', 'Panel',
    '--dir', path.join(tmp, 'panel'),
    '--starter', 'empty',
    '--targets', 'esp32',
    '--dry-run'
  ], { ...out.io, cwd: tmp }), 0)

  assert.match(out.out.join('\n'), /npm install/)
  assert.equal(readJson(path.join(tmp, 'panel/package.json')).gea.targets.esp32, true)
})

test('gea create help presents the guided command', async () => {
  const out = capture()

  assert.equal(await runGea(['create', '--help'], out.io), 0)
  assert.match(out.out.join('\n'), /gea create <name>/)
  assert.match(out.out.join('\n'), /Run without options for guided setup/)
})

test('list and inspect use the current npm project', async (t) => {
  const fixture = createFixture(t)

  const apps = capture()
  await runGea(['list', 'apps'], { ...apps.io, cwd: fixture.root })
  assert.deepEqual(apps.out, ['bad-app', 'watch', 'web-only'])

  const targets = capture()
  await runGea(['list', 'targets'], { ...targets.io, cwd: fixture.root })
  assert.deepEqual(targets.out, ['esp32-s3-touch-amoled-2.06', 'geaos', 'rp2350-tufty-2350'])

  const boards = capture()
  await runGea(['list', 'boards', '--json'], { ...boards.io, cwd: fixture.root })
  assert.equal(JSON.parse(boards.out.join('\n')).amoled.target, 'esp32-s3-touch-amoled-2.06')

  const current = capture()
  await runGea(['inspect', '--json'], { ...current.io, cwd: path.join(fixture.appDir, 'nested') })
  const app = JSON.parse(current.out.join('\n'))
  assert.equal(app.id, 'watch')
  assert.equal(app.entry, 'index.tsx')
})

test('embedded build delegates to the installed targets package', async (t) => {
  const fixture = createFixture(t)
  const out = capture()
  await runGea(['build', '--board=amoled', '--dry-run'], {
    ...out.io,
    cwd: fixture.appDir
  })

  const command = out.out.join('\n')
  assert.match(command, new RegExp(`${escapeRegex(fixture.installed('targets'))}/scripts/board build`))
  assert.match(command, /--board=amoled --app=watch/)
})

test('flash, monitor, and BLE OTA delegate all board options', async (t) => {
  const fixture = createFixture(t)

  const flash = capture()
  await runGea(['flash', '--board=amoled', '--port=/dev/cu.usb', '--monitor', '--dry-run', '--', '--manual-boot'], {
    ...flash.io,
    cwd: fixture.appDir
  })
  assert.match(flash.out.join('\n'), /board flash-monitor --board=amoled --app=watch \/dev\/cu\.usb --manual-boot/)

  const monitor = capture()
  await runGea(['monitor', '--board=amoled', '--port=auto', '--dry-run'], { ...monitor.io, cwd: fixture.appDir })
  assert.match(monitor.out.join('\n'), /board monitor --board=amoled auto/)

  const ota = capture()
  await runGea(['ota', '--board=amoled', '--transport=ble', '--dry-run'], { ...ota.io, cwd: fixture.appDir })
  assert.match(ota.out.join('\n'), /board ble-ota --board=amoled --app=watch/)
})

test('setup routes known targets and can write a local board alias', async (t) => {
  const fixture = createFixture(t)
  const routed = capture()
  await runGea(['setup', '--board=amoled', '--dry-run'], { ...routed.io, cwd: fixture.appDir })
  assert.match(routed.out.join('\n'), /board setup --board=amoled/)

  const out = capture()
  const prompt = scriptedPrompt(['1', '1', 'desk-amoled', '1', '', '', 'y', 'n'])
  await runGea(['setup', '--dry-run'], {
    ...out.io,
    prompt,
    cwd: fixture.appDir,
    env: { ...process.env, GEA_SERIAL_DEVICES: '/dev/cu.usbmodem101|ESP32-S3 USB/JTAG|USB123' }
  })

  const boards = readJson(path.join(fixture.appDir, '.gea/boards.json'))
  assert.equal(boards['desk-amoled'].target, 'esp32-s3-touch-amoled-2.06')
  assert.equal(boards['desk-amoled'].transports.usbSerial.serial, 'USB123')
  assert.match(out.out.join('\n'), /Ready: npx gea flash --board desk-amoled --monitor/)
})

test('build rejects invalid manifests and incompatible boards', async (t) => {
  const fixture = createFixture(t)

  await assert.rejects(
    runGea(['build', '--target=web', '--dry-run'], { ...capture().io, cwd: fixture.badAppDir }),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /gea.entry does not exist/.test(error.message)
  )
  await assert.rejects(
    runGea(['build', '--board=amoled', '--dry-run'], { ...capture().io, cwd: path.join(fixture.root, 'apps/web-only') }),
    (error) => error instanceof CliError && error.exitCode === ExitCode.targetUnavailable
  )
  await assert.rejects(
    runGea(['ota', '--board=amoled', '--transport=serial'], { ...capture().io, cwd: fixture.appDir }),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /transport/.test(error.message)
  )
})

test('doctor requires npm packages and the board adapter, while platform tools are optional', async (t) => {
  const fixture = createFixture(t)
  const tools = createFakeToolchain(t)
  const out = capture()
  const code = await runGea(['doctor', '--json'], { ...out.io, cwd: fixture.appDir, env: tools.env })
  const result = JSON.parse(out.out.join('\n'))

  assert.equal(code, 0)
  assert.equal(result.ok, true)
  assert.equal(result.checks.find((check) => check.name === '@geastack/targets').ok, true)
  assert.equal(result.checks.find((check) => check.name === 'board script').ok, true)
})

test('doctor fails closed for invalid board configuration', async (t) => {
  const fixture = createFixture(t, { invalidBoardsJson: true })
  const out = capture()
  const code = await runGea(['doctor', '--json'], { ...out.io, cwd: fixture.root, env: { PATH: '' } })
  assert.equal(code, ExitCode.missingDependency)
  assert.equal(JSON.parse(out.out.join('\n')).ok, false)
})

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
