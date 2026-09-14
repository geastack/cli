import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { resolveUsbSerialPort } from '../boards/usb.mjs'
import { CliError, ExitCode, fail } from '../errors.mjs'
import { formatCommand } from '../run.mjs'

// GeaOS phones and watches. The heavy lifting (docker cross-builds, boot
// image repacking, fastboot/BROM flashing) stays in the target project's
// scripts; the CLI resolves the board, the packages and the device, and
// hands them over as environment.

function geaosEnv(ctx, selection, env) {
  const out = { ...env, GEA_BOARD_TARGET: selection.target, GEA_APPS_ROOT: ctx.projectRoot }
  if (selection.telnetHost) {
    out.GEA_BOARD_TELNET_HOST = selection.telnetHost
    out.GEAOS_DEVICE_HOST = selection.telnetHost
  }
  if (selection.telnetPort) {
    out.GEA_BOARD_TELNET_PORT = selection.telnetPort
    out.GEAOS_DEVICE_PORT = selection.telnetPort
  }
  if (selection.fastbootSerial) {
    out.GEA_BOARD_FASTBOOT_SERIAL = selection.fastbootSerial
    out.GEAOS_FASTBOOT_SERIAL = selection.fastbootSerial
  }
  if (selection.usbSerial) out.GEA_BOARD_USB_SERIAL = selection.usbSerial
  for (const [key, value] of Object.entries({
    GEA_BOARD_MTK_WORKDIR: selection.mtkWorkdir,
    GEA_BOARD_MTK_BOOT_SLOT: selection.mtkBootSlot,
    GEA_BOARD_MTK_METHOD: selection.mtkMethod,
    GEA_BOARD_MTK_MONITOR_GLOB: selection.mtkMonitorGlob
  })) {
    if (value) out[key] = value
  }
  // The device is addressed by its USB SERIAL, never by path order. A
  // detached watch must still build, so an unresolved port stays empty and
  // the flasher falls through to its own (BROM) path -- pinned to a glob only
  // this serial can match, so another attached geaos device is never grabbed.
  let port = selection.port
  if (!port && selection.usbSerial) {
    try {
      port = resolveUsbSerialPort({ serial: selection.usbSerial })
    } catch {
      port = ''
    }
  }
  if (port) {
    out.GEAOS_SERIAL_PORT = port
    out.GEAOS_MTK_GADGET_GLOB = port
    out.GEA_BOARD_MTK_MONITOR_GLOB = port
  } else if (selection.usbSerial) {
    out.GEAOS_MTK_GADGET_GLOB = `/dev/cu.usbmodem*${selection.usbSerial}*`
    out.GEA_BOARD_MTK_MONITOR_GLOB = `/dev/cu.usbmodem*${selection.usbSerial}*`
  }
  return out
}

function run(command, args, { cwd, env, dryRun, stdout, failureCode }) {
  if (dryRun) {
    stdout(formatCommand([command, ...args]))
    return 0
  }
  if (!existsSync(command)) fail(`${command} was not found. Is the geaos target project available at ${cwd}?`, ExitCode.missingDependency)
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new CliError(`ERROR: Command failed (${result.status ?? 1}): ${formatCommand([command, ...args])}`, failureCode)
  return 0
}

export function runGeaos({ ctx, selection, action, app = null, positionals = [], env, dryRun = false, stdout }) {
  const childEnv = geaosEnv(ctx, selection, env)
  const targetDir = selection.targetDir
  const appId = app?.id || positionals[0] || ''
  const needApp = () => {
    if (!appId) fail('A geaos app id is required (--app <id>).', ExitCode.usage)
    return appId
  }
  if (selection.bootMode === 'ram-only') {
    if (!['build', 'flash', 'flash-monitor', 'monitor', 'ota'].includes(action)) {
      fail(`'${action}' is not supported by this RAM-only target.`, ExitCode.usage)
    }
    // The CLI's deployment actions invoke fastboot boot, never flash. Keep
    // this route ahead of the legacy MediaTek scripts and their fallbacks.
    const ramAction = action === 'ota' ? 'deploy' : action === 'flash' || action === 'flash-monitor' ? 'boot' : action
    if (selection.host || selection.otaHost) childEnv.GEAOS_DEVICE_HOST = selection.host || selection.otaHost
    return run(path.join(targetDir, 'board.py'), appId ? [ramAction, appId] : [ramAction],
      { cwd: targetDir, env: childEnv, dryRun, stdout,
        failureCode: action === 'build' ? ExitCode.buildFailed : ExitCode.deployFailed })
  }
  if (selection.adapter === 'geaos-arm64') {
    const script = path.join(targetDir, 'flash-geaos-arm64.sh')
    switch (action) {
      case 'build':
      case 'flash':
      case 'flash-monitor':
        return run(script, [needApp()], { cwd: targetDir, env: { ...childEnv, GEAOS_ARM64_ACTION: action }, dryRun, stdout, failureCode: action === 'build' ? ExitCode.buildFailed : ExitCode.deployFailed })
      case 'monitor':
        return run(script, [appId || 'tic-tac-toe'], { cwd: targetDir, env: { ...childEnv, GEAOS_ARM64_ACTION: 'monitor' }, dryRun, stdout, failureCode: ExitCode.deployFailed })
      default:
        fail(`'${action}' is not supported by geaos-arm64 boards (build|flash|run|monitor).`, ExitCode.usage)
    }
  }
  const deviceArgs = []
  if (selection.telnetHost) deviceArgs.push('--host', selection.telnetHost)
  if (selection.telnetPort) deviceArgs.push('--port', selection.telnetPort)
  switch (action) {
    case 'build':
      return run(path.join(targetDir, 'build-geaos.sh'), [needApp()], { cwd: targetDir, env: childEnv, dryRun, stdout, failureCode: ExitCode.buildFailed })
    case 'flash':
    case 'flash-monitor':
      return run(path.join(targetDir, 'flash-geaos.sh'), [needApp()], { cwd: targetDir, env: childEnv, dryRun, stdout, failureCode: ExitCode.deployFailed })
    case 'flash-kernel':
      return run(path.join(targetDir, 'flash-kernel.sh'), positionals, { cwd: targetDir, env: childEnv, dryRun, stdout, failureCode: ExitCode.deployFailed })
    case 'bringup':
    case 'probe':
    case 'shell':
    case 'push':
    case 'screenshot':
    case 'record':
    case 'tap':
    case 'drag':
    case 'down':
    case 'move':
    case 'up':
      return run(path.join(targetDir, 'geaos-device.py'), [...deviceArgs, action, ...positionals], { cwd: targetDir, env: childEnv, dryRun, stdout, failureCode: ExitCode.deployFailed })
    default:
      fail(`'${action}' is not supported by geaos-linux boards.`, ExitCode.usage)
  }
}
