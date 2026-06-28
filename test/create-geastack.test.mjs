import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CliError, ExitCode } from '../src/errors.mjs'
import { runCreateGeastack } from '../src/create-geastack.mjs'
import { createFixture, readJson } from './helpers/fixture.mjs'

test('create-geastack scaffolds a valid app manifest', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-create-'))
  const out = []

  await runCreateGeastack(['Hello Panel', '--dir', tmp, '--targets=web,macos'], {
    cwd: tmp,
    stdout: (line) => out.push(line)
  })

  const packageJson = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'))
  assert.equal(packageJson.gea.id, 'hello-panel')
  assert.equal(packageJson.gea.name, 'Hello Panel')
  assert.equal(packageJson.gea.targets.web, true)
  assert.equal(packageJson.gea.targets.macos, true)
  assert.equal(packageJson.gea.targets.esp32, false)
  assert.equal(packageJson.dependencies['@geastack/core'].startsWith('file:'), true)
  assert.equal(fs.existsSync(path.join(tmp, 'index.tsx')), true)
  assert.equal(fs.existsSync(path.join(tmp, 'tsconfig.json')), true)
  assert.match(out.join('\n'), /Created Hello Panel/)
})

test('create-geastack uses explicit id, display name, and core dependency', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-create-'))

  await runCreateGeastack([
    'ignored-name',
    '--dir',
    tmp,
    '--id',
    'Factory Console',
    '--name',
    'Factory Control',
    '--core-dependency',
    'workspace:*'
  ], { cwd: tmp, stdout: () => {} })

  const packageJson = readJson(path.join(tmp, 'package.json'))
  assert.equal(packageJson.name, 'gea-factory-console')
  assert.equal(packageJson.gea.id, 'factory-console')
  assert.equal(packageJson.gea.name, 'Factory Control')
  assert.equal(packageJson.dependencies['@geastack/core'], 'workspace:*')
  assert.match(fs.readFileSync(path.join(tmp, 'index.tsx'), 'utf8'), /Factory Control/)
})

test('create-geastack defaults to local file dependency when collection root is available', async (t) => {
  const fixture = createFixture(t)
  const targetDir = path.join(fixture.root, 'scratch')

  await runCreateGeastack(['scratch', '--collection-root', fixture.root, '--dir', targetDir], {
    cwd: fixture.root,
    stdout: () => {}
  })

  const packageJson = readJson(path.join(targetDir, 'package.json'))
  assert.equal(packageJson.dependencies['@geastack/core'], 'file:../core/packages/core')
})

test('create-geastack can emit published dependency instead of local file dependency', async (t) => {
  const fixture = createFixture(t)
  const targetDir = path.join(fixture.root, 'published-app')

  await runCreateGeastack(['published-app', '--collection-root', fixture.root, '--dir', targetDir, '--published'], {
    cwd: fixture.root,
    stdout: () => {}
  })

  const packageJson = readJson(path.join(targetDir, 'package.json'))
  assert.equal(packageJson.dependencies['@geastack/core'], '^0.1.0')
})

test('create-geastack rejects missing and unsluggable names with usage exit code', async () => {
  await assert.rejects(
    runCreateGeastack([], { stdout: () => {} }),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /requires an app name/.test(error.message)
  )

  await assert.rejects(
    runCreateGeastack(['!!!'], { stdout: () => {} }),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /valid app id/.test(error.message)
  )
})

test('create-geastack protects non-empty directories unless --force is passed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-create-'))
  fs.writeFileSync(path.join(tmp, 'existing.txt'), 'keep me')

  await assert.rejects(
    runCreateGeastack(['blocked', '--dir', tmp], { cwd: tmp, stdout: () => {} }),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /not empty/.test(error.message)
  )

  await runCreateGeastack(['blocked', '--dir', tmp, '--force'], { cwd: tmp, stdout: () => {} })
  assert.equal(fs.existsSync(path.join(tmp, 'existing.txt')), true)
  assert.equal(readJson(path.join(tmp, 'package.json')).gea.id, 'blocked')
})

test('create-geastack help prints usage', async () => {
  const out = []
  const code = await runCreateGeastack(['--help'], { stdout: (line) => out.push(line) })

  assert.equal(code, 0)
  assert.match(out.join('\n'), /create-geastack <name>/)
})
