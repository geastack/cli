import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { normalizeApp } from '../src/manifest.mjs'
import { resolveBuildConfig, renderBuildCmake, validateBuildManifest, writeBuildConfig, nativeScriptBuildEnv } from '../src/build-config.mjs'
import { prepareEsp32Build } from '../src/esp32/build.mjs'
import { createFixture, writeJson } from './helpers/fixture.mjs'
import { createContext } from '../src/context.mjs'
import { parseArgs } from '../src/args.mjs'
import { runGea } from '../src/gea.mjs'

// Unit tests own their data; source-checkout migration checks are opt-in.
const suite = createFixture({ after })
const targetsRoot = suite.installed('targets')
const base = {
  supported: ['compiler.generatedCodeOptimization', 'compiler.numberPrecision',
    'renderer.bandedUi', 'renderer.fuseReplayFlush', 'renderer.subtreeRevealChecks', 'renderer.recordInlinePositions',
    'renderer.adaptiveCoalescing', 'renderer.broadDirtyBounds', 'display.framebufferStream',
    'display.presentStream', 'diagnostics.performanceCounters', 'diagnostics.frameTiming'],
  defaults: {
    compiler: { generatedCodeOptimization: 'Os', numberPrecision: 'float64' },
    renderer: { fuseReplayFlush: false, subtreeRevealChecks: true, recordInlinePositions: true, adaptiveCoalescing: false, broadDirtyBounds: false },
    diagnostics: { performanceCounters: true, frameTiming: true },
    display: { framebufferStream: 'independent', presentStream: 'independent' }
  },
  cssDevicePixelRatio: 1.5
}
writeJson(path.join(targetsRoot, 'build-config.json'), {
  platforms: {
    esp32: { supported: ['ui.styleStorage', 'compiler.staticCssTapeMinChunk'], defaults: { ui: { styleStorage: 'inline' } } },
    macos: { supported: ['compiler.allowAny'], defaults: { compiler: { allowAny: true } } }
  },
  boards: {
    'esp32-s3-touch-amoled-1.8': base,
    'esp32-s3-touch-amoled-2.06': { ...base, inference: { canvasOnly: true }, supported: [...base.supported, 'display.flushPoolBytes'] },
    'esp32-s3-touch-amoled-2.41': { ...base, constraints: { 'display.framebufferStream': ['independent'] } },
    'esp32-s3-lilygo-t-display-s3-long': { ...base, constraints: { 'renderer.fuseReplayFlush': [false] } }
  }
})
const integrationTargetsRoot = process.env.GEA_TEST_TARGETS_ROOT
const examplesRoot = process.env.GEA_TEST_EXAMPLES_ROOT
const integration = { skip: !integrationTargetsRoot || !examplesRoot ? 'Set GEA_TEST_TARGETS_ROOT and GEA_TEST_EXAMPLES_ROOT for source migration checks' : false }
const board = 'esp32-s3-touch-amoled-1.8'
function app(manifest = {}) {
  return normalizeApp('/application', { name: 'arbitrary-name', gea: { id: 'anything', entry: 'index.tsx', targets: { esp32: true }, ...manifest } })
}
const resolve = (manifest, other = {}) => resolveBuildConfig({ app: app(manifest), platform: 'esp32', board, targetsRoot, ...other })

test('root, platform and board overrides preserve false, zero and leaf provenance', () => {
  const result = resolve({
    build: { renderer: { fuseReplayFlush: true, subtreeRevealChecks: false } },
    targets: { esp32: {
      build: { renderer: { fuseReplayFlush: false } },
      boards: { [board]: { build: { diagnostics: { performanceCounters: false } } } }
    }}
  })
  assert.equal(result.settings.renderer.fuseReplayFlush, false)
  assert.equal(result.settings.renderer.subtreeRevealChecks, false)
  assert.equal(result.origins['renderer.fuseReplayFlush'], 'gea.targets.esp32.build.renderer.fuseReplayFlush')
  assert.equal(result.origins['diagnostics.performanceCounters'], 'gea.targets.esp32.boards.' + board + '.build.diagnostics.performanceCounters')
  assert.ok(result.defines.includes('GEA_EMBEDDED_DISPLAY_FUSE_REPLAY_FLUSH=0'))
  const zero = resolve({ build: { display: { flushPoolBytes: 0 } } }, { board: 'esp32-s3-touch-amoled-2.06' })
  assert.equal(zero.settings.display.flushPoolBytes, 0)
})

test('invalid and unsupported choices cannot silently disappear', () => {
  for (const build of [
    { renderer: { fusedReplayFlush: true } },
    { renderer: { fuseReplayFlush: 1 } },
    { compiler: { numberPrecision: 'fast' } },
    { compiler: { staticCssTapeMinChunk: 0 } },
    { compiler: { staticCssTapeMinChunk: 2.5 } },
    { mystery: {} }
  ]) assert.throws(() => resolve({ build }), /Unknown|must be/)
  assert.throws(() => resolve({ build: { runtime: { framework: 'canvas' } } }), /Unknown/)
  assert.throws(() => validateBuildManifest({ targets: { esp32: { boards: { [board]: { buidl: {} } } } } }), /Unknown/)
  assert.throws(() => resolve({ build: { display: { framebufferStream: 'continuous' } } }, { board: 'esp32-s3-touch-amoled-2.41' }), /requires/)
  assert.throws(() => resolve({ build: { renderer: { fuseReplayFlush: true } } }, { board: 'esp32-s3-lilygo-t-display-s3-long' }), /requires/)
})

test('legacy define migration is explicit and duplicate authorities are errors', () => {
  const result = resolve({ defines: { GEA_EMBEDDED_SHARED_STYLES: 1 } })
  assert.equal(result.settings.ui.styleStorage, 'shared')
  assert.match(result.origins['ui.styleStorage'], /legacy/)
  assert.equal(result.defines.filter(d => d.startsWith('GEA_EMBEDDED_SHARED_STYLES=')).length, 1)
  assert.throws(() => resolve({ defines: { GEA_EMBEDDED_SHARED_STYLES: 1 }, build: { ui: { styleStorage: 'shared' } } }), /conflicts/)
  const full = resolve({ build: { compiler: { numberPrecision: 'float64' } } })
  assert.ok(!full.defines.some(d => d.startsWith('GEA_NUMBER_FLOAT')))
})

test('shell tuning cannot override even an identical manifest value', () => {
  for (const name of ['GEA_EMBEDDED_NUMBER_F32', 'GEA_BOARD_OPTIMIZE_BOUNCING_BALLS_JSX', 'GEA_NUMBER_FLOAT', 'GEA_STATIC_CSS_RULES', 'GEA_SKIP_STORE_RELOWER']) {
    assert.throws(() => resolve({}, { env: { [name]: '0' } }), /package.json/)
  }
  assert.deepEqual(resolve({}, { env: { PATH: '/toolchain', HOME: '/home' } }), resolve({}))
})

test('board-specific DPR overrides platform and app DPR', () => {
  const result = resolve({ cssDevicePixelRatio: 2, targets: { esp32: { cssDevicePixelRatio: 1.5, boards: { [board]: { cssDevicePixelRatio: 1 } } } } })
  assert.equal(result.cssDevicePixelRatio, 1)
  assert.match(result.cssDevicePixelRatioOrigin, /boards/)
})

test('all migrated example settings are independent of application identity', integration, () => {
  const cases = {
    'bouncing-balls-jsx': [board, 'esp32-s3-touch-amoled-2.06', 'esp32-s3-touch-amoled-2.41', 'esp32-s3-lilygo-t-display-s3-long'],
    'bubble-grid': ['esp32-s3-touch-amoled-2.06'],
    'canvas-3d': ['esp32-s3-touch-amoled-2.06'],
    'gea3d-cube': ['esp32-s3-touch-amoled-2.06'],
    'sky-hop-jsx': ['esp32-s3-touch-amoled-2.06'],
    'css-3d-cube': ['rp2350-tufty-2350']
  }
  for (const [name, boards] of Object.entries(cases)) {
    const pkg = JSON.parse(fs.readFileSync(path.join(examplesRoot, 'apps', name, 'package.json')))
    for (const id of boards) {
      const input = { app: normalizeApp('/app', pkg), platform: id.startsWith('rp') ? 'rp2350' : 'esp32', board: id, targetsRoot: integrationTargetsRoot }
      const before = resolveBuildConfig(input)
      const renamed = resolveBuildConfig({ ...input, app: normalizeApp('/renamed', { ...pkg, name: 'renamed', gea: { ...pkg.gea, id: 'renamed' } }) })
      assert.deepEqual(before, renamed, name + ' on ' + id)
      assert.equal(renderBuildCmake(before), renderBuildCmake(renamed))
    }
  }
})

test('bouncing balls keeps the qualified 1.8 profile and panel restrictions on other boards', integration, () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(examplesRoot, 'apps/bouncing-balls-jsx/package.json')))
  const balls = normalizeApp('/app', pkg)
  const result = resolveBuildConfig({ app: balls, platform: 'esp32', board, targetsRoot: integrationTargetsRoot })
  assert.equal(result.settings.compiler.generatedCodeOptimization, 'O2')
  assert.equal(result.settings.compiler.numberPrecision, 'float32')
  assert.equal(result.settings.ui.styleStorage, 'shared')
  assert.deepEqual(result.settings.renderer, { fuseReplayFlush: true, subtreeRevealChecks: false, recordInlinePositions: false, adaptiveCoalescing: true, broadDirtyBounds: true })
  assert.deepEqual(result.settings.diagnostics, { performanceCounters: false, frameTiming: false })
  const large = resolveBuildConfig({ app: balls, platform: 'esp32', board: 'esp32-s3-touch-amoled-2.41', targetsRoot: integrationTargetsRoot })
  assert.equal(large.settings.display.framebufferStream, 'independent')
  assert.equal(large.settings.renderer.broadDirtyBounds, false)
  // Naming an unconfigured app "bouncing-balls-jsx" never enables the profile.
  assert.equal(resolve({ id: 'bouncing-balls-jsx' }).settings.renderer.fuseReplayFlush, false)
})

test('bouncing balls inherits its common ESP32 settings on every catalog board', integration, () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(examplesRoot, 'apps/bouncing-balls-jsx/package.json')))
  const balls = normalizeApp('/app', pkg)
  const catalog = JSON.parse(fs.readFileSync(path.join(integrationTargetsRoot, 'targets.json')))
  for (const [id, entry] of Object.entries(catalog)) {
    if (entry.appPlatform !== 'esp32') continue
    const resolved = resolveBuildConfig({ app: balls, platform: 'esp32', board: id, targetsRoot: integrationTargetsRoot })
    assert.equal(resolved.settings.compiler.numberPrecision, 'float32', id)
    assert.equal(resolved.settings.renderer.subtreeRevealChecks, false, id)
    assert.equal(resolved.settings.renderer.recordInlinePositions, false, id)
    assert.deepEqual(resolved.settings.diagnostics, { performanceCounters: false, frameTiming: false }, id)
    for (const key of ['compiler.numberPrecision', 'renderer.subtreeRevealChecks', 'renderer.recordInlinePositions', 'diagnostics.performanceCounters', 'diagnostics.frameTiming']) {
      assert.equal(resolved.origins[key], 'gea.targets.esp32.build.' + key, id)
    }
  }
})

test('shared panel preferences apply only to supported drivers; explicit overrides must be supported', () => {
  const build = { renderer: { fuseReplayFlush: true }, display: { presentStream: 'continuous' } }
  const result = resolve({ build }, { board: 'generic-esp32' })
  assert.equal(result.settings.renderer, undefined)
  assert.equal(result.settings.display, undefined)
  assert.ok(!result.defines.some(d => /FUSE_REPLAY_FLUSH|PRESENT_CS_HELD_STREAM/.test(d)))
  assert.deepEqual(result.inapplicable['renderer.fuseReplayFlush'], {
    value: true, origin: 'gea.build.renderer.fuseReplayFlush', reason: 'unsupported by selected target'
  })
  assert.equal(result.inapplicable['display.presentStream'].value, 'continuous')
  assert.throws(() => resolve({ targets: { esp32: { boards: { 'generic-esp32': { build } } } } }, { board: 'generic-esp32' }), /not supported/)
  const long = 'esp32-s3-lilygo-t-display-s3-long'
  assert.throws(() => resolve({ build }, { board: long }), /requires/)
  const allowed = resolve({ build, targets: { esp32: { boards: { [long]: { build: { renderer: { fuseReplayFlush: false } } } } } } }, { board: long })
  assert.equal(allowed.settings.renderer.fuseReplayFlush, false)
  assert.equal(allowed.settings.display.presentStream, 'continuous')
})

test('bouncing balls declares each identical build choice once, with only differing board exceptions', integration, () => {
  const esp32 = JSON.parse(fs.readFileSync(path.join(examplesRoot, 'apps/bouncing-balls-jsx/package.json'))).gea.targets.esp32
  // A board exception exists only to differ from the base. Two boards that both
  // need the same non-base value (a panel constraint they share) each declare it,
  // so identical choices are checked against the base, not against each other.
  for (const [id, entry] of Object.entries(esp32.boards)) {
    for (const [group, values] of Object.entries(entry.build)) {
      for (const [key, value] of Object.entries(values)) {
        const base = esp32.build[group]?.[key]
        assert.notDeepEqual(value, base, `${group}.${key}=${JSON.stringify(value)} on ${id} repeats the base value`)
      }
    }
  }
  assert.equal(esp32.build.renderer.fuseReplayFlush, true)
  assert.equal(esp32.build.display.presentStream, 'continuous')
  assert.equal(esp32.boards['esp32-s3-lilygo-t-display-s3-long'].build.renderer.fuseReplayFlush, false)
  assert.equal(esp32.boards['esp32-s3-touch-amoled-2.41'].build.display.presentStream, 'independent')
  assert.equal(esp32.boards['esp32-s3-touch-amoled-2.06'], undefined)
})

test('configuration fingerprints change on options, reset removed options, and preserve unchanged mtimes', (t) => {
  const fixture = createFixture(t)
  const result = resolve({ build: { compiler: { generatedCodeOptimization: 'O2' } } })
  const first = writeBuildConfig(fixture.root, result)
  const mtime = fs.statSync(first.cmake).mtimeMs
  assert.equal(writeBuildConfig(fixture.root, result).hash, first.hash)
  assert.equal(fs.statSync(first.cmake).mtimeMs, mtime)
  const reset = writeBuildConfig(fixture.root, resolve({}))
  assert.notEqual(reset.hash, first.hash)
  assert.match(fs.readFileSync(reset.cmake, 'utf8'), /OPTIMIZATION "Os"/)
  assert.doesNotMatch(fs.readFileSync(reset.cmake, 'utf8'), /OPTIMIZATION "O2"/)
})

test('gea config uses the same resolver as real ESP32 preparation', async (t) => {
  const fixture = createFixture(t)
  fs.copyFileSync(path.join(targetsRoot, 'build-config.json'), path.join(fixture.installed('targets'), 'build-config.json'))
  const pkgFile = path.join(fixture.appDir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgFile))
  pkg.gea.build = { ui: { styleStorage: 'shared' }, renderer: { subtreeRevealChecks: false } }
  writeJson(pkgFile, pkg)
  const output = []
  await runGea(['config', '--target', 'esp32-s3-touch-amoled-2.06'], { cwd: fixture.appDir, env: {}, stdout: x => output.push(x) })
  const reported = JSON.parse(output.at(-1))
  const ctx = createContext(parseArgs([]), {}, fixture.appDir)
  const prepared = prepareEsp32Build({ ctx, selection: { target: 'esp32-s3-touch-amoled-2.06', targetDir: fixture.esp32Target }, app: normalizeApp(fixture.appDir, pkg), env: {}, dryRun: true })
  const built = JSON.parse(fs.readFileSync(path.join(prepared.buildDir, 'gea-build-config.json')))
  assert.deepEqual(reported, built)
  assert.ok(prepared.idfArgs.some(arg => arg.startsWith('-DGEA_BUILD_CONFIG_HASH=')))
  assert.match(prepared.childEnv.GEA_EMBEDDED_APP_DEFINES, /GEA_EMBEDDED_SUBTREE_REVEAL_CHECK=0/)
})

test('board build glue has no example-name conditionals or named optimization presets', integration, () => {
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['build', 'managed_components', 'node_modules', '.git'].includes(entry.name) || entry.name.startsWith('build-')) continue
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(p)
      else if (entry.name === 'CMakeLists.txt' || entry.name.endsWith('.cmake')) {
        const source = fs.readFileSync(p, 'utf8')
        assert.doesNotMatch(source, /GEA_EMBEDDED_APP\s+(?:STREQUAL|MATCHES)\s+"[^"]+"/, p)
        assert.doesNotMatch(source, /GEA_BOARD_OPTIMIZE_BOUNCING_BALLS_JSX/, p)
      }
    }
  }
  visit(path.join(integrationTargetsRoot, 'targets'))
})


test('native WASM canvas and macOS module-graph choices survive renaming', integration, () => {
  for (const [name, platform] of [['canvas-3d', 'web'], ['gea3d-cube', 'web'], ['three-angle-metal', 'macos']]) {
    const pkg = JSON.parse(fs.readFileSync(path.join(examplesRoot, 'apps', name, 'package.json')))
    const before = resolveBuildConfig({ app: normalizeApp('/app', pkg), platform, targetsRoot: integrationTargetsRoot })
    const after = resolveBuildConfig({ app: normalizeApp('/renamed', { ...pkg, gea: { ...pkg.gea, id: 'renamed' } }), platform, targetsRoot: integrationTargetsRoot })
    assert.deepEqual(after, before)
    assert.equal(before.settings.runtime, undefined)
    assert.equal(before.settings.compiler?.runtime, undefined)
    if (name === 'three-angle-metal') assert.equal(before.settings.compiler.moduleGraph, 'compile')
  }
})

test('obsolete controls are rejected instead of advertised as optimizations', () => {
  assert.throws(() => resolve({ defines: { GEA_CPP_MINIMAL_GLOBAL_OBJECT: 1 } }), /obsolete/)
  assert.throws(() => resolve({ build: { compiler: { globalObject: 'minimal' } } }), /Unknown/)
  assert.throws(() => resolve({ defines: ['GEA_EMBEDDED_SHARED_STYLES=0', 'GEA_EMBEDDED_SHARED_STYLES=1'] }), /Conflicting/)
})

test('script adapters resolve the app installation and retain its configuration provenance', () => {
  const application = normalizeApp(suite.appDir, { name: 'desktop-app', gea: { targets: { macos: true } } })
  const env = nativeScriptBuildEnv(application, 'macos', {})
  const config = JSON.parse(fs.readFileSync(env.GEA_BUILD_CONFIG_JSON))
  assert.equal(config.settings.compiler.allowAny, true)
  assert.equal(config.origins['compiler.allowAny'], 'platform defaults.compiler.allowAny')
})

test('removing a DPR override restores the board value in generated state', () => {
  const withOverride = writeBuildConfig(suite.root, resolve({ cssDevicePixelRatio: 2 }))
  const reset = writeBuildConfig(suite.root, resolve({}))
  assert.notEqual(reset.hash, withOverride.hash)
  assert.equal(JSON.parse(fs.readFileSync(reset.json)).cssDevicePixelRatio, 1.5)
})

const canvasProof = { features: ['runtime-analysis-v1', 'runtime-canvas-only'], bindings: ['display'], network: false, audio: false, ble: false }

test('canvas runtime selection is a derived fact, never an app option', () => {
  for (const build of [
    { runtime: { directCanvasContext: true } }, { compiler: { runtime: 'direct-canvas' } },
    { runtime: { framework: 'canvas' } }, { services: { boot: 'minimal' } },
  ]) assert.throws(() => resolve({ build }), /Unknown/)
  assert.throws(() => resolve({ defines: { GEA_EMBEDDED_DIRECT_CANVAS_CONTEXT: 1 } }), /inferred/)
  assert.throws(() => resolve({}, { env: { GEA_WEB_DIRECT_CANVAS: '1' } }), /inferred/)
  const options = { board: 'esp32-s3-touch-amoled-2.06', capabilities: canvasProof }
  const direct = resolve({}, options)
  assert.equal(direct.inferred.runtime.mode, 'canvas')
  assert.ok(direct.managedDefines.includes('GEA_EMBEDDED_DIRECT_CANVAS_CONTEXT=1'))
  assert.match(renderBuildCmake(direct), /set\(GEA_APP_CANVAS_ONLY "1"\)/)
  assert.deepEqual(resolve({ id: 'renamed' }, options), direct)
  assert.equal(resolve({}, { capabilities: canvasProof }).inferred.runtime.mode, 'full', 'unsupported board')
  for (const capabilities of [
    {}, { ...canvasProof, features: [] }, { ...canvasProof, features: ['runtime-canvas-only', 'runtime-analysis-v2'] },
    { ...canvasProof, network: true }, { ...canvasProof, audio: true }, { ...canvasProof, ble: true },
    { ...canvasProof, bindings: ['display', 'storage'] },
  ]) {
    const full = resolve({}, { ...options, capabilities })
    assert.equal(full.inferred.runtime.mode, 'full')
    assert.ok(full.managedDefines.includes('GEA_EMBEDDED_DIRECT_CANVAS_CONTEXT=0'))
    assert.match(renderBuildCmake(full), /set\(GEA_APP_CANVAS_ONLY "0"\)/)
  }
  for (const manifest of [{ nativeSources: ['custom.cpp'] }, { compilerPlugins: ['custom.mjs'] }, { targets: { esp32: { componentDirs: ['native'] } } }, { targets: { esp32: { componentRequires: ['native'] } } }, { targets: { esp32: { linkOptions: ['-lnative'] } } }]) {
    assert.equal(resolve(manifest, options).inferred.runtime.mode, 'full')
  }
})

test('inference changes the configuration fingerprint when source requirements change', () => {
  const options = { board: 'esp32-s3-touch-amoled-2.06' }
  const direct = writeBuildConfig(suite.root, resolve({}, { ...options, capabilities: canvasProof }))
  const full = writeBuildConfig(suite.root, resolve({}, { ...options, capabilities: { ...canvasProof, features: ['runtime-analysis-v1'] } }))
  assert.notEqual(full.hash, direct.hash)
  assert.equal(JSON.parse(fs.readFileSync(full.json)).inferred.runtime.mode, 'full')
  assert.doesNotMatch(fs.readFileSync(full.cmake, 'utf8'), /CANVAS_ONLY "1"/)
})

test('board native defines replace root values only for the selected target', () => {
  const manifest = {
    defines: { PANEL_WIDTH: 502, HAS_POWER: 1 },
    cssDevicePixelRatio: 2,
    targets: { esp32: { boards: { [board]: {
      defines: { PANEL_WIDTH: 480, HAS_POWER: false }, cssDevicePixelRatio: 1.5
    } } } }
  }
  const selected = resolve(manifest)
  assert.ok(selected.defines.includes('PANEL_WIDTH=480'))
  assert.ok(selected.defines.includes('HAS_POWER=0'))
  assert.equal(selected.defines.filter(d => d.startsWith('PANEL_WIDTH=')).length, 1)
  assert.equal(selected.cssDevicePixelRatio, 1.5)
  const other = resolve(manifest, { board: 'esp32-s3-touch-amoled-2.06' })
  assert.ok(other.defines.includes('PANEL_WIDTH=502'))
  assert.ok(other.defines.includes('HAS_POWER=1'))
  assert.equal(other.cssDevicePixelRatio, 2)
  for (const defines of [[], { 'BAD-NAME': 1 }, { PANEL_WIDTH: '480;INJECT=1' }]) {
    assert.throws(() => validateBuildManifest({ targets: { esp32: { boards: { [board]: { defines } } } } }), /define|object/)
  }
})

test('banded rendering is an app manifest opt-in', () => {
  for (const enabled of [false, true]) {
    const result = resolve({ build: { renderer: { bandedUi: enabled } } })
    assert.equal(result.settings.renderer.bandedUi, enabled)
    assert.ok(result.defines.includes(`GEA_EMBEDDED_DISPLAY_BANDED_UI=${Number(enabled)}`))
  }
  assert.throws(() => resolve({ build: { renderer: { bandedUi: 1 } } }), /boolean/)
})
