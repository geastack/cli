import os from 'node:os'
import path from 'node:path'

import { ExitCode, fail } from '../errors.mjs'
import { exists, readJson, writeJson } from '../fs-utils.mjs'

// Board aliases are machine-local configuration: which physical board answers
// to `--board amoled`, its USB serial, its IP. They live in two tiers that
// are merged, project over home:
//
//   ~/.geastack/boards.json   every board on this machine (GEA_HOME overrides
//                             the directory)
//   <project>/.gea/boards.json aliases specific to one project, overriding a
//                             home alias of the same name
//
// An explicit --boards-config (or GEA_BOARDS_CONFIG) replaces both tiers: a
// caller naming a file wants exactly that file. Nothing is ever read from an
// installed package -- a board catalog shipped in @geastack/targets was a
// development convenience that described one developer's bench, and every
// npm install would have to overwrite it.

export function homeBoardsConfigPath(env = process.env) {
  const home = env.GEA_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.geastack')
  return path.join(home, 'boards.json')
}

// Every file that contributes aliases, lowest precedence first. The list is
// the same whether or not the files exist so writers can target a tier that
// has not been created yet.
export function boardConfigTiers(ctx) {
  if (ctx.boardsConfig) return [{ scope: 'explicit', file: ctx.boardsConfig }]
  const tiers = []
  if (ctx.homeBoardsConfig) tiers.push({ scope: 'home', file: ctx.homeBoardsConfig })
  if (ctx.projectBoardsConfig) tiers.push({ scope: 'project', file: ctx.projectBoardsConfig })
  return tiers
}

// The single path older callers print or check: the explicit file, else the
// highest-precedence tier that exists, else where `gea boards add` would
// write (project when the project already has a config, else home).
export function boardConfigPath(ctx) {
  const tiers = boardConfigTiers(ctx)
  const existing = [...tiers].reverse().find((tier) => exists(tier.file))
  return existing ? existing.file : boardConfigWritePath(ctx)
}

// Where a write goes when the caller does not say: `--global` / `--local`
// pick a tier, an alias that already exists is edited in place, a new alias
// joins the project config if the project has one and the home config
// otherwise.
export function boardConfigWritePath(ctx, { scope = '', alias = '' } = {}) {
  const tiers = boardConfigTiers(ctx)
  if (ctx.boardsConfig) return ctx.boardsConfig
  if (scope === 'global' || scope === 'home') return ctx.homeBoardsConfig
  if (scope === 'project') return ctx.projectBoardsConfig
  if (scope) fail(`Unknown board config scope '${scope}'. Expected --global or --local.`, ExitCode.usage)
  if (alias) {
    const origin = boardConfigOrigins(ctx).get(alias)
    if (origin) return origin
  }
  const project = tiers.find((tier) => tier.scope === 'project')
  if (project && exists(project.file)) return project.file
  return ctx.homeBoardsConfig || project?.file || path.join(ctx.cwd || process.cwd(), '.gea', 'boards.json')
}

function readTier(file) {
  if (!exists(file)) return {}
  try {
    return normalizeBoardConfig(readJson(file))
  } catch (error) {
    fail(`Could not read board config ${file}: ${error.message}`, ExitCode.usage)
  }
}

// Merged aliases plus, for each, the file it came from: a `targetDefinition`
// is relative to its own file, and `gea boards list` says which tier an alias
// lives in.
export function loadBoardConfigWithOrigins(ctx) {
  const boards = {}
  const origins = new Map()
  for (const tier of boardConfigTiers(ctx)) {
    for (const [alias, board] of Object.entries(readTier(tier.file))) {
      boards[alias] = board
      origins.set(alias, tier.file)
    }
  }
  return { boards, origins }
}

export function loadBoardConfig(ctx) {
  return loadBoardConfigWithOrigins(ctx).boards
}

export function boardConfigOrigins(ctx) {
  return loadBoardConfigWithOrigins(ctx).origins
}

export function readBoardConfigFile(file) {
  return readTier(file)
}

export function writeBoardConfigFile(file, boards) {
  writeJson(file, boards)
}

export function normalizeBoardConfig(raw) {
  if (!raw || typeof raw !== 'object') return {}
  if (raw.boards && typeof raw.boards === 'object') return raw.boards
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('$') && value && typeof value === 'object') out[key] = value
  }
  return out
}
