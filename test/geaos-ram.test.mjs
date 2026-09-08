import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveBoardSelection } from '../src/boards/resolve.mjs'
import { runGeaos } from '../src/geaos/adapter.mjs'

const targets = {
  tablet: { adapter: 'geaos-arm64', targetDir: '/geaos/boards/w87', appPlatform: 'geaos', bootMode: 'ram-only' }
}

test('RAM-only GeaOS deployment never selects the legacy flash script', () => {
  const selection = resolveBoardSelection({ targetName: 'tablet', targets, config: {} })
  assert.equal(selection.bootMode, 'ram-only')
  for (const [action, expected] of [['build', 'build'], ['flash', 'boot'], ['flash-monitor', 'boot'], ['monitor', 'monitor'], ['ota', 'deploy']]) {
    const lines = []
    runGeaos({ ctx: { projectRoot: '/apps' }, selection, action, env: {}, dryRun: true,
      stdout: line => lines.push(line) })
    assert.deepEqual(lines, [`/geaos/boards/w87/board.py ${expected} taurus-pedal`])
  }
  assert.throws(() => runGeaos({ ctx: { projectRoot: '/apps' }, selection, action: 'flash-kernel',
    env: {}, dryRun: true, stdout() {} }), /not supported by this RAM-only target/)
})

test('ordinary GeaOS boards retain their existing deployment route', () => {
  const lines = []
  runGeaos({ ctx: { projectRoot: '/apps' }, selection: { adapter: 'geaos-arm64', targetDir: '/geaos', target: 'watch' },
    action: 'flash', app: { id: 'clock' }, env: {}, dryRun: true, stdout: line => lines.push(line) })
  assert.deepEqual(lines, ['/geaos/flash-geaos-arm64.sh clock'])
})
