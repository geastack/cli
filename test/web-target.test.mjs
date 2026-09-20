import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { ExitCode } from '../src/errors.mjs'
import { runGea } from '../src/gea.mjs'
import { webPaths } from '../src/web/adapter.mjs'
import { capture, createFixture, writeExecutable, writeJson } from './helpers/fixture.mjs'

// A stand-in for an installed @geastack/simulator. The adapter only ever asks
// whether the three scripts exist and then hands them to bash/node, so a
// fixture that has the files is enough to assert the whole contract without an
// emcc compile -- which is also why every test here runs --dry-run.
function fakeSimulator(root) {
  const dir = path.join(root, 'fake-simulator')
  const web = path.join(dir, 'targets', 'web')
  fs.mkdirSync(path.join(dir, 'simulator'), { recursive: true })
  fs.mkdirSync(web, { recursive: true })
  fs.writeFileSync(path.join(dir, 'simulator', 'vite.config.ts'), '// fixture\n')
  fs.writeFileSync(path.join(web, 'build-web.sh'), '#!/usr/bin/env bash\nexit 0\n')
  fs.writeFileSync(path.join(web, 'dev-web.mjs'), '// fixture\n')
  fs.writeFileSync(path.join(web, 'build-dom-web.mjs'), '// fixture\n')
  writeJson(path.join(dir, 'package.json'), { name: '@geastack/simulator', version: '0.1.0' })
  return dir
}

// PATH is replaced rather than prepended: whether this machine happens to have
// a real Emscripten installed must not decide what the test asserts.
function envWith(root, binaries) {
  const bin = path.join(root, 'fake-bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const name of binaries) writeExecutable(path.join(bin, name), '#!/usr/bin/env bash\nprintf "4.0.0\\n"\n')
  return { ...process.env, PATH: bin, GEA_SIMULATOR_DIR: fakeSimulator(root) }
}

test('gea simulate builds to wasm and serves the simulator', async (t) => {
  const fixture = createFixture(t)
  const env = envWith(fixture.root, ['emcc', 'em++'])
  const out = capture()

  assert.equal(await runGea(['simulate', 'watch', '--dry-run'], { ...out.io, cwd: fixture.root, env }), 0)

  const printed = out.out.join('\n')
  assert.match(printed, /targets\/web\/build-web\.sh watch/)
  assert.match(printed, /vite --root .*fake-simulator\/simulator/)
})

test('gea dev defaults to the real DOM web target and resolves the app from the cwd', async (t) => {
  const fixture = createFixture(t)
  const env = envWith(fixture.root, ['emcc', 'em++'])
  const appDir = path.join(fixture.root, 'apps', 'watch')
  const out = capture()

  assert.equal(await runGea(['dev', '--dry-run'], { ...out.io, cwd: appDir, env }), 0)

  assert.match(out.out.join('\n'), new RegExp(`dev-web\\.mjs --app-dir ${appDir}$`, 'm'))
})

test('gea dev --target web and a bare gea dev are the same command', async (t) => {
  const fixture = createFixture(t)
  const env = envWith(fixture.root, ['emcc', 'em++'])
  const appDir = path.join(fixture.root, 'apps', 'watch')

  const bare = capture()
  const stated = capture()
  assert.equal(await runGea(['dev', '--dry-run'], { ...bare.io, cwd: appDir, env }), 0)
  assert.equal(await runGea(['dev', '--target', 'web', '--dry-run'], { ...stated.io, cwd: appDir, env }), 0)

  assert.deepEqual(bare.out, stated.out)
})

test('gea build --target web is no longer refused and writes outside node_modules', async (t) => {
  const fixture = createFixture(t)
  const env = envWith(fixture.root, ['emcc', 'em++'])
  const appDir = path.join(fixture.root, 'apps', 'watch')
  const out = capture()

  assert.equal(await runGea(['build', '--target', 'web', '--dry-run'], { ...out.io, cwd: appDir, env }), 0)

  const printed = out.out.join('\n')
  assert.doesNotMatch(printed, /not driven by gea/)
  assert.match(printed, /build-dom-web\.mjs --app-dir/)
  assert.match(printed, new RegExp(`--out-dir ${path.join(appDir, '.gea', 'build', 'web', 'site')}`))
})

test('gea simulate names the Emscripten SDK when emcc is missing', async (t) => {
  const fixture = createFixture(t)
  const env = envWith(fixture.root, [])
  const out = capture()

  await assert.rejects(
    runGea(['simulate', 'watch', '--dry-run'], { ...out.io, cwd: fixture.root, env }),
    (error) => {
      assert.equal(error.exitCode, ExitCode.missingDependency)
      assert.match(error.message, /emcc and em\+\+ not on PATH/)
      assert.match(error.message, /emsdk_env\.sh/)
      return true
    }
  )
})

test('the web commands refuse an app that does not declare the target', async (t) => {
  const fixture = createFixture(t)
  const env = envWith(fixture.root, ['emcc', 'em++'])
  const appDir = path.join(fixture.root, 'apps', 'device-only')
  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(path.join(appDir, 'index.tsx'), 'export default () => null\n')
  writeJson(path.join(appDir, 'package.json'), {
    name: '@fixture/device-only',
    private: true,
    gea: { id: 'device-only', name: 'Device Only', entry: 'index.tsx', runtime: 'gea', targets: { web: false, esp32: true } }
  })
  const out = capture()

  await assert.rejects(runGea(['dev', '--dry-run'], { ...out.io, cwd: appDir, env }), (error) => {
    assert.equal(error.exitCode, ExitCode.usage)
    assert.match(error.message, /does not declare gea\.targets\.web/)
    return true
  })
})

test('the web commands require an app to act on', async (t) => {
  const fixture = createFixture(t)
  const env = envWith(fixture.root, ['emcc', 'em++'])
  const out = capture()

  await assert.rejects(runGea(['dev', '--dry-run'], { ...out.io, cwd: fixture.root, env }), (error) => {
    assert.equal(error.exitCode, ExitCode.usage)
    assert.match(error.message, /No app selected/)
    return true
  })
})

test('web build output is the app\'s, and the object cache is the machine\'s', () => {
  const app = { id: 'watch', root: '/somewhere/apps/watch', targets: { web: true } }
  const paths = webPaths(app, { ...process.env, GEA_WEB_OBJCACHE_DIR: '' })

  // .gea/build/ is what `gea create` already gitignores, so simulating an app
  // must not leave ~800MB of untracked output in the user's repo.
  for (const key of ['generated', 'dist', 'public', 'domOut', 'viteCache', 'lock']) {
    assert.ok(paths[key].startsWith('/somewhere/apps/watch/.gea/build/web'), `${key}: ${paths[key]}`)
  }
  // The object cache is hash-keyed by toolchain and flags, so sharing it across
  // apps is safe -- and it is the expensive half worth not duplicating.
  assert.ok(!paths.objcache.startsWith(app.root), paths.objcache)
})
