import path from 'node:path'

import { ExitCode, fail } from '../errors.mjs'
import { exists, readJson } from '../fs-utils.mjs'

// Board aliases: an explicit --boards-config, else the project's
// .gea/boards.json, else the boards.json shipped by @geastack/targets.
export function boardConfigPath(ctx) {
  if (ctx.boardsConfig) return ctx.boardsConfig
  if (ctx.projectBoardsConfig && exists(ctx.projectBoardsConfig)) return ctx.projectBoardsConfig
  return ctx.targetsRoot ? path.join(ctx.targetsRoot, 'boards.json') : ''
}

export function loadBoardConfig(ctx) {
  const file = boardConfigPath(ctx)
  if (!file || !exists(file)) return {}
  try {
    return normalizeBoardConfig(readJson(file))
  } catch (error) {
    fail(`Could not read board config ${file}: ${error.message}`, ExitCode.usage)
  }
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
