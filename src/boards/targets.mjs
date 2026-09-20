import path from 'node:path'

import { ExitCode, fail } from '../errors.mjs'
import { exists, readJson } from '../fs-utils.mjs'

// Built-in targets are DATA shipped by @geastack/targets (targets.json at the
// package root). Each entry names an adapter and where its project lives; the
// project may sit in another package (geaos boards live in @geastack/geaos).
export function loadTargets(ctx) {
  if (!ctx.targetsRoot) return {}
  const file = path.join(ctx.targetsRoot, 'targets.json')
  if (!exists(file)) return {}
  const raw = readJson(file)
  const out = {}
  for (const [id, entry] of Object.entries(raw)) {
    const { targetPath, package: packageName, definition, ...rest } = entry
    if (!targetPath) fail(`Built-in target '${id}' is missing targetPath in ${file}.`, ExitCode.missingDependency)
    const packageRoot = packageName ? packageDirFor(ctx, packageName) : ctx.targetsRoot
    out[id] = {
      ...rest,
      id,
      package: packageName || '@geastack/targets',
      targetDir: packageRoot ? path.join(packageRoot, targetPath) : '',
      // A composed target: the entry borrows another board's project through
      // targetPath and states its own module in `definition`, the same JSON a
      // project-local board writes under .gea/targets. Shipping it here is what
      // makes a composed board a library target instead of one project's file.
      definitionPath: definition && packageRoot ? path.join(packageRoot, definition) : ''
    }
  }
  return out
}

export function requireTargets(ctx) {
  if (!ctx.targetsRoot) {
    fail('@geastack/targets is not installed in this project (npm i @geastack/targets).', ExitCode.missingDependency)
  }
  const targets = loadTargets(ctx)
  if (Object.keys(targets).length === 0) {
    fail(`No targets.json found in ${ctx.targetsRoot}.`, ExitCode.missingDependency)
  }
  return targets
}

function packageDirFor(ctx, packageName) {
  for (const field of Object.keys(ctx)) {
    if (typeof ctx.packageName === 'function' && ctx.packageName(field) === packageName) return ctx[field]
  }
  return ''
}
