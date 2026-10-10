import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { debuggerEntry, runDebug, sourceDebuggingRequested } from '../src/debugger.mjs'
import { runGea } from '../src/gea.mjs'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const env = { ...process.env, GEA_DEBUGGER_DIR: path.join(root, 'debugger'), GEA_SIMULATOR_DIR: path.join(root, 'simulator'), GEA_CHROME_PATH: process.execPath }

test('debugger resolution supports nested npm dependencies and preserves explicit directory overrides', () => {
  const packageRoot = '/app/node_modules/@geastack/cli/node_modules/@geastack/debugger'
  for (const module of ['launch.mjs', 'device.mjs']) {
    const expected = path.join(packageRoot, 'src', module)
    assert.equal(debuggerEntry({}, module, {
      hasFile: filename => filename === expected,
      resolvePackage: specifier => {
        assert.equal(specifier, '@geastack/debugger/package.json')
        return path.join(packageRoot, 'package.json')
      }
    }), expected)
  }
  assert.throws(() => debuggerEntry({ GEA_DEBUGGER_DIR: '/missing' }, 'device.mjs', {
    hasFile: () => false,
    resolvePackage: () => assert.fail('an invalid explicit directory must not silently use npm')
  }), /GEA_DEBUGGER_DIR does not contain src\/device.mjs/)
})

test('debug dry run accepts native-only Gea manifests without changing them', async () => {
  const output = []
  const app = { id: 'native', runtime: 'gea', root: '/apps/native', targets: { macos: true } }
  assert.equal(await runDebug({ app, env, dryRun: true, stdout: text => output.push(text) }), 0)
  assert.match(output[0], /--app-dir \/apps\/native/)
  assert.match(output[1], /--remote-debugging-port=9222/)
  assert.deepEqual(app.targets, { macos: true })
})

test('debug rejects invalid ports and conflicting runtime selections', async () => {
  const app = { id: 'native', runtime: 'gea', root: '/apps/native' }
  await assert.rejects(runDebug({ app, env, dryRun: true, stdout() {}, port: true }), /port number/)
  await assert.rejects(runDebug({ app, env, dryRun: true, stdout() {}, port: 9222 }), /must differ/)
  for (const flags of [['--target', 'ios'], ['--renderer', 'wasm']]) {
    await assert.rejects(runGea(['run', '--debug', ...flags], { env, cwd: root, stdout() {} }), /supports the DOM runtime, native macOS/)
  }
})


test('native debug config enables a non-Mac app and retains authored CSS without changing its manifest', async () => {
  const manifestPath = path.join(root, 'examples/apps/bouncing-balls-jsx/package.json')
  const before = readFileSync(manifestPath, 'utf8')
  const output = []
  assert.equal(await runGea(['config', '--project', path.join(root, 'examples'), '--app', 'bouncing-balls-jsx', '--target', 'macos', '--debug'], { env, cwd: root, stdout: text => output.push(text) }), 0)
  const config = JSON.parse(output[0])
  assert.equal(config.settings.compiler.staticCssRules, false)
  assert.equal(config.settings.compiler.staticCssTape, false)
  assert.equal(readFileSync(manifestPath, 'utf8'), before)
})


test('board debug attach selects registered AMOLED without building or opening USB in dry run', async () => {
  const output = []
  assert.equal(await runGea(['run', '--debug', '--attach', '--dry-run', '--no-open', '--board', 'amoled', '--project', path.join(root, 'examples'), '--app', 'tic-tac-toe'], { env, cwd: root, stdout: text => output.push(text) }), 0)
  assert.deepEqual(output, ['Device CDP: ws://127.0.0.1:9222/devtools/page/gea'])
})


test('ESP32 debug config retains live position records and overrides board CSS pruning', async () => {
  const { appForNativeDebugger } = await import('../src/build-config.mjs')
  const manifest = { targets: { esp32: { build: { renderer: { recordInlinePositions: false } }, boards: { demo: { build: { compiler: { staticCssRules: true, staticCssTape: true }, renderer: { recordInlinePositions: false } } } } } } }
  const app = { manifest, targets: {} }
  const debug = appForNativeDebugger(app, 'esp32')
  assert.equal(debug.manifest.targets.esp32.build.renderer.recordInlinePositions, true)
  assert.equal(debug.manifest.targets.esp32.boards.demo.build.renderer.recordInlinePositions, true)
  assert.equal(debug.manifest.targets.esp32.boards.demo.build.compiler.staticCssRules, false)
  assert.equal(debug.manifest.targets.esp32.boards.demo.build.compiler.staticCssTape, false)
  assert.equal(manifest.targets.esp32.build.renderer.recordInlinePositions, false)
})


test('debug FPS accepts 10/30 and rejects invalid or unsupported selections before device access',async()=>{
 const {debugFps}=await import('../src/debug-fps.mjs');assert.equal(debugFps('10'),10);assert.equal(debugFps('30'),30);assert.equal(debugFps(),0)
 for(const value of [true,'0','-1','121','10.5','abc'])assert.throws(()=>debugFps(value),/integer from 1 to 120/)
 const output=[];await runGea(['run','--debug','--attach','--dry-run','--no-open','--board','amoled','--project',path.join(root,'examples'),'--app','bouncing-balls-jsx','--debug-fps','10'],{env,cwd:root,stdout:s=>output.push(s)})
 assert.ok(output.includes('Device debug FPS cap: 10'))
 await assert.rejects(runGea(['run','--debug','--target','web','--debug-fps','10'],{env,cwd:path.join(root,'examples/apps/bouncing-balls-jsx'),stdout(){}}),/requires.*ESP32/)
})

test('USB JTAG requires explicit source debugging and can be disabled over an environment opt-in', async () => {
  const { parseArgs } = await import('../src/args.mjs')
  assert.equal(sourceDebuggingRequested(parseArgs([]), {}), false)
  assert.equal(sourceDebuggingRequested(parseArgs([]), { GEA_DEBUGGER_JTAG: '0' }), false)
  assert.equal(sourceDebuggingRequested(parseArgs([]), { GEA_DEBUGGER_JTAG: '1' }), true)
  assert.equal(sourceDebuggingRequested(parseArgs(['--debug-sources']), {}), true)
  assert.equal(sourceDebuggingRequested(parseArgs(['--no-debug-sources']), { GEA_DEBUGGER_JTAG: '1' }), false)
  assert.equal(sourceDebuggingRequested(parseArgs(['--debug-sources', '--no-debug-sources']), {}), false)
  for (const value of ['0', '1', 'false', 'true'])
    assert.throws(() => sourceDebuggingRequested(parseArgs(['--debug-sources=' + value]), {}), /without a value/)
  const output = []
  await runGea(['run', '--debug', '--attach', '--debug-sources', '--dry-run', '--no-open', '--board', 'amoled'], {
    env,
    cwd: path.join(root, 'examples/apps/bouncing-balls-jsx'),
    stdout: text => output.push(text),
  })
  assert.ok(output.includes('Native Sources: USB JTAG requested.'))
  for (const flags of [['--debug-sources'], ['--debug', '--debug-sources', '--target', 'web']])
    await assert.rejects(runGea(['run', ...flags], { env, cwd: path.join(root, 'examples/apps/bouncing-balls-jsx'), stdout() {} }), /--debug-sources requires/)
})

test('macOS enables LLDB symbols by default and accepts an explicit source debugging option', { skip: process.platform !== 'darwin' }, async () => {
  for (const flags of [[], ['--debug-sources'], ['--no-debug-sources']]) {
    const output = []
    await runGea(['run', '--debug', '--target', 'macos', '--dry-run', '--no-open', ...flags], {
      env, cwd: path.join(root, 'examples/apps/bouncing-balls-jsx'), stdout: text => output.push(text),
    })
    const command = output.join('\n')
    if (!flags.includes('--no-debug-sources')) {
      assert.match(command, /Native Sources: LLDB with full symbols and no optimization/)
    } else assert.doesNotMatch(command, /Native Sources: LLDB/)
    assert.match(command, /Native CDP: ws:/)
  }
})

test('Gea Changes override files require a debug run and a path', async () => {
  for (const flags of [['build', '--overrides', 'edits.json'], ['run', '--save-overrides', 'edits.json']])
    await assert.rejects(runGea(flags, { env, cwd: root, stdout() {} }), /requires gea run --debug/)
  await assert.rejects(
    runGea(['run', '--debug', '--target', 'macos', '--no-open', '--project', path.join(root, 'examples'), '--app', 'tic-tac-toe', '--overrides'], { env, cwd: root, stdout() {} }),
    /--overrides requires a file path/,
  )
})
