import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveUsbSerialPort } from '../boards/usb.mjs'
import { CliError, ExitCode, fail } from '../errors.mjs'
import { formatCommand } from '../run.mjs'

// The one per-target hook: a target directory may ship a board.mjs whose
// `commandFor({ action, app, port, serial, pedalRoot })` names the external
// command to run. taurus-s3 uses it to defer to the taurus-pedal firmware
// tree, which lives in its own repository.

export function pedalRootCandidates(ctx, env) {
  if (env.TAURUS_PEDAL_ROOT) return [path.resolve(env.TAURUS_PEDAL_ROOT)]
  const targetsRoot = ctx.targetsRoot || ctx.projectRoot
  return [path.resolve(targetsRoot, '../taurus-pedal'), path.resolve(targetsRoot, '../../coyotiv/taurus-pedal')]
}

export async function runTargetHook({ ctx, selection, action, app = null, env, dryRun = false, stdout }) {
  const hook = path.join(selection.targetDir, 'board.mjs')
  if (!existsSync(hook)) fail(`Target '${selection.target}' has no board.mjs hook at ${hook}.`, ExitCode.missingDependency)
  const module = await import(pathToFileURL(hook).href)
  if (typeof module.commandFor !== 'function') fail(`${hook} does not export commandFor().`, ExitCode.missingDependency)
  const candidates = pedalRootCandidates(ctx, env)
  const pedalRoot = candidates.find((candidate) => existsSync(path.join(candidate, 'esp32-s3-a2-full/flash-s3.sh'))) || ''
  let port = selection.port
  if (!port && selection.usbSerial && action === 'flash' && !dryRun) {
    try {
      port = resolveUsbSerialPort({ serial: selection.usbSerial })
    } catch {
      port = ''
    }
  }
  let command
  try {
    command = module.commandFor({ action, app: app?.id || '', port, serial: selection.usbSerial, pedalRoot: pedalRoot || candidates[0] })
  } catch (error) {
    fail(error.message, ExitCode.usage)
  }
  if (!command) return 0
  if (dryRun) {
    stdout(formatCommand([command.executable, ...command.args]))
    return 0
  }
  if (!pedalRoot) fail('Set TAURUS_PEDAL_ROOT to the taurus-pedal checkout; firmware sources remain in that repository.', ExitCode.missingDependency)
  const result = spawnSync(command.executable, command.args, { env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new CliError(`ERROR: Command failed (${result.status ?? 1}): ${formatCommand([command.executable, ...command.args])}`, ExitCode.deployFailed)
  return 0
}
