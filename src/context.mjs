import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { option } from './args.mjs'
import { homeBoardsConfigPath } from './boards/config.mjs'
import { exists, findUp } from './fs-utils.mjs'

const srcDir = path.dirname(fileURLToPath(import.meta.url))
export const cliPackageRoot = path.resolve(srcDir, '..')
export const cliBin = path.join(cliPackageRoot, 'bin', 'gea.mjs')

// Every @geastack package the CLI reads. They are sources and data (IDF
// projects, chip catalogs, C++ trees, the compiler) and they belong to the
// USER'S project: the CLI resolves them from the project's node_modules the
// way node itself would, never from its own install. The CLI has no @geastack
// dependencies of its own, so availability of a command is simply "is that
// package installed here".
const geastackPackages = Object.freeze({
  targetsRoot: { name: '@geastack/targets', env: 'GEA_TARGETS_ROOT' },
  corePackageDir: { name: '@geastack/core', env: 'GEA_CORE_DIR' },
  compilerPackageDir: { name: '@geastack/compiler', env: 'GEA_COMPILER_DIR' },
  chipsPackageDir: { name: '@geastack/chips', env: 'GEA_CHIPS_DIR' },
  elementsPackageDir: { name: '@geastack/elements', env: 'GEA_ELEMENTS_DIR' },
  enginePackageDir: { name: '@geastack/engine', env: 'GEA_ENGINE_DIR' },
  geaosPackageDir: { name: '@geastack/geaos', env: 'GEA_GEAOS_PACKAGE_DIR' },
  hostPackageDir: { name: '@geastack/host', env: 'GEA_HOST_DIR' },
  pluginPackageDir: { name: '@geastack/geatsc-plugin-gea', env: 'GEA_PLUGIN_DIR' }
})

export function createContext(parsed, env = process.env, cwd = process.cwd()) {
  const absoluteCwd = path.resolve(cwd)
  const explicitProject = option(parsed, 'project') || env.GEA_PROJECT_ROOT || ''
  const projectRoot = explicitProject ? path.resolve(absoluteCwd, explicitProject) : findNodeProjectRoot(absoluteCwd) || absoluteCwd
  const projectBoardsConfig = path.join(projectRoot, '.gea', 'boards.json')
  // Only an explicit file is `boardsConfig`; the project and home tiers are
  // merged by src/boards/config.mjs, which also decides where a write goes.
  const boardsConfig = option(parsed, 'boards-config') || env.GEA_BOARDS_CONFIG || ''

  const ctx = {
    cwd: absoluteCwd,
    projectRoot,
    projectBoardsConfig,
    homeBoardsConfig: homeBoardsConfigPath(env),
    cliPackageRoot,
    cliBin,
    boardsConfig: boardsConfig ? path.resolve(absoluteCwd, boardsConfig) : '',
    // Generated state (IDF build directories, sdkconfigs, generated board
    // headers) lives in the project, never inside an installed package.
    buildRoot: env.GEA_PROJECT_BUILD_ROOT
      ? path.resolve(absoluteCwd, env.GEA_PROJECT_BUILD_ROOT)
      : path.join(projectRoot, '.gea', 'build'),
    env
  }
  for (const [field, { name, env: envName }] of Object.entries(geastackPackages)) {
    ctx[field] = env[envName] || resolveInstalledPackageDir(name, projectRoot)
  }
  ctx.packageName = (field) => geastackPackages[field]?.name || field
  return ctx
}

// Environment handed to every build system the CLI drives (IDF/CMake, the
// Pico SDK, the geaos scripts). They receive exact package paths and never
// resolve anything themselves.
//
// There is deliberately no project-root variable here. A child that needs the
// project is spawned with the project as its cwd, and `createContext` resolves
// a project from cwd -- so announcing it in the environment as well only
// created a second spelling of the same value that could disagree with the
// first. The one child whose cwd is NOT the project (geaos, which runs in its
// own target directory) sets GEA_PROJECT_ROOT itself, which is the same name
// createContext reads on the way in.
export function createChildEnv(ctx, env = ctx.env || process.env) {
  const out = {
    ...env,
    GEA_CLI_BIN: ctx.cliBin,
    GEA_CHIPS_DIR: ctx.chipsPackageDir,
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

export function resolveInstalledPackageDir(packageName, anchor) {
  let current = path.resolve(anchor)
  while (true) {
    const candidate = path.join(current, 'node_modules', ...packageName.split('/'))
    if (exists(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(current)
    if (parent === current) return ''
    current = parent
  }
}

function appendPathList(current, value) {
  const entries = String(current || '').split(path.delimiter).filter(Boolean)
  if (value && !entries.includes(value)) entries.push(value)
  return entries.join(path.delimiter)
}

function findNodeProjectRoot(start) {
  return findUp(start, (dir) => exists(path.join(dir, 'package.json')))
}
