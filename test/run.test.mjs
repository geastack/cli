import assert from 'node:assert/strict'
import test from 'node:test'

import { CliError, ExitCode } from '../src/errors.mjs'
import { formatCommand, runExternal, runQuiet } from '../src/run.mjs'

// Exits 0 only when the argument survived the trip to the child intact, so a
// shell that ate the quotes shows up as a failing status rather than a pass.
const echoArgScript = 'process.exit(process.argv[1] === "two words" ? 0 : 3)'

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

test('runExternal keeps arguments intact through the sync path', () => {
  assert.equal(runExternal(process.execPath, ['-e', echoArgScript, 'two words']), 0)
})

test('runQuiet keeps arguments intact through the async path', async () => {
  await runQuiet(process.execPath, ['-e', echoArgScript, 'two words'], { stdout: () => {} })
})

test('runExternal resolves commands that exist only as a PATH shim', { skip: process.platform !== 'win32' }, () => {
  assert.equal(runExternal('npm', ['--version'], { stdout: () => {} }), 0)
})
