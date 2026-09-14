import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { spinner } from '@clack/prompts'
import pc from 'picocolors'

import { CliError, ExitCode } from './errors.mjs'

const failureTailLines = 40

// Windows ships `npm`, `npx` and the ESP-IDF installer as `.cmd`/`.bat` shims
// rather than real executables. Without a shell, spawn resolves neither
// PATHEXT nor those shims, so the call dies with ENOENT, and Node refuses to
// launch a batch file directly anyway (CVE-2024-27980) — the shell is the only
// way through. cmd.exe gets one flat string either way, so we quote the parts
// and join them ourselves rather than handing spawn an argument array it would
// only concatenate unescaped (DEP0190).
function spawnArgs(command, args, options) {
  if (process.platform !== 'win32' || options.shell) return [command, args, options]
  return [[command, ...args].map(quoteForCmd).join(' '), [], { ...options, shell: true }]
}

function quoteForCmd(value) {
  const text = String(value)
  if (text !== '' && !/[\s"^&|<>()!,;=]/.test(text)) return text
  // Backslashes only escape a quote, so the run that meets the closing quote
  // has to be doubled; embedded quotes take a backslash of their own.
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
}

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
  const result = spawnSync(...spawnArgs(command, args, { cwd, env, stdio: 'inherit' }))
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
// True when steps collapse to spinners: a terminal, and nobody asked for the
// raw stream. Callers use it to drop preamble the spinner labels already say.
export function quietSteps(env = process.env, verbose = false) {
  return !verbose && env.GEA_VERBOSE !== '1' && Boolean(process.stdout.isTTY)
}

export async function runQuiet(command, args, options = {}) {
  const { failureCode = ExitCode.generic } = options
  const { status } = await runStep(command, args, options)
  if (status !== 0) throw new CliError(`ERROR: Command failed (${status}): ${formatCommand([command, ...args])}`, failureCode)
}

// Same step handling for callers that retry on their own: returns the exit
// status and whether the output went to the log rather than the terminal.
export async function runStep(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    dryRun = false,
    verbose = false,
    label = command,
    logFile = null,
    appendLog = false,
    stdout = console.log,
    stderr = console.error
  } = options
  if (dryRun) {
    stdout(`${label}...`)
    stdout(formatCommand([command, ...args]))
    return { status: 0, quiet: false }
  }

  const passthrough = verbose || env.GEA_VERBOSE === '1' || !process.stdout.isTTY || !logFile
  if (passthrough) {
    stdout(`${label}...`)
    const status = await spawnAndWait(command, args, { cwd, env, stdio: 'inherit' })
    return { status, quiet: false }
  }

  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const log = fs.openSync(logFile, appendLog ? 'a' : 'w')
  const progress = spinner()
  progress.start(label)
  const status = await spawnAndWait(command, args, { cwd, env, stdio: ['ignore', log, log] })
  fs.closeSync(log)
  if (status === 0) {
    progress.stop(`${label} ${pc.dim(`(log: ${logFile})`)}`)
    return { status, quiet: true }
  }

  progress.stop(pc.red(`${label} failed`), 1)
  stderr(failureExcerpt(logFile))
  stderr(pc.dim(`Full log: ${logFile}`))
  return { status, quiet: true }
}

function spawnAndWait(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(...spawnArgs(command, args, options))
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
