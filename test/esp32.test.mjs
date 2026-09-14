import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { parseArgs } from '../src/args.mjs'
import { createContext } from '../src/context.mjs'
import { applySdkconfigPolicy, esp32BuildDir } from '../src/esp32/build.mjs'
import { manifestRequestsBleOta, parseAnalysis, resolveAppCapabilities } from '../src/esp32/capabilities.mjs'
import { activateEspIdf, esptoolCommand, findEspIdf, findIdfPythonEnv } from '../src/esp32/idf-env.mjs'
import { DEFAULT_ESP_IDF_VERSION, fetchLatestEspIdfVersion, idfVersionMeetsTarget, resolveEspIdfVersion } from '../src/esp32/idf-version.mjs'
import { flashOffsetForBuildImage, loadPartitions, normalizeOtaSlot, partitionByName, sizeToBytes } from '../src/esp32/partitions.mjs'
import { Sdkconfig, prepareBuildLocalSdkconfig, withSdkconfigUnset, withSdkconfigValue } from '../src/esp32/sdkconfig.mjs'
import { quoteCString, wifiConfigContents } from '../src/esp32/wifi-config.mjs'
import { findCurrentApp } from '../src/manifest.mjs'
import { createFixture } from './helpers/fixture.mjs'

test('ESP-IDF activation runs idf_tools export from the installed python env, never export.sh', (t) => {
  const fixture = createFixture(t)
  assert.equal(findEspIdf(fixture.env), fixture.env.IDF_PATH)
  assert.equal(findIdfPythonEnv(fixture.env.IDF_PATH, fixture.env), fixture.env.IDF_PYTHON_ENV_PATH)
  const idf = activateEspIdf({ env: fixture.env })
  assert.equal(idf.version.full, '6.0.2')
  assert.equal(idf.python, path.join(fixture.env.IDF_PYTHON_ENV_PATH, 'bin', 'python'))
  assert.equal(idf.env.OPENOCD_SCRIPTS, '/fake/openocd/scripts')
  assert.equal(idf.env.IDF_PATH, fixture.env.IDF_PATH)
  assert.ok(idf.env.PATH.startsWith(`${path.join(fixture.env.IDF_PYTHON_ENV_PATH, 'bin')}${path.delimiter}/fake/idf-tools/bin${path.delimiter}`))
  assert.ok(idf.env.PATH.endsWith(fixture.env.PATH), 'the literal $PATH placeholder is replaced with the caller PATH')
  assert.deepEqual(esptoolCommand(idf, ['--chip', 'esp32s3']), { command: idf.python, args: ['-m', 'esptool', '--chip', 'esp32s3'] })
  assert.match(fixture.calls().join('\n'), /idf_tools\.py export --format key-value/)
})

test('ESP-IDF version resolution: default pin, env/option override, latest-release lookup, and the acceptance floor', async () => {
  assert.equal(DEFAULT_ESP_IDF_VERSION, 'v6.0.2')

  // No override and no fetch available (offline/never-hit-network in tests):
  // falls back to the pin.
  assert.equal(
    await resolveEspIdfVersion({ env: {}, fetchLatest: async () => '' }),
    'v6.0.2'
  )

  // --idf-version wins outright, without ever calling fetchLatest.
  let fetchCalled = false
  assert.equal(
    await resolveEspIdfVersion({
      override: 'v6.0.3',
      env: { GEA_ESP_IDF_VERSION: 'v9.9.9' },
      fetchLatest: async () => { fetchCalled = true; return 'v7.0.0' }
    }),
    'v6.0.3'
  )
  assert.equal(fetchCalled, false, 'an explicit override short-circuits the network lookup')

  // GEA_ESP_IDF_VERSION wins when no --idf-version is given, and a bare
  // version (no leading v) is normalized so it works as a git tag.
  assert.equal(
    await resolveEspIdfVersion({ env: { GEA_ESP_IDF_VERSION: '6.1.0-rc1' }, fetchLatest: async () => '' }),
    'v6.1.0-rc1'
  )

  // A stable latest release is used when no override is given.
  assert.equal(
    await resolveEspIdfVersion({ env: {}, fetchLatest: async () => 'v6.1.0' }),
    'v6.1.0'
  )

  // fetchLatestEspIdfVersion itself: stable tag accepted.
  assert.equal(
    await fetchLatestEspIdfVersion({
      fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v6.1.0' }) })
    }),
    'v6.1.0'
  )
  // Pre-releases/RCs are ignored -- caller falls back to the pin.
  assert.equal(
    await fetchLatestEspIdfVersion({
      fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v6.1.0-rc1' }) })
    }),
    ''
  )
  // A failed/timed-out/offline request falls back silently (empty string,
  // at most one log line -- never throws).
  let logged = ''
  assert.equal(
    await fetchLatestEspIdfVersion({
      fetchImpl: async () => { throw new Error('network unreachable') },
      log: (line) => { logged = line }
    }),
    ''
  )
  assert.match(logged, /Could not determine the latest ESP-IDF release/)
  assert.equal(await fetchLatestEspIdfVersion({ fetchImpl: async () => ({ ok: false }) }), '')

  // Installed-version acceptance is a floor on major.minor: newer, equal,
  // and a newer major all pass; an older minor or major fails.
  assert.equal(idfVersionMeetsTarget({ majorMinor: '6.0' }, 'v6.0.2'), true)
  assert.equal(idfVersionMeetsTarget({ majorMinor: '6.1' }, 'v6.0.2'), true)
  assert.equal(idfVersionMeetsTarget({ majorMinor: '7.0' }, 'v6.0.2'), true)
  assert.equal(idfVersionMeetsTarget({ majorMinor: '5.4' }, 'v6.0.2'), false)
  assert.equal(idfVersionMeetsTarget({ majorMinor: '6.0' }, 'v6.1.0'), false, 'a user on 6.0 is told to move up to a 6.1 target')
  assert.equal(idfVersionMeetsTarget(null, 'v6.0.2'), false, 'nothing installed never passes')
  assert.equal(idfVersionMeetsTarget({ majorMinor: '6.0' }, ''), true, 'an unresolved target never blocks')
})

test('sdkconfig edits are idempotent and keep one line per key', () => {
  let text = 'CONFIG_A=y\n# CONFIG_B is not set\n'
  text = withSdkconfigValue(text, 'CONFIG_B', '3')
  assert.equal(text, 'CONFIG_A=y\nCONFIG_B=3\n')
  assert.equal(withSdkconfigValue(text, 'CONFIG_B', '3'), text)
  text = withSdkconfigUnset(text, 'CONFIG_A')
  assert.equal(text, '# CONFIG_A is not set\nCONFIG_B=3\n')
  assert.equal(withSdkconfigUnset(text, 'CONFIG_A'), text)
})

test('each app build keeps its sdkconfig inside its own build directory', (t) => {
  const fixture = createFixture(t)
  const boardA = path.join(fixture.root, 'board-a')
  const boardB = path.join(fixture.root, 'board-b')
  for (const board of [boardA, boardB]) {
    mkdirSync(board, { recursive: true })
    writeFileSync(path.join(board, 'sdkconfig.defaults'), 'CONFIG_SHARED_DEFAULT=y\n')
    writeFileSync(path.join(board, 'sdkconfig'), 'CONFIG_LEGACY_GLOBAL_SENTINEL=y\n')
  }
  const configure = (board, buildRel, key, value) => {
    const { file, defaultsFile } = prepareBuildLocalSdkconfig(board, buildRel)
    new Sdkconfig(file, defaultsFile).set(key, value).save()
    return file
  }
  const weather = configure(boardA, 'build/app-builds/weather', 'CONFIG_APP_WEATHER', 'y')
  assert.equal(weather, path.join(boardA, 'build/app-builds/weather/sdkconfig'))
  const before = readFileSync(weather, 'utf8')
  configure(boardA, 'build/app-builds/tic-tac-toe', 'CONFIG_APP_GAME', 'y')
  configure(boardB, path.join(fixture.root, 'abs-build'), 'CONFIG_BOARD_B_ONLY', 'y')
  assert.equal(readFileSync(weather, 'utf8'), before)
  assert.equal(readFileSync(path.join(boardA, 'sdkconfig'), 'utf8'), 'CONFIG_LEGACY_GLOBAL_SENTINEL=y\n', 'the target-root sdkconfig is never touched')
  assert.equal(readFileSync(path.join(fixture.root, 'abs-build', 'sdkconfig'), 'utf8'), 'CONFIG_BOARD_B_ONLY=y\n')
  assert.throws(() => prepareBuildLocalSdkconfig(boardA, '../escape'), /Invalid ESP32 build directory/)
})

test('build directories are per target and per app, with an optional variant', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs([]), {}, fixture.root)
  const selection = { target: 'esp32-s3-touch-amoled-2.06' }
  assert.equal(esp32BuildDir(ctx, selection, ''), path.join(fixture.root, '.gea/build/esp32-s3-touch-amoled-2.06/default'))
  assert.equal(esp32BuildDir(ctx, selection, 'my app!'), path.join(fixture.root, '.gea/build/esp32-s3-touch-amoled-2.06/app-builds/my_app_'))
  assert.equal(esp32BuildDir(ctx, selection, 'watch', { GEA_IDF_BUILD_VARIANT: 'ninja' }), path.join(fixture.root, '.gea/build/esp32-s3-touch-amoled-2.06/app-builds/watch__variant-ninja'))
  assert.throws(() => esp32BuildDir(ctx, selection, 'watch', { GEA_IDF_BUILD_VARIANT: 'bad variant' }), /GEA_IDF_BUILD_VARIANT/)
})

function policy(t, { boardName = 'amoled', idfTarget = 'esp32s3', defaults = '', appDefaults = '', existing = '', app = { id: 'watch' }, capabilities = {}, bleOta = false }) {
  const fixture = createFixture(t)
  const dir = path.join(fixture.root, 'policy')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'sdkconfig.defaults'), defaults)
  writeFileSync(path.join(dir, 'app.sdkconfig.defaults'), appDefaults)
  writeFileSync(path.join(dir, 'sdkconfig'), existing)
  const sdkconfig = new Sdkconfig(path.join(dir, 'sdkconfig'), path.join(dir, 'sdkconfig.defaults'), path.join(dir, 'app.sdkconfig.defaults'))
  applySdkconfigPolicy(sdkconfig, {
    selection: { boardName, idfTarget, mainTaskStackSize: '', ipcTaskStackSize: '' },
    app,
    capabilities: { network: false, ble: false, bleApi: false, audio: false, ...capabilities },
    bleOta
  })
  return sdkconfig.text
}

test('the sdkconfig policy sets development logging, stacks and the S3 instruction cache', (t) => {
  const text = policy(t, {})
  assert.match(text, /^CONFIG_ESP_MAIN_TASK_STACK_SIZE=32768$/m)
  assert.match(text, /^CONFIG_ESP_IPC_TASK_STACK_SIZE=16384$/m)
  assert.match(text, /^CONFIG_ESP32S3_INSTRUCTION_CACHE_32KB=y$/m)
  assert.match(text, /^# CONFIG_ESP32S3_INSTRUCTION_CACHE_16KB is not set$/m)
  assert.match(text, /^CONFIG_LOG_DEFAULT_LEVEL_INFO=y$/m)
  assert.match(text, /^CONFIG_LOG_DEFAULT_LEVEL=3$/m)
  assert.match(text, /^CONFIG_LOG_MAXIMUM_LEVEL=3$/m)
  assert.doesNotMatch(text, /CONFIG_LOG_MAXIMUM_LEVEL_(?:ERROR|WARN|INFO)/, 'choices invisible at the default level are not rewritten')
  assert.match(text, /^# CONFIG_GEA_EMBEDDED_PRODUCTION_LOCKDOWN is not set$/m)
  assert.match(text, /^CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_ENABLE=y$/m)
  assert.match(text, /^CONFIG_COMPILER_OPTIMIZATION_ASSERTION_LEVEL=2$/m)
  assert.match(text, /^CONFIG_BOOTLOADER_LOG_LEVEL_INFO=y$/m)
  assert.doesNotMatch(text, /CONFIG_BT_ENABLED/, 'a no-BLE build only rewrites CONFIG_BT_ENABLED when the bt component exposes it')
  assert.doesNotMatch(policy(t, { idfTarget: 'esp32p4' }), /INSTRUCTION_CACHE/)

  // An app that needs SRAM0's IRAM-only region more than it needs frame time
  // says so in its own defaults, and the policy stops overruling it. A board
  // default is not the app asking -- boards already get 32 KB by policy.
  const small = policy(t, { appDefaults: 'CONFIG_ESP32S3_INSTRUCTION_CACHE_16KB=y\n', existing: 'CONFIG_ESP32S3_INSTRUCTION_CACHE_32KB=y\n' })
  assert.match(small, /^CONFIG_ESP32S3_INSTRUCTION_CACHE_16KB=y$/m)
  assert.match(small, /^# CONFIG_ESP32S3_INSTRUCTION_CACHE_32KB is not set$/m)
  const boardCache = policy(t, { defaults: 'CONFIG_ESP32S3_INSTRUCTION_CACHE_16KB=y\n' })
  assert.match(boardCache, /^CONFIG_ESP32S3_INSTRUCTION_CACHE_32KB=y$/m)
})

test('an app that runs its own Bluetooth stack keeps the controller the Gea BLE API never asked for', (t) => {
  const appDefaults = 'CONFIG_BT_ENABLED=y\nCONFIG_BT_NIMBLE_ENABLED=y\n'
  // Sticky state from a build configured before the app asked for Bluetooth:
  // the generated sdkconfig outranks any defaults file, so the policy has to
  // undo its own earlier line rather than leave the app's request unheard.
  const text = policy(t, { appDefaults, existing: '# CONFIG_BT_ENABLED is not set\n' })
  assert.match(text, /^CONFIG_BT_ENABLED=y$/m)
  // The board asking is not the app asking: a board default alone is still a
  // no-BLE build, and the whole bt component stays out of it.
  const boardOnly = policy(t, { defaults: 'CONFIG_BT_ENABLED=y\n', existing: 'CONFIG_BT_ENABLED=y\n' })
  assert.match(boardOnly, /^# CONFIG_BT_ENABLED is not set$/m)
  // The app's defaults answer questions about the app; the board still answers
  // its own.
  const layered = policy(t, { defaults: 'CONFIG_BT_NIMBLE_MAX_CONNECTIONS=4\n', appDefaults, capabilities: { ble: true, bleApi: true } })
  assert.match(layered, /^CONFIG_BT_NIMBLE_MAX_CONNECTIONS=4$/m)
})

test('the generated sdkconfig is rebuilt when the defaults it came from change', (t) => {
  const fixture = createFixture(t)
  const board = path.join(fixture.root, 'board')
  mkdirSync(board, { recursive: true })
  writeFileSync(path.join(board, 'sdkconfig.defaults'), 'CONFIG_BOARD=y\n')
  const appDefaults = path.join(fixture.root, 'app.sdkconfig.defaults')
  writeFileSync(appDefaults, 'CONFIG_APP_ONE=y\n')
  const first = prepareBuildLocalSdkconfig(board, 'build/app', appDefaults)
  assert.equal(first.regenerated, false)
  // Whatever IDF generated last time, including answers the defaults have since
  // stopped asking for.
  writeFileSync(first.file, 'CONFIG_APP_ONE=y\nCONFIG_APP_STALE=y\n')
  assert.equal(prepareBuildLocalSdkconfig(board, 'build/app', appDefaults).regenerated, false, 'unchanged inputs keep the generated file')
  assert.equal(readFileSync(first.file, 'utf8'), 'CONFIG_APP_ONE=y\nCONFIG_APP_STALE=y\n')
  // Deleting a line from the defaults is a change like any other: the derived
  // file goes, so the setting it used to carry cannot outlive it.
  writeFileSync(appDefaults, '')
  const after = prepareBuildLocalSdkconfig(board, 'build/app', appDefaults)
  assert.equal(after.regenerated, true)
  assert.equal(readFileSync(after.file, 'utf8'), '')
  writeFileSync(path.join(board, 'sdkconfig.defaults'), 'CONFIG_BOARD=n\n')
  assert.equal(prepareBuildLocalSdkconfig(board, 'build/app', appDefaults).regenerated, false, 'an empty generated file has nothing to throw away')
})

test('assertions follow the board: sticks3 disables, silent defaults stay silent', (t) => {
  const sticks = policy(t, { boardName: 'sticks3' })
  assert.match(sticks, /^CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_DISABLE=y$/m)
  assert.match(sticks, /^CONFIG_COMPILER_OPTIMIZATION_ASSERTION_LEVEL=0$/m)
  const silent = policy(t, { defaults: 'CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_SILENT=y\n' })
  assert.match(silent, /^CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_SILENT=y$/m)
  assert.match(silent, /^CONFIG_COMPILER_OPTIMIZATION_ASSERTION_LEVEL=1$/m)
})

test('BLE apps inherit the board NimBLE policy; BLE-OTA-only builds use one link', (t) => {
  const defaults = 'CONFIG_BT_NIMBLE_MAX_CONNECTIONS=4\nCONFIG_BT_NIMBLE_ROLE_CENTRAL=y\nCONFIG_BT_NIMBLE_ROLE_OBSERVER=y\n'
  const api = policy(t, { defaults, capabilities: { ble: true, bleApi: true } })
  assert.match(api, /^CONFIG_BT_ENABLED=y$/m)
  assert.match(api, /^CONFIG_BT_NIMBLE_ENABLED=y$/m)
  assert.match(api, /^# CONFIG_BT_BLUEDROID_ENABLED is not set$/m)
  assert.match(api, /^CONFIG_BT_NIMBLE_MAX_CONNECTIONS=4$/m)
  assert.match(api, /^CONFIG_BT_NIMBLE_ROLE_CENTRAL=y$/m)
  assert.match(api, /^CONFIG_BT_NIMBLE_ROLE_OBSERVER=y$/m)

  const otaOnly = policy(t, { defaults, capabilities: { ble: true, bleApi: false }, bleOta: true })
  assert.match(otaOnly, /^CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1$/m)
  assert.match(otaOnly, /^# CONFIG_BT_NIMBLE_ROLE_CENTRAL is not set$/m)
  assert.match(otaOnly, /^# CONFIG_BT_NIMBLE_ROLE_OBSERVER is not set$/m)

  const disabled = policy(t, { existing: 'CONFIG_BT_ENABLED=y\n' })
  assert.match(disabled, /^# CONFIG_BT_ENABLED is not set$/m)
})

test('app capabilities come from the compiler analysis plus the manifest', (t) => {
  assert.deepEqual(parseAnalysis('noise\nbindings=audio;ble\nfeatures=https\n'), { bindings: ['audio', 'ble'], features: ['https'] })
  assert.equal(manifestRequestsBleOta({ gea: { ota: { ble: true } } }), true)
  assert.equal(manifestRequestsBleOta({ gea: { ota: { ble: false } } }), false)
  assert.equal(manifestRequestsBleOta({ scripts: { ota: 'x' } }), false, 'an npm script named ota must not enable the BLE firmware service')

  const fixture = createFixture(t)
  const ctx = createContext(parseArgs([]), fixture.env, fixture.appDir)
  const app = findCurrentApp(fixture.appDir)
  const capabilities = resolveAppCapabilities(ctx, app, { env: fixture.env })
  assert.deepEqual(capabilities, { network: true, ble: false, bleApi: false, audio: true, bindings: ['audio', 'fetch'], features: [] })
  const call = fixture.calls().find((line) => line.startsWith('compiler '))
  assert.equal(call, `compiler analyze ${path.join(fixture.appDir, 'index.tsx')} --plugin ${path.join(fixture.installed('geatsc-plugin-gea'), 'dist', 'index.js')}`)
})

test('wifi config is generated from the app .env as C string literals', () => {
  assert.equal(quoteCString('a"b\\c\n'), '"a\\"b\\\\c\\n"')
  const generated = wifiConfigContents({ GEA_WIFI_SSID: 'test network', GEA_WIFI_PASSWORD: 'secret' })
  assert.match(generated, /GEA_EMBEDDED_WIFI_SSID "test network"/)
  assert.match(generated, /GEA_EMBEDDED_WIFI_PASSWORD "secret"/)
  assert.match(generated, /GEA_EMBEDDED_WIFI_EARLY_CONNECT 1/)
  assert.match(wifiConfigContents({}), /GEA_EMBEDDED_WIFI_EARLY_CONNECT 0/)
})

test('partition tables answer slot offsets, sizes and build image offsets', (t) => {
  const fixture = createFixture(t)
  const partitions = loadPartitions(fixture.esp32Target)
  assert.equal(partitionByName(partitions, 'ota_1').offset, '0x210000')
  assert.equal(sizeToBytes(partitionByName(partitions, 'ota_0').size), 0x200000)
  assert.equal(sizeToBytes('64K'), 65536)
  assert.equal(sizeToBytes('2M'), 2097152)
  assert.equal(normalizeOtaSlot('1'), 'ota_1')
  assert.equal(normalizeOtaSlot('ota_2'), 'ota_2')
  assert.throws(() => partitionByName(partitions, 'ota_9'), /was not found/)
  const buildDir = path.join(fixture.root, 'build')
  mkdirSync(buildDir, { recursive: true })
  writeFileSync(path.join(buildDir, 'flash_args'), '--flash_mode dio\n0x0 bootloader/bootloader.bin\n0x8000 partition_table/partition-table.bin\n')
  assert.equal(flashOffsetForBuildImage(buildDir, path.join(buildDir, 'bootloader/bootloader.bin'), '0x1000'), '0x0')
  assert.equal(flashOffsetForBuildImage(buildDir, path.join(buildDir, 'missing.bin'), '0x2000'), '0x2000')
})
