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

test('createContext resolves Geastack packages from node_modules', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs([]), {}, fixture.appDir)

  assert.equal(ctx.projectRoot, fixture.appDir)
  assert.equal(ctx.targetsRoot, fixture.installed('targets'))
  assert.equal(ctx.corePackageDir, fixture.installed('core'))
  assert.equal(ctx.compilerPackageDir, fixture.installed('compiler'))
  assert.equal(ctx.chipsPackageDir, fixture.installed('chips'))
  assert.equal(ctx.scripts.board, path.join(fixture.installed('targets'), 'scripts/board'))
})

test('createChildEnv exports exact installed package paths', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs(['--boards-config', 'local-boards.json']), {}, fixture.appDir)
  const env = createChildEnv(ctx, {
    GEA_EXTRA_APP_DIRS: '/custom/apps',
    PATH: '/bin'
  })

  assert.equal(env.GEA_APPS_ROOT, fixture.appDir)
  assert.equal(env.GEA_CORE_PACKAGE, fixture.installed('core'))
  assert.equal(env.GEA_CORE_DIR, fixture.installed('core'))
  assert.equal(env.GEA_CHIPS_DIR, fixture.installed('chips'))
  assert.equal(env.GEA_ENGINE_DIR, fixture.installed('engine'))
  assert.equal(env.GEA_HOST_DIR, fixture.installed('host'))
  assert.equal(env.GEA_EXTRA_APP_DIRS, `/custom/apps${path.delimiter}${fixture.appDir}`)
  assert.equal(env.GEA_BOARDS_CONFIG, path.join(fixture.appDir, 'local-boards.json'))
  assert.equal(env.PATH, '/bin')
  assert.equal(env.GEA_COLLECTION_ROOT, undefined)
})

test('createContext discovers a project-local board config', (t) => {
  const fixture = createFixture(t)
  const boardsPath = path.join(fixture.appDir, '.gea/boards.json')
  writeJson(boardsPath, {
    desk: {
      target: 'esp32-s3-touch-amoled-2.06',
      adapter: 'esp32-idf'
    }
  })

  const ctx = createContext(parseArgs([]), {}, path.join(fixture.appDir, 'nested'))
  const env = createChildEnv(ctx, {})

  assert.equal(ctx.projectRoot, fixture.appDir)
  assert.equal(ctx.projectBoardsConfig, boardsPath)
  assert.equal(ctx.boardsConfig, boardsPath)
  assert.equal(env.GEA_BOARDS_CONFIG, boardsPath)
})

test('manifest discovery finds root workspace apps in deterministic order', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs([]), {}, fixture.root)
  const apps = discoverApps(ctx)

  assert.deepEqual(apps.map((app) => app.id), ['bad-app', 'watch', 'web-only'])
})

test('manifest helpers validate current app and installed target metadata', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs([]), {}, fixture.root)

  const current = findCurrentApp(path.join(fixture.appDir, 'nested/deeper'))
  assert.equal(current.id, 'watch')
  assert.deepEqual(validateApp(current), [])
  assert.equal(appPlatformForTarget(ctx, 'amoled'), 'esp32')
  assert.equal(appPlatformForTarget(ctx, 'esp32-s3-touch-amoled-2.06'), 'esp32')
  assert.equal(appPlatformForTarget(ctx, 'tufty'), 'rp2350')
  assert.deepEqual(appPlatformsForTarget(ctx, 'tufty'), ['rp2350', 'esp32'])
  assert.equal(targetEnabledForApp(ctx, current, 'amoled'), true)
  assert.equal(targetEnabledForApp(ctx, current, 'tufty'), true)

  const bad = findCurrentApp(fixture.badAppDir)
  assert.deepEqual(validateApp(bad), ['gea.entry does not exist: missing.tsx'])
})
