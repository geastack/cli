import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGeaBundle, validateIconFile } from '../src/apps/bundle-writer.mjs'
import { discoverAppsInRoot } from '../src/manifest.mjs'

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function includesName(zipBuffer, name) {
  return zipBuffer.includes(Buffer.from(name, 'utf8'))
}

function minimalPng(width, height) {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  buffer[24] = 8
  buffer[25] = 6
  return buffer
}

// The example apps were renamed from `examples/<app>` to `examples/apps/<app>`
// in the repo split, and `discoverGeaApps` followed: it now scans
// `<repoRoot>/apps` (`examplesDir = 'apps'`). This fixture still built the old
// `<root>/examples/<app>` shape, so discovery found nothing and the failure
// surfaced as a missing app rather than as the layout drift it was.
const root = mkdtempSync(join(tmpdir(), 'gea-bundle-writer-'))
const appDir = join(root, 'apps', 'alpha')
const iconDir = join(appDir, 'icons')
const distDir = join(root, 'targets', 'geaos', 'dist', 'alpha')
mkdirSync(iconDir, { recursive: true })
mkdirSync(distDir, { recursive: true })

writeJson(join(appDir, 'package.json'), {
  name: 'alpha',
  version: '2.0.0',
  gea: {
    id: 'alpha',
    name: 'Alpha',
    entry: 'index.tsx',
    runtime: 'gea',
    targets: { geaos: true },
    icons: {
      32: 'icons/icon-32.png',
      64: 'icons/icon-64.png'
    },
    launcher: {
      description: 'test app',
      order: 2,
      accent: '#30d158'
    }
  }
})
writeFileSync(join(iconDir, 'icon-32.png'), minimalPng(32, 32))
writeFileSync(join(iconDir, 'icon-64.png'), minimalPng(64, 64))
writeFileSync(join(distDir, 'alpha'), '#!/bin/sh\necho alpha\n')

assert.throws(() => validateIconFile(join(iconDir, 'icon-32.png'), 64), /must be 64x64; got 32x32/)

const app = discoverAppsInRoot(root).find((candidate) => candidate.id === 'alpha')
assert.ok(app)
const outputPath = join(root, 'dist', 'alpha.gea.zip')
const manifest = createGeaBundle({ repoRoot: root, app, target: 'geaos', outputPath })

assert.equal(existsSync(outputPath), true)
assert.equal(manifest.format, 'dev.gea.geaos.app.bundle')
assert.equal(manifest.formatVersion, 1)
assert.equal(manifest.app.id, 'alpha')
assert.equal(manifest.app.name, 'Alpha')
assert.equal(manifest.artifacts[0].target, 'geaos-armv7')
assert.equal(manifest.artifacts[0].path, 'bin/geaos-armv7/alpha')
assert.equal(manifest.icons['32'], 'icons/icon-32.png')
assert.match(manifest.checksums['bin/geaos-armv7/alpha'], /^sha256-/)

const zip = readFileSync(outputPath)
assert.deepEqual([...zip.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04])
for (const name of [
  'gea-bundle.json',
  'package.json',
  'bin/geaos-armv7/alpha',
  'icons/icon-32.png',
  'icons/icon-64.png'
]) {
  assert.equal(includesName(zip, name), true, `${name} missing from zip`)
}
