import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import { envPath } from './env-path.mjs'

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
  return Boolean(findOnPath(name, env))
}

// The file a command resolves to on this PATH, or ''.
export function findOnPath(name, env = process.env) {
  const names = executableNames(name, env)
  for (const dir of envPath(env).split(path.delimiter)) {
    if (!dir) continue
    const found = names.map((candidate) => path.join(dir, candidate)).find((file) => existsSync(file))
    if (found) return found
  }
  return ''
}

// Windows executables carry an extension from PATHEXT, so probing for the bare
// name finds nothing even when the tool is installed and on PATH -- which is
// how an ESP-IDF install that ships ninja.exe still read as "no ninja".
// PATHEXT spells the extensions in capitals; files on disk are `cmake.exe`,
// and a path the CLI prints or runs reads the same way.
function executableNames(name, env) {
  if (process.platform !== 'win32') return [name]
  const extensions = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return [name, ...extensions.map((extension) => name + extension.toLowerCase())]
}
