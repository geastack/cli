import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { CliError, ExitCode, fail } from '../errors.mjs'
import { formatCommand } from '../run.mjs'

export function runXbox({ app, action, env, host = '', noBuild = false, dryRun = false, stdout }) {
  const configuration = app?.packageJson?.gea?.xbox
  if (!app || !configuration) fail('This app must declare gea.xbox buildScript and deployScript.', ExitCode.usage)
  const commands = []
  const script = key => {
    const entry = configuration[key]
    if (typeof entry !== 'string' || !entry) fail(`Missing gea.xbox.${key}.`, ExitCode.usage)
    const file = path.resolve(app.root, entry)
    if (!existsSync(file)) fail(`Xbox script not found: ${file}`, ExitCode.missingDependency)
    return file
  }
  if (action === 'build' || !noBuild) commands.push([script('buildScript')])
  if (action === 'deploy') {
    const args = [script('deployScript')]
    if (host) args.push('--xbox', host)
    if (env.GEA_XBOX_SELF_SIGNED === '1') args.push('--insecure')
    commands.push(args)
  }
  for (const args of commands) {
    if (dryRun) { stdout(formatCommand([process.execPath, ...args])); continue }
    const result = spawnSync(process.execPath, args, { cwd: app.root, env, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new CliError(`Xbox ${action} failed (${result.status ?? 1}).`, ExitCode.deployFailed)
  }
  return 0
}
