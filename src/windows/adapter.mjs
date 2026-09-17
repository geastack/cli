import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { CliError, ExitCode, fail } from '../errors.mjs'
import { formatCommand } from '../run.mjs'

// Windows is a platform, not a board: like macOS it has no alias, no catalog
// entry and no @geastack/targets dependency, so it never goes through board
// selection. The whole target is one Node script parameterised by an app id,
// shipped inside @geastack/windows -- which a Windows-native app already
// depends on -- so the app's own module resolution is what finds it. An app
// declares `targets.windows` and nothing else; the script reads the rest from
// the same manifest. Node rather than bash, because the machine this runs on
// is a Windows box that need not have a POSIX shell.
export function runWindows({ app, env, dryRun = false, stdout, run = false }) {
  const require = createRequire(path.join(app.root, 'package.json'))
  let windowsRoot = ''
  try {
    windowsRoot = path.dirname(require.resolve('@geastack/windows/package.json'))
  } catch {
    fail(`'${app.id}' targets Windows but @geastack/windows is not installed in ${app.root} — run npm install there.`, ExitCode.missingDependency)
  }
  const script = path.join(windowsRoot, 'targets', 'win32', 'build-windows.mjs')
  if (!existsSync(script)) fail(`Windows build script not found: ${script}`, ExitCode.missingDependency)
  // The script resolves the app through this CLI again, against GEA_APPS_ROOT;
  // the app's own folder is what lets an app live outside a workspace.
  const childEnv = { ...env, GEA_APPS_ROOT: app.root }
  const plugins = geatscPluginsOf(app, require)
  if (plugins.length > 0) childEnv.GEA_EXTRA_GEATSC_PLUGINS = plugins.join(path.delimiter)
  const scriptArgs = [script, app.id, ...(run ? ['--run'] : [])]
  if (dryRun) {
    stdout(formatCommand(['node', ...scriptArgs]))
    return 0
  }
  const result = spawnSync(process.execPath, scriptArgs, { cwd: app.root, env: childEnv, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new CliError(`Windows build failed (${result.status ?? 1}).`, ExitCode.deployFailed)
  return 0
}

// Compiler plugins come from the packages the app depends on, exactly as the
// macOS adapter collects them: each ships its own `./geatsc-plugin` export,
// and an app-owned geatsc-plugin.mjs is the whole list when present.
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
