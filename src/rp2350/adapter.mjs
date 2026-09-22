import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolvePicotoolSelection } from '../boards/usb.mjs'
import { CliError, ExitCode, fail } from '../errors.mjs'
import { envPath } from '../env-path.mjs'
import { appCmakeMeta } from '../manifest.mjs'
import { formatCommand } from '../run.mjs'

// Raspberry Pi RP2350 boards through the Pico SDK: cmake configure + build,
// then UF2 over the BOOTSEL volume or picotool.

const firmwareStems = {
  'rp2350-waveshare-touch-amoled-2.41': 'gea_rp2350_touch_amoled_241',
  'rp2350-tufty-2350': 'gea_rp2350_tufty_2350'
}

function toolchainHasRuntime(root) {
  if (!existsSync(path.join(root, 'bin', 'arm-none-eabi-gcc'))) return false
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'nosys.specs') return true
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name))
    }
  }
  return false
}

function globDirs(pattern) {
  const parent = path.dirname(pattern)
  const prefix = path.basename(pattern).replace(/\*.*$/, '')
  const suffix = pattern.includes('*') ? pattern.slice(pattern.indexOf('*') + 1) : ''
  try {
    return readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(parent, name, suffix))
      .filter((dir) => existsSync(dir))
  } catch {
    return []
  }
}

export function prepareArmToolchain(env, stderr = () => {}) {
  if (env.PICO_TOOLCHAIN_PATH) {
    return { ...env, PATH: `${path.join(env.PICO_TOOLCHAIN_PATH, 'bin')}${path.delimiter}${env.PATH || ''}` }
  }
  const probe = spawnSync('arm-none-eabi-gcc', ['-print-file-name=nosys.specs'], { env, encoding: 'utf8' })
  const specs = (probe.stdout || '').trim()
  if (probe.status === 0 && specs && specs !== 'nosys.specs' && existsSync(specs)) return env
  const candidates = [
    ...globDirs(path.join(os.homedir(), 'Tools', 'arm-gnu-toolchain-*', 'extract', 'Payload')),
    ...globDirs('/Applications/ArmGNUToolchain/*/arm-none-eabi')
  ]
  for (const candidate of candidates) {
    if (toolchainHasRuntime(candidate)) {
      stderr(`Using RP2350 ARM toolchain: ${candidate}`)
      return { ...env, PICO_TOOLCHAIN_PATH: candidate, PATH: `${path.join(candidate, 'bin')}${path.delimiter}${env.PATH || ''}` }
    }
  }
  fail('RP2350 Pico SDK builds need an arm-none-eabi toolchain with newlib/nosys.specs.\nInstall the official Arm GNU Embedded toolchain or set PICO_TOOLCHAIN_PATH to its root.', ExitCode.missingDependency)
}

export function cmakeBinary(env) {
  if (env.CMAKE) return env.CMAKE
  for (const dir of envPath(env).split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, 'cmake'))) return path.join(dir, 'cmake')
  }
  for (const candidate of ['/opt/homebrew/bin/cmake', '/usr/local/bin/cmake', '/Applications/CMake.app/Contents/bin/cmake']) {
    if (existsSync(candidate)) return candidate
  }
  fail('CMake is required for RP2350 Pico SDK builds. Install cmake or set CMAKE=/path/to/cmake.', ExitCode.missingDependency)
}

export function firmwareTarget(selection, app) {
  const stem = firmwareStems[selection.target]
  if (!stem) fail(`No RP2350 firmware target is registered for '${selection.target}'.`, ExitCode.usage)
  return app ? `${stem}_app` : `${stem}_bringup`
}

function run(command, args, { cwd, env, dryRun, stdout, failureCode = ExitCode.buildFailed }) {
  if (dryRun) {
    stdout(formatCommand([command, ...args]))
    return
  }
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new CliError(`ERROR: Command failed (${result.status ?? 1}): ${formatCommand([command, ...args])}`, failureCode)
}

export function rp2350BuildDir(ctx, selection) {
  return path.join(ctx.buildRoot, selection.target)
}

export function buildRp2350({ ctx, selection, app = null, env, dryRun = false, stdout, stderr, configureOnly = false }) {
  const toolEnv = prepareArmToolchain(env, stderr)
  const cmake = cmakeBinary(toolEnv)
  const buildDir = rp2350BuildDir(ctx, selection)
  const configure = ['-S', selection.targetDir, '-B', buildDir]
  const buildEnv = { ...toolEnv }
  if (app) {
    const meta = appCmakeMeta(ctx, app)
    configure.push(`-DGEA_EMBEDDED_APP=${app.id}`, `-DGEA_EMBEDDED_APP_META=${meta}`)
    buildEnv.GEA_EMBEDDED_APP = app.id
    buildEnv.GEA_EMBEDDED_APP_META = meta
  }
  run(cmake, configure, { cwd: selection.targetDir, env: buildEnv, dryRun, stdout })
  if (configureOnly) return { buildDir, uf2: '' }
  const target = firmwareTarget(selection, app)
  run(cmake, ['--build', buildDir, '--target', target], { cwd: selection.targetDir, env: buildEnv, dryRun, stdout })
  return { buildDir, uf2: path.join(buildDir, `${target}.uf2`) }
}

function bootselVolumes(env) {
  const user = env.USER || 'user'
  return [
    ...globDirs('/Volumes/RPI-RP2*'),
    ...globDirs('/Volumes/RP2350*'),
    `/media/${user}/RPI-RP2`,
    `/media/${user}/RP2350`,
    `/run/media/${user}/RPI-RP2`,
    `/run/media/${user}/RP2350`
  ].filter((dir) => existsSync(dir))
}

export function flashRp2350({ selection, uf2, env, dryRun = false, stdout }) {
  if (!dryRun && !existsSync(uf2)) fail(`UF2 image not found after build: ${uf2}`, ExitCode.deployFailed)
  const [volume] = bootselVolumes(env)
  if (volume) {
    const copyArgs = process.platform === 'darwin' ? ['-X', uf2, `${volume}/`] : [uf2, `${volume}/`]
    run('cp', copyArgs, { env, dryRun, stdout, failureCode: ExitCode.deployFailed })
    if (!dryRun) spawnSync('sync', [], { stdio: 'ignore' })
    stdout(`Copied UF2 to ${volume}. The board should reboot automatically.`)
    return
  }
  const picotool = spawnSync('picotool', ['version'], { env, stdio: 'ignore' })
  if (!picotool.error) {
    const selectionArgs = selection.usbSerial ? resolvePicotoolSelection({ serial: selection.usbSerial }) : []
    run('picotool', ['load', ...selectionArgs, '-f', '-x', uf2], { env, dryRun, stdout, failureCode: ExitCode.deployFailed })
    return
  }
  if (dryRun) {
    stdout(formatCommand(['picotool', 'load', '-f', '-x', uf2]))
    return
  }
  fail('Could not flash RP2350 target.\nInstall picotool or put the board in BOOTSEL mode so RPI-RP2/RP2350 is mounted, then retry.', ExitCode.deployFailed)
}
