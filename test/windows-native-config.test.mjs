// The Windows target's manifest surface: per-target native sources, providers
// and TypeScript project, its include/library/resource extensions, the typed
// native build settings, and compiler-plugin composition.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

import { appSummary, normalizeApp, validateApp } from '../src/manifest.mjs'
import { resolveBuildConfig } from '../src/build-config.mjs'
import { geatscPluginsOf, runWindows } from '../src/windows/adapter.mjs'

function write(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`)
}

function appRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gea-windows-config-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(path.join(root, 'index.ts'), '')
  return root
}

test('windows target native sources, includes, libraries, resources, providers and tsconfig resolve', (t) => {
  const root = appRoot(t)
  write(path.join(root, 'windows', 'window.cpp'))
  write(path.join(root, 'windows', 'host.mm'))
  write(path.join(root, 'windows', 'include', 'thing.h'))
  write(path.join(root, 'build', 'assets', 'a.bin'), 'a')
  write(path.join(root, 'tsconfig.native.json'), '{}')
  const windows = {
    nativeSources: ['windows/window.cpp', 'windows/host.mm', 'windows/host.mm', 'notes.txt'],
    nativeIncludeDirectories: ['windows/include'],
    nativeSystemLibraries: ['windowscodecs'],
    nativeResources: { assets: 'build/assets' },
    providers: { gles: { directory: 'build/renderer' } },
    tsconfig: 'tsconfig.native.json',
  }
  const app = normalizeApp(root, { name: 'fixture', gea: { entry: 'index.ts', targets: { windows } } })
  assert.deepEqual(validateApp(app), [])
  const summary = appSummary({ projectRoot: root }, app)
  assert.deepEqual(summary.targetNativeSourcePaths.windows, [path.join(root, 'windows', 'window.cpp'), path.join(root, 'windows', 'host.mm')])
  assert.deepEqual(summary.nativeLink.windows.nativeIncludeDirectories, [path.join(root, 'windows', 'include')])
  assert.deepEqual(summary.nativeLink.windows.nativeSystemLibraries, ['windowscodecs'])
  assert.deepEqual(summary.nativeResources.windows, { assets: path.join(root, 'build', 'assets') })
  assert.deepEqual(summary.targetConfig.windows.providers, windows.providers)
  assert.equal(summary.targetConfig.windows.tsconfig, 'tsconfig.native.json')
})

test('windows-only native settings are refused elsewhere and checked for existence', (t) => {
  const root = appRoot(t)
  write(path.join(root, 'native', 'engine.cpp'))
  const macos = normalizeApp(root, { name: 'fixture', gea: { entry: 'index.ts', targets: { macos: { nativeSources: ['native/engine.cpp'], providers: { gles: 'x' }, tsconfig: 'tsconfig.json' } } } })
  const errors = validateApp(macos)
  assert.ok(errors.some((error) => /gea\.targets\.macos\.nativeSources is supported only by windows/.test(error)), errors.join('\n'))
  assert.ok(errors.some((error) => /gea\.targets\.macos\.providers is supported only by windows/.test(error)), errors.join('\n'))
  assert.ok(errors.some((error) => /gea\.targets\.macos\.tsconfig is supported only by windows/.test(error)), errors.join('\n'))
  const missing = normalizeApp(root, { name: 'fixture', gea: { entry: 'index.ts', targets: { windows: { nativeSources: ['native/absent.cpp'], tsconfig: 'absent.json', providers: 'dir' } } } })
  const missingErrors = validateApp(missing)
  assert.ok(missingErrors.some((error) => /nativeSources entry does not exist: native\/absent\.cpp/.test(error)), missingErrors.join('\n'))
  assert.ok(missingErrors.some((error) => /tsconfig does not exist: absent\.json/.test(error)), missingErrors.join('\n'))
  assert.ok(missingErrors.some((error) => /providers must be an object keyed by capability/.test(error)), missingErrors.join('\n'))
})

test('typed native build settings are validated against the target catalog', (t) => {
  const root = appRoot(t)
  write(path.join(root, 'build-config.json'), {
    platforms: { windows: { supported: ['native.lto', 'native.ltoJobs', 'native.arch', 'native.pgo', 'native.ltoCache'], defaults: { native: { lto: 'off', arch: 'default' } } } },
  })
  const resolve = (native) => resolveBuildConfig({
    app: normalizeApp(root, { name: 'fixture', gea: { entry: 'index.ts', targets: { windows: { build: { native } } } } }),
    platform: 'windows',
    targetsRoot: root,
  })
  const resolved = resolve({ lto: 'thin', ltoJobs: 8, arch: 'AVX2', ltoCache: 'build/lto' })
  assert.deepEqual(resolved.settings.native, { lto: 'thin', arch: 'AVX2', ltoJobs: 8, ltoCache: 'build/lto' })
  assert.throws(() => resolve({ lto: 'full' }), /native\.lto must be off \| thin/)
  assert.throws(() => resolve({ ltoJobs: -1 }), /native\.ltoJobs must be a non-negative safe integer/)
  assert.throws(() => resolve({ ltoCache: 3 }), /native\.ltoCache must be string/)
  assert.throws(() => resolve({ debugInfo: true }), /not supported by windows/)
})

test('windows compiler plugins compose: dependencies, then the app plugin, then gea.compilerPlugins', (t) => {
  const root = appRoot(t)
  write(path.join(root, 'package.json'), { name: 'fixture', dependencies: { 'with-plugin': '1.0.0', 'without-plugin': '1.0.0' } })
  write(path.join(root, 'node_modules', 'with-plugin', 'package.json'), { name: 'with-plugin', exports: { './geatsc-plugin': './plugin.mjs' } })
  write(path.join(root, 'node_modules', 'with-plugin', 'plugin.mjs'), 'export default {}\n')
  write(path.join(root, 'node_modules', 'without-plugin', 'package.json'), { name: 'without-plugin' })
  write(path.join(root, 'geatsc-plugin.mjs'), 'export default {}\n')
  write(path.join(root, 'plugins', 'extra.mjs'), 'export default {}\n')
  const app = normalizeApp(root, { name: 'fixture', gea: { entry: 'index.ts', compilerPlugins: ['plugins/extra.mjs'], targets: { windows: true } } })
  const require = createRequire(path.join(root, 'package.json'))
  assert.deepEqual(geatscPluginsOf(app, require), [
    path.join(root, 'node_modules', 'with-plugin', 'plugin.mjs'),
    path.join(root, 'geatsc-plugin.mjs'),
    path.join(root, 'plugins', 'extra.mjs'),
  ])
})

test('a windows prebuild runs in the app folder before the target script', (t) => {
  const root = appRoot(t)
  write(path.join(root, 'package.json'), { name: 'fixture' })
  const target = path.join(root, 'node_modules', '@geastack', 'windows')
  write(path.join(target, 'package.json'), { name: '@geastack/windows', version: '0.0.0' })
  write(path.join(target, 'targets', 'win32', 'build-windows.mjs'), "import fs from 'node:fs'\nfs.writeFileSync('script-saw.txt', fs.existsSync('prebuilt.txt') ? 'prebuilt' : 'missing')\n")
  write(path.join(root, 'prebuild.mjs'), "import fs from 'node:fs'\nfs.writeFileSync('prebuilt.txt', process.cwd())\n")
  const app = normalizeApp(root, { name: 'fixture', gea: { id: 'fixture', entry: 'index.ts', targets: { windows: { prebuild: 'node prebuild.mjs' } } } })
  const lines = []
  const dry = runWindows({ app, env: { ...process.env }, dryRun: true, stdout: (line) => lines.push(line) })
  assert.equal(dry, 0)
  assert.equal(lines[0], 'node prebuild.mjs')
  assert.ok(!fs.existsSync(path.join(root, 'prebuilt.txt')), 'a dry run runs nothing')
  assert.equal(runWindows({ app, env: { ...process.env, GEA_TARGETS_ROOT: root }, stdout: () => {} }), 0)
  assert.equal(fs.readFileSync(path.join(root, 'prebuilt.txt'), 'utf8'), root)
  assert.equal(fs.readFileSync(path.join(root, 'script-saw.txt'), 'utf8'), 'prebuilt')
  const failing = normalizeApp(root, { name: 'fixture', gea: { id: 'fixture', entry: 'index.ts', targets: { windows: { prebuild: 'node -e "process.exit(3)"' } } } })
  assert.throws(() => runWindows({ app: failing, env: { ...process.env, GEA_TARGETS_ROOT: root }, stdout: () => {} }), /App prebuild exited 3/)
})
