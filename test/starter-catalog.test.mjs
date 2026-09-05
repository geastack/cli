import assert from 'node:assert/strict'
import os from 'node:os'
import test from 'node:test'

import { discoverBundledStarters, discoverGithubExamples, formatStarterChoice } from '../src/starter-catalog.mjs'
import { cliRoot } from './helpers/fixture.mjs'

test('starter catalog exposes the embedded component counter', () => {
  const starters = discoverBundledStarters({ cliPackageRoot: cliRoot })

  assert.deepEqual(starters.map((starter) => starter.id), ['counter'])
  assert.equal(starters[0].source, 'bundled')
  assert.equal(starters[0].name, 'Component Counter')
  assert.equal(starters[0].description, 'Touchscreen counter with component-local reactive state and BLE updates.')
  assert.equal(starters[0].targets.esp32, true)
  assert.equal(starters[0].targets.rp2350, false)
  assert.equal(starters[0].targets.android, false)
})

test('example catalog hard-codes rich GitHub examples without source files', () => {
  const examples = discoverGithubExamples(
    { cliPackageRoot: cliRoot },
    {
      GEA_EXAMPLES_REPO: os.tmpdir(),
      GEA_EXAMPLES_REF: 'test-ref'
    }
  )

  assert.equal(examples.length, 44)
  assert.equal(examples.every((example) => example.source === 'github'), true)
  assert.equal(examples.some((example) => example.id === 'watch'), true)
  assert.equal(examples.some((example) => example.id === 'bubble-grid'), true)
  assert.equal(examples.some((example) => example.id === 'reactive-counter'), false)

  const watch = examples.find((example) => example.id === 'watch')
  assert.equal(watch.name, 'Watch')
  assert.equal(watch.description, 'watch face')
  assert.equal(watch.path, 'apps/watch')
  assert.equal(watch.repo, os.tmpdir())
  assert.equal(watch.ref, 'test-ref')
  assert.equal(watch.targets.esp32, true)

  const cssCube = examples.find((example) => example.id === 'css-3d-cube')
  assert.equal(cssCube.targets.rp2350, true)
  assert.equal(cssCube.targets.android, true)

  const ios = examples.find((example) => example.id === 'ios-native-showcase')
  assert.equal(ios.name, 'iOS Native Showcase')
  assert.equal(ios.description, 'native iOS controls showcase')
  assert.equal(ios.targets.ios, true)
  assert.equal(formatStarterChoice(ios), 'iOS Native Showcase - native iOS controls showcase [ios]')

  const macos = examples.find((example) => example.id === 'notes-native')
  assert.equal(macos.description, 'native macOS notes app')
  assert.equal(macos.targets.macos, true)
  assert.equal(formatStarterChoice(macos), 'geaNotes - native macOS notes app [macos]')
})
