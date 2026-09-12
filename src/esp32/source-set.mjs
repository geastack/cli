import fs from 'node:fs'
import path from 'node:path'

// The files CMake lists as inputs of the TSX -> C++ step. It scans them once at
// configure time, so the CLI keeps the same list in the configure signature and
// reconfigures when a file appears or disappears.

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.html'])
const sourceNames = new Set(['package.json', 'tsconfig.json', 'vite.config.ts'])
const prunedDirs = new Set(['node_modules', 'dist', 'build', '.build', '.vite', '.gea', '.git'])

export function listAppSources(root) {
  const found = []
  walk(root, root, found)
  return found.sort()
}

function walk(root, dir, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!prunedDirs.has(entry.name)) walk(root, full, found)
      continue
    }

    if (isSource(entry.name)) found.push(path.relative(root, full))
  }
}

function isSource(name) {
  return sourceNames.has(name) || sourceExtensions.has(path.extname(name))
}
