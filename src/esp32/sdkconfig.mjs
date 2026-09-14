import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// ESP-IDF's generated sdkconfig is mutable build state. It lives beside the
// CMake cache that owns it (inside the app's own build directory), so
// configuring one app can never rewrite another app's configuration or the
// stale target-root sdkconfig old builds left behind. The file starts empty:
// a partial sdkconfig is valid Kconfig input and IDF fills everything else
// from sdkconfig.defaults on the first configure.
export function prepareBuildLocalSdkconfig(targetDir, buildDir) {
  const normalized = path.normalize(buildDir)
  if (!buildDir || normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.split(path.sep).includes('..')) {
    throw new Error(`Invalid ESP32 build directory: ${buildDir}`)
  }
  const file = path.isAbsolute(buildDir) ? path.join(buildDir, 'sdkconfig') : path.join(targetDir, buildDir, 'sdkconfig')
  const defaultsFile = path.join(targetDir, 'sdkconfig.defaults')
  if (!existsSync(defaultsFile)) throw new Error(`ESP32 sdkconfig defaults not found: ${defaultsFile}`)
  mkdirSync(path.dirname(file), { recursive: true })
  if (!existsSync(file)) writeFileSync(file, '')
  return { file, defaultsFile }
}

function splitLines(text) {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function withSdkconfigValue(text, key, value) {
  const lines = splitLines(text)
  const wanted = `${key}=${value}`
  if (lines.includes(wanted)) return text
  const out = []
  let written = false
  for (const line of lines) {
    if (line.startsWith(`${key}=`) || line === `# ${key} is not set`) {
      if (!written) {
        out.push(wanted)
        written = true
      }
      continue
    }
    out.push(line)
  }
  if (!written) out.push(wanted)
  return `${out.join('\n')}\n`
}

export function withSdkconfigUnset(text, key) {
  const lines = splitLines(text)
  const unset = `# ${key} is not set`
  if (lines.includes(unset) && !lines.some((line) => line.startsWith(`${key}=`))) return text
  const out = []
  let written = false
  for (const line of lines) {
    if (line.startsWith(`${key}=`) || line === unset) {
      if (!written) {
        out.push(unset)
        written = true
      }
      continue
    }
    out.push(line)
  }
  if (!written) out.push(unset)
  return `${out.join('\n')}\n`
}

function matchSdkconfigValue(text, key) {
  return text.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=(.*)$`, 'm'))?.[1] ?? ''
}

export class Sdkconfig {
  // `appDefaultsFile` is gea.targets.esp32.sdkconfig -- the app's own defaults,
  // layered over the board's. It is kept separate from the board text because
  // the policy has to be able to ask which of the two asked for a setting.
  constructor(file, defaultsFile, appDefaultsFile = '') {
    this.file = file
    this.defaultsFile = defaultsFile
    this.appDefaultsFile = appDefaultsFile
    this.text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    this.defaults = existsSync(defaultsFile) ? readFileSync(defaultsFile, 'utf8') : ''
    this.appDefaults = appDefaultsFile && existsSync(appDefaultsFile) ? readFileSync(appDefaultsFile, 'utf8') : ''
  }

  set(key, value) {
    this.text = withSdkconfigValue(this.text, key, value)
    return this
  }

  unset(key) {
    this.text = withSdkconfigUnset(this.text, key)
    return this
  }

  has(pattern) {
    return pattern.test(this.text)
  }

  defaultValue(key) {
    return this.appDefaultValue(key) || matchSdkconfigValue(this.defaults, key)
  }

  defaultIsSet(key) {
    return this.defaultValue(key) === 'y'
  }

  // Only what the app's own defaults file asked for, ignoring the board's.
  appDefaultValue(key) {
    return matchSdkconfigValue(this.appDefaults, key)
  }

  appDefaultIsSet(key) {
    return this.appDefaultValue(key) === 'y'
  }

  save() {
    const current = existsSync(this.file) ? readFileSync(this.file, 'utf8') : null
    if (current !== this.text) writeFileSync(this.file, this.text)
  }
}
