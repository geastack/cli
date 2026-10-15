import { existsSync } from 'node:fs'
import path from 'node:path'

import { resolveBuildConfig, writeBuildConfig } from '../build-config.mjs'
import { ExitCode, fail } from '../errors.mjs'
import { appCmakeMeta } from '../manifest.mjs'
import { runExternal } from '../run.mjs'
import { onPath } from '../toolchain.mjs'
import { armToolchainRoot, findArmGcc } from './toolchain.mjs'

// STMicroelectronics STM32 boards: cmake configure + build with the Arm GNU
// toolchain against the target's CMSIS headers, then one openocd `program`
// of the ELF, which writes internal flash and the board's QSPI flash
// (execute-in-place app code) in a single pass.

const boards = {
  'stm32f746g-disco': { stem: 'gea_stm32f746g_disco', openocdConfig: 'board/stm32f746g-disco.cfg' }
}

function boardFor(selection) {
  const board = boards[selection.target]
  if (!board) fail(`No STM32 firmware target is registered for '${selection.target}'.`, ExitCode.usage)

  return board
}

export function firmwareTarget(selection, app) {
  const { stem } = boardFor(selection)
  return app ? `${stem}_app` : `${stem}_bringup`
}

export function stm32BuildDir(ctx, selection) {
  return path.join(ctx.buildRoot, selection.target)
}

// Fails before CMake runs when a build tool is missing. The toolchain found is
// handed to the target's CMake toolchain file as ARM_TOOLCHAIN_PATH, which
// also covers the Arm installer's folders that are not on PATH.
function buildToolsEnv(env) {
  const gcc = findArmGcc(env)
  if (!gcc) {
    fail('STM32 builds need the Arm GNU toolchain: put arm-none-eabi-gcc on PATH or set ARM_TOOLCHAIN_PATH to its root.', ExitCode.missingDependency)
  }

  if (!env.CMAKE && !onPath('cmake', env)) {
    fail('STM32 builds need CMake 3.20+. Install cmake or set CMAKE=/path/to/cmake.', ExitCode.missingDependency)
  }

  return { ...env, ARM_TOOLCHAIN_PATH: armToolchainRoot(gcc) }
}

export function buildStm32({ ctx, selection, app = null, env, dryRun = false, stdout, configureOnly = false }) {
  const toolsEnv = dryRun ? env : buildToolsEnv(env)
  const resolvedBuild = resolveBuildConfig({ app, platform: 'stm32', board: selection.target, targetBase: selection.targetBase, targetsRoot: ctx.targetsRoot, env })
  const cmake = env.CMAKE || 'cmake'
  const buildDir = stm32BuildDir(ctx, selection)
  const buildConfig = writeBuildConfig(buildDir, resolvedBuild)
  const configure = [
    '-S', selection.targetDir,
    '-B', buildDir,
    `-DGEA_BUILD_CONFIG_FILE=${buildConfig.cmake}`,
    `-DGEA_BUILD_CONFIG_JSON=${buildConfig.json}`,
    `-DGEA_BUILD_CONFIG_HASH=${buildConfig.hash}`,
    `-DGEA_EMBEDDED_APP_DEFINES=${resolvedBuild.defines.join(';')}`
  ]
  if (resolvedBuild.cssDevicePixelRatio) configure.push(`-DGEA_EMBEDDED_CSS_DEVICE_PIXEL_RATIO=${resolvedBuild.cssDevicePixelRatio}`)

  const buildEnv = { ...toolsEnv }
  if (app) {
    const meta = appCmakeMeta(ctx, app)
    configure.push(`-DGEA_EMBEDDED_APP=${app.id}`, `-DGEA_EMBEDDED_APP_META=${meta}`)
    buildEnv.GEA_EMBEDDED_APP = app.id
    buildEnv.GEA_EMBEDDED_APP_META = meta
    // gea.compilerPlugins: the app's own geatsc plugins, as absolute paths.
    buildEnv.GEA_EMBEDDED_APP_GEATSC_PLUGINS = app.compilerPlugins.map((plugin) => path.join(app.root, plugin)).join(';')
  }

  const step = { cwd: selection.targetDir, env: buildEnv, dryRun, stdout, failureCode: ExitCode.buildFailed }
  runExternal(cmake, configure, step)
  if (configureOnly) return { buildDir, elf: '' }

  const target = firmwareTarget(selection, app)
  runExternal(cmake, ['--build', buildDir, '--target', target, '--parallel'], step)
  return { buildDir, elf: path.join(buildDir, `${target}.elf`) }
}

// The ST-LINK's USB serial number doubles as the openocd adapter selector, so
// an alias registered for `gea monitor` also pins which board gets flashed.
export function flashStm32({ selection, elf, env, dryRun = false, stdout }) {
  const { openocdConfig } = boardFor(selection)
  if (!dryRun && !existsSync(elf)) fail(`ELF image not found after build: ${elf}`, ExitCode.deployFailed)
  if (!dryRun && !onPath('openocd', env)) fail('Flashing STM32 boards needs openocd 0.12+ (brew install open-ocd).', ExitCode.missingDependency)

  const adapterSerial = selection.usbSerial ? ['-c', `adapter serial ${selection.usbSerial}`] : []
  const args = ['-f', openocdConfig, ...adapterSerial, '-c', `program {${elf}} verify reset exit`]
  runExternal('openocd', args, { env, dryRun, stdout, failureCode: ExitCode.deployFailed })
}
