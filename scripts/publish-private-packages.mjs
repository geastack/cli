#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCOPE = '@geastack/'
const ORG_PACKAGES_URL = 'https://www.npmjs.com/settings/geastack/packages'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const DEFAULT_REPOS = ['core', 'compiler', 'apple', 'simulator', 'cli']
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vscode',
  'build',
  'dist',
  'node_modules',
  'out',
])

const scriptPath = fileURLToPath(import.meta.url)
const cliRoot = path.resolve(path.dirname(scriptPath), '..')
const defaultCollectionRoot = path.dirname(cliRoot)

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}

const collectionRoot = path.resolve(options.root ?? defaultCollectionRoot)
const packages = orderPackages(
  discoverPublishablePackages(collectionRoot)
    .filter((pkg) => options.packages.length === 0 || options.packages.includes(pkg.name))
)
const selectedPackages = applyFromFilter(packages, options.from)

if (options.packages.length > 0) {
  const found = new Set(selectedPackages.map((pkg) => pkg.name))
  const missing = options.packages.filter((name) => !found.has(name))
  if (missing.length > 0) fail(`package filter did not match: ${missing.join(', ')}`)
}

if (selectedPackages.length === 0) fail('no publishable packages found')

printPlan(selectedPackages, collectionRoot, options)

if (options.plan) process.exit(0)
if (options.yes && options.dryRun) fail('use either --yes or --dry-run, not both')

const dryRun = options.dryRun || !options.yes
if (!dryRun && !options.yes) fail('real publish requires --yes')

const dirtyRepos = dirtyGitRepos(selectedPackages)
if (dirtyRepos.length > 0) {
  const message = [
    'dirty git worktrees detected:',
    ...dirtyRepos.map((repo) => `  - ${relative(collectionRoot, repo.root)}`),
  ].join('\n')
  if (!options.allowDirty && !dryRun) fail(`${message}\npass --allow-dirty to publish anyway`)
  console.warn(`${message}${options.allowDirty ? '' : '\ncontinuing because this is a dry run'}`)
}

ensureNpm()
runNpm(['whoami', '--registry', options.registry], { cwd: collectionRoot, label: 'npm login check' })

const published = []
const skipped = []
for (const pkg of selectedPackages) {
  const target = `${pkg.name}@${pkg.version}`
  if (options.skipExisting && npmVersionExists(pkg.name, pkg.version, options)) {
    console.log(`\n- skip ${target}: version already exists on npm`)
    skipped.push(target)
    continue
  }

  console.log(`\n- ${dryRun ? 'dry-run' : 'publish'} ${target}`)
  const args = [
    'publish',
    '--access',
    'restricted',
    '--tag',
    options.tag,
    '--registry',
    options.registry,
  ]
  if (options.otp) args.push('--otp', options.otp)
  if (dryRun) args.push('--dry-run')
  runNpm(args, { cwd: pkg.dir, label: `publish ${target}` })
  published.push(target)
}

console.log('\nDone.')
console.log(`npm org packages: ${ORG_PACKAGES_URL}`)
if (published.length > 0) console.log(`published${dryRun ? ' dry-run' : ''}: ${published.join(', ')}`)
if (skipped.length > 0) console.log(`skipped existing: ${skipped.join(', ')}`)

function parseArgs(argv) {
  const options = {
    allowDirty: false,
    dryRun: false,
    from: null,
    help: false,
    otp: null,
    packages: [],
    plan: false,
    registry: DEFAULT_REGISTRY,
    root: null,
    skipExisting: true,
    tag: 'latest',
    yes: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--allow-dirty') options.allowDirty = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--yes' || arg === '--publish') options.yes = true
    else if (arg === '--plan') options.plan = true
    else if (arg === '--no-skip-existing') options.skipExisting = false
    else if (arg === '--root') options.root = readValue(argv, ++index, arg)
    else if (arg === '--registry') options.registry = readValue(argv, ++index, arg)
    else if (arg === '--tag') options.tag = readValue(argv, ++index, arg)
    else if (arg === '--otp') options.otp = readValue(argv, ++index, arg)
    else if (arg === '--package') options.packages.push(readValue(argv, ++index, arg))
    else if (arg === '--from') options.from = readValue(argv, ++index, arg)
    else fail(`unknown option: ${arg}`)
  }
  return options
}

function readValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith('--')) fail(`${flag} requires a value`)
  return value
}

function printHelp() {
  console.log(`Publish GeaStack private npm packages.

Usage:
  node scripts/publish-private-packages.mjs --plan
  node scripts/publish-private-packages.mjs --dry-run
  node scripts/publish-private-packages.mjs --yes [--otp 123456]

Default behavior is a dry run unless --yes is passed.

Options:
  --plan                 Print the package order and exit.
  --dry-run              Run npm publish --dry-run for every package.
  --yes, --publish       Actually publish to npm.
  --otp <code>           Pass an npm 2FA one-time password to publish.
  --tag <tag>            npm dist-tag to publish with. Default: latest.
  --registry <url>       npm registry. Default: ${DEFAULT_REGISTRY}
  --package <name>       Publish only one package. Can be repeated.
  --from <name>          Resume from a package name in the ordered list.
  --no-skip-existing     Do not skip versions already visible through npm view.
  --allow-dirty          Allow real publish from dirty git worktrees.
  --root <dir>           GeaStack collection root. Default: ${defaultCollectionRoot}

Only non-private ${SCOPE} packages with publishConfig.access = "restricted"
are included. Real publish uses npm publish --access restricted, which places
packages under ${ORG_PACKAGES_URL}.`)
}

function discoverPublishablePackages(root) {
  const packages = []
  for (const repo of DEFAULT_REPOS) {
    const repoRoot = path.join(root, repo)
    if (!fs.existsSync(repoRoot)) continue
    walk(repoRoot, (packageJsonPath) => {
      const pkg = readJson(packageJsonPath)
      if (!pkg.name?.startsWith(SCOPE)) return
      if (pkg.private === true) return
      if (pkg.publishConfig?.access !== 'restricted') return
      packages.push({
        dependencies: dependencyNames(pkg),
        dir: path.dirname(packageJsonPath),
        name: pkg.name,
        packageJsonPath,
        repoRoot,
        version: pkg.version,
      })
    })
  }
  return packages
}

function walk(dir, visitPackageJson) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(fullPath, visitPackageJson)
      continue
    }
    if (entry.isFile() && entry.name === 'package.json') visitPackageJson(fullPath)
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`could not read ${file}: ${error.message}`)
  }
}

function dependencyNames(pkg) {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ])
}

function orderPackages(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const ordered = []
  const state = new Map()

  const visit = (pkg, stack = []) => {
    const existing = state.get(pkg.name)
    if (existing === 'done') return
    if (existing === 'visiting') fail(`dependency cycle: ${[...stack, pkg.name].join(' -> ')}`)
    state.set(pkg.name, 'visiting')
    const deps = [...pkg.dependencies].filter((name) => byName.has(name)).sort()
    for (const dep of deps) visit(byName.get(dep), [...stack, pkg.name])
    state.set(pkg.name, 'done')
    ordered.push(pkg)
  }

  for (const pkg of [...packages].sort((a, b) => a.name.localeCompare(b.name))) visit(pkg)
  return ordered
}

function applyFromFilter(packages, from) {
  if (!from) return packages
  const index = packages.findIndex((pkg) => pkg.name === from)
  if (index < 0) fail(`--from package not found in publish order: ${from}`)
  return packages.slice(index)
}

function printPlan(packages, root, options) {
  console.log(`GeaStack private npm publish plan (${packages.length} packages)`)
  console.log(`root: ${root}`)
  console.log(`registry: ${options.registry}`)
  console.log(`tag: ${options.tag}`)
  console.log(`org packages: ${ORG_PACKAGES_URL}`)
  console.log(`mode: ${options.plan ? 'plan only' : options.yes ? 'publish' : 'dry run'}`)
  packages.forEach((pkg, index) => {
    console.log(`${String(index + 1).padStart(2, '0')}. ${pkg.name}@${pkg.version}  ${relative(root, pkg.dir)}`)
  })
}

function ensureNpm() {
  const result = spawnSync('npm', ['--version'], { encoding: 'utf8' })
  if (result.error) {
    fail(`npm is required on PATH to publish packages: ${result.error.message}`)
  }
  if (result.status !== 0) fail(`npm --version failed:\n${result.stderr || result.stdout}`)
}

function npmVersionExists(name, version, options) {
  const result = spawnSync(
    'npm',
    ['view', `${name}@${version}`, 'version', '--registry', options.registry, '--json'],
    { encoding: 'utf8' }
  )
  if (result.status === 0) return true
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (/\bE404\b|404 Not Found|is not in this registry/i.test(output)) return false
  console.warn(`could not determine whether ${name}@${version} exists; npm publish will decide`)
  return false
}

function runNpm(args, { cwd, label }) {
  const result = spawnSync('npm', args, { cwd, stdio: 'inherit' })
  if (result.error) fail(`${label} failed: ${result.error.message}`)
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status}`)
}

function dirtyGitRepos(packages) {
  const roots = [...new Set(packages.map((pkg) => pkg.repoRoot))].sort()
  return roots.flatMap((root) => {
    const result = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) return [{ root }]
    return result.stdout.trim() ? [{ root }] : []
  })
}

function relative(from, to) {
  return path.relative(from, to) || '.'
}

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}
