import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { appCmakeMeta, appSummary, normalizeApp, normalizeNativeSources, validateApp } from '../src/manifest.mjs'
import { createFixture } from './helpers/fixture.mjs'

test('shared native inputs survive manifest normalization and reach native build metadata', (t) => {
  const fixture = createFixture(t)
  const root = path.join(fixture.root, 'preview')
  mkdirSync(root)
  writeFileSync(path.join(root, 'index.ts'), '')
  writeFileSync(path.join(fixture.root, 'shared.cpp'), 'void shared() {}\n')
  const app = normalizeApp(root, {
    name: 'preview',
    gea: { entry: 'index.ts', nativeSources: ['../shared.cpp', '../missing.c', '../shared.cpp'] }
  })
  assert.deepEqual(app.nativeSources, ['../shared.cpp', '../missing.c'])
  assert.deepEqual(validateApp(app), ['gea.nativeSources entry does not exist: ../missing.c'])
  const ctx = { projectRoot: fixture.root }
  assert.deepEqual(appSummary(ctx, app).nativeSourcePaths, [path.join(fixture.root, 'shared.cpp')])
  const meta = appCmakeMeta(ctx, app).split(';')
  assert.equal(meta[3], '../shared.cpp')
  assert.equal(path.resolve(meta[0], meta[3]), path.join(fixture.root, 'shared.cpp'))
})

test('only native inputs accept parent paths; metadata delimiters and absolute inputs remain rejected', () => {
  assert.deepEqual(normalizeNativeSources(['../shared.cpp', '../../shared.c', '/absolute.cpp', '../x;bad.cpp']), [
    '../shared.cpp', '../../shared.c'
  ])
  const app = normalizeApp('/project/app', {
    name: 'app',
    gea: { targets: { esp32: { componentDirs: ['../first', '../second'], ldFragments: ['../first.lf', '../second.lf'] } } }
  })
  assert.deepEqual(app.targetConfig.esp32.componentDirs, ['', ''])
  assert.deepEqual(app.targetConfig.esp32.ldFragments, ['', ''])
})
