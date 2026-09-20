import fs from 'node:fs'
import path from 'node:path'

// WiFi credentials come from the app's .env (GEA_WIFI_SSID / GEA_WIFI_PASSWORD)
// and are compiled in as a generated header inside the build directory.

export function readDotEnv(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
  const values = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals < 0) continue
    let key = line.slice(0, equals).trim()
    if (key.startsWith('export ')) key = key.slice(7).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(equals + 1).trim()
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

export function quoteCString(value) {
  let output = '"'
  for (const character of String(value)) {
    const code = character.codePointAt(0)
    if (character === '\\') output += '\\\\'
    else if (character === '"') output += '\\"'
    else if (character === '\n') output += '\\n'
    else if (character === '\r') output += '\\r'
    else if (character === '\t') output += '\\t'
    else if (code < 0x20 || code === 0x7f) output += `\\x${code.toString(16).padStart(2, '0')}""`
    else output += character
  }
  return `${output}"`
}

export function wifiConfigContents(values) {
  const ssid = values.GEA_WIFI_SSID || ''
  const password = values.GEA_WIFI_PASSWORD || ''
  return [
    '#pragma once',
    `#define GEA_EMBEDDED_WIFI_SSID ${quoteCString(ssid)}`,
    `#define GEA_EMBEDDED_WIFI_PASSWORD ${quoteCString(password)}`,
    `#define GEA_EMBEDDED_WIFI_EARLY_CONNECT ${ssid ? 1 : 0}`,
    ''
  ].join('\n')
}

export function generateWifiConfig(appDir, outputFile) {
  const contents = wifiConfigContents(readDotEnv(path.join(appDir, '.env')))
  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  let current = ''
  try {
    current = fs.readFileSync(outputFile, 'utf8')
  } catch {
    current = ''
  }
  if (current !== contents) fs.writeFileSync(outputFile, contents, { mode: 0o600 })
  fs.chmodSync(outputFile, 0o600)
  return outputFile
}
