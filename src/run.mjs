import { spawnSync } from 'node:child_process'

import { CliError, ExitCode } from './errors.mjs'

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
