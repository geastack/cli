import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'


import { writeZip } from './zip-writer.mjs'

const FORMAT = 'dev.gea.geaos.app.bundle'
const FORMAT_VERSION = 1
const ICON_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg'])

function sha256(buffer) {
  return `sha256-${createHash('sha256').update(buffer).digest('hex')}`
}

function targetArtifact(repoRoot, app, target) {
  if (target === 'geaos') {
    return {
      target: 'geaos-armv7',
      sourcePath: path.join(repoRoot, 'targets', 'geaos', 'dist', app.id, app.id),
      bundlePath: `bin/geaos-armv7/${app.id}`,
      executable: true
    }
  }
  throw new Error(`Unsupported bundle target '${target}'`)
}

function readBundleFile(sourcePath, bundlePath, executable = false) {
  if (!existsSync(sourcePath)) throw new Error(`Missing bundle input: ${sourcePath}`)
  return {
    name: bundlePath,
    data: readFileSync(sourcePath),
    executable
  }
}

function pngDimensions(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (buffer.length < 24) return null
  if (!signature.every((byte, index) => buffer[index] === byte)) return null
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    format: 'png'
  }
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    offset += 2
    if (marker === 0xd9 || marker === 0xda) break
    if (offset + 2 > buffer.length) break
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) break
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)
    if (isSof && length >= 7) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
        format: 'jpeg'
      }
    }
    offset += length
  }
  return null
}

export function validateIconFile(sourcePath, expectedSize) {
  const ext = path.extname(sourcePath).toLowerCase()
  if (!ICON_EXTENSIONS.has(ext)) {
    throw new Error(`Icon must be a PNG or JPEG: ${sourcePath}`)
  }
  const buffer = readFileSync(sourcePath)
  const dimensions = ext === '.png' ? pngDimensions(buffer) : jpegDimensions(buffer)
  if (!dimensions) throw new Error(`Icon has unsupported or invalid image data: ${sourcePath}`)
  if (dimensions.width !== expectedSize || dimensions.height !== expectedSize) {
    throw new Error(`Icon ${sourcePath} must be ${expectedSize}x${expectedSize}; got ${dimensions.width}x${dimensions.height}`)
  }
}

function iconEntries(repoRoot, app) {
  const entries = []
  for (const [size, iconPath] of Object.entries(app.icons)) {
    const sourcePath = path.resolve(repoRoot, app.root, iconPath)
    validateIconFile(sourcePath, Number(size))
    entries.push(readBundleFile(sourcePath, `icons/icon-${size}${path.extname(iconPath).toLowerCase()}`))
  }
  return entries
}

function packageEntry(repoRoot, app) {
  return readBundleFile(path.resolve(repoRoot, app.root, 'package.json'), 'package.json')
}

export function createGeaBundle({ repoRoot, app, target = 'geaos', outputPath }) {
  if (!repoRoot) throw new Error('createGeaBundle requires repoRoot')
  if (!app) throw new Error('createGeaBundle requires app')
  if (!app.targets?.[target] === true) throw new Error(`App '${app.id}' does not enable target '${target}'`)
  if (!outputPath) throw new Error('createGeaBundle requires outputPath')

  const artifact = targetArtifact(repoRoot, app, target)
  const payloadEntries = [
    packageEntry(repoRoot, app),
    ...iconEntries(repoRoot, app),
    readBundleFile(artifact.sourcePath, artifact.bundlePath, artifact.executable)
  ]
  const checksums = Object.fromEntries(payloadEntries.map((entry) => [entry.name, sha256(entry.data)]))
  const icons = Object.fromEntries(
    Object.entries(app.icons).map(([size, iconPath]) => [
      size,
      `icons/icon-${size}${path.extname(iconPath).toLowerCase()}`
    ])
  )

  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    app: {
      id: app.id,
      name: app.name,
      packageName: app.packageName,
      version: app.version,
      runtime: app.runtime,
      entry: app.entry,
      launcher: app.launcher
    },
    icons,
    artifacts: [
      {
        target: artifact.target,
        path: artifact.bundlePath,
        executable: artifact.executable
      }
    ],
    checksums
  }

  writeZip(outputPath, [
    {
      name: 'gea-bundle.json',
      data: `${JSON.stringify(manifest, null, 2)}\n`
    },
    ...payloadEntries
  ])
  return manifest
}
