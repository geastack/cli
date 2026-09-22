import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { cliRoot, readJson } from './helpers/fixture.mjs'

test('package metadata publishes scoped public npm packages with a local gea bin', () => {
  const geaPackage = readJson(path.join(cliRoot, 'package.json'))
  const createPackage = readJson(path.join(cliRoot, 'packages/create-geastack/package.json'))

  assert.equal(geaPackage.name, '@geastack/cli')
  assert.equal(geaPackage.private, undefined)
  assert.equal(geaPackage.publishConfig.access, 'public')
  assert.equal(geaPackage.bin.gea, 'bin/gea.mjs')
  assert.equal(geaPackage.exports['./create'], './src/create-geastack.mjs')
  assert.ok(geaPackage.files.includes('starters/'))
  assert.ok(geaPackage.files.includes('examples/'))

  assert.equal(createPackage.name, 'create-geastack')
  assert.equal(createPackage.private, undefined)
  assert.equal(createPackage.publishConfig.access, 'public')
  assert.equal(createPackage.bin['create-geastack'], 'bin/create-geastack.mjs')
  // The scaffolder is a thin bin over the CLI; it pins the CLI it was released with.
  assert.equal(createPackage.dependencies['@geastack/cli'], `^${geaPackage.version}`)
  assert.ok(createPackage.files.includes('bin/'))
})
