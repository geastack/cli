import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { envPath, withEnvPath } from '../env-path.mjs'

// ESP-IDF activation without `source export.sh`. export.sh re-checks Python,
// dependencies, outdated tools and shell completion on every invocation; the
// installation itself already knows the exact tool paths (idf_tools.py
// export) and which Python env it installed, so the CLI reads those and runs
// `<venv>/bin/python $IDF_PATH/tools/idf.py` directly.

const idfVersionFile = 'tools/cmake/version.cmake'

export function espIdfVersion(idfDir) {
  const file = path.join(idfDir, idfVersionFile)
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8')
    const major = text.match(/set\(IDF_VERSION_MAJOR\s+(\d+)\)/)?.[1]
    const minor = text.match(/set\(IDF_VERSION_MINOR\s+(\d+)\)/)?.[1]
    const patch = text.match(/set\(IDF_VERSION_PATCH\s+(\d+)\)/)?.[1]
    if (major && minor) return { major: Number(major), majorMinor: `${major}.${minor}`, full: `${major}.${minor}.${patch || 0}` }
  }
  const named = path.basename(idfDir).match(/^esp-idf-v(\d+\.\d+)(?:\.(\d+))?/)
  if (named) return { major: Number(named[1].split('.')[0]), majorMinor: named[1], full: `${named[1]}.${named[2] || 0}` }
  return null
}

function isIdfDir(dir) {
  return Boolean(dir) && existsSync(path.join(dir, 'tools', 'idf.py'))
}

function versionKey(dir) {
  const version = espIdfVersion(dir)?.full || '0.0.0'
  return version.split('.').map((part) => Number(part) || 0)
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0)
  }
  return 0
}

// A checkout of an unreleased IDF line (master, a release candidate) is named
// for it: `esp-idf-v6.2-dev`, `esp-idf-v6.1-rc1`. Its version.cmake already
// reads like the release, so the name is the only thing that tells it apart.
function isPrereleaseIdf(dir) {
  return /-(dev|rc\d*|beta\d*|master)$/i.test(path.basename(dir))
}

function meetsMinimum(dir, minimum) {
  if (!minimum) return true
  const want = minimum.split('.').map((part) => Number(part) || 0)
  return compareVersions(versionKey(dir), [want[0] || 0, want[1] || 0, 0]) >= 0
}

function matchesDefaultVersion(dir, defaultVersion) {
  if (!defaultVersion) return true
  const version = espIdfVersion(dir)
  if (defaultVersion.endsWith('-dev')) {
    return version?.majorMinor === defaultVersion.slice(0, -4) && /-dev$/i.test(path.basename(dir))
  }
  return version?.full === defaultVersion && !isPrereleaseIdf(dir)
}

// Generic discovery honours explicit settings and otherwise prefers the
// newest stable installation. Callers can request a minimum version instead.
// Builds provide an exact defaultVersion for automatic discovery. IDF_PATH
// overrides that default; export-script hints must still match the target.
export function findEspIdf(env = process.env, home = os.homedir(), { minVersion = '', defaultVersion = '' } = {}) {
  const accepts = (dir) => meetsMinimum(dir, minVersion) && matchesDefaultVersion(dir, defaultVersion)
  if (isIdfDir(env.IDF_PATH) && meetsMinimum(env.IDF_PATH, minVersion)) return path.resolve(env.IDF_PATH)
  const explicit = [envExportDir(env.GEA_EMBEDDED_IDF_EXPORT), envExportDir(env.ESP_IDF_EXPORT)]
  for (const candidate of explicit) {
    if (isIdfDir(candidate) && accepts(candidate)) return path.resolve(candidate)
  }
  const roots = [path.join(home, 'esp'), path.join(home, 'esp32'), home]
  const found = []
  for (const root of roots) {
    for (const name of ['esp-idf']) {
      const dir = path.join(root, name)
      if (isIdfDir(dir)) found.push(dir)
    }
    let entries = []
    try {
      entries = readdirSync(root)
    } catch {
      entries = []
    }
    for (const name of entries) {
      if (!/^esp-idf-v\d/.test(name)) continue
      const dir = path.join(root, name)
      if (isIdfDir(dir)) found.push(dir)
    }
  }
  if (found.length === 0) return ''
  found.sort((a, b) => compareVersions(versionKey(b), versionKey(a)))
  if (defaultVersion) return found.find(accepts) || ''
  if (minVersion) return found.find((dir) => meetsMinimum(dir, minVersion)) || ''
  return found.find((dir) => !isPrereleaseIdf(dir)) || found[0]
}

function envExportDir(exportScript) {
  return exportScript ? path.dirname(exportScript) : ''
}

// A venv keeps its interpreter in `bin/python` everywhere except Windows,
// where it is `Scripts/python.exe`. ESP-IDF's own installer follows that, so
// looking only for the POSIX layout finds nothing on a correctly installed
// Windows toolchain and reports it as missing.
const venvPython = process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python')
const venvBin = process.platform === 'win32' ? 'Scripts' : 'bin'
export const installScriptName = process.platform === 'win32' ? 'install.bat' : 'install.sh'

export function idfVenvPython(pythonEnv) {
  return path.join(pythonEnv, venvPython)
}

export function findIdfPythonEnv(idfDir, env = process.env, home = os.homedir()) {
  const version = espIdfVersion(idfDir)?.majorMinor
  const explicit = env.IDF_PYTHON_ENV_PATH
  const explicitVersion = explicit && path.basename(explicit).match(/^idf(\d+\.\d+)_py/)?.[1]
  if (explicit && (!explicitVersion || explicitVersion === version) && existsSync(idfVenvPython(explicit))) return explicit
  if (!version) return ''
  const envRoot = path.join(env.IDF_TOOLS_PATH || path.join(home, '.espressif'), 'python_env')
  let entries = []
  try {
    entries = readdirSync(envRoot)
  } catch {
    return ''
  }
  const prefix = `idf${version}_py`
  const candidates = entries
    .filter((name) => name.startsWith(prefix) && name.endsWith('_env'))
    .sort()
    .map((name) => path.join(envRoot, name))
    .filter((dir) => existsSync(idfVenvPython(dir)))
  return candidates[0] || ''
}

function parseKeyValueExport(output) {
  const values = {}
  for (const line of output.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    values[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return values
}

const activationCache = new Map()

// Returns the environment and command prefixes for one ESP-IDF install, or
// null when none is installed. `python` is the IDF venv interpreter, which
// is also where esptool lives.
// The tool export is cached per installation; the caller's environment is
// layered on fresh every time so per-invocation settings (jobs, variants,
// flash baud) are never frozen into a cached activation.
export function activateEspIdf({ env = process.env, home = env.HOME || env.USERPROFILE || os.homedir(), log = () => {}, minVersion = '', defaultVersion = '' } = {}) {
  const idfDir = findEspIdf(env, home, { minVersion, defaultVersion })
  if (!idfDir) return null
  // A venv exported by a different active checkout belongs to that checkout.
  const activeIdf = env.IDF_PATH || envExportDir(env.GEA_EMBEDDED_IDF_EXPORT) || envExportDir(env.ESP_IDF_EXPORT)
  const pythonEnvSettings = defaultVersion && activeIdf && path.resolve(activeIdf) !== idfDir
    ? { ...env, IDF_PYTHON_ENV_PATH: '' }
    : env
  const pythonEnv = findIdfPythonEnv(idfDir, pythonEnvSettings, home)
  if (!pythonEnv) {
    const envRoot = path.join(env.IDF_TOOLS_PATH || path.join(home, '.espressif'), 'python_env')
    throw new Error(
      `ESP-IDF at ${idfDir} has no installed Python environment under ${envRoot}. Run ${path.join(idfDir, installScriptName)} once.`
    )
  }
  const python = idfVenvPython(pythonEnv)
  const idfToolsPy = path.join(idfDir, 'tools', 'idf_tools.py')
  const cacheKey = `${idfDir}\n${pythonEnv}`
  let exported = activationCache.get(cacheKey)
  if (!exported) {
    try {
      exported = parseKeyValueExport(
        execFileSync(python, [idfToolsPy, 'export', '--format', 'key-value'], {
          encoding: 'utf8',
          env: { ...env, IDF_PATH: idfDir, IDF_PYTHON_ENV_PATH: pythonEnv },
          stdio: ['ignore', 'pipe', 'ignore']
        })
      )
    } catch (error) {
      throw new Error(`ESP-IDF tool export failed for ${idfDir}: ${error.message}`)
    }
    activationCache.set(cacheKey, exported)
  }
  log(`Using ESP-IDF ${espIdfVersion(idfDir)?.full || ''} at ${idfDir} (python env ${pythonEnv})`)
  const callerPath = envPath(env)
  const exportedPath = (exported.PATH || '').replace(/\$PATH|%PATH%/g, callerPath)
  return {
    idfDir,
    version: espIdfVersion(idfDir),
    pythonEnv,
    python,
    idfPy: path.join(idfDir, 'tools', 'idf.py'),
    env: withEnvPath(
      {
        ...env,
        ...Object.fromEntries(Object.entries(exported).filter(([key]) => key !== 'PATH' && key !== 'IDF_DEACTIVATE_FILE_PATH')),
        IDF_PATH: idfDir,
        IDF_PYTHON_ENV_PATH: pythonEnv,
        VIRTUAL_ENV: pythonEnv
      },
      [path.join(pythonEnv, venvBin), exportedPath || callerPath].filter(Boolean).join(path.delimiter)
    )
  }
}

export function esptoolCommand(idf, args) {
  return { command: idf.python, args: ['-m', 'esptool', ...args] }
}

export function idfPyCommand(idf, args) {
  return { command: idf.python, args: [idf.idfPy, ...args] }
}
