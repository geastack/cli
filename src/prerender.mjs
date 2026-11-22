import path from 'node:path'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { flag, option } from './args.mjs'
import { ExitCode, fail } from './errors.mjs'
import { formatCommand } from './run.mjs'
import { appleTargetScript, macosAppBundle, runMacos } from './macos/adapter.mjs'
import { linuxTargetRoot, runLinux } from './linux/adapter.mjs'
import { runWindows, windowsTargetRoot } from './windows/adapter.mjs'

const nativeTargets = {
  darwin: 'macos',
  linux: 'raspberry-pi-os',
  win32: 'windows'
}

function nativeBuild(app, target, env) {
  if (target === 'macos') {
    return {
      executable: path.join(macosAppBundle(app, env), 'Contents', 'MacOS', app.name),
      build: ({ dryRun, stdout }) => {
        const { script } = appleTargetScript(app, 'macos', 'build-macos.sh', env)
        if (!existsSync(path.join(path.dirname(script), 'main', 'macos_prerender.h'))) {
          fail('The installed @geastack/apple lacks native prerender support.', ExitCode.missingDependency)
        }
        return runMacos({ app, env: { ...env, GEA_MACOS_PRERENDER: '1' }, dryRun, stdout })
      }
    }
  }

  const linux = target === 'raspberry-pi-os'
  const output = linux ? env.GEA_LINUX_OUTPUT_DIR : env.GEA_WINDOWS_OUTPUT_DIR
  const name = linux ? app.id : `${app.name.replace(/[<>:"/\\|?*]+/g, '').trim() || app.id}.exe`

  return {
    executable: path.resolve(app.root, output || path.join('dist', target), app.id, name),
    build: ({ dryRun, stdout }) => {
      const root = linux ? linuxTargetRoot(app, env) : windowsTargetRoot(app, env)
      const platform = linux ? 'raspberry-pi-os' : 'win32'
      const source = linux ? 'rpios_prerender.cpp' : 'win32_prerender.cpp'
      if (!existsSync(path.join(root, 'targets', platform, 'main', source))) {
        fail(`The installed @geastack/${linux ? 'linux' : 'windows'} lacks native prerender support.`, ExitCode.missingDependency)
      }

      return linux
        ? runLinux({ app, env: { ...env, GEA_LINUX_PRERENDER_RGBA: '1' }, dryRun, stdout })
        : runWindows({ app, env: { ...env, GEA_WINDOWS_PRERENDER_RGBA: '1' }, dryRun, stdout })
    }
  }
}

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
  const target = option(parsed, 'target', nativeTargets[process.platform])
  if (!Object.values(nativeTargets).includes(target)) {
    fail('Prerender supports macos, windows, and raspberry-pi-os.', ExitCode.usage)
  }
  if (!app.targets?.[target]) fail(`'${app.id}' does not declare gea.targets.${target}.`, ExitCode.usage)
  const dryRun = flag(parsed, 'dry-run')
  const reuse = flag(parsed, 'reuse')
  if (!dryRun && nativeTargets[process.platform] !== target) {
    fail(`Cannot run a ${target} prerender on ${process.platform}.`, ExitCode.usage)
  }

  const { executable, build } = nativeBuild(app, target, env)
  if (reuse) {
    if (!dryRun && !existsSync(executable)) {
      fail(`No native prerender executable at ${executable}. Run prerender once to build it.`, ExitCode.buildFailed)
    }
  } else {
    build({ dryRun, stdout })
  }
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
