import { spawnSync } from 'node:child_process'

import { CliError, ExitCode, fail } from '../errors.mjs'
import { appleChildEnv, appleTargetScript } from '../macos/adapter.mjs'
import { formatCommand } from '../run.mjs'

// iOS mirrors macOS: a platform, not a board, driven by one script shipped
// inside @geastack/apple and resolved from the app's own dependencies. The
// script takes a destination -- `simulator` (the default) or `device` -- which
// `--mode` selects. `gea build --target ios` compiles the .app and stops;
// `gea run --target ios` also installs and launches it on the picked simulator
// or attached iPhone, which is the script's own default behaviour. The script
// reads GEA_IOS_SKIP_LAUNCH, so a caller who already set it keeps their choice.
export function runIos({ app, env, dryRun = false, stdout, mode = '', run = false }) {
  const destination = mode || 'simulator'
  if (destination !== 'simulator' && destination !== 'device') {
    fail(`--mode ${mode} is not an iOS destination; expected simulator or device.`, ExitCode.usage)
  }
  const { script, require } = appleTargetScript(app, 'ios', 'build-ios.sh')
  const childEnv = appleChildEnv(app, env, require)
  if (!run && childEnv.GEA_IOS_SKIP_LAUNCH === undefined) childEnv.GEA_IOS_SKIP_LAUNCH = '1'
  if (dryRun) {
    stdout(formatCommand(['bash', script, app.id, destination]))
    return 0
  }
  const result = spawnSync('bash', [script, app.id, destination], { cwd: app.root, env: childEnv, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new CliError(`iOS build failed (${result.status ?? 1}).`, ExitCode.deployFailed)
  return 0
}
