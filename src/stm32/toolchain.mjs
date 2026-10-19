import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { envPath, withEnvPath } from '../env-path.mjs'
import { findOnPath, globDirs } from '../toolchain.mjs'

// The tools an STM32 board needs: the Arm GNU toolchain and CMake to build it,
// openocd to flash it. `gea doctor`, `gea setup` and the stm32-cube adapter all
// ask here, so they agree on what is installed.

const stm32Tools = [
  {
    name: 'arm-none-eabi-gcc (STM32)',
    find: findArmGcc,
    versionArgs: ['-dumpversion'],
    minimum: '',
    install: 'brew install --cask gcc-arm-embedded, or the Arm GNU Toolchain from developer.arm.com (ARM_TOOLCHAIN_PATH names its root)'
  },
  {
    name: 'cmake 3.20+ (STM32)',
    find: (env) => env.CMAKE || findOnPath('cmake', env),
    versionArgs: ['--version'],
    minimum: '3.20',
    install: 'brew install cmake, or set CMAKE=/path/to/cmake'
  },
  {
    name: 'openocd 0.12+ (STM32 flashing)',
    find: (env) => findOnPath('openocd', env),
    versionArgs: ['--version'],
    minimum: '0.12',
    install: 'brew install open-ocd'
  }
]

// arm-none-eabi-gcc where the target's CMake toolchain file looks for it
// (ARM_TOOLCHAIN_PATH, then PATH), then in the folders the Arm installer
// creates on macOS; '' when there is none.
export function findArmGcc(env = process.env) {
  const dirs = [
    env.ARM_TOOLCHAIN_PATH ? path.join(env.ARM_TOOLCHAIN_PATH, 'bin') : '',
    envPath(env),
    ...globDirs('/Applications/ArmGNUToolchain/*/arm-none-eabi/bin')
  ]
  const searchEnv = withEnvPath(env, dirs.filter(Boolean).join(path.delimiter))
  return findOnPath('arm-none-eabi-gcc', searchEnv)
}

// The toolchain root a found compiler lives under, as ARM_TOOLCHAIN_PATH spells it.
export function armToolchainRoot(gcc) {
  return path.dirname(path.dirname(gcc))
}

// One { name, ok, detail } per tool, `detail` naming the install command when
// the tool is missing or too old.
export function stm32ToolChecks(env = process.env) {
  return stm32Tools.map((tool) => toolCheck(tool, env))
}

function toolCheck(tool, env) {
  const file = tool.find(env)
  if (!file) return { name: tool.name, ok: false, detail: `not found; ${tool.install}` }

  const version = toolVersion(file, tool.versionArgs, env)
  if (!version) return { name: tool.name, ok: false, detail: `${file} reports no version; ${tool.install}` }

  if (tool.minimum && !versionAtLeast(version, tool.minimum)) {
    return { name: tool.name, ok: false, detail: `${version} at ${file}, needs ${tool.minimum}+; ${tool.install}` }
  }

  return { name: tool.name, ok: true, detail: `${version} at ${file}` }
}

// The first x.y[.z] a tool prints for its version. openocd prints it on stderr.
function toolVersion(file, args, env) {
  const result = spawnSync(file, args, { encoding: 'utf8', env })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  return output.match(/\d+\.\d+(\.\d+)?/)?.[0] || ''
}

function versionAtLeast(version, minimum) {
  const [major, minor] = version.split('.').map(Number)
  const [minimumMajor, minimumMinor] = minimum.split('.').map(Number)
  return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor)
}
