import { existsSync } from 'node:fs'
import path from 'node:path'

import { flag } from '../args.mjs'
import { boardConfigPath, boardConfigTiers, loadBoardConfig } from '../boards/config.mjs'
import { ExitCode } from '../errors.mjs'
import { findEspIdf, findIdfPythonEnv } from '../esp32/idf-env.mjs'
import { exists } from '../fs-utils.mjs'
import { discoverApps, resolveRequestedApp, validateApp } from '../manifest.mjs'
import { commandVersion, nodeAtLeast } from '../toolchain.mjs'
import pc from 'picocolors'

function packageExists(dir) {
  return Boolean(dir) && exists(path.join(dir, 'package.json'))
}

function onPath(name, env) {
  return String(env.PATH || '').split(path.delimiter).some((dir) => dir && existsSync(path.join(dir, name)))
}

async function serialportAvailable() {
  try {
    await import('serialport')
    return true
  } catch {
    return false
  }
}

export async function doctorCommand(ctx, parsed, rest, options) {
  const env = options.env || process.env
  const checks = []
  const add = (name, ok, detail, required) => checks.push({ name, ok: Boolean(ok), detail: String(detail ?? ''), required })

  add('project root', exists(ctx.projectRoot), ctx.projectRoot, true)
  add('Node >= 20.19', nodeAtLeast(20, 19), process.version, true)
  add('@geastack/targets', packageExists(ctx.targetsRoot), ctx.targetsRoot || 'not installed in this project', true)
  add('@geastack/core', packageExists(ctx.corePackageDir), ctx.corePackageDir || 'not installed', true)
  add('@geastack/compiler', packageExists(ctx.compilerPackageDir), ctx.compilerPackageDir || 'not installed', true)
  add('@geastack/geatsc-plugin-gea', packageExists(ctx.pluginPackageDir), ctx.pluginPackageDir || 'not installed', true)
  for (const [name, dir] of [['@geastack/chips', ctx.chipsPackageDir], ['@geastack/engine', ctx.enginePackageDir], ['@geastack/host', ctx.hostPackageDir], ['@geastack/elements', ctx.elementsPackageDir], ['@geastack/geaos', ctx.geaosPackageDir]]) {
    add(name, packageExists(dir), dir || 'not installed', false)
  }
  add('serialport (USB device access)', await serialportAvailable(), 'npm package', false)

  const idfDir = findEspIdf(env)
  const pythonEnv = idfDir ? findIdfPythonEnv(idfDir, env) : ''
  add('ESP-IDF', Boolean(idfDir), idfDir || 'not found (set IDF_PATH)', false)
  add('ESP-IDF python env', Boolean(pythonEnv), pythonEnv || 'run install.sh in ESP-IDF', false)
  add('cmake', onPath('cmake', env) || Boolean(pythonEnv), commandVersion('cmake', ['--version'], env).split('\n')[0] || 'from ESP-IDF tools', false)
  add('ninja', onPath('ninja', env), onPath('ninja', env) ? 'on PATH' : 'optional; Unix Makefiles used otherwise', false)
  add('ccache', onPath('ccache', env), onPath('ccache', env) ? 'on PATH' : 'optional', false)
  add('arm-none-eabi-gcc (RP2350)', onPath('arm-none-eabi-gcc', env) || Boolean(env.PICO_TOOLCHAIN_PATH), env.PICO_TOOLCHAIN_PATH || 'optional', false)
  add('picotool (RP2350)', onPath('picotool', env), onPath('picotool', env) ? 'on PATH' : 'optional', false)
  add('swift (BLE OTA)', onPath('swift', env), onPath('swift', env) ? 'on PATH' : 'optional; macOS only', false)

  const boardFiles = boardConfigTiers(ctx).filter((tier) => exists(tier.file)).map((tier) => tier.file)
  try {
    const boards = boardFiles.length ? loadBoardConfig(ctx) : {}
    add('boards.json', true, boardFiles.length ? `${boardFiles.join(', ')} (${Object.keys(boards).length} board(s))` : `not configured (gea boards add; looked for ${boardConfigPath(ctx)})`, false)
  } catch (error) {
    add('boards.json', false, error.message, true)
  }

  const apps = discoverApps(ctx)
  add('app catalog', apps.length > 0, `${apps.length} app(s)`, true)
  let currentApp = null
  try {
    currentApp = resolveRequestedApp(ctx, parsed, [])
  } catch {
    currentApp = null
  }
  if (currentApp) {
    const errors = validateApp(currentApp)
    add(`app manifest (${currentApp.id})`, errors.length === 0, errors.length === 0 ? currentApp.root : errors.join('; '), true)
  }

  const failedRequired = checks.filter((check) => check.required && !check.ok)
  const failedOptional = checks.filter((check) => !check.required && !check.ok)
  if (flag(parsed, 'json')) {
    options.stdout(JSON.stringify({ ok: failedRequired.length === 0, checks }, null, 2))
  } else {
    for (const check of checks) {
      const marker = check.ok ? pc.green('[ok]') : check.required ? pc.red('[fail]') : pc.yellow('[warn]')
      options.stdout(`${marker} ${check.name}: ${check.detail}`)
    }
    if (failedRequired.length > 0 || failedOptional.length > 0) options.stdout('Setup guide: cli/docs/SETUP.md')
  }
  if (failedRequired.length > 0) return ExitCode.missingDependency
  if (failedOptional.length > 0 && flag(parsed, 'strict')) return ExitCode.missingDependency
  return 0
}
