import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { parseArgs } from '../src/args.mjs'
import { createChildEnv, createContext } from '../src/context.mjs'
import {
  appPlatformForTarget,
  appPlatformsForTarget,
  discoverApps,
  findCurrentApp,
  targetEnabledForApp,
  validateApp
} from '../src/manifest.mjs'
import { createFixture, writeJson } from './helpers/fixture.mjs'

test('createContext honors collection root and package-dir overrides', (t) => {
  const fixture = createFixture(t)
  const parsed = parseArgs(['--collection-root', fixture.root])

  const ctx = createContext(parsed, {}, path.join(fixture.root, 'examples/apps/watch'))

  assert.equal(ctx.collectionRoot, fixture.root)
  assert.equal(ctx.androidRoot, path.join(fixture.root, 'android'))
  assert.equal(ctx.corePackageDir, path.join(fixture.root, 'core/packages/core'))
  assert.equal(ctx.compilerPackageDir, path.join(fixture.root, 'compiler'))
  assert.equal(ctx.examplesRoot, path.join(fixture.root, 'examples'))
})

test('createContext normalizes legacy package-dir env overrides back to repo roots', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs([]), {
    GEA_COLLECTION_ROOT: fixture.root,
    GEA_CORE_DIR: path.join(fixture.root, 'core/packages/core'),
    GEA_COMPILER_DIR: path.join(fixture.root, 'compiler')
  }, fixture.root)

  assert.equal(ctx.coreRoot, path.join(fixture.root, 'core'))
  assert.equal(ctx.compilerRoot, path.join(fixture.root, 'compiler'))
})

test('createChildEnv fills split-repo environment without clobbering explicit values', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs(['--collection-root', fixture.root, '--boards-config', 'local-boards.json']), {}, fixture.root)
  const env = createChildEnv(ctx, {
    GEA_APPS_ROOT: '/custom/apps',
    PATH: '/bin'
  })

  assert.equal(env.GEA_COLLECTION_ROOT, fixture.root)
  assert.equal(env.GEA_APPS_ROOT, '/custom/apps')
  assert.equal(env.GEA_CORE_DIR, path.join(fixture.root, 'core/packages/core'))
  assert.equal(env.GEA_BOARDS_CONFIG, path.join(fixture.root, 'local-boards.json'))
  assert.equal(env.PATH, '/bin')
})

test('createContext discovers project-local board config for generated apps', (t) => {
  const fixture = createFixture(t)
  const boardsPath = path.join(fixture.appDir, '.gea/boards.json')
  writeJson(boardsPath, {
    desk: {
      target: 'esp32-s3-touch-amoled-2.06',
      adapter: 'esp32-idf'
    }
  })

  const ctx = createContext(parseArgs(['--collection-root', fixture.root]), {}, path.join(fixture.appDir, 'nested'))
  const env = createChildEnv(ctx, {})

  assert.equal(ctx.projectRoot, fixture.appDir)
  assert.equal(ctx.projectBoardsConfig, boardsPath)
  assert.equal(ctx.boardsConfig, boardsPath)
  assert.equal(env.GEA_BOARDS_CONFIG, boardsPath)
})

test('manifest discovery finds examples and companion apps with deterministic order', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs(['--collection-root', fixture.root]), {}, fixture.root)
  const apps = discoverApps(ctx)

  assert.deepEqual(apps.map((app) => app.id), ['bad-app', 'gea-companion', 'watch', 'web-only'])
})

test('manifest helpers validate current app, target metadata, and board platform mapping', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs(['--collection-root', fixture.root]), {}, fixture.root)

  const current = findCurrentApp(path.join(fixture.appDir, 'nested/deeper'))
  assert.equal(current.id, 'watch')
  assert.deepEqual(validateApp(current), [])
  assert.equal(appPlatformForTarget(ctx, 'amoled'), 'esp32')
  assert.equal(appPlatformForTarget(ctx, 'esp32-s3-touch-amoled-2.06'), 'esp32')
  assert.equal(appPlatformForTarget(ctx, 'tufty'), 'rp2350')
  assert.equal(appPlatformForTarget(ctx, 'rp2350-tufty-2350'), 'rp2350')
  assert.deepEqual(appPlatformsForTarget(ctx, 'tufty'), ['rp2350', 'esp32'])
  assert.equal(appPlatformForTarget(ctx, 'android'), 'android')
  assert.equal(targetEnabledForApp(ctx, current, 'amoled'), true)
  assert.equal(targetEnabledForApp(ctx, current, 'tufty'), true)
  assert.equal(targetEnabledForApp(ctx, current, 'android'), true)

  const bad = findCurrentApp(fixture.badAppDir)
  assert.deepEqual(validateApp(bad), ['gea.entry does not exist: missing.tsx'])
})
