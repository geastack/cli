import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const realCollectionRoot = path.resolve(cliRoot, '..')

export function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-cli-fixture-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  mkdir(root, 'core/packages/core/bin')
  mkdir(root, 'compiler')
  mkdir(root, 'examples/apps/watch')
  mkdir(root, 'examples/apps/web-only')
  mkdir(root, 'examples/apps/bad-app')
  mkdir(root, 'companion/examples/gea-companion')
  mkdir(root, 'simulator/targets/web')
  mkdir(root, 'targets/scripts/boards')
  mkdir(root, 'android/targets/android')
  mkdir(root, 'apple/targets/macos')
  mkdir(root, 'apple/targets/ios')
  mkdir(root, 'geaos')

  writeJson(path.join(root, 'core/packages/core/package.json'), {
    name: '@geastack/core',
    version: '0.1.0'
  })
  writeExecutable(path.join(root, 'core/packages/core/bin/gea-embedded.mjs'), '#!/usr/bin/env node\n')
  writeJson(path.join(root, 'compiler/package.json'), {
    name: '@geastack/compiler',
    version: '0.1.0'
  })

  writeApp(root, 'examples/apps/watch', {
    id: 'watch',
    name: 'Watch',
    targets: { web: true, esp32: true, rp2350: false, geaos: true, macos: true, ios: true, android: true }
  })
  writeApp(root, 'examples/apps/web-only', {
    id: 'web-only',
    name: 'Web Only',
    targets: { web: true, esp32: false, rp2350: false, geaos: false, macos: false, ios: false, android: false }
  })
  writeJson(path.join(root, 'examples/apps/bad-app/package.json'), {
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
  writeApp(root, 'companion/examples/gea-companion', {
    id: 'gea-companion',
    name: 'Gea Companion',
    targets: { macos: true, web: false, esp32: false, rp2350: false, geaos: false, ios: false, android: false }
  })

  writeExecutable(path.join(root, 'simulator/targets/web/dev-web.mjs'), '#!/usr/bin/env node\n')
  writeExecutable(path.join(root, 'simulator/targets/web/build-web.sh'), '#!/usr/bin/env bash\n')
  writeExecutable(path.join(root, 'targets/scripts/board'), '#!/usr/bin/env bash\n')
  writeExecutable(path.join(root, 'android/targets/android/build-android.sh'), '#!/usr/bin/env bash\n')
  writeExecutable(path.join(root, 'apple/targets/macos/build-macos.sh'), '#!/usr/bin/env bash\n')
  writeExecutable(path.join(root, 'apple/targets/ios/build-ios.sh'), '#!/usr/bin/env bash\n')

  writeJson(path.join(root, 'targets/scripts/boards/targets.json'), {
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
    fs.writeFileSync(path.join(root, 'targets/boards.json'), '{ this is not json\n')
  } else {
    writeJson(path.join(root, 'targets/boards.json'), {
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
    appDir: path.join(root, 'examples/apps/watch'),
    badAppDir: path.join(root, 'examples/apps/bad-app')
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
