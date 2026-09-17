import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// A complete fake project: installed @geastack packages (targets with one
// ESP32 and one RP2350 project, a chips catalog, a compiler whose `analyze`
// reports fixed bindings), a fake ESP-IDF install whose python/cmake/ninja
// record every invocation, and a boards.json with USB, WiFi and manual-restart
// boards. Tests drive the real CLI against it and read the call log.
export function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-cli-fixture-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  writeJson(path.join(root, 'package.json'), {
    name: 'fixture-project',
    private: true,
    workspaces: ['apps/*']
  })

  const installed = (name) => path.join(root, 'node_modules', '@geastack', name)
  for (const name of ['chips', 'compiler', 'elements', 'engine', 'geaos', 'host', 'geatsc-plugin-gea', 'core', 'targets']) {
    writeJson(path.join(installed(name), 'package.json'), { name: `@geastack/${name}`, version: '0.1.0' })
  }
  writeJson(path.join(installed('chips'), 'catalog.json'), chipCatalog())
  fs.writeFileSync(path.join(installed('core'), 'gea_app_entry.cpp'), '// fixture\n')
  writeExecutable(path.join(installed('compiler'), 'dist', 'cli.js'), [
    '#!/usr/bin/env node',
    "const log = process.env.GEA_TEST_CALL_LOG",
    "if (log) require('node:fs').appendFileSync(log, `compiler ${process.argv.slice(2).join(' ')}\\n`)",
    "console.log('bindings=audio;fetch')",
    "console.log('features=')",
    ''
  ].join('\n'))
  fs.mkdirSync(path.join(installed('geatsc-plugin-gea'), 'dist'), { recursive: true })
  fs.writeFileSync(path.join(installed('geatsc-plugin-gea'), 'dist', 'index.js'), 'module.exports = {}\n')

  writeApp(root, 'apps/watch', {
    id: 'watch',
    name: 'Watch',
    targets: { web: true, esp32: true, rp2350: false, geaos: true, macos: true, ios: true, android: true, windows: true }
  })
  writeApp(root, 'apps/web-only', {
    id: 'web-only',
    name: 'Web Only',
    targets: { web: true, esp32: false, rp2350: false, geaos: false, macos: false, ios: false, android: false, windows: false }
  })
  writeJson(path.join(root, 'apps/bad-app/package.json'), {
    name: '@fixture/bad-app',
    private: true,
    gea: { id: 'bad-app', name: 'Bad App', entry: 'missing.tsx', runtime: 'gea', targets: { web: true } }
  })

  const esp32Target = path.join(installed('targets'), 'targets/esp32-s3-touch-amoled-2.06')
  fs.mkdirSync(esp32Target, { recursive: true })
  fs.writeFileSync(path.join(esp32Target, 'CMakeLists.txt'), 'project(gea_embedded)\n')
  fs.writeFileSync(path.join(esp32Target, 'sdkconfig.defaults'), 'CONFIG_BT_NIMBLE_MAX_CONNECTIONS=4\nCONFIG_BT_NIMBLE_ROLE_CENTRAL=y\n')
  fs.writeFileSync(path.join(esp32Target, 'partitions.csv'), [
    '# Name,   Type, SubType, Offset,   Size, Flags',
    'nvs,      data, nvs,     0x9000,   0x4000,',
    'otadata,  data, ota,     0xd000,   0x2000,',
    'ota_0,    app,  ota_0,   0x10000,  0x200000,',
    'ota_1,    app,  ota_1,   0x210000, 0x200000,',
    ''
  ].join('\n'))
  const rp2350Target = path.join(installed('targets'), 'targets/rp2350-tufty-2350')
  fs.mkdirSync(rp2350Target, { recursive: true })
  fs.writeFileSync(path.join(rp2350Target, 'CMakeLists.txt'), 'project(gea_rp2350)\n')

  writeJson(path.join(installed('targets'), 'targets.json'), {
    'esp32-s3': {
      adapter: 'esp32-idf',
      targetPath: 'targets/esp32-s3-touch-amoled-2.06',
      flashSize: '32MB',
      appPlatform: 'esp32',
      idfTarget: 'esp32s3',
      esptoolChip: 'esp32s3'
    },
    'esp32-s3-touch-amoled-2.06': {
      adapter: 'esp32-idf',
      targetPath: 'targets/esp32-s3-touch-amoled-2.06',
      flashSize: '16MB',
      appPlatform: 'esp32',
      idfTarget: 'esp32s3',
      esptoolChip: 'esp32s3'
    },
    'rp2350-tufty-2350': {
      adapter: 'rp2350-pico',
      targetPath: 'targets/rp2350-tufty-2350',
      flashSize: '16MB',
      appPlatform: 'rp2350',
      compatibleAppPlatforms: ['esp32']
    },
    geaos: {
      adapter: 'geaos-linux',
      targetPath: '../geaos/targets/geaos',
      appPlatform: 'geaos'
    }
  })
  // Board aliases live in the fixture's HOME (~/.geastack/boards.json), the
  // machine-wide tier; tests that want a project override write
  // apps/watch/.gea/boards.json themselves.
  const homeBoards = path.join(root, '.geastack', 'boards.json')
  fs.mkdirSync(path.dirname(homeBoards), { recursive: true })
  if (options.invalidBoardsJson) {
    fs.writeFileSync(homeBoards, '{ this is not json\n')
  } else {
    writeJson(homeBoards, {
      amoled: {
        target: 'esp32-s3-touch-amoled-2.06',
        adapter: 'esp32-idf',
        transports: { usbSerial: { serial: 'USB123' } }
      },
      // Same target, but reachable by IP. Exercises the 'auto' transport picking
      // the cable-free path for logs and screenshots.
      'amoled-wifi': {
        target: 'esp32-s3-touch-amoled-2.06',
        adapter: 'esp32-idf',
        transports: { usbSerial: { serial: 'USB123' }, ota: { host: '10.0.0.5' } }
      },
      'amoled-manual': {
        target: 'esp32-s3-touch-amoled-2.06',
        adapter: 'esp32-idf',
        transports: { usbSerial: { serial: 'USB999', restartAfterFlash: 'manual' } }
      },
      tufty: {
        target: 'rp2350-tufty-2350',
        adapter: 'rp2350-pico'
      },
      linux: {
        target: 'geaos',
        adapter: 'geaos-linux'
      }
    })
  }

  const idf = createFakeEspIdf(root)
  const fakePort = path.join(root, 'fake-usb-port')
  fs.writeFileSync(fakePort, '')

  return {
    root,
    appDir: path.join(root, 'apps/watch'),
    badAppDir: path.join(root, 'apps/bad-app'),
    installed,
    esp32Target,
    fakePort,
    callLog: idf.callLog,
    calls: () => (fs.existsSync(idf.callLog) ? fs.readFileSync(idf.callLog, 'utf8').split('\n').filter(Boolean) : []),
    buildDir: (target, appId) => path.join(root, 'apps/watch', '.gea', 'build', target, 'app-builds', appId),
    env: {
      PATH: `${idf.bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: root,
      IDF_PATH: idf.dir,
      IDF_PYTHON_ENV_PATH: idf.pythonEnv,
      GEA_TEST_CALL_LOG: idf.callLog,
      GEA_ESP32_MANUAL_BOOT_GRACE_SECONDS: '0',
      GEA_ESP32_FLASH_RETRY_SECONDS: '5'
    }
  }
}

// A fake ESP-IDF: tools/idf.py + idf_tools.py exist, and the venv python is a
// shell script that answers `idf_tools.py export` and records everything else.
function createFakeEspIdf(root) {
  const dir = path.join(root, 'esp-idf')
  const pythonEnv = path.join(root, 'python_env')
  const bin = path.join(root, 'fake-bin')
  const callLog = path.join(root, 'calls.log')
  fs.mkdirSync(path.join(dir, 'tools', 'cmake'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'tools', 'idf.py'), '# fake idf.py\n')
  fs.writeFileSync(path.join(dir, 'tools', 'idf_tools.py'), '# fake idf_tools.py\n')
  fs.writeFileSync(path.join(dir, 'tools', 'cmake', 'version.cmake'), 'set(IDF_VERSION_MAJOR 6)\nset(IDF_VERSION_MINOR 0)\nset(IDF_VERSION_PATCH 2)\n')
  writeExecutable(path.join(pythonEnv, 'bin', 'python'), `#!/usr/bin/env bash
log="\${GEA_TEST_CALL_LOG:-/dev/null}"
printf 'python %s\\n' "$*" >> "$log"
if [ "$2" = "export" ]; then
  printf 'OPENOCD_SCRIPTS=/fake/openocd/scripts\\nESP_ROM_ELF_DIR=/fake/rom\\nIDF_PYTHON_ENV_PATH=${pythonEnv}\\nPATH=/fake/idf-tools/bin:$PATH\\n'
  exit 0
fi
prev=""; build=""
for a in "$@"; do if [ "$prev" = "-B" ]; then build="$a"; fi; prev="$a"; done
case " $* " in *" reconfigure "*) mkdir -p "$build" && : > "$build/CMakeCache.txt" ;; esac
exit 0
`)
  writeExecutable(path.join(bin, 'cmake'), `#!/usr/bin/env bash
log="\${GEA_TEST_CALL_LOG:-/dev/null}"
printf 'cmake %s\\n' "$*" >> "$log"
if [ "$1" = "--build" ]; then
  mkdir -p "$2/bootloader" "$2/partition_table"
  printf 'app-image' > "$2/gea_embedded.bin"
  printf 'bootloader' > "$2/bootloader/bootloader.bin"
  printf 'partitions' > "$2/partition_table/partition-table.bin"
  printf 'otadata' > "$2/ota_data_initial.bin"
  printf '{ "flash_settings": { "flash_mode": "dio", "flash_freq": "80m", "flash_size": "16MB" } }' > "$2/flasher_args.json"
fi
exit 0
`)
  writeExecutable(path.join(bin, 'ninja'), '#!/usr/bin/env bash\nexit 0\n')
  return { dir, pythonEnv, bin, callLog }
}

export function createFakeToolchain(t, options = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-cli-tools-'))
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }))

  const versions = {
    npm: '10.0.0',
    python3: 'Python 3.11.0',
    cmake: 'cmake version 3.30.0',
    ...options.versions
  }
  for (const [name, output] of Object.entries(versions)) {
    writeExecutable(path.join(bin, name), `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(output)}\n`)
  }
  return {
    bin,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`
    }
  }
}

export function capture() {
  const out = []
  const err = []
  const raw = []
  return {
    out,
    err,
    raw,
    io: {
      stdout: (line) => out.push(String(line)),
      stderr: (line) => err.push(String(line)),
      output: { write: (chunk) => raw.push(Buffer.from(chunk)) },
      // Tests never hit the network: the setup wizard's best-effort ESP-IDF
      // "latest release" lookup is stubbed to behave like it is unreachable,
      // so version resolution deterministically falls back to the pin.
      // Tests exercising the lookup itself pass their own fetchEspIdfLatest.
      fetchEspIdfLatest: async () => '',
      // Nor a serial port: GEADEV probes answer "no reply" unless a test
      // passes its own probeSerialDevice.
      probeSerialDevice: async () => ({ ok: false, error: 'not probed in tests' })
    }
  }
}

export function scriptedPrompt(answers) {
  const questions = []
  const writes = []
  return {
    questions,
    writes,
    async ask(question) {
      questions.push(question)
      return answers.length > 0 ? answers.shift() : ''
    },
    write(line) {
      writes.push(String(line))
    },
    async close() {}
  }
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export function mkdir(root, relativePath) {
  fs.mkdirSync(path.join(root, relativePath), { recursive: true })
}

export function writeExecutable(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, body)
  fs.chmodSync(filePath, 0o755)
}

function writeApp(root, relativePath, app) {
  const appDir = path.join(root, relativePath)
  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(path.join(appDir, 'index.tsx'), 'export const value = 1\n')
  writeJson(path.join(appDir, 'package.json'), {
    name: `@fixture/${app.id}`,
    private: true,
    gea: {
      id: app.id,
      name: app.name,
      entry: 'index.tsx',
      runtime: 'gea',
      targets: app.targets
    }
  })
}

function chipCatalog() {
  return {
    schemaVersion: 1,
    chips: {
      co5300: {
        label: 'CO5300 AMOLED display controller',
        category: 'display',
        interfaces: ['qspi'],
        adapters: { 'esp32-idf': { mcus: ['esp32s3'], bindingSources: ['chip_bindings/displays/co5300.cpp'] } },
        configuration: [
          { path: 'width', label: 'Display width', type: 'integer', min: 1, max: 4096 },
          { path: 'height', label: 'Display height', type: 'integer', min: 1, max: 4096 },
          { path: 'spiHost', label: 'SPI host', type: 'choice', values: ['spi2', 'spi3'], default: 'spi2' },
          { path: 'pins.cs', label: 'Chip-select pin', type: 'pin' },
          { path: 'pins.pclk', label: 'Pixel-clock pin', type: 'pin' },
          { path: 'pins.data0', label: 'QSPI data 0 pin', type: 'pin' },
          { path: 'pins.data1', label: 'QSPI data 1 pin', type: 'pin' },
          { path: 'pins.data2', label: 'QSPI data 2 pin', type: 'pin' },
          { path: 'pins.data3', label: 'QSPI data 3 pin', type: 'pin' },
          { path: 'pins.reset', label: 'Display reset pin', type: 'pin' },
          { path: 'pins.te', label: 'Tearing-effect pin', type: 'pin', optional: true }
        ]
      },
      ft3168: {
        label: 'FT3168 capacitive touch controller',
        category: 'touch',
        interfaces: ['i2c'],
        adapters: { 'esp32-idf': { mcus: ['esp32s3'], bindingSources: ['chip_bindings/touch/ft3168.cpp'] } },
        configuration: [
          { path: 'pins.reset', label: 'Touch reset pin', type: 'pin' },
          { path: 'pins.interrupt', label: 'Touch interrupt pin', type: 'pin' }
        ]
      },
      axp2101: {
        label: 'AXP2101 power-management controller',
        category: 'power',
        interfaces: ['i2c'],
        adapters: { 'esp32-idf': { mcus: ['esp32s3'], bindingSources: ['chip_bindings/power/axp2101.cpp'] } },
        configuration: []
      },
      qmi8658: {
        label: 'QMI8658 inertial measurement unit',
        category: 'imu',
        interfaces: ['i2c'],
        adapters: { 'esp32-idf': { mcus: ['esp32s3'], bindingSources: ['chip_bindings/imu/qmi8658.cpp'] } },
        configuration: []
      },
      es8311: {
        label: 'ES8311 audio codec',
        category: 'audio',
        interfaces: ['i2s'],
        adapters: { 'esp32-idf': { mcus: ['esp32s3'], bindingSources: ['chip_bindings/audio/es8311.cpp'] } },
        configuration: [
          { path: 'pins.mclk', label: 'I2S master-clock pin', type: 'pin' },
          { path: 'pins.bclk', label: 'I2S bit-clock pin', type: 'pin' },
          { path: 'pins.ws', label: 'I2S word-select pin', type: 'pin' },
          { path: 'pins.dout', label: 'I2S data-out pin', type: 'pin' },
          { path: 'pins.din', label: 'I2S data-in pin', type: 'pin' },
          { path: 'pins.powerAmplifier', label: 'Power-amplifier enable pin', type: 'pin', optional: true }
        ]
      },
      rm690b0: {
        label: 'RM690B0 AMOLED display controller',
        category: 'display',
        interfaces: ['qspi'],
        adapters: {},
        configuration: []
      }
    }
  }
}
