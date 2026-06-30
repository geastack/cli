import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { option } from './args.mjs'
import { exists, findUp, readJson } from './fs-utils.mjs'

const srcDir = path.dirname(fileURLToPath(import.meta.url))
export const cliPackageRoot = path.resolve(srcDir, '..')

const repoNames = Object.freeze({
  android: 'android',
  apple: 'apple',
  companion: 'companion',
  compiler: 'compiler',
  core: 'core',
  examples: 'examples',
  geaos: 'geaos',
  simulator: 'simulator',
  targets: 'targets'
})

export function createContext(parsed, env = process.env, cwd = process.cwd()) {
  const collectionRoot = resolveCollectionRoot(parsed, env, cwd)
  const coreRoot = normalizePackageRepoRoot(resolvePathOption(parsed, env, 'core-root', 'GEA_CORE_ROOT', 'GEA_CORE_DIR', path.join(collectionRoot, repoNames.core)), 'packages/core')
  const compilerRoot = normalizePackageRepoRoot(resolvePathOption(parsed, env, 'compiler-root', 'GEA_COMPILER_ROOT', 'GEA_COMPILER_DIR', path.join(collectionRoot, repoNames.compiler)), 'packages/geatsc')
  const examplesRoot = resolvePathOption(parsed, env, 'examples-root', 'GEA_EXAMPLES_ROOT', 'GEA_APPS_ROOT', path.join(collectionRoot, repoNames.examples))
  const companionRoot = resolvePathOption(parsed, env, 'companion-root', 'GEA_COMPANION_ROOT', '', path.join(collectionRoot, repoNames.companion))
  const projectRoot = findGeaProjectRoot(cwd) || path.resolve(cwd)
  const projectBoardsConfig = path.join(projectRoot, '.gea', 'boards.json')
  const explicitBoardsConfig = option(parsed, 'boards-config') || env.GEA_BOARDS_CONFIG || ''
  const boardsConfig = explicitBoardsConfig || (exists(projectBoardsConfig) ? projectBoardsConfig : '')

  const ctx = {
    cwd: path.resolve(cwd),
    projectRoot,
    projectBoardsConfig,
    cliPackageRoot,
    collectionRoot,
    androidRoot: resolvePathOption(parsed, env, 'android-root', 'GEA_ANDROID_ROOT', '', path.join(collectionRoot, repoNames.android)),
    appleRoot: resolvePathOption(parsed, env, 'apple-root', 'GEA_APPLE_ROOT', '', path.join(collectionRoot, repoNames.apple)),
    companionRoot,
    compilerRoot,
    compilerPackageDir: path.join(compilerRoot, 'packages', 'geatsc'),
    coreRoot,
    corePackageDir: path.join(coreRoot, 'packages', 'core'),
    boardsConfig: boardsConfig ? path.resolve(cwd, boardsConfig) : '',
    examplesRoot,
    geaosRoot: resolvePathOption(parsed, env, 'geaos-root', 'GEA_GEAOS_ROOT', '', path.join(collectionRoot, repoNames.geaos)),
    simulatorRoot: resolvePathOption(parsed, env, 'simulator-root', 'GEA_SIMULATOR_ROOT', '', path.join(collectionRoot, repoNames.simulator)),
    targetsRoot: resolvePathOption(parsed, env, 'targets-root', 'GEA_TARGETS_ROOT', '', path.join(collectionRoot, repoNames.targets))
  }
  ctx.scripts = {
    board: path.join(ctx.targetsRoot, 'scripts', 'board'),
    webBuild: path.join(ctx.simulatorRoot, 'targets', 'web', 'build-web.sh'),
    webDev: path.join(ctx.simulatorRoot, 'targets', 'web', 'dev-web.mjs'),
    androidBuild: path.join(ctx.androidRoot, 'targets', 'android', 'build-android.sh'),
    macosBuild: path.join(ctx.appleRoot, 'targets', 'macos', 'build-macos.sh'),
    iosBuild: path.join(ctx.appleRoot, 'targets', 'ios', 'build-ios.sh'),
    geaEmbedded: path.join(ctx.corePackageDir, 'bin', 'gea-embedded.mjs')
  }
  return ctx
}

export function createChildEnv(ctx, env = process.env) {
  const out = {
    ...env,
    GEA_COLLECTION_ROOT: ctx.collectionRoot,
    GEA_APPS_ROOT: env.GEA_APPS_ROOT || ctx.examplesRoot,
    GEA_CLI_BIN: env.GEA_CLI_BIN || path.join(ctx.cliPackageRoot, 'bin', 'gea.mjs'),
    GEA_CORE_DIR: env.GEA_CORE_DIR || ctx.corePackageDir,
    GEA_COMPILER_DIR: env.GEA_COMPILER_DIR || ctx.compilerPackageDir
  }
  if (ctx.boardsConfig) out.GEA_BOARDS_CONFIG = ctx.boardsConfig
  return out
}

function resolveCollectionRoot(parsed, env, cwd) {
  const explicit = option(parsed, 'collection-root') || env.GEA_COLLECTION_ROOT
  if (explicit) return path.resolve(cwd, explicit)

  const fromCwd = findCollectionRoot(cwd)
  if (fromCwd) return fromCwd

  const fromCli = findCollectionRoot(path.dirname(cliPackageRoot))
  if (fromCli) return fromCli

  return path.dirname(cliPackageRoot)
}

function findCollectionRoot(start) {
  let current = path.resolve(start)
  while (true) {
    if (looksLikeCollectionRoot(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return ''
    current = parent
  }
}

function looksLikeCollectionRoot(dir) {
  let score = 0
  for (const name of Object.values(repoNames)) {
    if (exists(path.join(dir, name))) score += 1
  }
  return score >= 3
}

function resolvePathOption(parsed, env, optionName, envName, legacyEnvName, fallback) {
  const value = option(parsed, optionName) || env[envName] || (legacyEnvName ? env[legacyEnvName] : '') || fallback
  return path.resolve(value)
}

function normalizePackageRepoRoot(input, packageSubdir) {
  const resolved = path.resolve(input)
  if (exists(path.join(resolved, packageSubdir, 'package.json'))) return resolved
  if (exists(path.join(resolved, 'package.json'))) return path.resolve(resolved, '..', '..')
  return resolved
}

function findGeaProjectRoot(start) {
  return findUp(start, (dir) => {
    const packagePath = path.join(dir, 'package.json')
    if (!exists(packagePath)) return false
    try {
      return Boolean(readJson(packagePath).gea)
    } catch {
      return false
    }
  })
}
