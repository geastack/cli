import { execFileSync } from 'node:child_process'

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
