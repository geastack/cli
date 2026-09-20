import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateLauncherCatalog } from '../src/apps/launcher-catalog.mjs'
import { discoverAppsInRoot } from '../src/manifest.mjs'

function writePackage(dir, gea) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: gea.id, gea }, null, 2)}\n`)
}

const root = mkdtempSync(join(tmpdir(), 'gea-launcher-catalog-'))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
writePackage(join(root, 'apps', 'app-launcher'), {
  id: 'app-launcher',
  name: 'Launcher',
  targets: { geaos: true },
  launcher: { hidden: true }
})
writePackage(join(root, 'apps', 'alpha'), {
  id: 'alpha',
  name: 'Alpha',
  targets: { geaos: true },
  icons: { 64: 'icons/icon-64.png' },
  launcher: { description: 'first app', order: 2, accent: '#111111' }
})
writePackage(join(root, 'apps', 'beta'), {
  id: 'beta',
  name: 'Beta',
  targets: { geaos: true },
  launcher: { description: 'second app', order: 1, accent: '#222222' }
})
mkdirSync(join(root, 'apps', 'alpha', 'icons'), { recursive: true })
writeFileSync(join(root, 'apps', 'alpha', 'icons', 'icon-64.png'), 'icon')

const out = join(root, 'apps', 'app-launcher', 'generated', 'LauncherCatalog.tsx')
const apps = generateLauncherCatalog({ repoRoot: root, apps: discoverAppsInRoot(root), target: 'geaos', outputFile: out })
assert.deepEqual(apps.map((app) => app.id), ['beta', 'alpha'])

const source = readFileSync(out, 'utf8')
assert.match(source, /Apps\.launch\("beta"\)/)
assert.match(source, /Apps\.launch\("alpha"\)/)
assert.match(source, /<span class="launcher-card-title">Alpha<\/span>/)
assert.match(source, /<img class="launcher-card-icon" src="generated\/icons\/alpha-64\.png" \/>/)
assert.doesNotMatch(source, /launcher-card-description/)
assert.doesNotMatch(source, /first app/)
assert.doesNotMatch(source, /second app/)
assert.doesNotMatch(source, /iconSrc=/)
assert.doesNotMatch(source, /import \{ LauncherButton \}/)
assert.doesNotMatch(source, /app-launcher/)

writePackage(join(root, 'apps', 'app-launcher'), {
  id: 'app-launcher',
  name: 'Launcher',
  targets: { geaos: true },
  launcher: { hidden: true },
  launcherCatalog: { appIds: ['alpha'] }
})
const filteredOut = join(root, 'apps', 'app-launcher', 'generated', 'FilteredLauncherCatalog.tsx')
const filteredApps = generateLauncherCatalog({ repoRoot: root, apps: discoverAppsInRoot(root), target: 'geaos', outputFile: filteredOut })
assert.deepEqual(filteredApps.map((app) => app.id), ['alpha'])
const filteredSource = readFileSync(filteredOut, 'utf8')
assert.match(filteredSource, /Apps\.launch\("alpha"\)/)
assert.doesNotMatch(filteredSource, /Apps\.launch\("beta"\)/)
