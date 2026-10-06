import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { nativeDebugBuilds } from '../src/debugger-builds.mjs'

const app = { id: 'demo', root: '/workspace/apps/demo' }
const selection = { target: 'esp32-demo' }
const ctx = { buildRoot: path.join(app.root, '.gea/build') }
const build = (root, variant = '') => {
  const directory = path.join(root, '.gea/build', selection.target, 'app-builds', app.id + variant)
  return {
    elf: path.join(directory, 'gea_embedded.elf'),
    metadata: path.join(directory, 'apps', app.id, 'gea-debug-source.json'),
  }
}

test('current-directory attach discovers complete app and ancestor workspace builds', () => {
  const local = build(app.root)
  const workspace = build('/workspace')
  const files = new Set([...Object.values(local), ...Object.values(workspace)])
  assert.deepEqual(
    nativeDebugBuilds(ctx, selection, app, {}, (file) => files.has(file)),
    [local, workspace],
  )
  files.delete(local.metadata)
  assert.deepEqual(
    nativeDebugBuilds(ctx, selection, app, {}, (file) => files.has(file)),
    [workspace],
  )
})

test('an explicit build root is authoritative and variants keep their canonical path', () => {
  const explicit = build('/chosen', '__variant-debug')
  const workspace = build('/workspace', '__variant-debug')
  const files = new Set([...Object.values(explicit), ...Object.values(workspace)])
  const env = { GEA_PROJECT_BUILD_ROOT: '/chosen/.gea/build', GEA_IDF_BUILD_VARIANT: 'debug' }
  assert.deepEqual(
    nativeDebugBuilds({ buildRoot: env.GEA_PROJECT_BUILD_ROOT }, selection, app, env, (file) =>
      files.has(file),
    ),
    [explicit],
  )
})
