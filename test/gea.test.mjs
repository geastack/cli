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
  assert.match(help.out.join('\n'), /gea ota/)
  assert.match(help.out.join('\n'), /gea devctl/)

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

test('apps, targets and boards are listed from the current npm project', async (t) => {
  const fixture = createFixture(t)

  const apps = capture()
  await runGea(['apps', 'list'], { ...apps.io, cwd: fixture.root })
  assert.deepEqual(apps.out, ['bad-app', 'watch', 'web-only'])

  const esp32Apps = capture()
  await runGea(['apps', 'list', '--target', 'esp32'], { ...esp32Apps.io, cwd: fixture.root })
  assert.deepEqual(esp32Apps.out, ['watch'])

  const targets = capture()
  await runGea(['targets', 'list'], { ...targets.io, cwd: fixture.root })
  assert.deepEqual(targets.out.map((line) => line.split('\t')[0]), ['esp32-s3', 'esp32-s3-touch-amoled-2.06', 'geaos', 'rp2350-tufty-2350'])
  assert.match(targets.out[1], new RegExp(`\tesp32-idf\t${escapeRegex(fixture.esp32Target)}$`))

  const boards = capture()
  await runGea(['boards', 'list', '--json'], { ...boards.io, cwd: fixture.root, env: fixture.env })
  assert.equal(JSON.parse(boards.out.join('\n')).amoled.target, 'esp32-s3-touch-amoled-2.06')

  const current = capture()
  await runGea(['apps', 'inspect', '--json'], { ...current.io, cwd: path.join(fixture.appDir, 'nested') })
  const app = JSON.parse(current.out.join('\n'))
  assert.equal(app.id, 'watch')
  assert.equal(app.entry, 'index.tsx')
  assert.equal(app.root, '.', 'roots are relative to the project the command runs in')

  const fromRoot = capture()
  await runGea(['apps', 'inspect', 'watch', '--json'], { ...fromRoot.io, cwd: fixture.root })
  assert.equal(JSON.parse(fromRoot.out.join('\n')).root, 'apps/watch')

  const shell = capture()
  await runGea(['apps', 'inspect', 'watch', '--format', 'shell'], { ...shell.io, cwd: fixture.root })
  assert.deepEqual(shell.out, ['apps/watch\tindex.tsx\tgea\tWatch'], 'the tab-separated form the Apple build scripts parse')

  const cmake = capture()
  await runGea(['apps', 'inspect', 'watch', '--format', 'cmake'], { ...cmake.io, cwd: fixture.root })
  assert.deepEqual(cmake.out, ['apps/watch;index.tsx;gea'])

  const legacy = capture()
  await runGea(['list', 'apps'], { ...legacy.io, cwd: fixture.root })
  assert.deepEqual(legacy.out, ['bad-app', 'watch', 'web-only'])
})

test('chips catalog can compose and edit an app-local custom board', async (t) => {
  const fixture = createFixture(t)
  const definitionPath = path.join(fixture.appDir, '.gea/targets/my-board.json')
  writeJson(definitionPath, {
    id: 'my-board',
    extends: 'esp32-s3',
    adapter: 'esp32-idf',
    mcu: 'esp32s3',
    buses: {},
    chips: {}
  })
  writeJson(path.join(fixture.appDir, '.gea/boards.json'), {
    'my-board': {
      target: 'my-board',
      targetDefinition: 'targets/my-board.json',
      appPlatform: 'esp32'
    }
  })

  const listed = capture()
  await runGea(['chips', 'list'], { ...listed.io, cwd: fixture.appDir })
  assert.match(listed.out.join('\n'), /co5300\tdisplay/)

  const added = capture()
  await runGea([
    'chips', 'add', 'co5300', '--board', 'my-board',
    '--set', 'co5300.width=410',
    '--set', 'co5300.height=502',
    '--set', 'co5300.pins.cs=12',
    '--set', 'co5300.pins.pclk=11',
    '--set', 'co5300.pins.data0=4',
    '--set', 'co5300.pins.data1=5',
    '--set', 'co5300.pins.data2=6',
    '--set', 'co5300.pins.data3=7',
    '--set', 'co5300.pins.reset=8'
  ], { ...added.io, cwd: fixture.appDir })
  let definition = readJson(definitionPath)
  assert.deepEqual(definition.chips.display, {
    driver: 'co5300',
    interface: 'qspi',
    width: 410,
    height: 502,
    spiHost: 'spi2',
    pins: { cs: 12, pclk: 11, data0: 4, data1: 5, data2: 6, data3: 7, reset: 8, te: null }
  })

  const prompt = scriptedPrompt(['15', '14', '9', '38'])
  await runGea(['chips', 'add', 'ft3168', '--board', 'my-board'], {
    ...capture().io,
    prompt,
    cwd: fixture.appDir
  })
  definition = readJson(definitionPath)
  assert.deepEqual(definition.buses.i2c, { sda: 15, scl: 14 })
  assert.equal(definition.chips.touch.driver, 'ft3168')
  assert.equal(definition.chips.touch.pins.interrupt, 38)

  await runGea(['chips', 'remove', 'ft3168', '--board', 'my-board'], { ...capture().io, cwd: fixture.appDir })
  definition = readJson(definitionPath)
  assert.equal(definition.chips.touch, undefined)

  await assert.rejects(
    runGea([
      'chips', 'add', 'ft3168', '--board', 'my-board',
      '--set', 'i2c.sda=15',
      '--set', 'i2c.scl=14',
      '--set', 'ft3168.pins.reset=12',
      '--set', 'ft3168.pins.interrupt=38'
    ], { ...capture().io, cwd: fixture.appDir }),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /GPIO 12 is assigned/.test(error.message)
  )
  definition = readJson(definitionPath)
  assert.equal(definition.chips.touch, undefined)

  await assert.rejects(
    runGea(['chips', 'add', 'rm690b0', '--board', 'my-board'], { ...capture().io, cwd: fixture.appDir }),
    (error) => error instanceof CliError && error.exitCode === ExitCode.targetUnavailable
  )
})

function gea(args, fixture, extra = {}) {
  const out = capture()
  return runGea(args, { ...out.io, cwd: fixture.appDir, env: fixture.env, ...extra }).then((code) => ({ code, out: out.out.join('\n'), err: out.err.join('\n') }))
}

test('build configures and builds the app in its own ESP-IDF build directory', async (t) => {
  const fixture = createFixture(t)
  const buildDir = fixture.buildDir('esp32-s3-touch-amoled-2.06', 'watch')

  const dry = await gea(['build', '--board', 'amoled', '--dry-run'], fixture)
  assert.equal(dry.code, 0)
  const python = path.join(fixture.env.IDF_PYTHON_ENV_PATH, 'bin/python')
  assert.match(dry.out, new RegExp(`^${escapeRegex(python)} ${escapeRegex(fixture.env.IDF_PATH)}/tools/idf.py -G Ninja -B ${escapeRegex(buildDir)} -DSDKCONFIG=${escapeRegex(buildDir)}/sdkconfig -DSDKCONFIG_DEFAULTS=${escapeRegex(fixture.esp32Target)}/sdkconfig.defaults -DIDF_TARGET=esp32s3 -DGEA_APPS_ROOT=${escapeRegex(fixture.appDir)} -DGEA_EMBEDDED_APP=watch '-DGEA_EMBEDDED_APP_META=.;index.tsx;gea' -DGEA_EMBEDDED_CAPABILITY_NETWORK=1 -DGEA_EMBEDDED_CAPABILITY_BLE=0 -DGEA_EMBEDDED_CAPABILITY_AUDIO=1 reconfigure$`, 'm'))
  assert.match(dry.out, new RegExp(`^cmake --build ${escapeRegex(buildDir)} --parallel 8$`, 'm'))
  assert.doesNotMatch(dry.out, /--ccache/, 'ccache is only passed when it is on PATH')
  assert.equal(fs.existsSync(path.join(buildDir, 'CMakeCache.txt')), false, 'dry-run never configures')
  // Preparation still happens in dry-run so the printed command is real.
  assert.match(fs.readFileSync(path.join(buildDir, 'sdkconfig'), 'utf8'), /^CONFIG_ESP_MAIN_TASK_STACK_SIZE=32768$/m)
  assert.match(fs.readFileSync(path.join(buildDir, 'apps/watch/wifi_config.h'), 'utf8'), /GEA_EMBEDDED_WIFI_EARLY_CONNECT 0/)

  const real = await gea(['build', '--board', 'amoled'], fixture)
  assert.equal(real.code, 0, real.err)
  const calls = fixture.calls()
  const configure = calls.find((line) => / reconfigure$/.test(line))
  assert.ok(configure, `expected a reconfigure call, got:\n${calls.join('\n')}`)
  assert.match(configure, /-DGEA_EMBEDDED_APP=watch/)
  assert.ok(calls.some((line) => line === `cmake --build ${buildDir} --parallel 8`), calls.join('\n'))
  assert.ok(fs.existsSync(path.join(buildDir, 'gea_embedded.bin')))
  assert.equal(fs.readFileSync(path.join(buildDir, '.gea-configure-args'), 'utf8').includes('-DGEA_EMBEDDED_APP=watch'), true)

  // A second build with the same inputs skips reconfigure entirely.
  fs.rmSync(fixture.callLog)
  const again = await gea(['build', '--board', 'amoled', '--jobs', '2'], fixture, { env: { ...fixture.env, GEA_IDF_JOBS: '2' } })
  assert.equal(again.code, 0)
  const second = fixture.calls().filter((line) => !line.includes('idf_tools.py export') && !line.startsWith('compiler '))
  assert.deepEqual(second, [`cmake --build ${buildDir} --parallel 2`])
})

test('flash writes bootloader, app, partition table and otadata over USB and then monitors', async (t) => {
  const fixture = createFixture(t)
  const buildDir = fixture.buildDir('esp32-s3-touch-amoled-2.06', 'watch')
  assert.equal((await gea(['build', '--board', 'amoled'], fixture)).code, 0)

  const dry = await gea(['flash', '--board', 'amoled', '--dry-run'], fixture)
  assert.equal(dry.code, 0, dry.err)
  assert.match(dry.out, /USB flash attempt 1 on <usb serial USB123>/)
  const esptool = dry.out.split('\n').find((line) => line.includes('-m esptool'))
  assert.ok(esptool, dry.out)
  assert.match(esptool, /-m esptool -p '<usb serial USB123>' --chip esp32s3 --before default_reset --after hard_reset -b 921600 write_flash --flash_mode dio --flash_freq 80m --flash_size 16MB/)
  assert.match(esptool, new RegExp(`0x0 ${escapeRegex(buildDir)}/bootloader/bootloader.bin 0x10000 ${escapeRegex(buildDir)}/gea_embedded.bin 0x8000 ${escapeRegex(buildDir)}/partition_table/partition-table.bin 0xd000 ${escapeRegex(buildDir)}/ota_data_initial.bin`))

  const options = await gea(['flash', '--board', 'amoled', '--port', fixture.fakePort, '--manual-boot', '--no-reset', '--flash-baud', '460800', '--dry-run'], fixture)
  assert.equal(options.code, 0, options.err)
  assert.match(options.out, /Manual boot mode: hold BOOT/)
  assert.match(options.out, new RegExp(`-p ${escapeRegex(fixture.fakePort)} --chip esp32s3 --before no_reset --after no_reset -b 460800 write_flash`))

  const manual = await gea(['flash', '--board', 'amoled-manual', '--dry-run'], fixture)
  assert.match(manual.err, /power-cycle/i)

  const real = await gea(['flash', '--board', 'amoled', '--port', fixture.fakePort, '--no-build'], fixture)
  assert.equal(real.code, 0, real.err)
  const call = fixture.calls().find((line) => line.includes('-m esptool'))
  assert.ok(call, fixture.calls().join('\n'))
  assert.match(call, new RegExp(`^python -m esptool -p ${escapeRegex(fixture.fakePort)} --chip esp32s3 --before default_reset --after hard_reset -b 921600 write_flash`))

  const monitor = await gea(['run', '--board', 'amoled', '--dry-run'], fixture)
  assert.equal(monitor.code, 0, monitor.err)
  assert.match(monitor.out, /-m esptool/)
  assert.match(monitor.out, /\[dry-run\] usb device: usb serial USB123/)
})

test('flash slot management: erase, stage into a slot, and restore boot metadata', async (t) => {
  const fixture = createFixture(t)
  const image = path.join(fixture.root, 'other.bin')
  fs.writeFileSync(image, 'x')

  const erase = await gea(['flash', '--board', 'amoled', '--erase-slot', 'ota_1', '--dry-run'], fixture)
  assert.equal(erase.code, 0, erase.err)
  assert.match(erase.out, /erase_region 0x210000 2097152/)

  const stage = await gea(['flash', '--board', 'amoled', '--image', image, '--slot', '1', '--dry-run'], fixture)
  assert.equal(stage.code, 0, stage.err)
  assert.match(stage.out, new RegExp(`write_flash --flash_mode dio --flash_freq 80m --flash_size 16MB 0x210000 ${escapeRegex(image)}`))

  const built = await gea(['build', '--board', 'amoled'], fixture)
  assert.equal(built.code, 0, built.err)
  const restore = await gea(['flash', '--board', 'amoled', '--restore-boot', '--dry-run'], fixture)
  assert.equal(restore.code, 0, restore.err)
  assert.match(restore.out, /write_flash .* 0xd000 .*ota_data_initial\.bin$/m)
  assert.doesNotMatch(restore.out, /gea_embedded\.bin/)
})

test('ota uploads the built image over WiFi and BLE OTA runs the swift helper', async (t) => {
  const fixture = createFixture(t)
  const buildDir = fixture.buildDir('esp32-s3-touch-amoled-2.06', 'watch')
  assert.equal((await gea(['build', '--board', 'amoled'], fixture)).code, 0)

  const wifi = await gea(['ota', '--board', 'amoled-wifi', '--dry-run'], fixture)
  assert.equal(wifi.code, 0, wifi.err)
  assert.match(wifi.out, new RegExp(`^POST http://10\\.0\\.0\\.5:8080/ota <- ${escapeRegex(buildDir)}/gea_embedded\\.bin$`, 'm'))

  const host = await gea(['ota', '--board', 'amoled', '--host', '10.0.0.9', '--slot', 'ota_1', '--boot', '--dry-run'], fixture)
  assert.equal(host.code, 0, host.err)
  assert.match(host.out, /http:\/\/10\.0\.0\.9:8080\/ota\?slot=ota_1&boot=1&reboot=0/)

  await assert.rejects(gea(['ota', '--board', 'amoled', '--dry-run'], fixture), /transports\.ota\.host/)

  const ble = await gea(['ota', '--board', 'amoled', '--transport', 'ble', '--dry-run'], fixture)
  assert.equal(ble.code, 0, ble.err)
  assert.match(ble.out, /-DGEA_EMBEDDED_CAPABILITY_BLE=1/)
  assert.match(ble.out, new RegExp(`swift .*src/ble/ble-ota\\.swift ${escapeRegex(buildDir)}/gea_embedded\\.bin`))
})

test('logs and screenshots pick WiFi when the board has an address, USB otherwise', async (t) => {
  const fixture = createFixture(t)

  const explicit = await gea(['logs', '--board', 'amoled', '--host', '10.0.0.5', '--follow', '--dry-run'], fixture)
  assert.match(explicit.out, /\[dry-run\] wifi device: 10\.0\.0\.5/)

  const auto = await gea(['logs', '--board', 'amoled-wifi', '--dry-run'], fixture)
  assert.match(auto.out, /\[dry-run\] wifi device: 10\.0\.0\.5/)

  const shot = await gea(['screenshot', 'shot.png', '--board', 'amoled-wifi', '--dry-run'], fixture)
  assert.match(shot.out, /\[dry-run\] wifi device: 10\.0\.0\.5/)

  const serial = await gea(['screenshot', 'shot.png', '--board', 'amoled', '--dry-run'], fixture)
  assert.match(serial.out, /\[dry-run\] usb device: usb serial USB123/)

  const forced = await gea(['logs', '--board', 'amoled-wifi', '--transport', 'usb', '--dry-run'], fixture)
  assert.match(forced.out, /\[dry-run\] usb device: usb serial USB123/)

  const hbm = await gea(['devctl', 'hbm', 'on', '--board', 'amoled-wifi', '--dry-run'], fixture)
  assert.match(hbm.out, /\[dry-run\] wifi device: 10\.0\.0\.5/)

  await assert.rejects(gea(['logs', '--board', 'amoled', '--transport', 'ble'], fixture), (error) => error instanceof CliError && error.exitCode === ExitCode.usage)
  await assert.rejects(gea(['logs'], fixture), /--board/)
})

test('rp2350 boards build with the Pico SDK toolchain and flash a UF2', async (t) => {
  const fixture = createFixture(t)
  const dry = await gea(['build', '--board', 'tufty', '--dry-run'], fixture, { env: { ...fixture.env, PICO_SDK_PATH: '/pico-sdk', PICO_TOOLCHAIN_PATH: '/arm' } })
  assert.equal(dry.code, 0, dry.err)
  assert.match(dry.out, new RegExp(`^${escapeRegex(fixture.env.PATH.split(path.delimiter)[0])}/cmake -S ${escapeRegex(fixture.installed('targets'))}/targets/rp2350-tufty-2350 -B ${escapeRegex(fixture.appDir)}/.gea/build/rp2350-tufty-2350 -DGEA_EMBEDDED_APP=watch '-DGEA_EMBEDDED_APP_META=.;index.tsx;gea'$`, 'm'))
  assert.match(dry.out, /cmake --build .*rp2350-tufty-2350 --target gea_rp2350_tufty_2350_app$/m)
})

test('setup builds a known target in configure-only mode and can write a local board alias', async (t) => {
  const fixture = createFixture(t)
  const routed = await gea(['setup', '--board', 'amoled', '--dry-run'], fixture)
  assert.equal(routed.code, 0, routed.err)
  assert.match(routed.out, /Configuring target esp32s3/)
  assert.match(routed.out, /idf\.py .* reconfigure$/m)
  assert.doesNotMatch(routed.out, /cmake --build/)

  const out = capture()
  const prompt = scriptedPrompt(['1', '1', 'desk-amoled', '1', '', '', 'y', 'n'])
  await runGea(['setup', '--dry-run'], {
    ...out.io,
    prompt,
    cwd: fixture.appDir,
    env: { ...fixture.env, GEA_SERIAL_DEVICES: '/dev/cu.usbmodem101|ESP32-S3 USB/JTAG|USB123' }
  })

  // The fixture project has no .gea/boards.json, so a new alias joins the
  // machine-wide config in HOME.
  assert.equal(fs.existsSync(path.join(fixture.appDir, '.gea/boards.json')), false)
  const boards = readJson(path.join(fixture.root, '.geastack/boards.json'))
  assert.equal(boards['desk-amoled'].target, 'esp32-s3-touch-amoled-2.06')
  assert.equal(boards['desk-amoled'].transports.usbSerial.serial, 'USB123')
  assert.equal(boards.amoled.target, 'esp32-s3-touch-amoled-2.06', 'existing home aliases survive')
  assert.match(out.out.join('\n'), /Ready: npx gea flash --board desk-amoled --monitor/)
})

test('custom setup composes a flash-ready target from the chip catalog', async (t) => {
  const fixture = createFixture(t)
  const tools = createFakeToolchain(t)
  // A generated project carries an (empty) .gea/boards.json, so the custom
  // board and its target definition are written next to it.
  writeJson(path.join(fixture.appDir, '.gea/boards.json'), {})
  const out = capture()
  const prompt = scriptedPrompt([
    '2', 'from-scratch', '1',
    '1', '410', '502', '1', '12', '11', '4', '5', '6', '7', '8', '13',
    '1', '15', '14', '9', '38',
    '1',
    '1',
    '1', '16', '41', '45', '40', '42', '46',
    'y', '2', '1', '3',
    'y', '0', '1',
    '1', '',
    'y'
  ])
  await runGea(['setup', '--dry-run'], {
    ...out.io,
    prompt,
    cwd: fixture.appDir,
    env: { ...tools.env, ...fixture.env, PATH: `${tools.bin}${path.delimiter}${fixture.env.PATH}`, GEA_SERIAL_DEVICES: '/dev/cu.usbmodem101|ESP32-S3 USB/JTAG|USB123' }
  })

  const boards = readJson(path.join(fixture.appDir, '.gea/boards.json'))
  assert.equal(boards['from-scratch'].target, 'from-scratch')
  assert.equal(boards['from-scratch'].targetDefinition, 'targets/from-scratch.json')
  assert.equal(boards['from-scratch'].transports.usbSerial.serial, 'USB123')

  const definition = readJson(path.join(fixture.appDir, '.gea/targets/from-scratch.json'))
  assert.equal(definition.extends, 'esp32-s3')
  assert.equal(definition.chips.display.driver, 'co5300')
  assert.equal(definition.chips.touch.driver, 'ft3168')
  assert.equal(definition.chips.power.driver, 'axp2101')
  assert.equal(definition.chips.imu.driver, 'qmi8658')
  assert.equal(definition.chips.audio.driver, 'es8311')
  assert.deepEqual(definition.buses.i2c, { sda: 15, scl: 14 })
  assert.deepEqual(definition.storage.microSD.pins, { clk: 2, cmd: 1, data0: 3 })
  assert.equal(definition.controls.launcherButton.pin, 0)
  assert.match(out.out.join('\n'), /Ready: npx gea flash --board from-scratch --monitor/)

  // The custom target is materialized into the build directory and handed to CMake.
  const built = await gea(['build', '--board', 'from-scratch', '--dry-run'], fixture)
  assert.equal(built.code, 0, built.err)
  const customDir = path.join(fixture.appDir, '.gea/build/from-scratch/app-builds/watch/gea-custom-target')
  assert.match(built.out, new RegExp(`-DGEA_BOARD_DEFINITION=${escapeRegex(path.join(fixture.appDir, '.gea/targets/from-scratch.json'))} -DGEA_CUSTOM_TARGET_DIR=${escapeRegex(customDir)}`))
  assert.match(fs.readFileSync(path.join(customDir, 'board.h'), 'utf8'), /\.cs = GPIO_NUM_12/)
  assert.match(fs.readFileSync(path.join(customDir, 'target.cmake'), 'utf8'), /GEA_EMBEDDED_DISPLAY_WIDTH=410/)
})

test('build rejects invalid manifests, incompatible boards, and platform names', async (t) => {
  const fixture = createFixture(t)

  await assert.rejects(
    gea(['build', '--board', 'amoled', '--dry-run'], fixture, { cwd: fixture.badAppDir }),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /gea.entry does not exist/.test(error.message)
  )
  await assert.rejects(
    gea(['build', '--board', 'amoled', '--dry-run'], fixture, { cwd: path.join(fixture.root, 'apps/web-only') }),
    (error) => error instanceof CliError && error.exitCode === ExitCode.targetUnavailable
  )
  await assert.rejects(
    gea(['ota', '--board', 'amoled', '--transport', 'serial'], fixture),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /transport/.test(error.message)
  )
  await assert.rejects(
    gea(['build', '--target', 'web', '--dry-run'], fixture),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /web build is not driven by gea/.test(error.message)
  )
  await assert.rejects(
    gea(['build', '--board', 'amoled', '--dry-run'], fixture, { env: { ...fixture.env, IDF_PATH: '', IDF_PYTHON_ENV_PATH: '', HOME: fixture.root } }),
    (error) => error instanceof CliError && error.exitCode === ExitCode.missingDependency && /ESP-IDF/.test(error.message)
  )
})

test('doctor requires npm packages while platform tools are optional', async (t) => {
  const fixture = createFixture(t)
  const tools = createFakeToolchain(t)
  const out = capture()
  const code = await runGea(['doctor', '--json'], { ...out.io, cwd: fixture.appDir, env: { ...fixture.env, PATH: `${tools.bin}${path.delimiter}${fixture.env.PATH}` } })
  const result = JSON.parse(out.out.join('\n'))

  assert.equal(code, 0)
  assert.equal(result.ok, true)
  assert.equal(result.checks.find((check) => check.name === '@geastack/targets').ok, true)
  assert.equal(result.checks.find((check) => check.name === 'ESP-IDF').ok, true)
  assert.equal(result.checks.find((check) => check.name === 'ESP-IDF python env').ok, true)
  assert.equal(result.checks.find((check) => check.name === 'ninja').ok, true)
  assert.equal(result.checks.find((check) => check.name === 'ccache').ok, false)
  assert.equal(result.checks.find((check) => check.name === 'ccache').required, false)
})

test('doctor fails closed for invalid board configuration', async (t) => {
  const fixture = createFixture(t, { invalidBoardsJson: true })
  const out = capture()
  const code = await runGea(['doctor', '--json'], { ...out.io, cwd: fixture.root, env: { PATH: '', HOME: fixture.root } })
  assert.equal(code, ExitCode.missingDependency)
  assert.equal(JSON.parse(out.out.join('\n')).ok, false)
})

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
