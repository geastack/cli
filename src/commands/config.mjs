import { option } from '../args.mjs'
import { selectBoard } from './board.mjs'
import { assertValidApp, assertTargetEnabled, resolveRequestedApp, knownPlatforms } from '../manifest.mjs'
import { resolveAppBuildConfig } from '../build-config.mjs'

export function configCommand(ctx, parsed, rest, { stdout, env }) {
  const app = resolveRequestedApp(ctx, parsed, rest)
  assertValidApp(app)
  const requested = option(parsed, 'target', '')
  const selection = knownPlatforms.includes(requested) ? { target: '', appPlatform: requested } : selectBoard(ctx, parsed)
  const platform = selection.appPlatform || (selection.adapter === 'rp2350-pico' ? 'rp2350' : 'esp32')
  assertTargetEnabled(ctx, app, selection.boardName || selection.target || platform)
  const resolved = resolveAppBuildConfig({ app, platform, board: selection.target, targetBase: selection.targetBase, targetsRoot: ctx.targetsRoot, env })
  stdout(JSON.stringify(resolved, null, 2))
  return 0
}
