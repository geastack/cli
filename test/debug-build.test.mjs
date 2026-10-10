import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runGea } from '../src/gea.mjs'
import { nativeDebugBuildOf } from '../src/debugger.mjs'
import { capture, createFixture, readJson, writeExecutable } from './helpers/fixture.mjs'

const stack = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const debuggerDir = path.join(stack, 'debugger')

function debugFixture(t) {
  const fixture = createFixture(t)
  // Exercise the target's public capability catalogue while keeping all build
  // tools isolated in the fixture.
  fs.copyFileSync(path.join(stack, 'targets/build-config.json'),
    path.join(fixture.installed('targets'), 'build-config.json'))
  return fixture
}

const debugEnvOf = (fixture) => ({
  ...fixture.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${fixture.env.PATH}`,
  GEA_DEBUGGER_DIR: debuggerDir,
  GEA_COMPILER: fixture.installed('compiler'),
  GEA_COMPILER_DIR: fixture.installed('compiler'),
  GEA_PLUGIN_DIR: fixture.installed('geatsc-plugin-gea'),
  GEA_TARGETS_ROOT: fixture.installed('targets'),
  GEA_CORE_DIR: fixture.installed('core'),
  GEA_ENGINE_DIR: fixture.installed('engine'),
  GEA_HOST_DIR: fixture.installed('host'),
  GEA_ELEMENTS_DIR: fixture.installed('elements'),
  GEA_GEAOS_PACKAGE_DIR: fixture.installed('geaos'),
  GEA_CHIPS_DIR: fixture.installed('chips')
})

test('macOS debug builds hand instrumentation and editable CSS to the build adapter without launching', async (t) => {
  const fixture = debugFixture(t)
  const appleRoot = path.join(fixture.root, 'apple')
  const report = path.join(fixture.root, 'debug-build.json')
  const recorder = path.join(fixture.root, 'record-debug.cjs')
  fs.writeFileSync(recorder, `
    const fs = require('node:fs')
    fs.writeFileSync(process.env.GEA_TEST_REPORT, JSON.stringify({
      app: process.argv[2],
      instrumentation: process.env.GEA_NATIVE_DEBUGGER,
      source: process.env.GEA_DEBUGGER_NATIVE_SOURCE,
      symbols: process.env.GEA_MACOS_DEBUG_INFO,
      optimization: process.env.GEA_MACOS_OPT_LEVEL,
      compiler: process.env.GEA_COMPILER,
      config: JSON.parse(fs.readFileSync(process.env.GEA_BUILD_CONFIG_JSON, 'utf8'))
    }))
  `)
  writeExecutable(path.join(appleRoot, 'targets/macos/build-macos.sh'),
    '#!/usr/bin/env bash\nexec "$GEA_TEST_NODE" "$GEA_TEST_RECORDER" "$@"\n')
  const manifestFile = path.join(fixture.appDir, 'package.json')
  const before = fs.readFileSync(manifestFile, 'utf8')
  for (const sourceFlags of [[], ['--no-debug-sources']]) {
    const captured = capture()
    const env = {
      ...debugEnvOf(fixture),
      GEA_APPLE_ROOT: appleRoot,
      GEA_TEST_NODE: process.execPath,
      GEA_TEST_RECORDER: recorder,
      GEA_TEST_REPORT: report
    }
    assert.equal(await runGea(['build', '--target', 'macos', '--debug', ...sourceFlags], {
      ...captured.io, env, cwd: fixture.appDir
    }), 0)
    const built = readJson(report)
    assert.equal(built.app, 'watch')
    assert.equal(built.instrumentation, '1')
    assert.equal(built.source, path.join(debuggerDir, 'native/macos.mm'))
    assert.equal(built.compiler, fixture.installed('compiler'), 'an explicit compiler wins over the contributor default')
    assert.equal(built.config.settings.compiler.staticCssRules, false)
    assert.equal(built.config.settings.compiler.staticCssTape, false)
    assert.equal(built.symbols, sourceFlags.length === 0 ? 'full' : undefined)
    assert.equal(built.optimization, sourceFlags.length === 0 ? '-O0' : undefined)
    assert.doesNotMatch(captured.out.join('\n'), /CDP|Chrome|Native Sources/)
    assert.equal(fs.readFileSync(manifestFile, 'utf8'), before)
  }
})

test('ESP32 debug builds configure native inspection without flashing or opening a device', async (t) => {
  const fixture = debugFixture(t)
  const python = path.join(fixture.env.IDF_PYTHON_ENV_PATH, 'bin/python')
  fs.writeFileSync(python, fs.readFileSync(python, 'utf8').replace(
    'prev=""; build=""',
    'printf "GEA_GEATSC_DEBUG_INFO=%s\\n" "$GEA_GEATSC_DEBUG_INFO" >> "$log"\nprev=""; build=""'))
  const captured = capture()
  assert.equal(await runGea(['build', '--debug', '--board', 'amoled', '--configure-only'], {
    ...captured.io, env: debugEnvOf(fixture), cwd: fixture.appDir
  }), 0)
  const calls = fixture.calls().join('\n')
  assert.match(calls, /GEA_NATIVE_DEBUGGER=1/)
  assert.match(calls, /GEA_GEATSC_DEBUG_INFO=1/)
  const config = readJson(path.join(fixture.buildDir('esp32-s3-touch-amoled-2.06', 'watch'), 'gea-build-config.json'))
  assert.equal(config.settings.compiler.staticCssRules, false)
  assert.equal(config.settings.compiler.staticCssTape, false)
  assert.equal(config.settings.compiler.generatedCodeOptimization, 'Og')
  assert.equal(config.settings.renderer.recordInlinePositions, true)
  assert.doesNotMatch(calls, /esptool|monitor|flash_id/)
  assert.doesNotMatch(captured.out.join('\n'), /CDP|Chrome/)
})

test('debug builds reject unsupported targets and invalid source flags before executing a tool', async (t) => {
  const fixture = createFixture(t)
  for (const target of ['web', 'ios', 'windows', 'rp2350'])
    await assert.rejects(runGea(['build', '--debug', '--target', target], {
      ...capture().io, env: debugEnvOf(fixture), cwd: fixture.appDir
    }), /debug builds support native macOS and ESP32/)
  await assert.rejects(runGea(['build', '--debug', '--target', 'macos', '--debug-sources=false'], {
    ...capture().io, env: debugEnvOf(fixture), cwd: fixture.appDir
  }), /without a value/)
  assert.deepEqual(fixture.calls(), [])
})

test('shared native debug build facts retain explicit paths and leave the input app unchanged', () => {
  const app = { id: 'demo', runtime: 'gea', targets: {}, manifest: { targets: {} } }
  const before = structuredClone(app)
  const sourceEnv = {
    GEA_DEBUGGER_DIR: debuggerDir,
    GEA_COMPILER: '/chosen/compiler',
    GEA_GEATSC_BIN: '/chosen/compiler/dist/cli.js'
  }
  const built = nativeDebugBuildOf(app, 'macos', sourceEnv)
  assert.equal(built.env.GEA_GEATSC_BIN, sourceEnv.GEA_GEATSC_BIN)
  assert.equal(built.app.targets.macos, true)
  assert.equal(built.app.manifest.targets.macos.build.compiler.staticCssTape, false)
  assert.deepEqual(app, before)
  assert.equal(sourceEnv.GEA_NATIVE_DEBUGGER, undefined)
})
