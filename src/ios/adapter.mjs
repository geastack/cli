import { nativeScriptBuildEnv } from '../build-config.mjs'
import { spawnSync } from 'node:child_process'

import { CliError, ExitCode, fail } from '../errors.mjs'
import { appleChildEnv, appleTargetScript } from '../macos/adapter.mjs'
import { formatCommand } from '../run.mjs'

// The UIKit script builds a simulator or device .app and optionally deploys it.
export function runIos({ app, env, dryRun = false, stdout, platform = 'ios', mode = '', run = false }) {
  const platformName = platform === 'tvos' ? 'tvOS' : 'iOS'
  const destination = mode || 'simulator'
  if (destination !== 'simulator' && destination !== 'device') {
    fail(`--mode ${mode} is not a valid destination for ${platformName}; expected simulator or device.`, ExitCode.usage)
  }
  const { script, require } = appleTargetScript(app, 'ios', 'build-ios.sh', env)
  const childEnv = appleChildEnv(app, nativeScriptBuildEnv(app, platform, env, { dryRun }), require)
  const platformArg = platform === 'tvos' ? [platform] : []
  if (!run && childEnv.GEA_IOS_SKIP_LAUNCH === undefined) childEnv.GEA_IOS_SKIP_LAUNCH = '1'
  if (dryRun) {
    stdout(formatCommand(['bash', script, app.id, destination, ...platformArg]))
    return 0
  }
  const result = spawnSync('bash', [script, app.id, destination, ...platformArg], { cwd: app.root, env: childEnv, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new CliError(`${platformName} build failed (${result.status ?? 1}).`, ExitCode.deployFailed)
  return 0
}
