import fs from 'node:fs'
import path from 'node:path'
import { resolveInstalledPackageDir } from './context.mjs'
import { resolveAppCapabilities } from './esp32/capabilities.mjs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { CliError, ExitCode } from './errors.mjs'

// Public, typed build choices. Reachability/packing facts are compiler output,
// never user options. Keep option names independent of application identity.
export const buildOptions = {
  'compiler.moduleGraph': { values: ['auto', 'compile', 'only', 'disabled'] },
  'compiler.allowAny': { type: 'boolean' },
  'compiler.staticCssRules': { type: 'boolean' },
  'compiler.staticCssTape': { type: 'boolean' },
  'compiler.staticCssTapeMinChunk': { type: 'integer', min: 1 },
  'compiler.translationUnits': { values: ['default', 'per-file', 'balanced'] },
  'compiler.storeRelowering': { type: 'boolean' },
  'compiler.generatedCodeOptimization': { values: ['O0', 'O1', 'O2', 'O3', 'Os', 'Og'] },
  'compiler.numberPrecision': { values: ['float64', 'float32'], macro: 'GEA_NUMBER_FLOAT', encode: v => v === 'float32' ? 1 : undefined },
  'ui.styleStorage': { values: ['inline', 'shared'], macro: 'GEA_EMBEDDED_SHARED_STYLES', encode: v => Number(v === 'shared') },
  'renderer.fuseReplayFlush': { boardScoped: true, type: 'boolean', macro: 'GEA_EMBEDDED_DISPLAY_FUSE_REPLAY_FLUSH' },
  'renderer.subtreeRevealChecks': { type: 'boolean', macro: 'GEA_EMBEDDED_SUBTREE_REVEAL_CHECK' },
  'renderer.recordInlinePositions': { type: 'boolean', macro: 'GEA_EMBEDDED_SKIP_POSITION_INLINE_RECORD', encode: v => Number(!v) },
  'renderer.adaptiveCoalescing': { type: 'boolean', macro: 'GEA_EMBEDDED_FLUSH_ADAPTIVE_COALESCE' },
  'renderer.broadDirtyBounds': { type: 'boolean', macro: 'GEA_EMBEDDED_BROAD_DIRTY_BBOX' },
  'display.framebufferStream': { values: ['independent', 'continuous'], macro: 'GEA_EMBEDDED_DISPLAY_CO5300_FRAMEBUFFER_CS_HELD_STREAM', encode: v => Number(v === 'continuous') },
  'display.presentStream': { boardScoped: true, values: ['independent', 'continuous'], macro: 'GEA_EMBEDDED_DISPLAY_CO5300_PRESENT_CS_HELD_STREAM', encode: v => Number(v === 'continuous') },
  'display.flushPoolBytes': { type: 'integer', macro: 'GEA_EMBEDDED_DISPLAY_FLUSH_POOL_BYTES' },
  'diagnostics.performanceCounters': { type: 'boolean', macro: 'GEA_EMBEDDED_PERF' },
  'diagnostics.frameTiming': { type: 'boolean', macro: 'GEA_EMBEDDED_FRAME_SCHEDULER_PERF_LITE' },
  'services.wifi': { values: ['auto', 'disabled'], macro: 'GEA_EMBEDDED_WIFI_DISABLED', encode: v => v === 'disabled' ? 1 : undefined },
}
const macros = new Map(Object.entries(buildOptions).filter(([, spec]) => spec.macro).map(([key, spec]) => [spec.macro, key]))
const removedEnvironment = {
  GEA_WEB_DEVICE_PIXEL_RATIO: 'cssDevicePixelRatio',
  GEA_WEB_DIRECT_CANVAS: null,
  GEA_WEB_DIRECT_CANVAS_CODEGEN: null,
  GEA_THREE_MODULE_GRAPH: 'compiler.moduleGraph',
  GEA_THREE_MODULE_GRAPH_ONLY: 'compiler.moduleGraph',
  GEA_THREE_MODULE_GRAPH_COMPILE: 'compiler.moduleGraph',
  GEA_VITE_MODULE_GRAPH: 'compiler.moduleGraph',
  GEA_STATIC_CSS_RULES: 'compiler.staticCssRules',
  GEA_STATIC_CSS_TAPE: 'compiler.staticCssTape',
  GEA_STATIC_CSS_TAPE_MIN_CHUNK: 'compiler.staticCssTapeMinChunk',
  GEA_CPP_TRANSLATION_UNITS: 'compiler.translationUnits',
  GEA_PER_FILE_UNITS: 'compiler.translationUnits',
  GEA_SKIP_STORE_RELOWER: 'compiler.storeRelowering',
  GEA_EMBEDDED_NUMBER_F32: 'compiler.numberPrecision',
  GEA_CPP_MINIMAL_GLOBAL_OBJECT: 'compiler (obsolete: no active consumer)',
  GEA_EMBEDDED_DIRECT_CANVAS_CONTEXT: null,
  GEA_BOARD_OPTIMIZE_BOUNCING_BALLS_JSX: 'renderer / compiler',
  GEA_BOARD_GEATSC_OPTIMIZATION: 'compiler.generatedCodeOptimization',
  GEA_BOARD_FUSE_REPLAY_FLUSH: 'renderer.fuseReplayFlush',
  GEA_BOARD_ADAPTIVE_COALESCE: 'renderer.adaptiveCoalescing',
  GEA_BOARD_BROAD_DIRTY_BBOX: 'renderer.broadDirtyBounds',
  GEA_BOARD_FRAMEBUFFER_CS_HELD_STREAM: 'display.framebufferStream',
  GEA_BOARD_PRESENT_CS_HELD_STREAM: 'display.presentStream',
}
for (const [macro, key] of macros) removedEnvironment[macro] ||= key

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function fail(message) { throw new CliError(message, ExitCode.usage) }
export function buildVariable(key) { return 'GEA_BUILD_' + key.replaceAll('.', '_').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() }
function flatten(raw, where) {
  if (raw === undefined) return {}
  if (!isObject(raw)) fail(`${where} must be an object`)
  const out = {}
  for (const [group, fields] of Object.entries(raw)) {
    if (!Object.keys(buildOptions).some(key => key.startsWith(group + '.'))) fail(`Unknown setting ${where}.${group}`)
    if (!isObject(fields)) fail(`${where}.${group} must be an object`)
    for (const [name, value] of Object.entries(fields)) {
      const key = group + '.' + name
      const spec = buildOptions[key]
      if (!spec) fail(`Unknown setting ${where}.${key}`)
      if (spec.values ? !spec.values.includes(value)
        : spec.type === 'integer' ? !Number.isSafeInteger(value) || value < (spec.min || 0)
        : typeof value !== spec.type) {
        fail(`${where}.${key} must be ${spec.values?.join(' | ') || (spec.type === 'integer' ? 'a non-negative safe integer' : spec.type)}`)
      }
      out[key] = value
    }
  }
  return out
}
function ratio(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(`${where} must be a positive number`)
  return value
}
function boardDefines(raw, where) {
  if (raw === undefined) return []
  if (!isObject(raw)) fail(`${where} must be an object`)
  return Object.entries(raw).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        !['string', 'number', 'boolean'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value)) ||
        /[;\n\r]/.test(String(value))) fail(`${where}.${name} must be a valid native define`)
    return `${name}=${typeof value === 'boolean' ? Number(value) : value}`
  })
}
export function validateBuildManifest(manifest) {
  flatten(manifest.build, 'gea.build')
  for (const [platform, target] of Object.entries(manifest.targets || {})) {
    if (!isObject(target)) continue
    const where = 'gea.targets.' + platform
    flatten(target.build, where + '.build')
    if (target.cssDevicePixelRatio !== undefined) ratio(target.cssDevicePixelRatio, where + '.cssDevicePixelRatio')
    if (target.boards === undefined) continue
    if (!isObject(target.boards)) fail(where + '.boards must be an object')
    for (const [id, board] of Object.entries(target.boards)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id) || !isObject(board)) fail(where + '.boards must contain board IDs mapped to objects')
      for (const key of Object.keys(board)) if (!['build', 'cssDevicePixelRatio', 'defines'].includes(key)) fail(`Unknown setting ${where}.boards.${id}.${key}`)
      boardDefines(board.defines, where + '.boards.' + id + '.defines')
      flatten(board.build, where + '.boards.' + id + '.build')
      if (board.cssDevicePixelRatio !== undefined) ratio(board.cssDevicePixelRatio, where + '.boards.' + id + '.cssDevicePixelRatio')
    }
  }
}
export function assertNoBuildEnvironment(env = {}) {
  for (const [name, key] of Object.entries(removedEnvironment)) {
    if (env[name] !== undefined && key === null) fail(`${name} was removed; canvas runtime selection is inferred from app capabilities. Remove the override.`)
    if (env[name] !== undefined) fail(`${name} is no longer a build override. Remove it from the environment and set gea.build.${key} in package.json (or a target/board override).`)
  }
}
function unflatten(flat) {
  const out = {}
  for (const [key, value] of Object.entries(flat)) {
    const [group, name] = key.split('.')
    ;(out[group] ||= {})[name] = value
  }
  return out
}
function legacyValue(key, literal) {
  const spec = buildOptions[key]
  // Legacy input remains readable until apps migrate. A typed setting and a
  // raw define for the same choice are always an error, even if they agree.
  for (const value of spec.values || (spec.type === 'boolean' ? [false, true] : [Number(literal)])) {
    if (String(spec.encode ? spec.encode(value) : typeof value === 'boolean' ? Number(value) : value) === literal) return value
  }
  fail(`Invalid legacy define for ${key}; use its typed package.json build setting`)
}
export function resolveBuildConfig({ app, platform, board = '', targetsRoot = '', targetBase = '', env = {}, capabilities }) {
  assertNoBuildEnvironment(env)
  const manifest = app?.manifest || {}
  validateBuildManifest(manifest)
  const catalogPath = path.join(targetsRoot, 'build-config.json')
  const catalog = targetsRoot && fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : {}
  const boardConfig = catalog.boards?.[board] || catalog.boards?.[targetBase] || {}
  const platformConfig = catalog.platforms?.[platform] || {}
  const supported = new Set([...(platformConfig.supported || []), ...(boardConfig.supported || [])])
  const flat = {}, origins = {}, inapplicable = {}, explicit = new Set()
  const apply = (raw, origin, user = false, base = false) => {
    for (const [key, value] of Object.entries(flatten(raw, origin))) {
      if (user && !supported.has(key)) {
        // A shared base may express panel preferences for several drivers.
        // Keep unsupported driver preferences out of native defines, and expose
        // their provenance in `gea config`. A concrete board override must work.
        if (base && buildOptions[key].boardScoped) {
          inapplicable[key] = { value, origin: origin + '.' + key, reason: 'unsupported by selected target' }
          continue
        }
        fail(`${origin}.${key} is not supported by ${board || platform}; it would have no effect`)
      }
      flat[key] = value; origins[key] = origin + '.' + key
      if (user) explicit.add(key)
    }
  }
  apply(platformConfig.defaults, 'platform defaults')
  apply(boardConfig.defaults, 'board defaults')
  const target = isObject(manifest.targets?.[platform]) ? manifest.targets[platform] : {}
  const boardOverride = target.boards?.[board] || {}
  apply(manifest.build, 'gea.build', true, true)
  apply(target.build, 'gea.targets.' + platform + '.build', true, true)
  apply(boardOverride.build, 'gea.targets.' + platform + '.boards.' + board + '.build', true)
  const passthroughDefines = []
  const seenLegacy = new Set()
  const overrides = boardDefines(boardOverride.defines, 'gea.targets.' + platform + '.boards.' + board + '.defines')
  const overridden = new Set(overrides.map(define => define.split('=')[0]))
  const selectedDefines = [...(app?.defines || []).filter(define => !overridden.has(define.split('=')[0])), ...overrides]
  for (const define of selectedDefines) {
    const [name, ...rest] = define.split('=')
    if (name === 'GEA_CPP_MINIMAL_GLOBAL_OBJECT' || name === 'GEA_EMBEDDED_NUMBER_F32') fail(`${name} is obsolete and has no active consumer; remove it from gea.defines`)
    if (['GEA_EMBEDDED_DIRECT_CANVAS_CONTEXT', 'GEA_EMBEDDED_FULL_BOOT_SERVICES'].includes(name)) fail(`${name} is inferred from app capabilities; remove it from gea.defines`)
    const key = macros.get(name)
    if (!key || !supported.has(key)) { passthroughDefines.push(define); continue }
    if (seenLegacy.has(key)) fail(`Conflicting legacy definitions for ${key}`)
    seenLegacy.add(key)
    if (explicit.has(key)) fail(`gea.defines.${name} conflicts with ${origins[key]}; keep only the typed setting`)
    flat[key] = legacyValue(key, rest.length ? rest.join('=') : '1')
    origins[key] = 'gea.defines.' + name + ' (legacy)'
  }
  for (const [key, allowed] of Object.entries(boardConfig.constraints || {})) {
    if (flat[key] !== undefined && !allowed.includes(flat[key])) fail(`${board} requires ${key} to be ${allowed.join(' | ')}`)
  }
  let cssDevicePixelRatio = app?.cssDevicePixelRatio || boardConfig.cssDevicePixelRatio || platformConfig.cssDevicePixelRatio || 0
  let cssOrigin = app?.cssDevicePixelRatio ? 'gea.cssDevicePixelRatio' : boardConfig.cssDevicePixelRatio ? 'board defaults' : platformConfig.cssDevicePixelRatio ? 'platform defaults' : 'target default'
  for (const [value, origin] of [[target.cssDevicePixelRatio, 'gea.targets.' + platform], [boardOverride.cssDevicePixelRatio, 'gea.targets.' + platform + '.boards.' + board]]) {
    if (value !== undefined) { cssDevicePixelRatio = ratio(value, origin + '.cssDevicePixelRatio'); cssOrigin = origin + '.cssDevicePixelRatio' }
  }
  const defines = [...passthroughDefines]
  const managedDefines = []
  for (const [key, value] of Object.entries(flat)) {
    const spec = buildOptions[key]
    if (!spec.macro) continue
    const encoded = spec.encode ? spec.encode(value) : typeof value === 'boolean' ? Number(value) : value
    if (encoded !== undefined) managedDefines.push(`${spec.macro}=${encoded}`)
  }
  const inferred = inferRuntime(app, platform, capabilities, boardConfig.inference || platformConfig.inference)
  if ((boardConfig.inference || platformConfig.inference)?.canvasOnly) {
    managedDefines.push(`GEA_EMBEDDED_DIRECT_CANVAS_CONTEXT=${Number(inferred.runtime.mode === 'canvas')}`)
    if (platform === 'esp32' && inferred.runtime.mode === 'canvas' && !managedDefines.some(d => d.startsWith('GEA_EMBEDDED_WIFI_DISABLED='))) managedDefines.push('GEA_EMBEDDED_WIFI_DISABLED=1')
  }
  defines.push(...managedDefines)
  return { platform, board, inferred, settings: unflatten(flat), origins, inapplicable, defines, managedDefines, cssDevicePixelRatio, cssDevicePixelRatioOrigin: cssOrigin }
}

function inferRuntime(app, platform, capabilities, target) {
  let reason = 'target does not implement the canvas-only runtime'
  if (target?.canvasOnly) {
    const features = capabilities?.features || []
    const proofs = features.filter(f => f.startsWith('runtime-analysis-'))
    const native = app?.manifest || {}
    const platformNative = typeof native.targets?.[platform] === 'object' ? native.targets[platform] : {}
    const extensionKeys = ['nativeSources', 'componentDirs', 'componentRequires', 'linkOptions', 'compilerPlugins']
    if (!proofs.length || proofs.some(p => p !== 'runtime-analysis-v1')) reason = 'no supported complete runtime analysis'
    else if (!features.includes('runtime-canvas-only')) reason = 'app requires the full runtime or source analysis is inconclusive'
    else if (extensionKeys.some(key => native[key]?.length || platformNative[key]?.length)) reason = 'native extensions cannot be proven independent of the UI and services'
    else if (capabilities.network || capabilities.ble || capabilities.audio || (capabilities.bindings || []).some(b => b !== 'display')) reason = 'app requires host services outside the canvas runtime'
    else return { runtime: { mode: 'canvas', reason: 'complete source analysis proves direct display drawing without UI or host services' } }
  }
  return { runtime: { mode: 'full', reason } }
}

// Use the same analyzer for inspection and script targets as ESP32 preparation.
// Missing/older proof markers retain the full runtime; no app name is involved.
export function resolveAppBuildConfig(input) {
  const { app, platform, env = {} } = input
  let capabilities = input.capabilities
  if (!capabilities && app?.runtime === 'gea' && ['esp32', 'web'].includes(platform)) {
    capabilities = resolveAppCapabilities({
      compilerPackageDir: env.GEA_COMPILER_DIR || resolveInstalledPackageDir('@geastack/compiler', app.root),
      pluginPackageDir: env.GEA_PLUGIN_DIR || resolveInstalledPackageDir('@geastack/geatsc-plugin-gea', app.root),
      env,
    }, app, { env })
  }
  return resolveBuildConfig({ ...input, capabilities })
}

export function renderBuildCmake(resolved) {
  const lines = ['# Generated by gea from package.json. Do not edit.']
  for (const [key, value] of Object.entries(flatten(resolved.settings, 'resolved build'))) {
    lines.push(`set(${buildVariable(key)} "${typeof value === 'boolean' ? Number(value) : value}")`)
  }
  lines.push(`set(GEA_APP_CANVAS_ONLY "${Number(resolved.inferred?.runtime.mode === 'canvas')}")`)
  return lines.join('\n') + '\n'
}
export function writeBuildConfig(buildDir, resolved) {
  fs.mkdirSync(buildDir, { recursive: true })
  const cmake = path.join(buildDir, 'gea-build-config.cmake')
  const json = path.join(buildDir, 'gea-build-config.json')
  const contents = JSON.stringify(resolved, null, 2) + '\n'
  for (const [file, value] of [[cmake, renderBuildCmake(resolved)], [json, contents]]) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== value) fs.writeFileSync(file, value)
  }
  return { cmake, json, hash: createHash('sha256').update(contents).digest('hex') }
}

// Script-based native targets receive the same resolved file as CMake targets.
// The path is an internal handoff; option values are never inherited from env.
export function nativeScriptBuildEnv(app, platform, env, { dryRun = false, buildDir, board = '', targetsRoot = '' } = {}) {
  if (!targetsRoot) {
    targetsRoot = env.GEA_TARGETS_ROOT || resolveInstalledPackageDir('@geastack/targets', app.root)
  }
  const resolved = resolveAppBuildConfig({ app, platform, board, targetsRoot, env })
  const directory = buildDir || path.join(app.root, '.gea', 'build', platform)
  const json = dryRun ? path.join(directory, 'gea-build-config.json') : writeBuildConfig(directory, resolved).json
  return { ...env, GEA_BUILD_CONFIG_JSON: json, GEA_CLI_BIN: fileURLToPath(new URL('../bin/gea.mjs', import.meta.url)) }
}


// A debug launch can compile a Gea app natively without adding a deployment
// target to its source manifest. Keep authored CSS available for inspection.
export function appForNativeDebugger(app, platform) {
  if (!['macos', 'esp32'].includes(platform)) fail('Native debugger build configuration requires macOS or ESP32')
  const manifest = app.manifest || {}
  const target = isObject(manifest.targets?.[platform]) ? manifest.targets[platform] : {}
  const debugTarget = { ...target, build: { ...target.build, ...(platform === 'esp32' ? { renderer: { ...target.build?.renderer, recordInlinePositions: true } } : {}), compiler: {
    ...target.build?.compiler, staticCssRules: false, staticCssTape: false, ...(platform === 'esp32' ? { generatedCodeOptimization: 'Og' } : {})
  } } }
  if (isObject(target.boards)) debugTarget.boards = Object.fromEntries(Object.entries(target.boards).map(([name, value]) => [name, isObject(value) ? { ...value, build: { ...value.build, ...(platform === 'esp32' ? { renderer: { ...value.build?.renderer, recordInlinePositions: true } } : {}), compiler: { ...value.build?.compiler, staticCssRules: false, staticCssTape: false, ...(platform === 'esp32' ? { generatedCodeOptimization: 'Og' } : {}) } } } : value]))
  return { ...app, targets: { ...app.targets, [platform]: true }, manifest: {
    ...manifest, targets: { ...manifest.targets, [platform]: debugTarget }
  } }
}
