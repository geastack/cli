import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-cli-fixture-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  writeJson(path.join(root, 'package.json'), {
    name: 'fixture-project',
    private: true,
    workspaces: ['apps/*']
  })

  const installed = (name) => path.join(root, 'node_modules', '@geastack', name)
  for (const name of ['chips', 'compiler', 'elements', 'engine', 'geaos', 'host', 'geatsc-plugin-gea']) {
    writeJson(path.join(installed(name), 'package.json'), {
      name: `@geastack/${name}`,
      version: '0.1.0'
    })
  }
  writeJson(path.join(installed('chips'), 'catalog.json'), {
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
  })
  writeJson(path.join(installed('core'), 'package.json'), {
    name: '@geastack/core',
    version: '0.1.2'
  })
  writeExecutable(path.join(installed('core'), 'bin/gea-embedded.mjs'), '#!/usr/bin/env node\n')
  writeJson(path.join(installed('targets'), 'package.json'), {
    name: '@geastack/targets',
    version: '0.1.1'
  })
  writeExecutable(path.join(installed('targets'), 'scripts/board'), '#!/usr/bin/env bash\n')

  writeApp(root, 'apps/watch', {
    id: 'watch',
    name: 'Watch',
    targets: { web: true, esp32: true, rp2350: false, geaos: true, macos: true, ios: true, android: true }
  })
  writeApp(root, 'apps/web-only', {
    id: 'web-only',
    name: 'Web Only',
    targets: { web: true, esp32: false, rp2350: false, geaos: false, macos: false, ios: false, android: false }
  })
  writeJson(path.join(root, 'apps/bad-app/package.json'), {
    name: '@fixture/bad-app',
    private: true,
    gea: {
      id: 'bad-app',
      name: 'Bad App',
      entry: 'missing.tsx',
      runtime: 'gea',
      targets: { web: true }
    }
  })

  writeJson(path.join(installed('targets'), 'scripts/boards/targets.json'), {
    'esp32-s3-touch-amoled-2.06': {
      adapter: 'esp32-idf',
      targetPath: 'targets/esp32-s3-touch-amoled-2.06',
      appPlatform: 'esp32'
    },
    'rp2350-tufty-2350': {
      adapter: 'rp2350-pico',
      targetPath: 'targets/rp2350-tufty-2350',
      appPlatform: 'rp2350',
      compatibleAppPlatforms: ['esp32']
    },
    geaos: {
      adapter: 'geaos-linux',
      targetPath: 'targets/geaos',
      appPlatform: 'geaos'
    }
  })
  if (options.invalidBoardsJson) {
    fs.writeFileSync(path.join(installed('targets'), 'boards.json'), '{ this is not json\n')
  } else {
    writeJson(path.join(installed('targets'), 'boards.json'), {
      amoled: {
        target: 'esp32-s3-touch-amoled-2.06',
        adapter: 'esp32-idf'
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

  return {
    root,
    appDir: path.join(root, 'apps/watch'),
    badAppDir: path.join(root, 'apps/bad-app'),
    installed
  }
}

export function createFakeToolchain(t, options = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-cli-tools-'))
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }))

  const versions = {
    npm: '10.0.0',
    python3: 'Python 3.11.0',
    'idf.py': 'ESP-IDF v6.0.1',
    emcc: 'emcc (Emscripten gcc/clang-like replacement) 4.0.0',
    xcodebuild: 'Xcode 26.6\nBuild version 17A400',
    adb: 'Android Debug Bridge version 1.0.41',
    javac: 'javac 24.0.0',
    ...options.versions
  }
  for (const [name, output] of Object.entries(versions)) {
    writeExecutable(path.join(bin, name), `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(output)}\n`)
  }
  return {
    bin,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      ANDROID_HOME: fakeAndroidSdk(bin)
    }
  }
}

function fakeAndroidSdk(bin) {
  const sdk = path.join(bin, 'android-sdk')
  fs.mkdirSync(path.join(sdk, 'platforms/android-35'), { recursive: true })
  fs.mkdirSync(path.join(sdk, 'build-tools/35.0.0'), { recursive: true })
  fs.writeFileSync(path.join(sdk, 'platforms/android-35/android.jar'), '')
  return sdk
}

export function capture() {
  const out = []
  const err = []
  return {
    out,
    err,
    io: {
      stdout: (line) => out.push(String(line)),
      stderr: (line) => err.push(String(line))
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
