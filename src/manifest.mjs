import path from 'node:path'

import { loadBoardConfig, normalizeBoardConfig } from './boards/config.mjs'
import { loadTargets } from './boards/targets.mjs'
import { CliError, ExitCode, fail } from './errors.mjs'
import { exists, findUp, isDirectory, listDirectories, readJson } from './fs-utils.mjs'

// App discovery. A Gea app is a package.json with a `gea` block; the project
// root, its apps/ and examples/ children, and any GEA_EXTRA_APP_DIRS entries
// are searched. The normalized shape is the one every consumer (IDF, the
// Pico SDK, geaos, the bundle writer, the launcher generator) reads.

export function readPathList(value) {
  return String(value || '').split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)
}

export function discoverApps(ctx) {
  const roots = [ctx.projectRoot, ...readPathList(ctx.env?.GEA_EXTRA_APP_DIRS)]
  const seen = new Set()
  const apps = []
  for (const root of roots) {
    for (const app of discoverAppsInRoot(root)) {
      if (seen.has(app.root) || apps.some((known) => known.id === app.id)) continue
      seen.add(app.root)
      apps.push(app)
    }
  }
  return apps.sort((a, b) => a.launcher.order - b.launcher.order || a.id.localeCompare(b.id))
}

export function discoverAppsInRoot(root) {
  if (!isDirectory(root)) return []
  const candidates = [
    path.join(root, 'package.json'),
    ...listDirectories(path.join(root, 'apps')).map((dir) => path.join(dir, 'package.json')),
    ...listDirectories(path.join(root, 'examples')).map((dir) => path.join(dir, 'package.json'))
  ]
  return candidates.flatMap((manifestPath) => {
    if (!exists(manifestPath)) return []
    try {
      const packageJson = readJson(manifestPath)
      if (!packageJson.gea) return []
      return [normalizeApp(path.dirname(manifestPath), packageJson)]
    } catch {
      return []
    }
  })
}

export function resolveRequestedApp(ctx, parsed, positionals = []) {
  const requested = parsed.options.app || positionals[0]
  if (requested) {
    const id = String(Array.isArray(requested) ? requested.at(-1) : requested)
    const app = findAppById(ctx, id)
    if (!app) fail(`Could not find Gea app '${id}' in ${ctx.projectRoot}.`, ExitCode.usage)
    return app
  }
  const current = findCurrentApp(ctx.cwd)
  if (current) return current
  fail('No app selected. Pass --app <id> or run inside a Gea app folder.', ExitCode.usage)
}

export function findAppById(ctx, id) {
  return discoverApps(ctx).find((app) => app.id === id) || null
}

export function findCurrentApp(cwd) {
  const packageDir = findUp(cwd, (dir) => hasGeaManifest(path.join(dir, 'package.json')))
  if (!packageDir) return null
  return normalizeApp(packageDir, readJson(path.join(packageDir, 'package.json')))
}

export function validateApp(app) {
  const errors = []
  if (!app.id) errors.push('gea.id is required')
  if (!app.entry) errors.push('gea.entry is required')
  if (app.entry && !exists(path.join(app.root, app.entry))) errors.push(`gea.entry does not exist: ${app.entry}`)
  if (!app.runtime) errors.push('gea.runtime is required or must default to gea')
  if (!app.targets || typeof app.targets !== 'object' || Array.isArray(app.targets)) errors.push('gea.targets must be an object')
  for (const source of app.nativeSources) {
    if (!exists(path.join(app.root, source))) errors.push(`gea.nativeSources entry does not exist: ${source}`)
  }
  for (const [target, config] of Object.entries(app.targetConfig)) {
    const where = (field) => `gea.targets.${target}.${field}`
    for (const fragment of config.ldFragments) {
      if (!exists(path.join(app.root, fragment))) errors.push(`${where('ldFragments')} entry does not exist: ${fragment}`)
    }
    for (const dir of config.componentDirs) {
      if (!exists(path.join(app.root, dir))) errors.push(`${where('componentDirs')} entry does not exist: ${dir}`)
    }
    if (config.sdkconfig && !exists(path.join(app.root, config.sdkconfig))) {
      errors.push(`${where('sdkconfig')} does not exist: ${config.sdkconfig}`)
    }
    if (typeof config.partitions === 'string' && !exists(path.join(app.root, config.partitions))) {
      errors.push(`${where('partitions')} does not exist: ${config.partitions}`)
    }
    if (config.partitions && typeof config.partitions === 'object') {
      for (const [name, partition] of Object.entries(config.partitions)) {
        if (!partition.type) errors.push(`${where('partitions')}.${name} needs a type`)
        if (!partition.size) errors.push(`${where('partitions')}.${name} needs a size`)
      }
    }
  }
  for (const define of app.defines) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:=.*)?$/.test(define)) errors.push(`gea.defines entry is not a valid macro: ${define}`)
  }
  return errors
}

export function assertValidApp(app) {
  const errors = validateApp(app)
  if (errors.length > 0) {
    throw new CliError(`ERROR: Invalid Gea app '${app.id || app.root}':\n${errors.map((line) => `  - ${line}`).join('\n')}`, ExitCode.usage)
  }
}

export function targetEnabledForApp(ctx, app, targetOrPlatform) {
  if (!targetOrPlatform) return true
  return appPlatformsForTarget(ctx, targetOrPlatform).some((platform) => Boolean(app.targets?.[platform]))
}

export function assertTargetEnabled(ctx, app, targetOrPlatform) {
  if (!targetEnabledForApp(ctx, app, targetOrPlatform)) {
    const platform = appPlatformForTarget(ctx, targetOrPlatform) || targetOrPlatform
    fail(`App '${app.id}' does not enable target '${platform}'.`, ExitCode.targetUnavailable)
  }
}

export const knownPlatforms = Object.freeze(['web', 'esp32', 'rp2350', 'geaos', 'macos', 'ios', 'android', 'xbox'])

export function appPlatformForTarget(ctx, targetOrBoard) {
  return appPlatformsForTarget(ctx, targetOrBoard)[0] || ''
}

export function appPlatformsForTarget(ctx, targetOrBoard) {
  if (!targetOrBoard) return []
  if (knownPlatforms.includes(targetOrBoard)) return [targetOrBoard]
  const targets = safeTargets(ctx)
  if (targets[targetOrBoard]?.appPlatform) return targetAppPlatforms(targets[targetOrBoard])
  const boards = safeBoards(ctx)
  const board = boards[targetOrBoard]
  const boardTarget = board?.target
  if (board?.appPlatform) {
    return uniquePlatforms([
      board.appPlatform,
      ...(Array.isArray(board.compatibleAppPlatforms) ? board.compatibleAppPlatforms : []),
      ...(boardTarget && targets[boardTarget] ? targetAppPlatforms(targets[boardTarget]).slice(1) : [])
    ])
  }
  if (boardTarget && targets[boardTarget]?.appPlatform) return targetAppPlatforms(targets[boardTarget])
  return [targetOrBoard]
}

// Consumers (CMake, the apple/geaos build scripts) join a relative root onto
// GEA_APPS_ROOT; an app outside the project keeps its absolute path.
export function appRootFor(ctx, app) {
  const relative = path.relative(ctx.projectRoot, app.root)
  if (!relative) return '.'
  return relative.startsWith('..') || path.isAbsolute(relative) ? app.root : relative.split(path.sep).join('/')
}

// `root;entry;runtime;nativeSource...` -- the one line CMake splits on ';'.
export function appCmakeMeta(ctx, app) {
  return [appRootFor(ctx, app), app.entry, app.runtime, ...app.nativeSources].join(';')
}

// Defines and linker fragments travel in their own variables rather than being
// appended to the meta line: that line is positional and its tail is already
// the native-source list, so a fourth kind of entry there could not be told
// apart from a source. Both are ';'-joined for CMake's list syntax; fragment
// paths are resolved against the app root so CMake needs no path logic.
export function appCmakeDefines(app) {
  return app.defines.join(';')
}

export function appTargetConfig(app, target) {
  return app.targetConfig[target] || emptyTargetConfig()
}

// Paths a target's config names are relative to the app; absolute them once
// here so no build backend has to know where the app lives.
export function appTargetPaths(app, target, field) {
  return appTargetConfig(app, target)[field].map((entry) => path.join(app.root, entry))
}

export function appCmakeLdFragments(app, target = 'esp32') {
  return appTargetPaths(app, target, 'ldFragments').join(';')
}

export function appSummary(ctx, app) {
  return {
    id: app.id,
    name: app.name,
    packageName: app.packageName,
    version: app.version,
    root: appRootFor(ctx, app),
    entry: app.entry,
    runtime: app.runtime,
    targets: app.targets,
    icons: app.icons,
    nativeSources: app.nativeSources,
    defines: app.defines,
    targetConfig: app.targetConfig,
    launcher: app.launcher
  }
}

function safeTargets(ctx) {
  try {
    return loadTargets(ctx)
  } catch {
    return {}
  }
}

function safeBoards(ctx) {
  try {
    return normalizeBoardConfig(loadBoardConfig(ctx))
  } catch {
    return {}
  }
}

function hasGeaManifest(packagePath) {
  try {
    return exists(packagePath) && Boolean(readJson(packagePath).gea)
  } catch {
    return false
  }
}

function targetAppPlatforms(targetInfo) {
  return uniquePlatforms([
    targetInfo.appPlatform,
    ...(Array.isArray(targetInfo.compatibleAppPlatforms) ? targetInfo.compatibleAppPlatforms : [])
  ])
}

function uniquePlatforms(values) {
  const out = []
  for (const value of values) {
    if (!value || out.includes(value)) continue
    out.push(value)
  }
  return out
}

function packageId(packageName) {
  const last = String(packageName || '').split('/').pop() || ''
  return last.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'app'
}

function normalizeTargets(raw) {
  if (Array.isArray(raw)) return Object.fromEntries(raw.map((name) => [String(name), true]))
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!name) continue
    if (value && typeof value === 'object') out[name] = value.enabled !== false
    else out[name] = value === true
  }
  return out
}

function normalizeIcons(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const icons = {}
  for (const [size, file] of Object.entries(raw)) {
    const numericSize = Number(size)
    if (!Number.isInteger(numericSize) || numericSize <= 0) continue
    if (typeof file !== 'string' || file.length === 0) continue
    icons[numericSize] = file
  }
  return icons
}

function normalizeLauncher(raw) {
  if (!raw || typeof raw !== 'object') return { description: '', order: 0, accent: '', hidden: false }
  return {
    description: typeof raw.description === 'string' ? raw.description : '',
    order: Number.isFinite(raw.order) ? raw.order : 0,
    accent: typeof raw.accent === 'string' ? raw.accent : '',
    hidden: raw.hidden === true
  }
}

function normalizeManifestRelativePath(value) {
  const normalized = path.posix.normalize(String(value || '').replaceAll('\\', '/'))
  if (!normalized || normalized === '.' || normalized === '..') return ''
  if (path.posix.isAbsolute(normalized) || normalized.startsWith('../')) return ''
  if (normalized.includes('/../') || normalized.includes(';')) return ''
  return normalized
}

export function normalizeNativeSources(raw) {
  if (!Array.isArray(raw)) return []
  const sources = raw.map(normalizeManifestRelativePath).filter((source) => /\.(?:c|cc|cpp|cxx|m|mm|S)$/.test(source))
  return [...new Set(sources)]
}

// Preprocessor macros the app needs applied to the WHOLE native build, not just
// its own sources: a value such as a cache-slot count changes the layout of a
// framework type, so the framework and the app must agree on it or the two
// disagree about a struct's size at link. Accepts either an object
// ({ GEA_X: 4, GEA_Y: 'text' }) or an array of ready-made `NAME=value` strings,
// and normalizes both to the array form CMake consumes. A boolean true becomes
// a bare define.
export function normalizeDefines(raw) {
  const entries = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue
      entries.push(item.trim())
    }
  } else if (raw && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) {
      if (value === false || value === null || value === undefined) continue
      entries.push(value === true ? name.trim() : `${name.trim()}=${value}`)
    }
  }
  return [...new Set(entries.filter(Boolean))]
}


function emptyTargetConfig() {
  return { ldFragments: [], componentDirs: [], linkOptions: [], embedFiles: {}, partitions: null, sdkconfig: '', prebuild: '' }
}

function normalizeStringList(raw) {
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
  return [...new Set(list.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()))]
}

// `{ symbol: path }` -- the key is the name the firmware refers to the bytes by,
// the value the file they come from. One field covers both of ESP-IDF's spellings
// (EMBED_FILES, and target_add_binary_data with a RENAME_TO).
function normalizeEmbedFiles(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const files = {}
  for (const [symbol, file] of Object.entries(raw)) {
    if (typeof file === 'string' && file.trim()) files[symbol] = normalizeManifestRelativePath(file)
  }
  return files
}

// Either a path to an existing ESP-IDF partition CSV, or the table itself. The
// object form keeps a partition's payload on the same line as its size, so a
// name cannot be misspelled into a silent no-op and the fit can be checked
// before the flash rather than during it.
function normalizePartitions(raw) {
  if (typeof raw === 'string' && raw.trim()) return normalizeManifestRelativePath(raw)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const table = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue
    table[name] = {
      type: String(entry.type || ''),
      subtype: String(entry.subtype ?? ''),
      size: String(entry.size || ''),
      offset: entry.offset === undefined ? '' : String(entry.offset),
      flags: String(entry.flags || ''),
      data: typeof entry.data === 'string' ? normalizeManifestRelativePath(entry.data) : ''
    }
  }
  return Object.keys(table).length > 0 ? table : null
}

// A target entry is `true` for "enabled with defaults" or an object that both
// enables the target and configures it. Keeping the two together makes the
// contradictory state -- a disabled target carrying configuration -- impossible
// to write.
function normalizeTargetConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const configs = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!name || !value || typeof value !== 'object' || value.enabled === false) continue
    configs[name] = {
      ldFragments: normalizeStringList(value.ldFragments).filter((entry) => entry.endsWith('.lf')).map(normalizeManifestRelativePath),
      componentDirs: normalizeStringList(value.componentDirs).map(normalizeManifestRelativePath),
      linkOptions: normalizeStringList(value.linkOptions),
      embedFiles: normalizeEmbedFiles(value.embedFiles),
      partitions: normalizePartitions(value.partitions),
      sdkconfig: typeof value.sdkconfig === 'string' && value.sdkconfig.trim() ? normalizeManifestRelativePath(value.sdkconfig) : '',
      prebuild: typeof value.prebuild === 'string' ? value.prebuild.trim() : ''
    }
  }
  return configs
}

export function normalizeApp(root, packageJson) {
  const gea = packageJson.gea || {}
  const id = typeof gea.id === 'string' && gea.id ? gea.id : packageId(packageJson.name)
  return {
    id,
    name: typeof gea.name === 'string' && gea.name ? gea.name : packageJson.name || id,
    packageName: packageJson.name || id,
    version: packageJson.version || '0.0.0',
    root: path.resolve(root),
    entry: typeof gea.entry === 'string' && gea.entry ? gea.entry : 'index.tsx',
    runtime: typeof gea.runtime === 'string' && gea.runtime ? gea.runtime : 'gea',
    targets: normalizeTargets(gea.targets),
    icons: normalizeIcons(gea.icons),
    nativeSources: normalizeNativeSources(gea.nativeSources),
    defines: normalizeDefines(gea.defines),
    targetConfig: normalizeTargetConfig(gea.targets),
    launcher: normalizeLauncher(gea.launcher),
    manifest: gea,
    packageJson
  }
}
