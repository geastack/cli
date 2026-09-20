import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { ExitCode, fail } from '../errors.mjs'
import { exists } from '../fs-utils.mjs'

// What the firmware must link for this app. The compiler analyses the entry
// (with the gea plugin) and reports the host bindings the program reaches;
// a network stack, the BLE host and the audio pipeline are only built when
// something actually uses them.
const networkBindings = ['wifi', 'fetch', 'http', 'websocket', 'rtc']

export function parseAnalysis(output) {
  const bindings = output.match(/^bindings=(.*)$/m)?.[1]?.split(';').filter(Boolean) ?? []
  const features = output.match(/^features=(.*)$/m)?.[1]?.split(';').filter(Boolean) ?? []
  return { bindings, features }
}

export function manifestRequestsBleOta(packageJson) {
  return packageJson?.gea?.ota?.ble === true
}

export function analyzeApp(ctx, app, { env = ctx.env || process.env } = {}) {
  const compiler = path.join(ctx.compilerPackageDir || '', 'dist', 'cli.js')
  const plugin = path.join(ctx.pluginPackageDir || '', 'dist', 'index.js')
  if (!ctx.compilerPackageDir || !exists(compiler)) {
    fail(`@geastack/compiler is not installed in this project (expected ${compiler}).`, ExitCode.missingDependency)
  }
  if (!ctx.pluginPackageDir || !exists(plugin)) {
    fail(`@geastack/geatsc-plugin-gea is not installed in this project (expected ${plugin}).`, ExitCode.missingDependency)
  }
  const output = execFileSync(process.execPath, [compiler, 'analyze', path.join(app.root, app.entry), '--plugin', plugin], {
    cwd: ctx.compilerPackageDir,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'inherit']
  })
  return parseAnalysis(output)
}

export function resolveAppCapabilities(ctx, app, options = {}) {
  const analysis = analyzeApp(ctx, app, options)
  const bindings = new Set(analysis.bindings)
  const features = new Set(analysis.features)
  const manifestBleOta = manifestRequestsBleOta(app.packageJson)
  return {
    network: networkBindings.some((binding) => bindings.has(binding)) || features.has('https'),
    ble: bindings.has('ble') || manifestBleOta,
    bleApi: bindings.has('ble'),
    audio: bindings.has('audio'),
    bindings: [...bindings].sort(),
    features: [...features].sort()
  }
}
