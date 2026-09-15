import { readdirSync } from 'node:fs'
import path from 'node:path'

import { flag, option, optionList } from '../args.mjs'
import { loadTargets } from '../boards/targets.mjs'
import { ExitCode, fail } from '../errors.mjs'
import { exists } from '../fs-utils.mjs'
import { appCmakeMeta, appSummary, assertValidApp, discoverApps, resolveRequestedApp } from '../manifest.mjs'

// gea apps ... : the app catalog and everything generated from it.

export async function appsCommand(ctx, parsed, rest, options) {
  const sub = rest[0] || 'list'
  const args = rest.slice(1)
  switch (sub) {
    case 'list': return listApps(ctx, parsed, options)
    case 'inspect': return inspectApp(ctx, parsed, args, options)
    case 'index': return appIndex(ctx, parsed, options)
    case 'launcher': return launcher(ctx, parsed, options)
    case 'icons': return icons(ctx, parsed, args, options)
    case 'icon-sheet': return iconSheet(ctx, parsed, options)
    case 'apple-icons': return appleIcons(ctx, parsed, args, options)
    default:
      fail(`Unknown apps subcommand '${sub}'. Expected list, inspect, pack, index, launcher, icons, icon-sheet, or apple-icons.`, ExitCode.usage)
  }
}

function listApps(ctx, parsed, options) {
  const target = option(parsed, 'target', '')
  const apps = discoverApps(ctx).filter((app) => !target || app.targets?.[target] === true)
  if (flag(parsed, 'json')) options.stdout(JSON.stringify(apps.map((app) => appSummary(ctx, app)), null, 2))
  else for (const app of apps) options.stdout(app.id)
  return 0
}

function inspectApp(ctx, parsed, args, options) {
  const app = resolveRequestedApp(ctx, parsed, args)
  assertValidApp(app)
  const format = option(parsed, 'format', flag(parsed, 'json') ? 'json' : 'text')
  const summary = appSummary(ctx, app)
  if (format === 'cmake') options.stdout(appCmakeMeta(ctx, app))
  else if (format === 'shell') options.stdout(`${summary.root}\t${app.entry}\t${app.runtime}\t${app.name}`)
  else if (format === 'json') options.stdout(JSON.stringify(summary, null, 2))
  else options.stdout(`${app.id}\t${app.name}\t${summary.root}\t${app.entry}`)
  return 0
}

async function appIndex(ctx, parsed, options) {
  const { generateAppIndex } = await import('../apps/app-index-writer.mjs')
  const outputFile = path.resolve(ctx.cwd, option(parsed, 'out', path.join(ctx.projectRoot, 'simulator', 'src', 'generated', 'app-index.ts')))
  const apps = generateAppIndex({ apps: discoverApps(ctx).map((app) => appSummary(ctx, app)), outputFile })
  options.stdout(flag(parsed, 'json') ? JSON.stringify({ outputFile, apps }, null, 2) : outputFile)
  return 0
}

async function launcher(ctx, parsed, options) {
  const { generateLauncherCatalog } = await import('../apps/launcher-catalog.mjs')
  const target = option(parsed, 'target', 'web')
  const outputFile = path.resolve(ctx.cwd, option(parsed, 'out', path.join(ctx.projectRoot, 'apps', 'app-launcher', 'generated', 'LauncherCatalog.tsx')))
  const apps = generateLauncherCatalog({ repoRoot: ctx.projectRoot, apps: discoverApps(ctx), target, outputFile })
  options.stdout(flag(parsed, 'json') ? JSON.stringify({ outputFile, apps: apps.map((app) => appSummary(ctx, app)) }, null, 2) : outputFile)
  return 0
}

async function icons(ctx, parsed, args, options) {
  const requested = args[0] || option(parsed, 'app', '')
  if (!requested) fail('gea apps icons <app-id|all> [--target <t>] [--model <m>] [--concurrency <n>] [--exclude a,b]', ExitCode.usage)
  const { generateIconSets } = await import('../apps/openai-icons.mjs')
  const excluded = new Set(optionList(parsed, 'exclude'))
  const iconTarget = option(parsed, 'target', '')
  const all = discoverApps(ctx)
  const apps = requested === 'all'
    ? all
      .filter((app) => iconTarget && iconTarget !== 'all'
        ? app.targets?.[iconTarget] === true
        : ['geaos', 'esp32', 'ios', 'macos'].some((candidate) => app.targets?.[candidate] === true))
      .filter((app) => !excluded.has(app.id))
    : [resolveRequestedApp(ctx, parsed, [requested])]
  await generateIconSets({
    repoRoot: ctx.projectRoot,
    apps,
    model: option(parsed, 'model', ctx.env.GEA_OPENAI_IMAGE_MODEL || 'gpt-image-2'),
    concurrency: Math.max(1, Number.parseInt(option(parsed, 'concurrency', '1'), 10) || 1)
  })
  return 0
}

// The Apple build scripts call this per app: the iOS generator wants an
// AppIcon.appiconset inside its asset catalog, the macOS bundle wants an
// AppIcon.icns in Resources. --signature prints a digest of every input the
// icon depends on so the scripts can skip regeneration when nothing changed.
async function appleIcons(ctx, parsed, args, options) {
  const usage = 'gea apps apple-icons <app-id> --platform ios --assets-dir <dir> | --platform macos --build-dir <dir> --resources-dir <dir> [--signature]'
  const app = resolveRequestedApp(ctx, parsed, args)
  assertValidApp(app)
  const platform = option(parsed, 'platform', '')
  if (platform !== 'ios' && platform !== 'macos') fail(usage, ExitCode.usage)
  const icons = await import('../apps/apple-icons.mjs')
  const repoRoot = ctx.projectRoot
  if (flag(parsed, 'signature')) {
    const { createHash } = await import('node:crypto')
    const { readFileSync } = await import('node:fs')
    const hash = createHash('sha256')
    const addFile = (file) => {
      hash.update(file)
      hash.update('\0')
      hash.update(readFileSync(file))
      hash.update('\0')
    }
    addFile(path.join(ctx.cliPackageRoot, 'src', 'apps', 'apple-icons.mjs'))
    hash.update(JSON.stringify({ id: app.id, root: appSummary(ctx, app).root, icons: app.icons || {}, platform }))
    addFile(icons.resolveAppleIconSourcePath(repoRoot, app))
    options.stdout(hash.digest('hex'))
    return 0
  }
  if (platform === 'ios') {
    const assetsDir = option(parsed, 'assets-dir', '')
    if (!assetsDir) fail(usage, ExitCode.usage)
    options.stdout(icons.prepareIosAppIconAssets({ repoRoot, app, assetsDir: path.resolve(ctx.cwd, assetsDir) }))
    return 0
  }
  const buildDir = option(parsed, 'build-dir', '')
  const resourcesDir = option(parsed, 'resources-dir', '')
  if (!buildDir || !resourcesDir) fail(usage, ExitCode.usage)
  options.stdout(icons.prepareMacosAppIcon({ repoRoot, app, buildDir: path.resolve(ctx.cwd, buildDir), resourcesDir: path.resolve(ctx.cwd, resourcesDir) }))
  return 0
}

async function iconSheet(ctx, parsed, options) {
  const { generateIconStyleSheet } = await import('../apps/openai-icons.mjs')
  const excluded = new Set(optionList(parsed, 'exclude'))
  const iconTarget = option(parsed, 'target', 'all')
  const outputPath = path.resolve(ctx.cwd, option(parsed, 'out', path.join(ctx.projectRoot, 'docs', 'icon-style-preview', `${iconTarget}-icon-style-sheet.png`)))
  const apps = discoverApps(ctx)
    .filter((app) => iconTarget === 'all' || app.targets?.[iconTarget] === true)
    .filter((app) => flag(parsed, 'include-hidden') || !app.launcher.hidden)
    .filter((app) => app.icons && Object.keys(app.icons).length > 0)
    .filter((app) => !excluded.has(app.id))
  if (apps.length === 0) fail(`No apps matched target '${iconTarget}'`, ExitCode.usage)
  const sheet = await generateIconStyleSheet({
    apps,
    model: option(parsed, 'model', ctx.env.GEA_OPENAI_IMAGE_MODEL || 'gpt-image-2'),
    outputPath,
    columns: Math.max(1, Number.parseInt(option(parsed, 'columns', '5'), 10) || 5)
  })
  options.stdout(flag(parsed, 'json') ? JSON.stringify({ outputPath: sheet.outputPath, apps: apps.map((app) => appSummary(ctx, app)) }, null, 2) : sheet.outputPath)
  return 0
}

// gea targets ...

export function targetsCommand(ctx, parsed, rest, options) {
  const sub = rest[0] || 'list'
  let targets
  try {
    targets = loadTargets(ctx)
  } catch (error) {
    fail(error.message, ExitCode.missingDependency)
  }
  if (sub === 'list') {
    if (flag(parsed, 'json')) options.stdout(JSON.stringify(targets, null, 2))
    else for (const id of Object.keys(targets).sort()) options.stdout(`${id}\t${targets[id].adapter}\t${exists(targets[id].targetDir) ? targets[id].targetDir : '(not installed)'}`)
    return 0
  }
  if (sub === 'show') {
    const id = rest[1] || ''
    if (!targets[id]) fail(`Unknown target '${id}'. Run gea targets list.`, ExitCode.usage)
    options.stdout(JSON.stringify(targets[id], null, 2))
    return 0
  }
  fail(`Unknown targets subcommand '${sub}'. Expected list or show.`, ExitCode.usage)
}

export async function heapReportCommand(ctx, parsed, rest, options) {
  const { DEFAULT_TITLE, parseLogs, renderHtml } = await import('../heap-report.mjs')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  let inputs = rest.map((file) => path.resolve(ctx.cwd, file))
  const logsDir = path.join(ctx.projectRoot, 'docs', 'esp32-perf-logs')
  if (inputs.length === 0 && exists(logsDir)) {
    inputs = readdirSync(logsDir).filter((name) => /\.(txt|log)$/.test(name)).map((name) => path.join(logsDir, name))
  }
  if (inputs.length === 0) fail('No heap log inputs found. Pass log files or place .txt/.log files in docs/esp32-perf-logs/.', ExitCode.usage)
  const out = path.resolve(ctx.cwd, option(parsed, 'out', path.join(logsDir, 'heap-map-report.html')))
  const maps = optionList(parsed, 'map').map((file) => path.resolve(ctx.cwd, file))
  const data = parseLogs(inputs, maps)
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, renderHtml(data, option(parsed, 'title', DEFAULT_TITLE)))
  options.stdout(`Wrote heap map report: ${out}`)
  options.stdout(`Parsed ${data.snapshots.length} heap-map snapshots, ${data.probes.length} probes, ${data.liveAllocations.length} live allocations, ${data.linkerMaps.length} linker map(s)`)
  return 0
}
