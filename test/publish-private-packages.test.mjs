import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { cliRoot, writeExecutable, writeJson } from './helpers/fixture.mjs'

const scriptPath = path.join(cliRoot, 'scripts/publish-private-packages.mjs')

test('publish plan ignores transient .state package copies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-publish-plan-'))
  try {
    writePublishable(root, 'cli/package.json', '@geastack/cli')
    writePublishable(
      root,
      'compiler/cloud-run-ts-sweep/.state/source-context/packages/geatsc/package.json',
      '@geastack/compiler'
    )

    const result = spawnSync(process.execPath, [scriptPath, '--root', root, '--plan'], { encoding: 'utf8' })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /GeaStack private npm publish plan \(1 packages\)/)
    assert.match(result.stdout, /@geastack\/cli@0\.1\.0/)
    assert.doesNotMatch(result.stdout, /\.state/)
    assert.doesNotMatch(result.stdout, /@geastack\/compiler@0\.1\.0/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('real publish mode tags existing package versions instead of skipping them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-publish-existing-'))
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-publish-npm-'))
  const npmLog = path.join(root, 'npm.log')
  try {
    writePublishable(root, 'cli/package.json', '@geastack/cli')
    writeExecutable(path.join(bin, 'npm'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$1" in
  --version)
    printf '10.0.0\\n'
    ;;
  whoami)
    printf 'geastack\\n'
    ;;
  view)
    printf '"0.1.0"\\n'
    ;;
  dist-tag)
    printf 'tagged\\n'
    ;;
  publish)
    printf 'publish should not run for an existing version\\n' >&2
    exit 42
    ;;
esac
`)

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--root', root, '--yes', '--allow-dirty'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NPM_LOG: npmLog,
          PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`
        }
      }
    )

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /tag existing @geastack\/cli@0\.1\.0/)
    assert.match(result.stdout, /ensure dist-tag alpha -> @geastack\/cli@0\.1\.0/)
    assert.match(result.stdout, /tagged existing: @geastack\/cli@0\.1\.0/)

    const npmCommands = fs.readFileSync(npmLog, 'utf8')
    assert.match(npmCommands, /view @geastack\/cli@0\.1\.0 version --registry https:\/\/registry\.npmjs\.org\/ --json/)
    assert.match(npmCommands, /dist-tag add @geastack\/cli@0\.1\.0 alpha --registry https:\/\/registry\.npmjs\.org\//)
    assert.doesNotMatch(npmCommands, /^publish/m)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(bin, { recursive: true, force: true })
  }
})

test('dry-run mode explains that dist-tags are not created', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-publish-dry-run-'))
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-publish-npm-'))
  const npmLog = path.join(root, 'npm.log')
  try {
    writePublishable(root, 'cli/package.json', '@geastack/cli')
    writeExecutable(path.join(bin, 'npm'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$1" in
  --version)
    printf '10.0.0\\n'
    ;;
  whoami)
    printf 'geastack\\n'
    ;;
  view)
    printf '"0.1.0"\\n'
    ;;
esac
`)

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--root', root, '--dry-run'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NPM_LOG: npmLog,
          PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`
        }
      }
    )

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Dry run: npm will build package tarballs, but the registry is unchanged\./)
    assert.match(result.stdout, /Dry run: npm dist-tags such as "alpha" are not created or updated until --yes is used\./)
    assert.match(result.stdout, /dry run: would set npm dist-tag alpha -> @geastack\/cli@0\.1\.0/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(bin, { recursive: true, force: true })
  }
})

function writePublishable(root, relativePath, name) {
  writeJson(path.join(root, relativePath), {
    name,
    version: '0.1.0',
    publishConfig: {
      access: 'restricted'
    }
  })
}
