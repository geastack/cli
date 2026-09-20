// A published package that declares an "exports" map and omits
// "./package.json" cannot be located by the one technique every build script
// here uses to find it:
//
//   require.resolve('<name>/package.json')
//
// That throws ERR_PACKAGE_PATH_NOT_EXPORTED, which is indistinguishable from
// "not installed" unless the caller keeps node's message. @geastack/cli
// shipped 0.1.77 that way and broke the web-WASM CI step: the CLI was
// installed, and the build reported it missing.
//
// It never fails while the packages are symlinked siblings, because a symlink
// makes package.json a plain file path and the exports map is never consulted.
// It only appears once the packages are installed from the registry, which is
// exactly when it is expensive to find. So it is asserted here, on the
// manifests, where a republish cannot be forgotten.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifests = execFileSync('git', ['ls-files', '*package.json'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter((line) => line === 'package.json' || line.endsWith('/package.json'))

test('every published package resolves its own package.json', () => {
  let checked = 0
  for (const relative of manifests) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, relative), 'utf8'))
    if (manifest.private) continue
    if (!manifest.exports || typeof manifest.exports !== 'object') continue
    checked += 1
    assert.equal(
      manifest.exports['./package.json'],
      './package.json',
      `${manifest.name} (${relative}) declares an exports map without "./package.json", so require.resolve('${manifest.name}/package.json') throws`,
    )
  }
  assert.ok(checked > 0, 'found no published package with an exports map -- the walk is broken, not the packages')
})
