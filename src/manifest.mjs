import path from 'node:path'

import { CliError, ExitCode, fail } from './errors.mjs'
import { exists, findUp, isDirectory, listDirectories, readJson } from './fs-utils.mjs'

export function discoverApps(ctx) {
  const roots = [ctx.examplesRoot, ctx.companionRoot]
  const seen = new Set()
  const apps = []
  for (const root of roots) {
    for (const app of discoverAppsInRoot(root)) {
      const key = app.root
      if (seen.has(key)) continue
      seen.add(key)
      apps.push(app)
    }
  }
  return apps.sort((a, b) => a.id.localeCompare(b.id))
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

export function resolveRequestedApp(ctx, parsed, positionals) {
  const requested = parsed.options.app || positionals[0]
  if (requested) {
    const app = findAppById(ctx, String(Array.isArray(requested) ? requested.at(-1) : requested))
    if (!app) fail(`Could not find Gea app '${requested}'. Use --examples-root or run from a split GeaStack checkout.`, ExitCode.usage)
    return app
  }
  const current = findCurrentApp(ctx.cwd)
  if (current) return current
  fail('No app selected. Pass --app <id>, pass an app id, or run inside a Gea app folder.', ExitCode.usage)
}

export function findAppById(ctx, id) {
  return discoverApps(ctx).find((app) => app.id === id) || null
}

export function findCurrentApp(cwd) {
  const packageDir = findUp(cwd, (dir) => exists(path.join(dir, 'package.json')) && hasGeaManifest(path.join(dir, 'package.json')))
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
  const platform = appPlatformForTarget(ctx, targetOrPlatform) || targetOrPlatform
  return app.targets?.[platform] === true
}

export function assertTargetEnabled(ctx, app, targetOrPlatform) {
  if (!targetEnabledForApp(ctx, app, targetOrPlatform)) {
    const platform = appPlatformForTarget(ctx, targetOrPlatform) || targetOrPlatform
    fail(`App '${app.id}' does not enable target '${platform}'.`, ExitCode.targetUnavailable)
  }
}

export function appPlatformForTarget(ctx, targetOrBoard) {
  if (!targetOrBoard) return ''
  if (['web', 'esp32', 'rp2350', 'geaos', 'macos', 'ios'].includes(targetOrBoard)) return targetOrBoard
  const targets = loadTargetMetadata(ctx)
  if (targets[targetOrBoard]?.appPlatform) return targets[targetOrBoard].appPlatform
  const boards = loadBoardConfig(ctx)
  const boardTarget = boards[targetOrBoard]?.target
  if (boardTarget && targets[boardTarget]?.appPlatform) return targets[boardTarget].appPlatform
  return ''
}

export function loadTargetMetadata(ctx) {
  const file = path.join(ctx.targetsRoot, 'scripts', 'boards', 'targets.json')
  return exists(file) ? readJson(file) : {}
}

export function loadBoardConfig(ctx) {
  const file = boardConfigPath(ctx)
  return exists(file) ? readJson(file) : {}
}

export function boardConfigPath(ctx) {
  if (ctx.boardsConfig) return ctx.boardsConfig
  if (ctx.projectBoardsConfig && exists(ctx.projectBoardsConfig)) return ctx.projectBoardsConfig
  return path.join(ctx.targetsRoot, 'boards.json')
}

function hasGeaManifest(packagePath) {
  try {
    return Boolean(readJson(packagePath).gea)
  } catch {
    return false
  }
}

function normalizeApp(root, packageJson) {
  const gea = packageJson.gea || {}
  return {
    id: String(gea.id || ''),
    name: String(gea.name || packageJson.name || gea.id || ''),
    packageName: packageJson.name || '',
    version: packageJson.version || '',
    root: path.resolve(root),
    entry: gea.entry || 'index.tsx',
    runtime: gea.runtime || 'gea',
    targets: gea.targets || {},
    icons: gea.icons || {},
    launcher: gea.launcher || {},
    manifest: gea,
    packageJson
  }
}
