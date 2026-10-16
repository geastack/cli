import path from 'node:path'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { nativeScriptBuildEnv } from '../build-config.mjs'
import { CliError, ExitCode, fail } from '../errors.mjs'
import { formatCommand } from '../run.mjs'

// A native SDL platform build, not board selection or a web simulator.
export function runLinux({ app, env, dryRun = false, stdout }) {
  const require = createRequire(path.join(app.root, 'package.json'))
  let root = env.GEA_LINUX_ROOT ? path.resolve(env.GEA_LINUX_ROOT) : ''
  try { if (!root) root = path.dirname(require.resolve('@geastack/linux/package.json')) }
  catch { fail(`'${app.id}' targets raspberry-pi-os but @geastack/linux is not installed in ${app.root}.`, ExitCode.missingDependency) }
  const script = path.join(root, 'targets/raspberry-pi-os/build-raspberry-pi-os.sh')
  if (!existsSync(script)) fail(`Linux native build script not found: ${script}`, ExitCode.missingDependency)
  if (dryRun) { stdout(formatCommand(['bash', script, app.id])); return 0 }
  const childEnv = nativeScriptBuildEnv(app, 'raspberry-pi-os', env)
  const result = spawnSync('bash', [script, app.id], { cwd: app.root, env: childEnv, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new CliError(`Linux native build failed (${result.status ?? 1}).`, ExitCode.deployFailed)
  return 0
}
