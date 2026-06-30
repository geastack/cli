import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

import { CliError, ExitCode } from '../src/errors.mjs'
import { runGea } from '../src/gea.mjs'
import { capture, cliRoot, createFakeToolchain, createFixture, readJson, realCollectionRoot, scriptedPrompt } from './helpers/fixture.mjs'

test('gea build web dry-run delegates to simulator build script', async () => {
  const out = []
  await runGea(['--collection-root', realCollectionRoot, 'build', 'watch', '--target=web', '--dry-run'], {
    stdout: (line) => out.push(line)
  })

  assert.match(out.join('\n'), /simulator\/targets\/web\/build-web\.sh watch/)
})

test('gea flash dry-run delegates to board script with app and board', async () => {
  const out = []
  await runGea(['--collection-root', realCollectionRoot, 'flash', 'watch', '--board=amoled', '--monitor', '--dry-run'], {
    stdout: (line) => out.push(line)
  })

  const command = out.join('\n')
  assert.match(command, /targets\/scripts\/board flash-monitor/)
  assert.match(command, /--board=amoled/)
  assert.match(command, /--app=watch/)
})

test('gea flash bringup dry-run delegates to board script without app', async (t) => {
  const fixture = createFixture(t)
  const out = []
  await runGea(['--collection-root', fixture.root, 'flash', '--bringup', '--board=tufty', '--monitor', '--dry-run'], {
    stdout: (line) => out.push(line)
  })

  const command = out.join('\n')
  assert.match(command, /targets\/scripts\/board flash-monitor/)
  assert.match(command, /--board=tufty/)
  assert.doesNotMatch(command, /--app=/)
})

test('gea list apps sees split-repo examples', async () => {
  const out = []
  await runGea(['--collection-root', realCollectionRoot, 'list', 'apps'], {
    stdout: (line) => out.push(line)
  })

  assert.ok(out.includes('watch'))
})

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
  assert.match(unknown.out.join('\n'), /Usage:/)
})

test('list supports apps, targets, boards, filters, and JSON output', async (t) => {
  const fixture = createFixture(t)

  const apps = capture()
  await runGea(['--collection-root', fixture.root, 'list', 'apps'], apps.io)
  assert.deepEqual(apps.out, ['bad-app', 'gea-companion', 'watch', 'web-only'])

  const webApps = capture()
  await runGea(['--collection-root', fixture.root, 'list', 'apps', '--target=web'], webApps.io)
  assert.deepEqual(webApps.out, ['bad-app', 'watch', 'web-only'])

  const targets = capture()
  await runGea(['--collection-root', fixture.root, 'list', 'targets'], targets.io)
  assert.deepEqual(targets.out, ['esp32-s3-touch-amoled-2.06', 'geaos', 'rp2350-tufty-2350'])

  const boards = capture()
  await runGea(['--collection-root', fixture.root, 'list', 'boards', '--json'], boards.io)
  const boardJson = JSON.parse(boards.out.join('\n'))
  assert.equal(boardJson.amoled.target, 'esp32-s3-touch-amoled-2.06')

  await assert.rejects(
    runGea(['--collection-root', fixture.root, 'list', 'planets'], capture().io),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /Unknown list subject/.test(error.message)
  )
})

test('inspect resolves explicit app and current-directory app', async (t) => {
  const fixture = createFixture(t)

  const explicit = capture()
  await runGea(['--collection-root', fixture.root, 'inspect', 'watch', '--json'], explicit.io)
  const payload = JSON.parse(explicit.out.join('\n'))
  assert.equal(payload.id, 'watch')
  assert.equal(payload.entry, 'index.tsx')
  assert.equal(payload.targets.esp32, true)

  const current = capture()
  await runGea(['--collection-root', fixture.root, 'inspect'], {
    ...current.io,
    cwd: path.join(fixture.appDir, 'nested')
  })
  assert.match(current.out.join('\n'), /^watch\tWatch\t/)
})

test('dev routes web target with port and explains unavailable non-web live targets', async (t) => {
  const fixture = createFixture(t)

  const web = capture()
  await runGea(['--collection-root', fixture.root, 'dev', 'watch', '--port=6123', '--dry-run'], web.io)
  assert.match(web.out.join('\n'), /node .*dev-web\.mjs watch --port 6123/)

  const esp32 = capture()
  assert.equal(await runGea(['--collection-root', fixture.root, 'dev', 'watch', '--target=esp32'], esp32.io), 0)
  assert.match(esp32.out.join('\n'), /No live dev loop/)

  await assert.rejects(
    runGea(['--collection-root', fixture.root, 'dev', 'web-only', '--target=esp32'], capture().io),
    (error) => error instanceof CliError && error.exitCode === ExitCode.targetUnavailable && /does not enable target 'esp32'/.test(error.message)
  )
})

test('build routes web, macOS, iOS, board, and target builds', async (t) => {
  const fixture = createFixture(t)

  const web = capture()
  await runGea(['--collection-root', fixture.root, 'build', 'watch', '--target=web', '--dry-run'], web.io)
  assert.match(web.out.join('\n'), /simulator\/targets\/web\/build-web\.sh watch/)

  const macos = capture()
  await runGea(['--collection-root', fixture.root, 'build', 'watch', '--target=macos', '--dry-run'], macos.io)
  assert.match(macos.out.join('\n'), /apple\/targets\/macos\/build-macos\.sh watch/)

  const ios = capture()
  await runGea(['--collection-root', fixture.root, 'build', 'watch', '--target=ios', '--mode=device', '--dry-run'], ios.io)
  assert.match(ios.out.join('\n'), /apple\/targets\/ios\/build-ios\.sh watch device/)

  const android = capture()
  await runGea(['--collection-root', fixture.root, 'build', 'watch', '--target=android', '--dry-run'], android.io)
  assert.match(android.out.join('\n'), /android\/targets\/android\/build-android\.sh watch debug/)

  const board = capture()
  await runGea(['--collection-root', fixture.root, 'build', 'watch', '--board=amoled', '--resident-apps=watch,web-only', '--dry-run'], board.io)
  assert.match(board.out.join('\n'), /targets\/scripts\/board build --board=amoled --app=watch --resident-apps=watch,web-only/)

  const target = capture()
  await runGea(['--collection-root', fixture.root, 'build', 'watch', '--target=geaos', '--dry-run'], target.io)
  assert.match(target.out.join('\n'), /targets\/scripts\/board build --target=geaos --app=watch/)
})

test('setup routes board and target initialization through board script', async (t) => {
  const fixture = createFixture(t)

  const board = capture()
  await runGea(['--collection-root', fixture.root, 'setup', '--board=amoled', '--dry-run'], board.io)
  assert.match(board.out.join('\n'), /targets\/scripts\/board setup --board=amoled/)

  const target = capture()
  await runGea(['--collection-root', fixture.root, 'setup', '--target=esp32-s3-touch-amoled-2.06', '--dry-run'], target.io)
  assert.match(target.out.join('\n'), /targets\/scripts\/board setup --target=esp32-s3-touch-amoled-2\.06/)
})

test('interactive setup writes a known board alias', async (t) => {
  const fixture = createFixture(t)
  const out = capture()
  const prompt = scriptedPrompt([
    '1',
    '1',
    'desk-amoled',
    '1',
    '',
    '',
    'y',
    'n'
  ])

  await runGea(['--collection-root', fixture.root, 'setup', '--dry-run'], {
    ...out.io,
    prompt,
    cwd: fixture.appDir,
    env: {
      ...process.env,
      GEA_SERIAL_DEVICES: '/dev/cu.usbmodem101|ESP32-S3 USB/JTAG|USB123'
    }
  })

  const boards = readJson(path.join(fixture.appDir, '.gea/boards.json'))
  assert.equal(boards['desk-amoled'].target, 'esp32-s3-touch-amoled-2.06')
  assert.equal(boards['desk-amoled'].transports.usbSerial.serial, 'USB123')
  assert.match(prompt.questions.join('\n'), /Detected serial devices/)
  assert.match(prompt.questions.join('\n'), /Save this board setup/)
  assert.match(out.out.join('\n'), /GeaStack setup/)
  assert.match(out.out.join('\n'), /\[ Review \]/)
  assert.match(out.out.join('\n'), /Wrote board alias 'desk-amoled'/)
  assert.match(out.out.join('\n'), /board setup --board=desk-amoled/)
  assert.match(out.out.join('\n'), /Ready: npx gea flash --board desk-amoled --monitor/)
})

test('interactive setup writes a rich custom board profile', async (t) => {
  const fixture = createFixture(t)
  const out = capture()
  const prompt = scriptedPrompt([
    '2',
    'factory-panel',
    '1',
    '2',
    '1',
    '1',
    'RM67162',
    '2',
    '480x480',
    'CST816',
    '',
    '',
    '',
    'u-blox M10',
    '',
    'ES8311',
    '',
    '2',
    'flash, psram, sdcard',
    'IMU, ambient light',
    'USB + LiPo charger',
    '3',
    'SERIAL42',
    '192.168.1.42',
    'schematic pending',
    'y',
    'n'
  ])

  await runGea(['--collection-root', fixture.root, 'setup'], {
    ...out.io,
    prompt,
    cwd: fixture.appDir,
    env: {
      ...process.env,
      GEA_SERIAL_DEVICES: '[]'
    }
  })

  const profilePath = path.join(fixture.appDir, '.gea/boards/factory-panel.json')
  const profile = readJson(profilePath)
  assert.equal(profile.mcu, 'esp32-s3')
  assert.equal(profile.display.controller, 'RM67162')
  assert.equal(profile.touch.controller, 'CST816')
  assert.equal(profile.wireless.wifi, 'built-in')
  assert.equal(profile.wireless.ble, 'built-in')
  assert.equal(profile.gps.module, 'u-blox M10')
  assert.equal(profile.audio.codec, 'ES8311')
  assert.deepEqual(profile.storage, ['flash', 'psram', 'sdcard'])
  assert.deepEqual(profile.sensors, ['IMU', 'ambient light'])
  assert.equal(profile.transports.usbSerial.serial, 'SERIAL42')
  assert.equal(profile.transports.ota.host, '192.168.1.42')
  assert.match(prompt.questions.join('\n'), /How much hardware detail/)
  assert.match(prompt.questions.join('\n'), /Full hardware profile/)
  assert.match(prompt.questions.join('\n'), /Save this custom board profile/)
  assert.match(out.out.join('\n'), /\[ Peripherals \]/)
  assert.match(out.out.join('\n'), /\[ Review \]/)

  const boards = readJson(path.join(fixture.appDir, '.gea/boards.json'))
  assert.equal(boards['factory-panel'].target, 'esp32-s3-touch-amoled-2.06')
  assert.equal(boards['factory-panel'].customProfile, profilePath)
})

test('interactive setup supports a fast custom board profile', async (t) => {
  const fixture = createFixture(t)
  const out = capture()
  const prompt = scriptedPrompt([
    '2',
    'quick-panel',
    '2',
    '1',
    '2',
    '5',
    '',
    '1',
    '',
    '',
    'y',
    'n'
  ])

  await runGea(['--collection-root', fixture.root, 'setup'], {
    ...out.io,
    prompt,
    cwd: fixture.appDir,
    env: {
      ...process.env,
      GEA_SERIAL_DEVICES: '[]'
    }
  })

  const profilePath = path.join(fixture.appDir, '.gea/boards/quick-panel.json')
  const profile = readJson(profilePath)
  assert.equal(profile.mcu, 'esp32-p4')
  assert.equal(profile.display.kind, 'none')
  assert.equal(profile.wireless.wifi, 'none')
  assert.equal(profile.wireless.ble, 'none')
  assert.deepEqual(profile.storage, ['flash', 'psram'])
  assert.equal(profile.sensors, undefined)
  assert.equal(profile.gps, undefined)
  assert.equal(profile.audio, undefined)
  assert.doesNotMatch(prompt.questions.join('\n'), /GPS module/)
  assert.doesNotMatch(prompt.questions.join('\n'), /Audio codec/)
  assert.match(out.out.join('\n'), /Using defaults/)
  assert.match(out.out.join('\n'), /Profile saved/)
})

test('interactive setup can dry-run ESP-IDF installation', async (t) => {
  const fixture = createFixture(t)
  const out = capture()
  const prompt = scriptedPrompt(['4'])

  await runGea([
    '--collection-root',
    fixture.root,
    'setup',
    '--dry-run',
    '--idf-dir',
    path.join(fixture.root, 'esp-idf')
  ], {
    ...out.io,
    prompt,
    cwd: fixture.appDir,
    env: {
      PATH: ''
    }
  })

  const text = out.out.join('\n')
  assert.match(text, /git clone -b v6\.0\.1 --recursive https:\/\/github\.com\/espressif\/esp-idf\.git/)
  assert.match(text, /install\.sh esp32,esp32s3,esp32p4/)
  assert.match(text, /For future shells: \. "/)
})

test('build rejects invalid manifests and incompatible targets', async (t) => {
  const fixture = createFixture(t)

  await assert.rejects(
    runGea(['--collection-root', fixture.root, 'build', 'bad-app', '--target=web', '--dry-run'], capture().io),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /gea.entry does not exist/.test(error.message)
  )

  await assert.rejects(
    runGea(['--collection-root', fixture.root, 'build', 'web-only', '--board=amoled', '--dry-run'], capture().io),
    (error) => error instanceof CliError && error.exitCode === ExitCode.targetUnavailable && /does not enable target 'esp32'/.test(error.message)
  )
})

test('flash and monitor validate selection and pass through board options', async (t) => {
  const fixture = createFixture(t)

  await assert.rejects(
    runGea(['--collection-root', fixture.root, 'flash', 'watch', '--dry-run'], capture().io),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /requires --board/.test(error.message)
  )

  const flash = capture()
  await runGea(['--collection-root', fixture.root, 'flash', 'watch', '--board=amoled', '--port=/dev/cu.usb', '--monitor', '--dry-run', '--', '--manual-boot'], flash.io)
  assert.match(flash.out.join('\n'), /board flash-monitor --board=amoled --app=watch \/dev\/cu\.usb --manual-boot/)

  const tuftyFlash = capture()
  await runGea(['--collection-root', fixture.root, 'flash', 'watch', '--board=tufty', '--dry-run'], tuftyFlash.io)
  assert.match(tuftyFlash.out.join('\n'), /board flash --board=tufty --app=watch/)

  const targetFlash = capture()
  await runGea(['--collection-root', fixture.root, 'flash', 'watch', '--target=geaos', '--dry-run'], targetFlash.io)
  assert.match(targetFlash.out.join('\n'), /board flash --target=geaos --app=watch/)

  const androidFlash = capture()
  await runGea(['--collection-root', fixture.root, 'flash', 'watch', '--target=android', '--dry-run'], androidFlash.io)
  assert.match(androidFlash.out.join('\n'), /android\/targets\/android\/build-android\.sh watch device/)

  const monitor = capture()
  await runGea(['--collection-root', fixture.root, 'monitor', '--board=amoled', '--port=auto', '--dry-run'], monitor.io)
  assert.match(monitor.out.join('\n'), /board monitor --board=amoled auto/)

  const androidMonitor = capture()
  await runGea(['--collection-root', fixture.root, 'monitor', '--target=android', '--dry-run'], androidMonitor.io)
  assert.match(androidMonitor.out.join('\n'), /android\/targets\/android\/build-android\.sh css-3d-cube monitor/)

  await assert.rejects(
    runGea(['--collection-root', fixture.root, 'monitor', '--dry-run'], capture().io),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /monitor requires/.test(error.message)
  )
})

test('doctor reports required and optional checks with JSON output', async (t) => {
  const fixture = createFixture(t)
  const tools = createFakeToolchain(t)
  const out = capture()

  const code = await runGea(['--collection-root', fixture.root, 'doctor', '--strict', '--json'], {
    ...out.io,
    env: tools.env
  })

  assert.equal(code, 0)
  const payload = JSON.parse(out.out.join('\n'))
  assert.equal(payload.ok, true)
  assert.equal(payload.checks.find((check) => check.name === 'npm').ok, true)
  assert.equal(payload.checks.find((check) => check.name === 'ESP-IDF').ok, true)
  assert.equal(payload.checks.find((check) => check.name === 'Android SDK').ok, true)
  assert.equal(payload.checks.find((check) => check.name === 'adb').ok, true)
  assert.equal(payload.checks.find((check) => check.name === 'app catalog').detail, '4 app(s)')
})

test('doctor returns missing dependency for required failures and invalid board config', async (t) => {
  const fixture = createFixture(t, { invalidBoardsJson: true })
  const out = capture()

  const code = await runGea(['--collection-root', fixture.root, 'doctor', '--json'], out.io)

  assert.equal(code, ExitCode.missingDependency)
  const payload = JSON.parse(out.out.join('\n'))
  assert.equal(payload.ok, false)
  assert.equal(payload.checks.find((check) => check.name === 'boards.json').required, true)
})

test('doctor human output points to setup guide when checks warn or fail', async (t) => {
  const fixture = createFixture(t)
  const out = capture()

  await runGea(['--collection-root', fixture.root, 'doctor'], {
    ...out.io,
    env: {
      ...process.env,
      PATH: ''
    }
  })

  assert.match(out.out.join('\n'), /Setup guide: cli\/docs\/SETUP\.md/)
})

test('bin wrappers propagate return codes and CliError exit codes', async (t) => {
  const fixture = createFixture(t)
  const tools = createFakeToolchain(t)

  const doctor = spawnSync(process.execPath, [path.join(cliRoot, 'bin/gea.mjs'), '--collection-root', fixture.root, 'doctor', '--strict', '--json'], {
    encoding: 'utf8',
    env: tools.env
  })
  assert.equal(doctor.status, 0)
  assert.match(doctor.stdout, /"ok": true/)

  const unknown = spawnSync(process.execPath, [path.join(cliRoot, 'bin/gea.mjs'), 'does-not-exist'], {
    encoding: 'utf8',
    env: process.env
  })
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown command/)

  const createMissingName = spawnSync(process.execPath, [path.join(cliRoot, 'bin/create-geastack.mjs')], {
    encoding: 'utf8',
    env: process.env
  })
  assert.equal(createMissingName.status, ExitCode.usage)
  assert.match(createMissingName.stderr, /requires an app name/)
})
