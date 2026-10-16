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

test('publish plan includes the debugger repo ahead of the CLI that depends on it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-publish-debugger-'))
  try {
    writePublishable(root, 'debugger/package.json', '@geastack/debugger')
    writePublishable(root, 'cli/package.json', '@geastack/cli', {
      dependencies: { '@geastack/debugger': '^0.1.0' }
    })

    const result = spawnSync(process.execPath, [scriptPath, '--root', root, '--plan'], { encoding: 'utf8' })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /@geastack\/debugger@0\.1\.0[\s\S]*@geastack\/cli@0\.1\.0/)
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

test('publish stops when an @geastack dependency range resolves nowhere', () => {
  const { root, run, npmCommands, cleanup } = dependencyFixture({
    npmVersions: { '@geastack/targets@^0.1.97': null, '@geastack/targets': '0.1.95' }
  })
  try {
    writePublishable(root, 'cli/package.json', '@geastack/cli', {
      version: '0.1.97',
      dependencies: { '@geastack/targets': '^0.1.97', picocolors: '^1.1.1' }
    })

    const result = run(['--yes', '--allow-dirty'])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /@geastack\/cli@0\.1\.97 needs @geastack\/targets@\^0\.1\.97/)
    assert.match(result.stderr, /npm has no version matching \^0\.1\.97 \(latest: 0\.1\.95\)/)
    assert.match(result.stderr, /@geastack\/targets is not in this publish/)
    assert.doesNotMatch(npmCommands(), /^publish/m)
    assert.doesNotMatch(npmCommands(), /picocolors/)
  } finally {
    cleanup()
  }
})

test('plan mode reports unresolved dependency ranges', () => {
  const { root, run, cleanup } = dependencyFixture({ npmVersions: {} })
  try {
    writePublishable(root, 'cli/package.json', '@geastack/cli', {
      optionalDependencies: { '@geastack/targets': '~0.1.97' }
    })

    const result = run(['--plan'])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /needs @geastack\/targets@~0\.1\.97/)
  } finally {
    cleanup()
  }
})

test('a dependency published in the same run satisfies the range without asking npm', () => {
  const { root, run, npmCommands, cleanup } = dependencyFixture({ npmVersions: {} })
  try {
    writePublishable(root, 'targets/package.json', '@geastack/targets', { version: '0.1.97' })
    writePublishable(root, 'cli/package.json', '@geastack/cli', {
      dependencies: { '@geastack/targets': '^0.1.97' }
    })

    const result = run(['--plan'])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /@geastack dependency ranges resolve\./)
    assert.equal(npmCommands(), '')
  } finally {
    cleanup()
  }
})

test('a dependency in the same run with a non-matching version still has to resolve on npm', () => {
  const { root, run, cleanup } = dependencyFixture({ npmVersions: {} })
  try {
    writePublishable(root, 'targets/package.json', '@geastack/targets', { version: '0.1.95' })
    writePublishable(root, 'cli/package.json', '@geastack/cli', {
      dependencies: { '@geastack/targets': '^0.1.97' }
    })

    const result = run(['--plan'])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /this publish has @geastack\/targets@0\.1\.95, which does not match/)
  } finally {
    cleanup()
  }
})

test('a dependency left out by --package is called out', () => {
  const { root, run, cleanup } = dependencyFixture({ npmVersions: {} })
  try {
    writePublishable(root, 'targets/package.json', '@geastack/targets', { version: '0.1.97' })
    writePublishable(root, 'cli/package.json', '@geastack/cli', {
      dependencies: { '@geastack/targets': '^0.1.97' }
    })

    const result = run(['--plan', '--package', '@geastack/cli'])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /@geastack\/targets@0\.1\.97 was found locally but is not selected/)
  } finally {
    cleanup()
  }
})

test('a range already on npm passes', () => {
  const { root, run, npmCommands, cleanup } = dependencyFixture({
    npmVersions: { '@geastack/targets@^0.1.94': '["0.1.94","0.1.95"]' }
  })
  try {
    writePublishable(root, 'cli/package.json', '@geastack/cli', {
      dependencies: { '@geastack/targets': '^0.1.94' }
    })

    const result = run(['--plan'])

    assert.equal(result.status, 0, result.stderr)
    assert.match(npmCommands(), /view @geastack\/targets@\^0\.1\.94 version/)
  } finally {
    cleanup()
  }
})

test('an npm failure other than a missing version also stops the publish', () => {
  const { root, run, cleanup } = dependencyFixture({ npmVersions: {}, viewFails: true })
  try {
    writePublishable(root, 'cli/package.json', '@geastack/cli', {
      dependencies: { '@geastack/targets': '^0.1.94' }
    })

    const result = run(['--plan'])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /could not query npm \(exit 1\): npm error code ETIMEDOUT/)
  } finally {
    cleanup()
  }
})

test('--skip-dep-check skips the dependency check', () => {
  const { root, run, npmCommands, cleanup } = dependencyFixture({ npmVersions: {} })
  try {
    writePublishable(root, 'cli/package.json', '@geastack/cli', {
      dependencies: { '@geastack/targets': '^0.1.97' }
    })

    const result = run(['--plan', '--skip-dep-check'])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /skipping @geastack dependency check/)
    assert.equal(npmCommands(), '')
  } finally {
    cleanup()
  }
})

test('caret, tilde and exact ranges follow npm semantics for local versions', () => {
  const cases = [
    ['0.1.97', '^0.1.97', true],
    ['0.1.98', '^0.1.97', true],
    ['0.2.0', '^0.1.97', false],
    ['0.0.4', '^0.0.3', false],
    ['1.4.0', '^1.2.0', true],
    ['2.0.0', '^1.2.0', false],
    ['0.1.99', '~0.1.97', true],
    ['0.2.0', '~0.1.97', false],
    ['0.1.97', '0.1.97', true],
    ['0.1.98', '0.1.97', false],
    ['0.1.98-alpha.1', '^0.1.97', false],
    ['0.3.0', '>=0.1.97', true],
  ]
  for (const [version, range, expected] of cases) {
    const { root, run, cleanup } = dependencyFixture({ npmVersions: {} })
    try {
      writePublishable(root, 'targets/package.json', '@geastack/targets', { version })
      writePublishable(root, 'cli/package.json', '@geastack/cli', {
        dependencies: { '@geastack/targets': range }
      })
      const result = run(['--plan'])
      assert.equal(result.status === 0, expected, `${version} vs ${range}: ${result.stderr}`)
    } finally {
      cleanup()
    }
  }
})

// A collection root plus a fake npm whose `view <spec>` prints
// npmVersions[spec], or fails with E404 when the spec is missing or null.
function dependencyFixture({ npmVersions, viewFails = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-publish-deps-'))
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-publish-npm-'))
  const npmLog = path.join(root, 'npm.log')
  const versionsFile = path.join(bin, 'versions.json')
  fs.writeFileSync(versionsFile, JSON.stringify(npmVersions))
  fs.writeFileSync(npmLog, '')
  writeFakeNpm(bin, {
    bash: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$1" in
  --version) printf '10.0.0\\n' ;;
  whoami) printf 'geastack\\n' ;;
  view)
    ${viewFails ? "printf 'npm error code ETIMEDOUT\\n' >&2; exit 1" : `exec "${process.execPath}" -e '
      const versions = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      const value = versions[process.argv[2]]
      if (value == null) { console.error("npm error code E404"); process.exit(1) }
      console.log(value.startsWith("[") ? value : JSON.stringify(value))
    ' "${versionsFile}" "$2"`}
    ;;
  dist-tag) printf 'tagged\\n' ;;
  publish) printf 'published\\n' ;;
esac
`,
    replies: { '--version': '10.0.0', whoami: 'geastack', 'dist-tag': 'tagged', publish: 'published' },
    extra: `if (args[0] === 'view') {
  ${viewFails ? "console.error('npm error code ETIMEDOUT')\n  process.exit(1)" : `const versions = JSON.parse(fs.readFileSync(${JSON.stringify(versionsFile)}, 'utf8'))
  const value = versions[args[1]]
  if (value == null) {
    console.error('npm error code E404')
    process.exit(1)
  }
  console.log(value.startsWith('[') ? value : JSON.stringify(value))`}
}
`
  })
  return {
    root,
    npmCommands: () => fs.readFileSync(npmLog, 'utf8').split('\n').filter((line) => line.startsWith('view') || line.startsWith('publish')).join('\n'),
    run: (args) => spawnSync(process.execPath, [scriptPath, '--root', root, ...args], {
      encoding: 'utf8',
      env: withPathPrefix({ ...process.env, NPM_LOG: npmLog }, bin)
    }),
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(bin, { recursive: true, force: true })
    }
  }
}

// The npm on PATH, faked: it logs its arguments to $NPM_LOG and answers by
// its first argument. POSIX hosts run the bash script; on Windows, where npm
// is an npm.cmd shim, the same behaviour runs behind one (`replies` print a
// line and succeed, `refuses` print to stderr and exit 42).
function writeFakeNpm(bin, { bash, replies, refuses = {}, extra = '' }) {
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
${extra}`,
    windowsLauncher: 'cmd'
  })
}

function writePublishable(root, relativePath, name, fields = {}) {
  writeJson(path.join(root, relativePath), {
    name,
    version: '0.1.0',
    publishConfig: {
      access: 'restricted'
    },
    ...fields
  })
}
