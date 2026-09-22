import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { CliError, ExitCode, fail } from '../errors.mjs'
import { formatCommand } from '../run.mjs'

// macOS is a platform, not a board: it has no alias, no catalog entry and no
// @geastack/targets dependency, so it never goes through board selection. The
// whole target is one script parameterised by an app id, shipped inside
// @geastack/apple -- which an apple-native app already depends on -- so the
// app's own module resolution is what finds it. An app declares `targets.macos`
// and nothing else; the script reads the rest from the same manifest.
export function runMacos({ app, env, dryRun = false, stdout }) {
  const { script, require } = appleTargetScript(app, 'macos', 'build-macos.sh')
  const childEnv = appleChildEnv(app, env, require)
  if (dryRun) {
    stdout(formatCommand(['bash', script, app.id]))
    return 0
  }
  const result = spawnSync('bash', [script, app.id], { cwd: app.root, env: childEnv, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new CliError(`macOS build failed (${result.status ?? 1}).`, ExitCode.deployFailed)
  return 0
}

// Both Apple targets ship as one script each inside @geastack/apple, and both
// resolve it the same way: through the app's own dependencies. iOS reuses this
// from src/ios/adapter.mjs rather than restating the resolution.
export function appleTargetScript(app, platform, scriptName) {
  const require = createRequire(path.join(app.root, 'package.json'))
  let appleRoot = ''
  try {
    appleRoot = path.dirname(require.resolve('@geastack/apple/package.json'))
  } catch {
    fail(`'${app.id}' targets ${platformLabel(platform)} but @geastack/apple is not installed in ${app.root} — run npm install there.`, ExitCode.missingDependency)
  }
  const script = path.join(appleRoot, 'targets', platform, scriptName)
  if (!existsSync(script)) fail(`${platformLabel(platform)} build script not found: ${script}`, ExitCode.missingDependency)
  return { script, require }
}

// The script resolves the app through this CLI again. It is spawned with the
// app's own folder as its cwd and that is the whole handoff: `createContext`
// resolves a project from cwd, and a root's own package.json is one of the
// places discovery looks, so an app outside the examples workspace resolves
// like any other. Nothing announces the path a second time.
export function appleChildEnv(app, env, require) {
  const childEnv = { ...env }
  const plugins = geatscPluginsOf(app, require)
  if (plugins.length > 0) childEnv.GEA_EXTRA_GEATSC_PLUGINS = plugins.join(path.delimiter)
  return childEnv
}

function platformLabel(platform) {
  return platform === 'ios' ? 'iOS' : 'macOS'
}

// Compiler plugins come from the packages the app depends on.
//
// Each of these packages ships its own geatsc plugin and exports it as
// "./geatsc-plugin". An app that depends on the package has already said it
// wants it; requiring it to ALSO keep a geatsc-plugin.mjs in its own folder
// that re-exports the package's is a step with no decision in it, and the
// relative path such a stub inevitably carries only resolves for an app that
// sits inside this repository -- one app's pointed outside it, so the plugin
// silently never loaded and three was compiled without its native transforms.
//
// An app-owned geatsc-plugin.mjs still wins, and when it exists it is the WHOLE
// list rather than an addition to it. That is the only way a plugin that wraps
// a package's own -- three-batched-mesh's probe wraps native-webgl-angle's and
// re-runs its source transforms -- does not end up applied twice, and it keeps
// "the app states its plugins" a real choice rather than an override.
function geatscPluginsOf(app, require) {
  const own = path.join(app.root, 'geatsc-plugin.mjs')
  if (existsSync(own)) return [own]
  const plugins = []
  let manifest = {}
  try {
    manifest = JSON.parse(readFileSync(path.join(app.root, 'package.json'), 'utf8'))
  } catch {
    return plugins
  }
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    try {
      plugins.push(require.resolve(`${name}/geatsc-plugin`))
    } catch {
      // The package ships no plugin, which is the normal case.
    }
  }
  return plugins
}
