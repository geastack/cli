import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  IOS_APP_ICON_IMAGES,
  MACOS_ICNS_CHUNKS,
  MACOS_ICONSET_IMAGES,
  appleIconConfig,
  resolveAppleIconSourcePath,
  writeIcnsFromIconset,
  writeIosAppIconContents,
} from '../src/apps/apple-icons.mjs'

// The example apps were renamed from `examples/<app>` to `examples/apps/<app>`
// in the repo split, and `discoverGeaApps` followed: it now scans
// `<repoRoot>/apps` (`examplesDir = 'apps'`). This fixture still built the old
// `<root>/examples/<app>` shape, so discovery found nothing and the failure
// surfaced as a missing app rather than as the layout drift it was.
// This one was migrated only halfway: `app.root` below had been updated but
// the directory it points at had not, and the leading `../` made the resolver
// escape the mkdtemp root entirely (it looked under the shared system tmpdir).
// `app.root` is `path.relative(repoRoot, packageDir)`, so it is `apps/alpha`.
const root = mkdtempSync(join(tmpdir(), 'gea-apple-icons-'))
const appDir = join(root, 'apps', 'alpha')
mkdirSync(join(appDir, 'icons'), { recursive: true })
writeFileSync(join(appDir, 'icons', 'icon-source.png'), 'source')
writeFileSync(join(appDir, 'icons', 'icon-512.png'), 'fallback')

const app = {
  id: 'alpha',
  root: 'apps/alpha',
  icons: appleIconConfig(),
}

assert.equal(resolveAppleIconSourcePath(root, app), join(appDir, 'icons', 'icon-source.png'))

const withoutSource = {
  ...app,
  icons: {
    512: 'icons/icon-512.png',
  },
}
rmSync(join(appDir, 'icons', 'icon-source.png'))
assert.equal(resolveAppleIconSourcePath(root, withoutSource), join(appDir, 'icons', 'icon-512.png'))

assert.equal(IOS_APP_ICON_IMAGES.some((image) => image.idiom === 'ios-marketing' && image.pixels === 1024), true)
assert.equal(IOS_APP_ICON_IMAGES.some((image) => image.idiom === 'iphone' && image.size === '60x60' && image.scale === '3x' && image.pixels === 180), true)
assert.equal(MACOS_ICONSET_IMAGES.some((image) => image.filename === 'icon_512x512@2x.png' && image.pixels === 1024), true)
assert.deepEqual(MACOS_ICNS_CHUNKS.map((chunk) => chunk.type), ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10'])

const appIconSetDir = join(root, 'AppIcon.appiconset')
mkdirSync(appIconSetDir, { recursive: true })
writeIosAppIconContents(appIconSetDir)
const contents = JSON.parse(readFileSync(join(appIconSetDir, 'Contents.json'), 'utf8'))
assert.deepEqual(contents.info, { author: 'xcode', version: 1 })
assert.equal(contents.images.length, IOS_APP_ICON_IMAGES.length)
assert.equal(contents.images.every((image) => image.filename), true)
assert.equal(contents.images.some((image) => image.filename === 'AppIcon-1024.png'), true)

const iconsetDir = join(root, 'AppIcon.iconset')
mkdirSync(iconsetDir, { recursive: true })
for (const chunk of MACOS_ICNS_CHUNKS) {
  writeFileSync(join(iconsetDir, chunk.filename), Buffer.from(`png-${chunk.type}`))
}
const icnsPath = join(root, 'AppIcon.icns')
writeIcnsFromIconset({ iconsetDir, icnsPath })
const icns = readFileSync(icnsPath)
assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns')
assert.equal(icns.readUInt32BE(4), icns.length)
for (const chunk of MACOS_ICNS_CHUNKS) {
  assert.equal(icns.includes(Buffer.from(chunk.type, 'ascii')), true)
}
