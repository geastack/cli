import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { spinner } from '@clack/prompts'
import pc from 'picocolors'

import { CliError, ExitCode } from './errors.mjs'

const failureTailLines = 40

export function runExternal(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    dryRun = false,
    failureCode = ExitCode.generic,
    stdout = console.log
  } = options
  if (dryRun) {
    stdout(formatCommand([command, ...args]))
    return 0
  }
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new CliError(`ERROR: Command failed (${result.status ?? 1}): ${formatCommand([command, ...args])}`, failureCode)
  }
  return result.status ?? 0
}

export function formatCommand(parts) {
  return parts.map(shellQuote).join(' ')
}

function shellQuote(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_/:=.,@%+\-]+$/.test(text)) return text
  return `'${text.replaceAll("'", "'\\''")}'`
}

// Long external steps (ESP-IDF configure, cmake, npm install) print hundreds
// of lines nobody reads when they succeed. On a terminal the step shows as a
// spinner and its output goes to `logFile`; the tail of that log comes back
// on failure. `--verbose` (or GEA_VERBOSE=1) and any non-terminal run keep
// the raw passthrough.
export async function runQuiet(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    dryRun = false,
    verbose = false,
    label = command,
    logFile = null,
    failureCode = ExitCode.generic,
    stdout = console.log,
    stderr = console.error
  } = options
  if (dryRun) {
    stdout(`${label}...`)
    stdout(formatCommand([command, ...args]))
    return
  }

  const passthrough = verbose || env.GEA_VERBOSE === '1' || !process.stdout.isTTY || !logFile
  if (passthrough) {
    stdout(`${label}...`)
    const status = await spawnAndWait(command, args, { cwd, env, stdio: 'inherit' })
    if (status !== 0) throw new CliError(`ERROR: Command failed (${status}): ${formatCommand([command, ...args])}`, failureCode)

    return
  }

  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const log = fs.openSync(logFile, 'w')
  const progress = spinner()
  progress.start(label)
  const status = await spawnAndWait(command, args, { cwd, env, stdio: ['ignore', log, log] })
  fs.closeSync(log)
  if (status === 0) {
    progress.stop(`${label} ${pc.dim(`(log: ${logFile})`)}`)
    return
  }

  progress.stop(pc.red(`${label} failed`), 1)
  stderr(failureExcerpt(logFile))
  stderr(pc.dim(`Full log: ${logFile}`))
  throw new CliError(`ERROR: Command failed (${status}): ${formatCommand([command, ...args])}`, failureCode)
}

function spawnAndWait(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

// Parallel make keeps printing after the failing job, so the tail of the log
// is usually other targets finishing. Show the lines around the first
// error instead, and fall back to the tail when nothing looks like one.
const errorPattern = /(^|\s)(error|fatal error|ERROR)\b|:\d+:\d+: |no certificate|command failed|\*\*\* \[/
const noiseNamePattern = /\.(c|cpp|o|obj|a)\b/

function failureExcerpt(logFile) {
  const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n')
  const first = lines.findIndex((line) => errorPattern.test(line) && !noiseNamePattern.test(line))
  if (first < 0) return lines.slice(-failureTailLines).join('\n')

  const start = Math.max(0, first - 5)
  return lines.slice(start, start + failureTailLines).join('\n')
}
