import assert from 'node:assert/strict'
import test from 'node:test'

import { CliError, ExitCode } from '../src/errors.mjs'
import { formatCommand, runExternal } from '../src/run.mjs'

test('formatCommand shell-quotes spaces and apostrophes', () => {
  assert.equal(
    formatCommand(['/tmp/my tool', "it's", '--flag=value']),
    "'/tmp/my tool' 'it'\\''s' --flag=value"
  )
})

test('runExternal dry-run prints command without executing', () => {
  const out = []
  const code = runExternal('/missing command', ['arg one'], {
    dryRun: true,
    stdout: (line) => out.push(line)
  })

  assert.equal(code, 0)
  assert.equal(out[0], "'/missing command' 'arg one'")
})

test('runExternal maps failed child status to requested exit code', () => {
  assert.throws(
    () => runExternal(process.execPath, ['-e', 'process.exit(7)'], {
      failureCode: ExitCode.buildFailed
    }),
    (error) => error instanceof CliError && error.exitCode === ExitCode.buildFailed && /Command failed/.test(error.message)
  )
})
