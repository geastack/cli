import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { option } from './args.mjs'
import { exists, findUp } from './fs-utils.mjs'

const srcDir = path.dirname(fileURLToPath(import.meta.url))
export const cliPackageRoot = path.resolve(srcDir, '..')
const requireFromCli = createRequire(import.meta.url)

export function createContext(parsed, _env = process.env, cwd = process.cwd()) {
  const absoluteCwd = path.resolve(cwd)
  const projectRoot = findNodeProjectRoot(absoluteCwd) || absoluteCwd
  const initialAnchors = [projectRoot, cliPackageRoot]
  const targetsRoot = resolveInstalledPackageDir('@geastack/targets', initialAnchors)
  const corePackageDir = resolveInstalledPackageDir('@geastack/core', initialAnchors)
  const packageAnchors = [projectRoot, cliPackageRoot, targetsRoot, corePackageDir].filter(Boolean)
  const compilerPackageDir = resolveInstalledPackageDir('@geastack/compiler', packageAnchors)
  const projectBoardsConfig = path.join(projectRoot, '.gea', 'boards.json')
  const explicitBoardsConfig = option(parsed, 'boards-config') || ''
  const boardsConfig = explicitBoardsConfig || (exists(projectBoardsConfig) ? projectBoardsConfig : '')

  const ctx = {
    cwd: absoluteCwd,
    projectRoot,
    projectBoardsConfig,
    cliPackageRoot,
    compilerPackageDir,
    corePackageDir,
    chipsPackageDir: resolveInstalledPackageDir('@geastack/chips', packageAnchors),
    elementsPackageDir: resolveInstalledPackageDir('@geastack/elements', packageAnchors),
    enginePackageDir: resolveInstalledPackageDir('@geastack/engine', packageAnchors),
    geaosPackageDir: resolveInstalledPackageDir('@geastack/geaos', packageAnchors),
    hostPackageDir: resolveInstalledPackageDir('@geastack/host', packageAnchors),
    pluginPackageDir: resolveInstalledPackageDir('@geastack/geatsc-plugin-gea', packageAnchors),
    boardsConfig: boardsConfig ? path.resolve(absoluteCwd, boardsConfig) : '',
    examplesRoot: projectRoot,
    simulatorRoot: '',
    androidRoot: '',
    appleRoot: '',
    targetsRoot
  }
  ctx.scripts = {
    board: packageFile(ctx.targetsRoot, 'scripts', 'board'),
    webBuild: '',
    webDev: '',
    androidBuild: '',
    macosBuild: '',
    iosBuild: '',
    geaEmbedded: packageFile(ctx.corePackageDir, 'bin', 'gea-embedded.mjs')
  }
  return ctx
}

export function createChildEnv(ctx, env = process.env) {
  const out = {
    ...env,
    GEA_APPS_ROOT: ctx.projectRoot,
    GEA_CLI_BIN: path.join(ctx.cliPackageRoot, 'bin', 'gea.mjs'),
    GEA_CHIPS_DIR: ctx.chipsPackageDir,
    GEA_CORE_PACKAGE: ctx.corePackageDir,
    GEA_CORE_DIR: ctx.corePackageDir,
    GEA_COMPILER_DIR: ctx.compilerPackageDir,
    GEA_ELEMENTS_DIR: ctx.elementsPackageDir,
    GEA_ENGINE_DIR: ctx.enginePackageDir,
    GEA_EXTRA_APP_DIRS: appendPathList(env.GEA_EXTRA_APP_DIRS, ctx.projectRoot),
    GEA_GEAOS_PACKAGE_DIR: ctx.geaosPackageDir,
    GEA_HOST_DIR: ctx.hostPackageDir,
    GEA_PLUGIN_DIR: ctx.pluginPackageDir,
    GEA_TARGETS_ROOT: ctx.targetsRoot
  }
  if (ctx.boardsConfig) out.GEA_BOARDS_CONFIG = ctx.boardsConfig
  for (const [name, value] of Object.entries(out)) {
    if (name.startsWith('GEA_') && value === '') delete out[name]
  }
  return out
}

function resolveInstalledPackageDir(packageName, anchors) {
  for (const anchor of anchors) {
    let current = path.resolve(anchor)
    while (true) {
      const candidate = path.join(current, 'node_modules', ...packageName.split('/'))
      if (exists(path.join(candidate, 'package.json'))) return candidate
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  try {
    return path.dirname(requireFromCli.resolve(`${packageName}/package.json`))
  } catch {
    return ''
  }
}

function packageFile(packageRoot, ...segments) {
  return packageRoot ? path.join(packageRoot, ...segments) : ''
}

function appendPathList(current, value) {
  const entries = String(current || '').split(path.delimiter).filter(Boolean)
  if (value && !entries.includes(value)) entries.push(value)
  return entries.join(path.delimiter)
}

function findNodeProjectRoot(start) {
  return findUp(start, (dir) => exists(path.join(dir, 'package.json')))
}
