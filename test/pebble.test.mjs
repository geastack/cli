import assert from 'node:assert/strict'
import test from 'node:test'
import { pebbleBuildArgs, runPebble } from '../src/pebble/adapter.mjs'
import { knownPlatforms } from '../src/manifest.mjs'
import { runGea } from '../src/gea.mjs'
import { ExitCode } from '../src/errors.mjs'
import { fileURLToPath } from 'node:url'

const app = { id: 'counter', root: '/apps/my counter', entry: 'src/watch.tsx' }
const script = '/packages/pebble/build-pebble.sh'

test('Pebble builds forward the manifest entry and preserve paths as arguments', () => {
  assert.deepEqual(pebbleBuildArgs(script, { app }), [script, app.root, '--entry', 'src/watch.tsx'])
  assert.ok(knownPlatforms.includes('pebble'))
})

test('run installs on the emulator by default or the requested phone', () => {
  assert.deepEqual(pebbleBuildArgs(script, { app, run: true }).slice(-2), ['--install', 'emulator'])
  assert.deepEqual(pebbleBuildArgs(script, { app, run: true, phone: '192.168.1.23' }).slice(-2), ['--install', '192.168.1.23'])
  assert.ok(!pebbleBuildArgs(script, { app, phone: '192.168.1.23' }).includes('--install'))
})

test('missing Pebble package reports an actionable dependency error', () => {
  assert.throws(() => runPebble({ app, env: {}, dryRun: true, stdout() {} }), error => {
    assert.equal(error.exitCode, ExitCode.missingDependency)
    assert.match(error.message, /@geastack\/pebble is not installed/)
    return true
  })
})

test('Pebble command requires an app instead of entering the board workflow', async () => {
  await assert.rejects(runGea(['build', '--target', 'pebble'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: {}, stdout() {}, stderr() {}
  }), error => {
    assert.equal(error.exitCode, ExitCode.usage)
    assert.match(error.message, /No app selected/)
    return true
  })
})
