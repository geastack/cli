import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CliError, ExitCode } from '../src/errors.mjs'
import { runCreateGeastack } from '../src/create-geastack.mjs'
import { runGea } from '../src/gea.mjs'
import { cliRoot, createFixture, readJson, scriptedPrompt } from './helpers/fixture.mjs'

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
  assert.equal(packageJson.gea.targets.rp2350, false)
  assert.equal(packageJson.gea.targets.android, false)
  assert.equal('runtime' in packageJson.gea, false)
  assert.equal(packageJson.dependencies['@geastack/core'], '^0.1.4')
  assert.equal(packageJson.dependencies['@geastack/cli'], '^0.1.17')
  assert.equal(fs.existsSync(path.join(tmp, 'src/index.tsx')), true)
  assert.equal(fs.existsSync(path.join(tmp, 'src/App.tsx')), true)
  assert.equal(fs.existsSync(path.join(tmp, 'tsconfig.json')), true)
  assert.deepEqual(readJson(path.join(tmp, '.gea/boards.json')), {})
  assert.match(fs.readFileSync(path.join(tmp, 'README.md'), 'utf8'), /bundled starter: `Component Counter`/)
  assert.match(out.join('\n'), /Created Hello Panel/)
  assert.match(out.join('\n'), /npx gea setup/)
})

test('the default starter derives its embedded entry and BLE OTA configuration', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-create-'))

  await runCreateGeastack([
    'Component Counter',
    '--dir', tmp,
    '--no-install'
  ], { cwd: tmp, stdout: () => {} })

  const packageJson = readJson(path.join(tmp, 'package.json'))
  assert.equal(packageJson.gea.entry, 'src/index.tsx')
  assert.deepEqual(packageJson.gea.ota, { ble: true })
  assert.equal(packageJson.gea.targets.esp32, true)
  assert.equal(packageJson.gea.targets.web, false)
  assert.equal(fs.existsSync(path.join(tmp, 'src/index.tsx')), true)
  assert.equal(fs.existsSync(path.join(tmp, 'src/App.tsx')), true)
  assert.equal(fs.existsSync(path.join(tmp, 'src/styles.css')), true)
  assert.equal(fs.existsSync(path.join(tmp, 'index.html')), false)
  assert.equal(fs.existsSync(path.join(tmp, 'vite.config.ts')), false)
  assert.equal(packageJson.scripts.build, undefined)
})

test('the guided blank application asks for its target and ESP32 update method', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-create-blank-'))
  const prompt = scriptedPrompt([
    '2',
    '2',
    ''
  ])

  await runCreateGeastack([
    'Device Dashboard',
    '--dir', tmp,
    '--no-install'
  ], { cwd: tmp, stdout: () => {}, prompt })

  const packageJson = readJson(path.join(tmp, 'package.json'))
  assert.equal(packageJson.gea.entry, 'index.tsx')
  assert.equal(packageJson.gea.targets.esp32, true)
  assert.equal(packageJson.gea.targets.web, false)
  assert.deepEqual(packageJson.gea.ota, { ble: true })
  assert.equal(fs.existsSync(path.join(tmp, 'index.html')), false)
  assert.equal(fs.existsSync(path.join(tmp, 'vite.config.ts')), false)
  assert.match(prompt.questions.join('\n'), /Where should this application run\?/)
  assert.match(prompt.questions.join('\n'), /Enable wireless firmware updates over Bluetooth\?/)
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
    'workspace:*',
    '--cli-dependency',
    'workspace:*',
    '--starter',
    'empty'
  ], { cwd: tmp, stdout: () => {} })

  const packageJson = readJson(path.join(tmp, 'package.json'))
  assert.equal(packageJson.name, 'gea-factory-console')
  assert.equal(packageJson.gea.id, 'factory-console')
  assert.equal(packageJson.gea.name, 'Factory Control')
  assert.equal(packageJson.dependencies['@geastack/core'], 'workspace:*')
  assert.equal(packageJson.dependencies['@geastack/cli'], 'workspace:*')
  assert.match(fs.readFileSync(path.join(tmp, 'index.tsx'), 'utf8'), /Factory Control/)
})

test('create-geastack always defaults to registry dependencies', async (t) => {
  const fixture = createFixture(t)
  const targetDir = path.join(fixture.root, 'generated-app')

  await runCreateGeastack(['generated-app', '--dir', targetDir], {
    cwd: fixture.root,
    stdout: () => {}
  })

  const packageJson = readJson(path.join(targetDir, 'package.json'))
  assert.equal(packageJson.dependencies['@geastack/core'], '^0.1.4')
  assert.equal(packageJson.dependencies['@geastack/cli'], '^0.1.17')
  assert.equal(packageJson.gea.targets.esp32, true)
  assert.equal(packageJson.gea.targets.rp2350, false)
  assert.equal(packageJson.gea.targets.android, false)
  assert.equal('runtime' in packageJson.gea, false)
})

test('create-geastack can interactively fetch a rich GitHub example', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-create-example-'))
  const out = []
  const prompt = scriptedPrompt([
    '3',
    'watch'
  ])

  await runCreateGeastack([
    'Example App',
    '--dir',
    tmp,
    '--no-install',
    '--examples-repo',
    path.join(cliRoot, '..', 'examples')
  ], {
    cwd: tmp,
    stdout: (line) => out.push(line),
    prompt
  })

  const packageJson = readJson(path.join(tmp, 'package.json'))
  assert.equal(packageJson.name, 'gea-example-app')
  assert.equal(packageJson.gea.id, 'example-app')
  assert.equal(packageJson.gea.name, 'Example App')
  assert.equal(packageJson.gea.entry, 'index.tsx')
  assert.equal(packageJson.gea.targets.esp32, true)
  assert.equal(packageJson.dependencies['@geastack/cli'], '^0.1.17')
  assert.match(fs.readFileSync(path.join(tmp, 'index.tsx'), 'utf8'), /watch\.init/)
  assert.match(fs.readFileSync(path.join(tmp, 'README.md'), 'utf8'), /Started from GitHub example: `Watch`/)
  assert.match(prompt.questions.join('\n'), /What do you want to build\?/)
  assert.match(prompt.questions.join('\n'), /Example application/)
  assert.match(prompt.questions.join('\n'), /Example to copy/)
  assert.match(out.join('\n'), /Example: fetched Watch/)
})

test('create-geastack installs dependencies by default in interactive terminals', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-create-install-'))
  const out = []
  const prompt = scriptedPrompt(['1'])

  await runCreateGeastack(['Panel', '--dir', tmp, '--dry-run'], {
    cwd: tmp,
    stdout: (line) => out.push(line),
    prompt
  })

  const text = out.join('\n')
  assert.match(text, /Installing npm dependencies/)
  assert.match(text, /npm install/)
  assert.match(text, /Next: cd .* && npx gea setup/)
  assert.doesNotMatch(fs.readFileSync(path.join(tmp, 'README.md'), 'utf8'), /npm install/)
})

test('create-geastack can fetch a named rich example from a local repo path non-interactively', async (t) => {
  const fixture = createFixture(t)
  const targetDir = path.join(fixture.root, 'watch-copy')

  await runCreateGeastack([
    'watch-copy',
    '--dir',
    targetDir,
    '--starter',
    'example',
    '--example',
    'watch',
    '--examples-repo',
    path.join(cliRoot, '..', 'examples')
  ], {
    cwd: fixture.root,
    stdout: () => {}
  })

  const packageJson = readJson(path.join(targetDir, 'package.json'))
  assert.equal(packageJson.gea.id, 'watch-copy')
  assert.equal(packageJson.gea.name, 'Watch Copy')
  assert.equal(packageJson.gea.targets.esp32, true)
  assert.equal(packageJson.gea.targets.web, true)
  assert.match(fs.readFileSync(path.join(targetDir, 'index.tsx'), 'utf8'), /watch\.init/)
})

test('create-geastack requires an example id for non-interactive example starters', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-create-'))

  await assert.rejects(
    runCreateGeastack(['needs-example', '--dir', tmp, '--starter', 'example'], { cwd: tmp, stdout: () => {} }),
    (error) => error instanceof CliError && error.exitCode === ExitCode.usage && /requires --example/.test(error.message)
  )
})

test('create-geastack accepts explicit dependency versions', async (t) => {
  const fixture = createFixture(t)
  const targetDir = path.join(fixture.root, 'versioned-app')

  await runCreateGeastack(['versioned-app', '--dir', targetDir, '--core-dependency=0.1.2', '--cli-dependency=0.1.0'], {
    cwd: fixture.root,
    stdout: () => {}
  })

  const packageJson = readJson(path.join(targetDir, 'package.json'))
  assert.equal(packageJson.dependencies['@geastack/core'], '0.1.2')
  assert.equal(packageJson.dependencies['@geastack/cli'], '0.1.0')
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
