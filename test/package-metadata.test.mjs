import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { cliRoot, readJson, realCollectionRoot } from './helpers/fixture.mjs'

test('package metadata supports scoped private npm packages and local gea bin', () => {
  const geaPackage = readJson(path.join(cliRoot, 'package.json'))
  const createPackage = readJson(path.join(cliRoot, 'packages/create-geastack/package.json'))

  assert.equal(geaPackage.name, '@geastack/cli')
  assert.equal(geaPackage.private, undefined)
  assert.equal(geaPackage.publishConfig.access, 'restricted')
  assert.equal(geaPackage.bin.gea, './bin/gea.mjs')
  assert.equal(geaPackage.exports['./create'], './src/create-geastack.mjs')
  assert.ok(geaPackage.files.includes('starters/'))
  assert.ok(geaPackage.files.includes('examples/'))

  assert.equal(createPackage.name, '@geastack/create-geastack')
  assert.equal(createPackage.private, undefined)
  assert.equal(createPackage.publishConfig.access, 'restricted')
  assert.equal(createPackage.bin['create-geastack'], './bin/create-geastack.mjs')
  assert.equal(createPackage.dependencies['@geastack/cli'], '^0.1.0')
  assert.ok(createPackage.files.includes('bin/'))
})

test('example app flash scripts route through the Gea CLI', () => {
  const appsRoot = path.join(realCollectionRoot, 'examples/apps')
  const geaBin = 'node ../../../cli/bin/gea.mjs'
  const checked = []

  for (const appName of fs.readdirSync(appsRoot).sort()) {
    const packagePath = path.join(appsRoot, appName, 'package.json')
    if (!fs.existsSync(packagePath)) continue
    const pkg = readJson(packagePath)
    const scripts = pkg.scripts || {}
    for (const scriptName of ['flash', 'flash:monitor', 'monitor']) {
      const command = scripts[scriptName]
      if (!command) continue
      checked.push(`${appName}:${scriptName}`)
      assert.equal(
        command.startsWith(geaBin),
        true,
        `${appName} ${scriptName} should call ${geaBin}, got: ${command}`
      )
      assert.equal(
        command.includes('scripts/board'),
        false,
        `${appName} ${scriptName} should not call scripts/board directly`
      )
    }
  }

  assert.ok(checked.length > 0)
})
