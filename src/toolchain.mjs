import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export function nodeAtLeast(major, minor) {
  const [actualMajor, actualMinor] = process.versions.node.split('.').map((value) => Number.parseInt(value, 10))
  return actualMajor > major || (actualMajor === major && actualMinor >= minor)
}

export function commandVersion(command, args, env = process.env) {
  if (!command) return ''
  try {
    return execFileSync(command, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

// Whether a command is reachable on this PATH. Kept here rather than in a
// single command's file because both `gea doctor` and the target adapters ask
// it -- a toolchain a build needs is worth failing on before the build starts,
// with the same answer doctor would have given.
export function onPath(name, env = process.env) {
  return String(env.PATH || '')
    .split(path.delimiter)
    .some((dir) => dir && existsSync(path.join(dir, name)))
}
