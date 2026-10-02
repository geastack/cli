import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { runCreateGeastack } from '../src/create-geastack.mjs'
import { cliRoot, readJson } from './helpers/fixture.mjs'

// Exercise the real scaffolder in memory: no npm install, clone, or disk output.
for (const starter of ['blank', 'counter', 'sky-hop']) {
  for (const version of [undefined, 'latest', '*', '~5.9.3', '6.0.2']) {
    test(`${starter} scaffolding bounds floating TypeScript ${version ?? '(missing)'}`, async (t) => {
      const root = '/virtual-gea-create'
      const files = new Map()
      const sourcePackage = { devDependencies: { typescript: version, vite: '^8.0.0' } }
      const realRead = fs.readFileSync.bind(fs)
      const realAccess = fs.accessSync.bind(fs)
      const virtual = (file) => String(file).startsWith(`${root}/`) || String(file) === root
      t.mock.method(fs, 'mkdirSync', (file) => { assert.ok(virtual(file)) })
      t.mock.method(fs, 'writeFileSync', (file, text) => {
        assert.ok(virtual(file))
        files.set(String(file), text)
      })
      t.mock.method(fs, 'readFileSync', (file, ...args) => files.has(String(file)) ? files.get(String(file)) : realRead(file, ...args))
      t.mock.method(fs, 'accessSync', (file, ...args) => {
        if (!virtual(file)) return realAccess(file, ...args)
        if (!files.has(String(file))) throw new Error('ENOENT')
      })
      t.mock.method(fs, 'copyFileSync', (_, target) => {
        assert.ok(virtual(target))
        files.set(target, '')
      })
      t.mock.method(fs, 'cpSync', (_, target) => {
        assert.equal(target, root)
        files.set(path.join(root, 'package.json'), JSON.stringify(sourcePackage))
        files.set(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'preserve', ignoreDeprecations: '6.0' } }))
      })
      const selection = starter === 'sky-hop'
        ? ['--starter=example', '--example=sky-hop', '--examples-repo', path.join(cliRoot, '..', 'examples')]
        : [`--starter=${starter}`]
      await runCreateGeastack(['app', '--dir', root, '--targets=web,esp32', '--no-install', ...selection], {
        cwd: cliRoot,
        stdout: () => {}
      })
      const manifest = JSON.parse(files.get(path.join(root, 'package.json')))
      assert.equal(manifest.devDependencies.typescript,
        starter === 'blank' || !version || ['latest', '*'].includes(version) ? '^5.9.3' : version)
      if (starter !== 'blank') assert.equal(manifest.devDependencies.vite, '^8.0.0')
      if (starter !== 'blank') {
        const config = JSON.parse(files.get(path.join(root, 'tsconfig.json')))
        assert.equal(config.compilerOptions.jsx, 'preserve')
        assert.equal(config.compilerOptions.ignoreDeprecations, version === '6.0.2' ? '6.0' : '5.0')
      }
    })
  }
}

test('the bundled counter declares the supported TypeScript major', () => {
  const manifest = readJson(path.join(cliRoot, 'starters/bundled/counter/package.json'))
  assert.equal(manifest.devDependencies.typescript, '^5.9.3')
})
