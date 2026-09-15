import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CliError, ExitCode, fail } from '../errors.mjs'
import { appSummary, discoverApps } from '../manifest.mjs'
import { formatCommand } from '../run.mjs'
import { onPath } from '../toolchain.mjs'

// `web` is two targets wearing one name, and the CLI keeps them apart.
//
//   gea simulate            the SIMULATOR. The app's C++ is generated with the
//                           same geatsc flags an ESP32 firmware uses -- same
//                           board profile, same font DPR, same renderer -- and
//                           only the final compile differs (emcc/WASM + an
//                           RGB565 framebuffer on a canvas, instead of clang +
//                           a QSPI panel). Gea's own layout engine does layout,
//                           so what you see is what the board will show.
//
//   gea {dev,build} --target web
//                           a REAL WEB APP. The same TSX compiled onto the
//                           @geajs/core reactive DOM runtime: real DOM nodes,
//                           the browser's own CSSOM, native HMR. Faster to
//                           iterate on, and deployable -- but the *browser*
//                           does layout, so it drifts from the device exactly
//                           where a simulator would need to be trusted.
//
// Both live in @geastack/simulator. Unlike the Apple targets -- where the app
// depends on @geastack/apple and the app's own resolution finds the script --
// nothing here is declared by the app: a gea app is simulatable because it is
// buildable, so the CLI owns the dependency and resolves it from its own
// installation.

const require = createRequire(import.meta.url)

// Resolution order, most explicit first. The env var is the escape hatch for a
// contributor working on the simulator itself; the sibling-checkout fallback is
// what makes this work inside the geastack tree before the package is
// published, and costs nothing once it is.
export function resolveSimulatorDir(env = process.env) {
  const stated = env.GEA_SIMULATOR_DIR
  if (stated) {
    const dir = path.resolve(stated)
    if (!hasWebTarget(dir)) fail(`GEA_SIMULATOR_DIR does not look like @geastack/simulator: ${dir}`, ExitCode.missingDependency)
    return dir
  }
  try {
    return path.dirname(require.resolve('@geastack/simulator/package.json'))
  } catch {
    // Not installed.
  }
  const cliRoot = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)))
  const sibling = path.resolve(cliRoot, '..', 'simulator')
  if (hasWebTarget(sibling)) return sibling
  fail('@geastack/simulator is not installed. Run npm install in the CLI, or set GEA_SIMULATOR_DIR to a simulator checkout.', ExitCode.missingDependency)
}

function hasWebTarget(dir) {
  return existsSync(path.join(dir, 'targets', 'web', 'build-web.sh'))
}

// Everything the web target writes, anchored at the app rather than at the
// package. `.gea/build/` is what `gea create` already gitignores, so a
// simulate in a scaffolded app does not dirty the user's tree.
//
// The object cache is the exception and is deliberately machine-wide: it is
// keyed by a hash of the whole toolchain and flag set, so sharing it across
// apps is safe by construction, and it is the expensive part -- giving every
// app its own copy would multiply the only cost worth avoiding.
export function webPaths(app, env = process.env) {
  const root = path.join(app.root, '.gea', 'build', 'web')
  return {
    root,
    generated: path.join(root, 'generated'),
    dist: path.join(root, 'dist'),
    public: path.join(root, 'public', 'apps'),
    domOut: path.join(root, 'site'),
    viteCache: path.join(root, 'vite-cache'),
    lock: path.join(root, 'heavy-build.lock'),
    objcache: env.GEA_WEB_OBJCACHE_DIR || path.join(os.homedir(), '.geastack', 'web-objcache')
  }
}

// The simulator build is an emcc compile. Checking here turns a failure 600
// lines into a bash script into one line of CLI output that names the fix.
// Both compilers are checked because build-web.sh invokes both and hashes both
// binaries into the object-cache profile.
function requireEmscripten(env, appId) {
  const missing = ['emcc', 'em++'].filter((binary) => !onPath(binary, env))
  if (missing.length === 0) return
  fail(
    `'${appId}' needs the Emscripten SDK: ${missing.join(' and ')} not on PATH. ` +
      'Source emsdk_env.sh (see cli/docs/SETUP.md, "Emscripten For Web/WASM Simulator Builds"), then run gea doctor.',
    ExitCode.missingDependency
  )
}

function requireWebTarget(app) {
  if (!app.targets?.web) fail(`'${app.id}' does not declare gea.targets.web.`, ExitCode.usage)
}

// build-web.sh resolves the app itself, through @geastack/core's gea-embedded
// CLI against GEA_APPS_ROOT. Pointing that at the app's own folder is what lets
// an app live outside the examples workspace: a root's own package.json is one
// of the places discovery looks, so an app rooted at GEA_APPS_ROOT resolves to
// itself. Same trick the macOS adapter uses.
function buildEnv(app, env, paths) {
  return {
    ...env,
    GEA_APPS_ROOT: app.root,
    GEA_WEB_GENERATED_ROOT: paths.generated,
    GEA_WEB_DIST_ROOT: paths.dist,
    GEA_WEB_PUBLIC_ROOT: paths.public,
    GEA_WEB_OBJCACHE_DIR: paths.objcache,
    // Scope the heavy-build lock to this app. Left at its default it would sit
    // beside the installed package, which silently serialises two unrelated
    // apps that happen to share a CLI installation.
    GEA_HEAVY_BUILD_LOCK_PATH: paths.lock
  }
}

function runScript(command, args, { cwd, env, dryRun, stdout, failureMessage }) {
  if (dryRun) {
    stdout(formatCommand([command, ...args]))
    return 0
  }
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new CliError(`${failureMessage} (${result.status ?? 1}).`, ExitCode.buildFailed)
  return 0
}

// --- gea simulate ----------------------------------------------------------

export function buildSimulatorApp({ app, env, dryRun = false, stdout }) {
  requireWebTarget(app)
  requireEmscripten(env, app.id)
  const simulatorDir = resolveSimulatorDir(env)
  const script = path.join(simulatorDir, 'targets', 'web', 'build-web.sh')
  const paths = webPaths(app, env)
  runScript('bash', [script, app.id], {
    cwd: app.root,
    env: buildEnv(app, env, paths),
    dryRun,
    stdout,
    failureMessage: `Web build failed for '${app.id}'`
  })
  return { simulatorDir, paths }
}

export async function runSimulate({ ctx, app, env, dryRun = false, stdout, port, open = true, view = {} }) {
  const { simulatorDir, paths } = buildSimulatorApp({ app, env, dryRun, stdout })
  const url = await startSimulatorServer({ ctx, app, env, simulatorDir, paths, port, dryRun, stdout })
  if (dryRun) return 0
  stdout(`Simulating ${app.id}: ${url}`)
  if (open) openBrowser(url, env)
  return 0
}

// The server is started in-process rather than by spawning vite's bin, for one
// reason that decides it: the CLI has to know which URL to open, and vite falls
// forward when a port is busy. `server.resolvedUrls` answers that; scraping a
// child's stdout for it does not. Running it here also lets the app index and
// the relocated dist root be passed as inline config that vite merges over the
// package's own vite.config.ts, instead of being smuggled through env vars the
// config would have to read back.
async function startSimulatorServer({ ctx, app, env, simulatorDir, paths, port, dryRun, stdout }) {
  const appRoot = path.join(simulatorDir, 'simulator')
  const configFile = path.join(appRoot, 'vite.config.ts')
  if (dryRun) {
    stdout(formatCommand(['vite', '--root', appRoot, '--config', configFile]))
    return ''
  }
  // vite belongs to the simulator package, not to this one.
  const viteEntry = createRequire(path.join(simulatorDir, 'package.json')).resolve('vite')
  const { createServer } = await import(pathToFileURL(viteEntry).href)
  const server = await createServer({
    root: appRoot,
    configFile,
    // Vite's default cacheDir is <root>/node_modules/.vite -- inside the
    // installed package, which may be read-only and is not this app's to dirty.
    cacheDir: paths.viteCache,
    define: { __GEA_APP_INDEX__: JSON.stringify(appIndexFor(ctx, app)) },
    server: {
      port,
      fs: { allow: [appRoot, paths.dist, paths.public] }
    }
  })
  await server.listen()
  const resolved = server.resolvedUrls?.local?.[0] || `http://localhost:${server.config.server.port}/`
  return `${resolved.replace(/\/$/, '')}/?${searchParams(app, view)}`
}

function searchParams(app, view) {
  const params = new URLSearchParams({ app: app.id })
  for (const key of ['width', 'height', 'dpr', 'zoom']) {
    if (view[key] !== undefined && view[key] !== '') params.set(key, String(view[key]))
  }
  return params.toString()
}

// The simulator's app list is normally a file generated into its own source
// tree. An app the CLI was pointed at is not in that file and would be
// rejected as unknown, so the CLI states the list instead -- as a define, so
// nothing has to be written into the installed package.
function appIndexFor(ctx, app) {
  const summaries = safeDiscover(ctx).map((found) => appSummary(ctx, found))
  if (summaries.some((summary) => summary.id === app.id)) return summaries
  // An app the CLI was pointed at directly need not be inside any catalogue
  // the context can see, and it is the one app that must be in the list.
  return [...summaries, appSummary(ctx, app)]
}

function safeDiscover(ctx) {
  try {
    return discoverApps(ctx)
  } catch {
    return []
  }
}

function openBrowser(url, env) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawnSync(opener, [url], { env, stdio: 'ignore' })
}

// --- gea dev --target web / gea build --target web -------------------------

// The DOM target resolves the app from the directory itself rather than from an
// id looked up under an apps root, so `gea dev --target web` works in any app
// folder on disk.
export function runWebDev({ app, env, dryRun = false, stdout, port }) {
  requireWebTarget(app)
  const simulatorDir = resolveSimulatorDir(env)
  const script = path.join(simulatorDir, 'targets', 'web', 'dev-web.mjs')
  if (!existsSync(script)) fail(`Web dev server not found: ${script}`, ExitCode.missingDependency)
  const args = [script, '--app-dir', app.root]
  if (port) args.push('--port', String(port))
  return runScript('node', args, {
    cwd: app.root,
    env: { ...env, GEA_APPS_ROOT: app.root },
    dryRun,
    stdout,
    failureMessage: `Web dev server failed for '${app.id}'`
  })
}

export function runWebBuild({ app, env, dryRun = false, stdout, outDir = '' }) {
  requireWebTarget(app)
  const simulatorDir = resolveSimulatorDir(env)
  const script = path.join(simulatorDir, 'targets', 'web', 'build-dom-web.mjs')
  if (!existsSync(script)) fail(`Web build script not found: ${script}`, ExitCode.missingDependency)
  const out = outDir ? path.resolve(outDir) : webPaths(app, env).domOut
  return runScript('node', [script, '--app-dir', app.root, '--out-dir', out], {
    cwd: app.root,
    env: { ...env, GEA_APPS_ROOT: app.root },
    dryRun,
    stdout,
    failureMessage: `Web build failed for '${app.id}'`
  })
}
