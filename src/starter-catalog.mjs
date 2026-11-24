import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { exists, readJson } from './fs-utils.mjs'

const defaultExamplesRepo = 'https://github.com/geastack/examples.git'
const defaultExamplesRef = 'main'

const excludedNames = new Set([
  '.git',
  '.gea',
  'dist',
  'build',
  'coverage',
  'test',
  '__tests__',
  'node_modules',
  '.turbo',
  '.next',
  'vitest.config.ts',
  'vitest.config.js',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock'
])

export function discoverBundledStarters(ctx) {
  const startersRoot = path.join(ctx.cliPackageRoot, 'starters')
  const catalogPath = path.join(startersRoot, 'catalog.json')
  if (!exists(catalogPath)) return []
  const catalog = readJson(catalogPath)
  const entries = Array.isArray(catalog) ? catalog : catalog.starters || []
  return entries.flatMap((entry) => bundledStarterFromCatalogEntry(entry, startersRoot))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function discoverGithubExamples(ctx, env = process.env) {
  const catalogPath = path.join(ctx.cliPackageRoot, 'examples', 'catalog.json')
  if (!exists(catalogPath)) return []
  const catalog = readJson(catalogPath)
  const repo = env.GEA_EXAMPLES_REPO || defaultExamplesRepo
  const ref = env.GEA_EXAMPLES_REF || defaultExamplesRef
  const entries = Array.isArray(catalog) ? catalog : catalog.examples || []
  return entries.flatMap((entry) => githubExampleFromCatalogEntry(entry, { repo, ref }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function copyStarterFiles(sourceDir, targetDir, repoRoot = null) {
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (source) => !excludedNames.has(path.basename(source))
  })
  if (repoRoot) vendorSharedAssets(sourceDir, targetDir, repoRoot)
}

// Examples share fonts and images from the repository root (examples/assets),
// referenced as `../../../assets/fonts/Inter-Regular.ttf`. A copied app stands
// alone, so every such file it references is copied into the project under the
// same repository-relative path and the reference is rewritten to point there.
const SHARED_ASSET_SOURCE = /\.(css|tsx?|jsx?|html)$/
const SHARED_ASSET_REFERENCE = /(['"(])((?:\.\.\/)+[^'"()\s]+)(?=['")])/g

function vendorSharedAssets(sourceDir, targetDir, repoRoot) {
  for (const file of listFiles(targetDir)) {
    if (!SHARED_ASSET_SOURCE.test(file)) continue
    const relative = path.relative(targetDir, file)
    const originalDir = path.dirname(path.join(sourceDir, relative))
    const text = fs.readFileSync(file, 'utf8')
    const rewritten = text.replace(SHARED_ASSET_REFERENCE, (match, quote, reference) => {
      const resolved = path.resolve(originalDir, reference)
      if (isInside(resolved, sourceDir) || !isInside(resolved, repoRoot)) return match
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return match
      const destination = path.join(targetDir, path.relative(repoRoot, resolved))
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.copyFileSync(resolved, destination)
      let local = path.relative(path.dirname(file), destination).split(path.sep).join('/')
      if (!local.startsWith('.')) local = `./${local}`
      return `${quote}${local}`
    })
    if (rewritten !== text) fs.writeFileSync(file, rewritten)
  }
}

function listFiles(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

export function formatStarterChoice(starter) {
  const targets = targetBadge(starter.targets)
  return `${starter.name} - ${starter.description}${targets ? ` [${targets}]` : ''}`
}

export function fetchGithubExample(example, targetDir, options = {}) {
  const repo = options.repo || example.repo
  const ref = options.ref || example.ref || 'main'
  if (!repo) throw new Error(`Example '${example.id}' does not define a GitHub repository.`)

  if (isDirectory(repo)) {
    const sourceDir = path.join(repo, example.path)
    if (!isDirectory(sourceDir)) throw new Error(`Example '${example.id}' was not found at ${sourceDir}.`)
    copyStarterFiles(sourceDir, targetDir, repo)
    return
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-example-'))
  try {
    runGit(['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', ref, repo, tmp], options)
    // The shared fonts and images live in the repository's assets/ folder.
    runGit(['-C', tmp, 'sparse-checkout', 'set', example.path, 'assets'], options)
    // A dry run only prints the git commands, so there is nothing to copy.
    if (options.dryRun) return
    const sourceDir = path.join(tmp, example.path)
    if (!isDirectory(sourceDir)) throw new Error(`Example '${example.id}' was not found in ${repo} at ${example.path}.`)
    copyStarterFiles(sourceDir, targetDir, tmp)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function targetSummary(targets = {}) {
  const enabled = Object.entries(targets)
    .filter(([, value]) => value === true)
    .map(([key]) => key)
  return enabled.length > 0 ? `Targets: ${enabled.join(', ')}` : 'Working Gea example'
}

function targetBadge(targets = {}) {
  return Object.entries(targets)
    .filter(([, value]) => value === true)
    .map(([key]) => key)
    .join(', ')
}

function bundledStarterFromCatalogEntry(entry, startersRoot) {
  if (!entry || typeof entry !== 'object') return []
  const root = path.resolve(startersRoot, entry.path || '')
  if (!isInside(root, startersRoot)) return []
  const starterEntry = entry.entry || 'index.tsx'
  if (!exists(path.join(root, starterEntry))) return []
  const packageJson = readOptionalJson(path.join(root, 'package.json'))
  const targets = entry.targets && typeof entry.targets === 'object' ? entry.targets : packageJson.gea?.targets || {}
  const description = entry.description || packageJson.gea?.description || packageJson.gea?.launcher?.description || packageJson.description || targetSummary(targets)
  const manifest = {
    ...(packageJson.gea || {}),
    description,
    entry: starterEntry,
    runtime: entry.runtime || packageJson.gea?.runtime || 'gea',
    targets
  }
  return [{
    id: String(entry.id || packageJson.gea?.id || ''),
    name: String(entry.name || packageJson.gea?.name || entry.id || ''),
    description: manifest.description,
    root,
    source: 'bundled',
    entry: manifest.entry,
    runtime: manifest.runtime,
    targets,
    manifest,
    packageJson
  }].filter((starter) => starter.id && starter.name)
}

function githubExampleFromCatalogEntry(entry, source) {
  if (!entry || typeof entry !== 'object') return []
  const id = String(entry.id || '')
  const examplePath = String(entry.path || '')
  if (!id || !examplePath || examplePath.startsWith('/') || examplePath.includes('..')) return []
  const targets = entry.targets && typeof entry.targets === 'object' ? entry.targets : {}
  return [{
    id,
    name: String(entry.name || id),
    description: String(entry.description || targetSummary(targets)),
    source: 'github',
    repo: source.repo,
    ref: source.ref,
    path: examplePath,
    entry: String(entry.entry || 'index.tsx'),
    runtime: String(entry.runtime || 'gea'),
    targets,
    manifest: {
      description: String(entry.description || targetSummary(targets)),
      entry: String(entry.entry || 'index.tsx'),
      runtime: String(entry.runtime || 'gea'),
      targets
    },
    packageJson: {}
  }]
}

function readOptionalJson(filePath) {
  if (!exists(filePath)) return {}
  try {
    return readJson(filePath)
  } catch {
    return {}
  }
}

function isInside(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function runGit(args, options) {
  if (options.dryRun) {
    options.stdout?.(['git', ...args].join(' '))
    return
  }
  const result = spawnSync('git', args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed with exit code ${result.status ?? 1}`)
}
