import path from 'node:path'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { flag, option } from '../args.mjs'
import { ExitCode, fail } from '../errors.mjs'
import { formatCommand } from '../run.mjs'
import { appleTargetScript, macosAppBundle, runMacos } from './adapter.mjs'

function numberOption(parsed, name, fallback, min, max, integer = true) {
  const raw = option(parsed, name, String(fallback))
  const value = typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    fail(`--${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`, ExitCode.usage)
  }
  return value
}

export function prerender({ app, parsed, cwd, env, stdout }) {
  const width = numberOption(parsed, 'width', 410, 1, 8192)
  const height = numberOption(parsed, 'height', 502, 1, 8192)
  const dpr = numberOption(parsed, 'dpr', 1, 0.1, 8, false)
  const fps = numberOption(parsed, 'fps', 60, 1, 1000)
  const frame = numberOption(parsed, 'frame', 0, 0, 2147483647)
  const at = option(parsed, 'at')
  if (at !== undefined && option(parsed, 'frame') !== undefined) {
    fail('Choose one of --frame and --at.', ExitCode.usage)
  }
  let timestamp = Math.round(frame * 1000 / fps)
  if (at !== undefined) {
    const duration = typeof at === 'string' && /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(at)
    if (!duration) fail('--at must be a duration such as 500ms or 5s. Bare numbers are milliseconds.', ExitCode.usage)
    timestamp = Math.round(Number(duration[1]) * (duration[2] === 's' ? 1000 : 1))
  }
  if (timestamp > 2147483647) fail('Capture time exceeds the native millisecond clock range.', ExitCode.usage)
  const output = option(parsed, 'out')
  if (typeof output !== 'string' || !output.trim()) fail('Pass --out <file.png>.', ExitCode.usage)
  if (option(parsed, 'target', 'macos') !== 'macos') fail('Prerender currently supports the macOS target.', ExitCode.usage)
  if (!app.targets?.macos) fail(`'${app.id}' does not declare gea.targets.macos.`, ExitCode.usage)
  const dryRun = flag(parsed, 'dry-run')
  if (!dryRun && process.platform !== 'darwin') fail('Native prerender currently requires macOS.', ExitCode.usage)

  const { script } = appleTargetScript(app, 'macos', 'build-macos.sh', env)
  if (!existsSync(path.join(path.dirname(script), 'main', 'macos_prerender.h'))) {
    fail('The installed @geastack/apple lacks native prerender support.', ExitCode.missingDependency)
  }
  runMacos({ app, env: { ...env, GEA_MACOS_PRERENDER: '1' }, dryRun, stdout })
  const executable = path.join(macosAppBundle(app, env), 'Contents', 'MacOS', app.name)
  const outputPath = path.resolve(cwd, output)
  const args = ['--gea-prerender', outputPath, String(width), String(height), String(dpr), String(fps), String(timestamp)]
  if (dryRun) {
    stdout(formatCommand([executable, ...args]))
    return 0
  }

  const result = spawnSync(executable, args, { cwd: app.root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`Native prerender failed (${result.signal || result.status}).`, ExitCode.buildFailed)
  stdout(outputPath)
  return 0
}
