import { existsSync } from 'node:fs'
import path from 'node:path'
import { esp32BuildDir } from './esp32/build.mjs'

// Attach can run from an app after its firmware was built from a workspace root.
// Return complete candidates; the relay verifies their hashes against firmware.
export function nativeDebugBuilds(ctx, selection, app, env = ctx.env || {}, hasFile = existsSync) {
  const roots = new Set([ctx.buildRoot])
  if (!env.GEA_PROJECT_BUILD_ROOT) {
    let directory = path.resolve(app.root)
    while (true) {
      roots.add(path.join(directory, '.gea', 'build'))
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return [...roots].flatMap((buildRoot) => {
    const directory = esp32BuildDir({ ...ctx, buildRoot }, selection, app.id, env)
    const elf = path.join(directory, 'gea_embedded.elf')
    const metadata = path.join(directory, 'apps', app.id, 'gea-debug-source.json')
    return hasFile(elf) && hasFile(metadata) ? [{ elf, metadata }] : []
  })
}
