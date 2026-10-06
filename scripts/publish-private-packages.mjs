#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { spawnArgs } from '../src/spawn-args.mjs'

const SCOPE = '@geastack/'
const ORG_PACKAGES_URL = 'https://www.npmjs.com/settings/geastack/packages'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
// Every repository that publishes an @geastack package. A repo missing here is
// a release pushed by hand that can drift from the versions the others expect:
// `targets` was missing once, then `node-compat` (a hard dependency of the
// compiler), `native-webgl-angle` and `windows`.
const DEFAULT_REPOS = ['core', 'compiler', 'node-compat', 'apple', 'windows', 'native-webgl-angle', 'simulator', 'targets', 'cli']
// Build output and scratch trees carry copies of package.json files that would
// shadow the real packages: `generated` (the simulator's staged framework
// sources), `.work` (benchmark checkouts), `.state` (sweep source contexts),
// `.build` (core's test pipelines).
const SKIP_DIRS = new Set([
  '.build',
  '.git',
  '.next',
  '.turbo',
  '.state',
  '.vscode',
  '.work',
  'build',
  'dist',
  'generated',
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
const discoveredPackages = discoverPublishablePackages(collectionRoot)
const packages = orderPackages(
  discoveredPackages
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

if (options.skipDepCheck) console.warn('\nskipping @geastack dependency check (--skip-dep-check)')
else verifyDependencies(selectedPackages, discoveredPackages, collectionRoot, options)

if (options.plan) process.exit(0)
if (options.yes && options.dryRun) fail('use either --yes or --dry-run, not both')

const dryRun = options.dryRun || !options.yes
if (!dryRun && !options.yes) fail('real publish requires --yes')
if (dryRun) {
  console.log('\nDry run: npm will build package tarballs, but the registry is unchanged.')
  console.log(`Dry run: npm dist-tags such as "${options.tag}" are not created or updated until --yes is used.`)
}

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
const taggedExisting = []
for (const pkg of selectedPackages) {
  const target = `${pkg.name}@${pkg.version}`
  if (options.skipExisting && npmVersionExists(pkg.name, pkg.version, options)) {
    console.log(`\n- ${dryRun ? 'dry-run tag' : 'tag'} existing ${target}`)
    ensureDistTag(pkg, target, options, dryRun)
    taggedExisting.push(target)
    continue
  }

  console.log(`\n- ${dryRun ? 'dry-run' : 'publish'} ${target}`)
  const args = [
    'publish',
    '--access',
    pkg.access,
    '--tag',
    options.tag,
    '--registry',
    options.registry,
  ]
  if (options.otp) args.push('--otp', options.otp)
  if (dryRun) args.push('--dry-run')
  runNpm(args, { cwd: pkg.dir, label: `publish ${target}` })
  ensureDistTag(pkg, target, options, dryRun)
  published.push(target)
}

console.log('\nDone.')
console.log(`npm org packages: ${ORG_PACKAGES_URL}`)
if (published.length > 0) console.log(`published${dryRun ? ' dry-run' : ''}: ${published.join(', ')}`)
if (taggedExisting.length > 0) {
  console.log(`${dryRun ? 'would tag existing' : 'tagged existing'}: ${taggedExisting.join(', ')}`)
}

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
    skipDepCheck: false,
    skipExisting: true,
    tag: 'alpha',
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
    else if (arg === '--skip-dep-check') options.skipDepCheck = true
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
  --dry-run              Run npm publish --dry-run for every package without changing registry dist-tags.
  --yes, --publish       Actually publish to npm.
  --otp <code>           Pass an npm 2FA one-time password to publish.
  --tag <tag>            npm dist-tag to publish with. Default: alpha.
  --registry <url>       npm registry. Default: ${DEFAULT_REGISTRY}
  --package <name>       Publish only one package. Can be repeated.
  --from <name>          Resume from a package name in the ordered list.
  --no-skip-existing     Do not skip versions already visible through npm view.
  --skip-dep-check       Do not check that @geastack dependency ranges resolve.
  --allow-dirty          Allow real publish from dirty git worktrees.
  --root <dir>           GeaStack collection root. Default: ${defaultCollectionRoot}

Only non-private ${SCOPE} packages with a publishConfig.access of "restricted"
or "public" are included, and each is published with its own access value, so
flipping a package to public in its package.json is enough. Packages land under
${ORG_PACKAGES_URL}. Existing package versions are not republished; real publish
ensures their npm dist-tag with npm dist-tag add.

Before anything is published, every @geastack dependency range of every
selected package must be met by a package in the same publish or by a version
already on npm; otherwise the script stops without publishing.`)
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
      if (pkg.publishConfig?.access !== 'restricted' && pkg.publishConfig?.access !== 'public') return
      packages.push({
        access: pkg.publishConfig.access,
        dependencies: dependencyNames(pkg),
        dependencyRanges: scopedDependencyRanges(pkg),
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

// Publish order follows the dependencies a package needs installed, not its
// peers: a peer is supplied by whoever installs the package, and the compiler
// names `apple` as an optional peer while `apple` depends on the compiler, so
// counting peers made the graph a cycle.
function dependencyNames(pkg) {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ])
}

function scopedDependencyRanges(pkg) {
  const ranges = { ...pkg.optionalDependencies, ...pkg.dependencies }
  return Object.entries(ranges).filter(([name]) => name.startsWith(SCOPE))
}

// A package published against an @geastack range nobody can install breaks
// every consumer: cli 0.1.97 went out needing targets ^0.1.97 while npm only had
// 0.1.95, because targets was not checked out under the collection root. Each
// range must be met by a package in this publish (published first, by order)
// or by a version npm already has.
function verifyDependencies(selected, discovered, root, options) {
  const inPublish = new Map(selected.map((pkg) => [pkg.name, pkg]))
  const inCollection = new Map(discovered.map((pkg) => [pkg.name, pkg]))
  const npmLookups = new Map()
  const problems = []

  for (const pkg of selected) {
    for (const [dep, range] of pkg.dependencyRanges) {
      const local = inPublish.get(dep)
      if (local && satisfies(local.version, range)) continue

      const key = `${dep}@${range}`
      if (!npmLookups.has(key)) npmLookups.set(key, npmRangeResolves(dep, range, options))
      const lookup = npmLookups.get(key)
      if (lookup.ok) continue

      const reasons = [lookup.reason]
      if (local) reasons.push(`this publish has ${dep}@${local.version}, which does not match`)
      else if (inCollection.has(dep)) reasons.push(`${dep}@${inCollection.get(dep).version} was found locally but is not selected by --package/--from`)
      else reasons.push(`${dep} is not in this publish (no checkout under ${root}; pass --root or publish it first)`)
      problems.push(`  - ${pkg.name}@${pkg.version} needs ${key}\n${reasons.map((reason) => `      ${reason}`).join('\n')}`)
    }
  }

  if (problems.length > 0) {
    fail(`unresolved @geastack dependencies:\n${problems.join('\n')}\npass --skip-dep-check to publish anyway`)
  }
  console.log('\n@geastack dependency ranges resolve.')
}

function npmRangeResolves(name, range, options) {
  const result = spawnSync(
    ...spawnArgs('npm', ['view', `${name}@${range}`, 'version', '--registry', options.registry, '--json'], {
      encoding: 'utf8'
    })
  )
  if (result.error) return { ok: false, reason: `npm view failed: ${result.error.message}` }
  if (result.status === 0 && result.stdout.trim()) return { ok: true }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (result.status === 0 || /\bE404\b|404 Not Found|No match found|is not in this registry/i.test(output)) {
    return { ok: false, reason: `npm has no version matching ${range}${latestNpmVersion(name, options)}` }
  }
  return { ok: false, reason: `could not query npm (exit ${result.status}): ${firstLine(result.stderr || result.stdout)}` }
}

function latestNpmVersion(name, options) {
  const result = spawnSync(
    ...spawnArgs('npm', ['view', name, 'version', '--registry', options.registry, '--json'], { encoding: 'utf8' })
  )
  if (result.status !== 0) return ''
  try {
    const version = JSON.parse(result.stdout)
    return typeof version === 'string' ? ` (latest: ${version})` : ''
  } catch {
    return ''
  }
}

function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0] ?? ''
}

// Covers the range forms the @geastack manifests use: exact, ^, ~ and >=.
// Anything else returns false, so npm decides whether the range resolves.
function satisfies(version, range) {
  const match = /^(\^|~|>=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(range.trim())
  const have = parseVersion(version)
  if (!match || !have) return false
  const [, operator = '', wantText] = match
  const want = parseVersion(wantText)
  if (operator === '') return compareVersions(have, want) === 0
  if (compareVersions(have, want) < 0) return false
  if (have.pre.length > 0 && !(have.major === want.major && have.minor === want.minor && have.patch === want.patch)) return false
  if (operator === '>=') return true
  if (operator === '~') return have.major === want.major && have.minor === want.minor
  if (want.major > 0) return have.major === want.major
  if (want.minor > 0) return have.major === 0 && have.minor === want.minor
  return have.major === 0 && have.minor === 0 && have.patch === want.patch
}

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text ?? '').trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split('.') : [] }
}

function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    if (a.pre[index] === undefined) return -1
    if (b.pre[index] === undefined) return 1
    if (a.pre[index] === b.pre[index]) continue
    const numeric = /^\d+$/.test(a.pre[index]) && /^\d+$/.test(b.pre[index])
    if (numeric) return Number(a.pre[index]) < Number(b.pre[index]) ? -1 : 1
    return a.pre[index] < b.pre[index] ? -1 : 1
  }
  return 0
}

function orderPackages(packages) {
  const byName = new Map()
  for (const pkg of packages) {
    const other = byName.get(pkg.name)
    if (other) fail(`${pkg.name} found twice:\n  - ${other.packageJsonPath}\n  - ${pkg.packageJsonPath}`)
    byName.set(pkg.name, pkg)
  }
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
    console.log(`${String(index + 1).padStart(2, '0')}. ${pkg.name}@${pkg.version}  ${relative(root, pkg.dir)}  (${pkg.access})`)
  })
}

function ensureNpm() {
  const result = spawnSync(...spawnArgs('npm', ['--version'], { encoding: 'utf8' }))
  if (result.error) {
    fail(`npm is required on PATH to publish packages: ${result.error.message}`)
  }
  if (result.status !== 0) fail(`npm --version failed:\n${result.stderr || result.stdout}`)
}

function npmVersionExists(name, version, options) {
  const result = spawnSync(
    ...spawnArgs('npm', ['view', `${name}@${version}`, 'version', '--registry', options.registry, '--json'], {
      encoding: 'utf8'
    })
  )
  if (result.status === 0) return true
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (/\bE404\b|404 Not Found|is not in this registry/i.test(output)) return false
  console.warn(`could not determine whether ${name}@${version} exists; npm publish will decide`)
  return false
}

function runNpm(args, { cwd, label }) {
  const result = spawnSync(...spawnArgs('npm', args, { cwd, stdio: 'inherit' }))
  if (result.error) fail(`${label} failed: ${result.error.message}`)
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status}`)
}

function ensureDistTag(pkg, target, options, dryRun) {
  const args = ['dist-tag', 'add', target, options.tag, '--registry', options.registry]
  if (options.otp) args.push('--otp', options.otp)
  if (dryRun) {
    console.log(`  dry run: would set npm dist-tag ${options.tag} -> ${target}`)
    console.log(`  would run: npm ${args.join(' ')}`)
    return
  }
  console.log(`  ensure dist-tag ${options.tag} -> ${target}`)
  runNpm(args, { cwd: pkg.dir, label: `dist-tag ${target}` })
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
