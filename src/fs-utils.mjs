import fs from 'node:fs'
import path from 'node:path'

export function exists(filePath) {
  try {
    fs.accessSync(filePath)
    return true
  } catch {
    return false
  }
}

export function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

export function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export function listDirectories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
  } catch {
    return []
  }
}

export function findUp(startDir, predicate) {
  let current = path.resolve(startDir)
  while (true) {
    if (predicate(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return ''
    current = parent
  }
}
