import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { ICON_SIZES } from './openai-icons.mjs'

export const IOS_APP_ICON_IMAGES = [
  { idiom: 'iphone', size: '20x20', scale: '2x', pixels: 40, filename: 'AppIcon-20@2x.png' },
  { idiom: 'iphone', size: '20x20', scale: '3x', pixels: 60, filename: 'AppIcon-20@3x.png' },
  { idiom: 'iphone', size: '29x29', scale: '2x', pixels: 58, filename: 'AppIcon-29@2x.png' },
  { idiom: 'iphone', size: '29x29', scale: '3x', pixels: 87, filename: 'AppIcon-29@3x.png' },
  { idiom: 'iphone', size: '40x40', scale: '2x', pixels: 80, filename: 'AppIcon-40@2x.png' },
  { idiom: 'iphone', size: '40x40', scale: '3x', pixels: 120, filename: 'AppIcon-40@3x.png' },
  { idiom: 'iphone', size: '60x60', scale: '2x', pixels: 120, filename: 'AppIcon-60@2x.png' },
  { idiom: 'iphone', size: '60x60', scale: '3x', pixels: 180, filename: 'AppIcon-60@3x.png' },
  { idiom: 'ipad', size: '20x20', scale: '1x', pixels: 20, filename: 'AppIcon-iPad-20.png' },
  { idiom: 'ipad', size: '20x20', scale: '2x', pixels: 40, filename: 'AppIcon-iPad-20@2x.png' },
  { idiom: 'ipad', size: '29x29', scale: '1x', pixels: 29, filename: 'AppIcon-iPad-29.png' },
  { idiom: 'ipad', size: '29x29', scale: '2x', pixels: 58, filename: 'AppIcon-iPad-29@2x.png' },
  { idiom: 'ipad', size: '40x40', scale: '1x', pixels: 40, filename: 'AppIcon-iPad-40.png' },
  { idiom: 'ipad', size: '40x40', scale: '2x', pixels: 80, filename: 'AppIcon-iPad-40@2x.png' },
  { idiom: 'ipad', size: '76x76', scale: '1x', pixels: 76, filename: 'AppIcon-iPad-76.png' },
  { idiom: 'ipad', size: '76x76', scale: '2x', pixels: 152, filename: 'AppIcon-iPad-76@2x.png' },
  { idiom: 'ipad', size: '83.5x83.5', scale: '2x', pixels: 167, filename: 'AppIcon-iPad-83.5@2x.png' },
  { idiom: 'ios-marketing', size: '1024x1024', scale: '1x', pixels: 1024, filename: 'AppIcon-1024.png' },
]

export const MACOS_ICONSET_IMAGES = [
  { filename: 'icon_16x16.png', pixels: 16 },
  { filename: 'icon_16x16@2x.png', pixels: 32 },
  { filename: 'icon_32x32.png', pixels: 32 },
  { filename: 'icon_32x32@2x.png', pixels: 64 },
  { filename: 'icon_128x128.png', pixels: 128 },
  { filename: 'icon_128x128@2x.png', pixels: 256 },
  { filename: 'icon_256x256.png', pixels: 256 },
  { filename: 'icon_256x256@2x.png', pixels: 512 },
  { filename: 'icon_512x512.png', pixels: 512 },
  { filename: 'icon_512x512@2x.png', pixels: 1024 },
]

export const MACOS_ICNS_CHUNKS = [
  { type: 'icp4', filename: 'icon_16x16.png' },
  { type: 'icp5', filename: 'icon_32x32.png' },
  { type: 'icp6', filename: 'icon_32x32@2x.png' },
  { type: 'ic07', filename: 'icon_128x128.png' },
  { type: 'ic08', filename: 'icon_256x256.png' },
  { type: 'ic09', filename: 'icon_512x512.png' },
  { type: 'ic10', filename: 'icon_512x512@2x.png' },
]

export function appleIconConfig() {
  return Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icons/icon-${size}.png`]))
}

export function resolveAppleIconSourcePath(repoRoot, app) {
  const sourcePath = path.resolve(repoRoot, app.root, 'icons', 'icon-source.png')
  if (existsSync(sourcePath)) return sourcePath

  for (const size of ['1024', '512', '256', '128', '64', '32']) {
    const iconPath = app.icons?.[size]
    if (!iconPath) continue
    const resolved = path.resolve(repoRoot, app.root, iconPath)
    if (existsSync(resolved)) return resolved
  }

  throw new Error(`Missing Apple icon source for ${app.id}: expected ${sourcePath} or a declared package icon`)
}

function resizePng(sourcePath, outputPath, pixels) {
  mkdirSync(path.dirname(outputPath), { recursive: true })
  const result = spawnSync('sips', ['-s', 'format', 'png', '-z', String(pixels), String(pixels), sourcePath, '--out', outputPath], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || `exit ${result.status}`
    throw new Error(`Failed to resize icon ${sourcePath} to ${pixels}x${pixels}: ${detail.trim()}`)
  }
}

export function writeIosAppIconContents(appIconSetDir) {
  const contents = {
    images: IOS_APP_ICON_IMAGES.map(({ idiom, size, scale, filename }) => ({
      idiom,
      size,
      scale,
      filename,
    })),
    info: {
      author: 'xcode',
      version: 1,
    },
  }
  writeFileSync(path.join(appIconSetDir, 'Contents.json'), `${JSON.stringify(contents, null, 2)}\n`)
}

export function prepareIosAppIconAssets({ repoRoot, app, assetsDir }) {
  if (!repoRoot) throw new Error('prepareIosAppIconAssets requires repoRoot')
  if (!app) throw new Error('prepareIosAppIconAssets requires app')
  if (!assetsDir) throw new Error('prepareIosAppIconAssets requires assetsDir')

  const sourcePath = resolveAppleIconSourcePath(repoRoot, app)
  const appIconSetDir = path.join(assetsDir, 'AppIcon.appiconset')
  rmSync(appIconSetDir, { recursive: true, force: true })
  mkdirSync(appIconSetDir, { recursive: true })

  for (const image of IOS_APP_ICON_IMAGES) {
    resizePng(sourcePath, path.join(appIconSetDir, image.filename), image.pixels)
  }
  writeIosAppIconContents(appIconSetDir)
  return appIconSetDir
}

export function writeIcnsFromIconset({ iconsetDir, icnsPath }) {
  const chunks = MACOS_ICNS_CHUNKS.map(({ type, filename }) => {
    const data = readFileSync(path.join(iconsetDir, filename))
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([header, data])
  })
  const length = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(length, 4)
  writeFileSync(icnsPath, Buffer.concat([header, ...chunks], length))
}

export function prepareMacosAppIcon({ repoRoot, app, buildDir, resourcesDir }) {
  if (!repoRoot) throw new Error('prepareMacosAppIcon requires repoRoot')
  if (!app) throw new Error('prepareMacosAppIcon requires app')
  if (!buildDir) throw new Error('prepareMacosAppIcon requires buildDir')
  if (!resourcesDir) throw new Error('prepareMacosAppIcon requires resourcesDir')

  const sourcePath = resolveAppleIconSourcePath(repoRoot, app)
  const iconsetDir = path.join(buildDir, 'AppIcon.iconset')
  const icnsPath = path.join(resourcesDir, 'AppIcon.icns')
  rmSync(iconsetDir, { recursive: true, force: true })
  mkdirSync(iconsetDir, { recursive: true })
  mkdirSync(resourcesDir, { recursive: true })

  for (const image of MACOS_ICONSET_IMAGES) {
    resizePng(sourcePath, path.join(iconsetDir, image.filename), image.pixels)
  }

  writeIcnsFromIconset({ iconsetDir, icnsPath })
  return icnsPath
}
