import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { cliRoot, withPathPrefix, writeFakeCommand, writeJson } from './helpers/fixture.mjs'

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
    writeFakeNpm(bin, {
      bash: `#!/usr/bin/env bash
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
`,
      replies: { '--version': '10.0.0', whoami: 'geastack', view: '"0.1.0"', 'dist-tag': 'tagged' },
      refuses: { publish: 'publish should not run for an existing version' }
    })

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--root', root, '--yes', '--allow-dirty'],
      {
        encoding: 'utf8',
        env: withPathPrefix({ ...process.env, NPM_LOG: npmLog }, bin)
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
    writeFakeNpm(bin, {
      bash: `#!/usr/bin/env bash
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
`,
      replies: { '--version': '10.0.0', whoami: 'geastack', view: '"0.1.0"' }
    })

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--root', root, '--dry-run'],
      {
        encoding: 'utf8',
        env: withPathPrefix({ ...process.env, NPM_LOG: npmLog }, bin)
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

// The npm on PATH, faked: it logs its arguments to $NPM_LOG and answers by
// its first argument. POSIX hosts run the bash script; on Windows, where npm
// is an npm.cmd shim, the same behaviour runs behind one (`replies` print a
// line and succeed, `refuses` print to stderr and exit 42).
function writeFakeNpm(bin, { bash, replies, refuses = {} }) {
  writeFakeCommand(bin, 'npm', {
    bash,
    node: `const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.NPM_LOG, \`\${args.join(' ')}\\n\`)
const replies = ${JSON.stringify(replies)}
const refuses = ${JSON.stringify(refuses)}
if (Object.hasOwn(replies, args[0])) console.log(replies[args[0]])
if (Object.hasOwn(refuses, args[0])) {
  console.error(refuses[args[0]])
  process.exit(42)
}
`,
    windowsLauncher: 'cmd'
  })
}

function writePublishable(root, relativePath, name) {
  writeJson(path.join(root, relativePath), {
    name,
    version: '0.1.0',
    publishConfig: {
      access: 'restricted'
    }
  })
}
