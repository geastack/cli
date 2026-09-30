import { nativeScriptBuildEnv } from '../build-config.mjs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

import { CliError, ExitCode, fail } from '../errors.mjs'
import { formatCommand } from '../run.mjs'

export function pebbleBuildArgs(script, { app, phone = '', run = false }) {
  const args = [script, app.root, '--entry', app.entry || 'index.tsx']
  if (run) args.push('--install', phone || 'emulator')
  return args
}

// Pebble is a platform, not a board: a Gea app becomes an ordinary .pbw that
// installs next to every other Pebble app, with the watch firmware untouched.
// Like macOS and iOS, the whole target is one script shipped inside a package
// the app depends on (@geastack/pebble), found through the app's own module
// resolution. `gea build --target pebble` produces the .pbw; `gea run --target
// pebble` also installs it -- on the emery emulator, or on a watch through the
// Pebble phone app's developer connection when `--phone <ip>` names one.
export function runPebble({ app, env, dryRun = false, stdout, phone = '', run = false }) {
  const require = createRequire(path.join(app.root, 'package.json'))
  let pebbleRoot = ''
  try {
    pebbleRoot = path.dirname(require.resolve('@geastack/pebble/package.json'))
  } catch {
    fail(`'${app.id}' targets Pebble but @geastack/pebble is not installed in ${app.root} — run npm install there.`, ExitCode.missingDependency)
  }
  const script = path.join(pebbleRoot, 'targets', 'pebble', 'build-pebble.sh')
  if (!existsSync(script)) fail(`Pebble build script not found: ${script}`, ExitCode.missingDependency)
  env = nativeScriptBuildEnv(app, 'pebble', env, { dryRun })
  const args = pebbleBuildArgs(script, { app, phone, run })
  if (dryRun) {
    stdout(formatCommand(['bash', ...args]))
    return 0
  }
  const result = spawnSync('bash', args, { cwd: app.root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new CliError(`Pebble build failed (${result.status ?? 1}).`, ExitCode.deployFailed)
  return 0
}
