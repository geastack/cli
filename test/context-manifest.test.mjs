import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { parseArgs } from '../src/args.mjs'
import { createChildEnv, createContext } from '../src/context.mjs'
import { loadTargets } from '../src/boards/targets.mjs'
import {
  appCmakeMeta,
  appCmakeDefines,
  appCmakeLdFragments,
  appPlatformForTarget,
  appPlatformsForTarget,
  discoverApps,
  findCurrentApp,
  targetEnabledForApp,
  validateApp
} from '../src/manifest.mjs'
import { createFixture, writeJson } from './helpers/fixture.mjs'

test('createContext resolves every Geastack package from the project node_modules', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs([]), {}, fixture.appDir)

  assert.equal(ctx.projectRoot, fixture.appDir)
  assert.equal(ctx.targetsRoot, fixture.installed('targets'))
  assert.equal(ctx.corePackageDir, fixture.installed('core'))
  assert.equal(ctx.compilerPackageDir, fixture.installed('compiler'))
  assert.equal(ctx.pluginPackageDir, fixture.installed('geatsc-plugin-gea'))
  assert.equal(ctx.chipsPackageDir, fixture.installed('chips'))
  assert.equal(ctx.buildRoot, path.join(fixture.appDir, '.gea', 'build'))
  assert.equal(ctx.scripts, undefined)
})

test('--project overrides project discovery from the working directory', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs(['--project', fixture.root]), {}, '/')
  assert.equal(ctx.projectRoot, fixture.root)
  assert.equal(ctx.targetsRoot, fixture.installed('targets'))
})

test('createChildEnv exports exact installed package paths and nothing stale', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs(['--boards-config', 'local-boards.json']), {}, fixture.appDir)
  const env = createChildEnv(ctx, { GEA_EXTRA_APP_DIRS: '/custom/apps', PATH: '/bin' })

  assert.equal(env.GEA_APPS_ROOT, fixture.appDir)
  assert.equal(env.GEA_CORE_DIR, fixture.installed('core'))
  assert.equal(env.GEA_CHIPS_DIR, fixture.installed('chips'))
  assert.equal(env.GEA_ENGINE_DIR, fixture.installed('engine'))
  assert.equal(env.GEA_HOST_DIR, fixture.installed('host'))
  assert.equal(env.GEA_TARGETS_ROOT, fixture.installed('targets'))
  assert.equal(env.GEA_CLI_BIN, ctx.cliBin)
  assert.equal(env.GEA_EXTRA_APP_DIRS, `/custom/apps${path.delimiter}${fixture.appDir}`)
  assert.equal(env.GEA_BOARDS_CONFIG, path.join(fixture.appDir, 'local-boards.json'))
  assert.equal(env.PATH, '/bin')
  assert.equal(env.GEA_CORE_PACKAGE, undefined)
})

test('createContext discovers a project-local board config', (t) => {
  const fixture = createFixture(t)
  const boardsPath = path.join(fixture.appDir, '.gea/boards.json')
  writeJson(boardsPath, { desk: { target: 'esp32-s3-touch-amoled-2.06', adapter: 'esp32-idf' } })

  const ctx = createContext(parseArgs([]), {}, path.join(fixture.appDir, 'nested'))
  const env = createChildEnv(ctx, {})

  assert.equal(ctx.projectRoot, fixture.appDir)
  assert.equal(ctx.projectBoardsConfig, boardsPath)
  // The project tier is merged over the home tier by the config loader; only
  // an explicit --boards-config is `boardsConfig`, and only that reaches
  // child processes.
  assert.equal(ctx.boardsConfig, '')
  assert.equal(env.GEA_BOARDS_CONFIG, undefined)
  assert.ok(ctx.homeBoardsConfig.endsWith(path.join('.geastack', 'boards.json')))
  assert.equal(createContext(parseArgs([]), { HOME: fixture.root }, fixture.appDir).homeBoardsConfig, path.join(fixture.root, '.geastack', 'boards.json'))
  assert.equal(createContext(parseArgs([]), { GEA_HOME: '/opt/gea' }, fixture.appDir).homeBoardsConfig, path.join('/opt/gea', 'boards.json'))
  assert.equal(createContext(parseArgs([]), { GEA_BOARDS_CONFIG: '/etc/gea/boards.json' }, fixture.appDir).boardsConfig, '/etc/gea/boards.json')
})

test('targets.json entries resolve to installed target project directories', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs([]), {}, fixture.root)
  const targets = loadTargets(ctx)
  assert.equal(targets['esp32-s3-touch-amoled-2.06'].targetDir, fixture.esp32Target)
  assert.equal(targets['esp32-s3-touch-amoled-2.06'].adapter, 'esp32-idf')
  assert.equal(targets.geaos.targetDir, path.resolve(fixture.installed('targets'), '../geaos/targets/geaos'))
})

test('manifest discovery finds root workspace apps in deterministic order', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs([]), {}, fixture.root)
  assert.deepEqual(discoverApps(ctx).map((app) => app.id), ['bad-app', 'watch', 'web-only'])
})

test('GEA_EXTRA_APP_DIRS adds apps outside the project', (t) => {
  const fixture = createFixture(t)
  const extra = path.join(fixture.root, '..', path.basename(fixture.root) + '-extra')
  t.after(() => import('node:fs').then((fs) => fs.rmSync(extra, { recursive: true, force: true })))
  writeJson(path.join(extra, 'package.json'), { name: 'extra', gea: { id: 'extra-app', entry: 'index.tsx', targets: { esp32: true }, nativeSources: ['native/bench.cpp'] } })
  const ctx = createContext(parseArgs([]), { GEA_EXTRA_APP_DIRS: extra }, fixture.root)
  const app = discoverApps(ctx).find((candidate) => candidate.id === 'extra-app')
  assert.ok(app)
  assert.deepEqual(app.nativeSources, ['native/bench.cpp'])
  assert.equal(appCmakeMeta(ctx, app), `${extra};index.tsx;gea;native/bench.cpp`)
  assert.deepEqual(validateApp(app), ['gea.entry does not exist: index.tsx', 'gea.nativeSources entry does not exist: native/bench.cpp'])
})

test('manifest helpers validate current app and installed target metadata', (t) => {
  const fixture = createFixture(t)
  const ctx = createContext(parseArgs([]), { HOME: fixture.root }, fixture.root)

  const current = findCurrentApp(path.join(fixture.appDir, 'nested/deeper'))
  assert.equal(current.id, 'watch')
  assert.deepEqual(validateApp(current), [])
  assert.equal(appCmakeMeta(ctx, current), 'apps/watch;index.tsx;gea')
  assert.equal(appPlatformForTarget(ctx, 'amoled'), 'esp32')
  assert.equal(appPlatformForTarget(ctx, 'esp32-s3-touch-amoled-2.06'), 'esp32')
  assert.equal(appPlatformForTarget(ctx, 'tufty'), 'rp2350')
  assert.deepEqual(appPlatformsForTarget(ctx, 'tufty'), ['rp2350', 'esp32'])
  assert.equal(targetEnabledForApp(ctx, current, 'amoled'), true)
  assert.equal(targetEnabledForApp(ctx, current, 'tufty'), true)

  const bad = findCurrentApp(fixture.badAppDir)
  assert.deepEqual(validateApp(bad), ['gea.entry does not exist: missing.tsx'])
})

test('an app declares compile defines and linker fragments for the native build', (t) => {
  const fixture = createFixture(t)
  const root = path.join(fixture.root, 'apps', 'pedal')
  writeJson(path.join(root, 'package.json'), {
    name: 'pedal',
    gea: {
      id: 'pedal',
      entry: 'index.tsx',
      targets: { esp32: true },
      defines: { GEA_EMBEDDED_UI_TRANSFORM_CACHE_SLOTS: 4, GEA_RUNTIME_COMPACT_ALLOCATION: true, GEA_UNUSED: false },
      ldFragments: 'memory.lf'
    }
  })
  const app = findCurrentApp(root)
  assert.deepEqual(app.defines, ['GEA_EMBEDDED_UI_TRANSFORM_CACHE_SLOTS=4', 'GEA_RUNTIME_COMPACT_ALLOCATION'])
  assert.deepEqual(app.ldFragments, ['memory.lf'])
  assert.equal(appCmakeDefines(app), 'GEA_EMBEDDED_UI_TRANSFORM_CACHE_SLOTS=4;GEA_RUNTIME_COMPACT_ALLOCATION')
  assert.equal(appCmakeLdFragments(app), path.join(root, 'memory.lf'))
  // The meta line stays positional: defines and fragments must not leak into it.
  const ctx = createContext(parseArgs([]), {}, fixture.root)
  assert.equal(appCmakeMeta(ctx, app).includes('memory.lf'), false)
  assert.ok(validateApp(app).includes('gea.ldFragments entry does not exist: memory.lf'))
})

test('an array of defines is accepted and invalid macros are reported', (t) => {
  const fixture = createFixture(t)
  const root = path.join(fixture.root, 'apps', 'arrayed')
  writeJson(path.join(root, 'package.json'), {
    name: 'arrayed',
    gea: { id: 'arrayed', entry: 'index.tsx', targets: { esp32: true }, defines: ['GEA_A=1', 'GEA_B', '2BAD=1'] }
  })
  const app = findCurrentApp(root)
  assert.deepEqual(app.defines, ['GEA_A=1', 'GEA_B', '2BAD=1'])
  assert.ok(validateApp(app).includes('gea.defines entry is not a valid macro: 2BAD=1'))
})

test('an app without the new fields keeps empty lists', (t) => {
  const fixture = createFixture(t)
  const root = path.join(fixture.root, 'apps', 'plain')
  writeJson(path.join(root, 'package.json'), { name: 'plain', gea: { id: 'plain', entry: 'index.tsx', targets: { esp32: true } } })
  const app = findCurrentApp(root)
  assert.deepEqual(app.defines, [])
  assert.deepEqual(app.ldFragments, [])
  assert.equal(appCmakeDefines(app), '')
  assert.equal(appCmakeLdFragments(app), '')
})
