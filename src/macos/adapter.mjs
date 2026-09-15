import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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
  const require = createRequire(path.join(app.root, 'package.json'))
  let appleRoot = ''
  try {
    appleRoot = path.dirname(require.resolve('@geastack/apple/package.json'))
  } catch {
    fail(`'${app.id}' targets macOS but @geastack/apple is not installed in ${app.root} — run npm install there.`, ExitCode.missingDependency)
  }
  const script = path.join(appleRoot, 'targets', 'macos', 'build-macos.sh')
  if (!existsSync(script)) fail(`macOS build script not found: ${script}`, ExitCode.missingDependency)
  // The script resolves the app through this CLI again, against GEA_APPS_ROOT.
  // Pointing that at the app's own folder is what lets an app live outside the
  // examples workspace -- a root's own package.json is one of the places
  // discovery looks, so this holds for every app rather than for a layout.
  const childEnv = { ...env, GEA_APPS_ROOT: app.root }
  if (dryRun) {
    stdout(formatCommand(['bash', script, app.id]))
    return 0
  }
  const result = spawnSync('bash', [script, app.id], { cwd: app.root, env: childEnv, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new CliError(`macOS build failed (${result.status ?? 1}).`, ExitCode.deployFailed)
  return 0
}
