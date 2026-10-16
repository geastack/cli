import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilitiesFromAnalysis } from '../src/esp32/capabilities.mjs'
import { selectDependencies } from '../src/esp32/dependencies.mjs'
import { resolveBuildConfig } from '../src/build-config.mjs'

test('camera and AEC are inferred independently of ordinary audio playback', () => {
  const app = { packageJson: {} }
  const voice = capabilitiesFromAnalysis(app, {
    bindings: ['audio', 'camera', 'websocket'], features: ['audio-capture', 'audio-playback'],
  })
  assert.equal(voice.camera, true)
  assert.equal(voice.aec, true)
  assert.equal(voice.network, true)
  const playback = capabilitiesFromAnalysis(app, { bindings: ['audio'], features: ['audio-playback'] })
  assert.equal(playback.aec, false)
  assert.equal(playback.camera, false)
  const resolved = resolveBuildConfig({ app: { manifest: {} }, platform: 'esp32', capabilities: voice })
  assert.equal(resolved.capabilities.aec, true)
  assert.ok(resolved.defines.includes('GEA_AUDIO_ECHO_CANCELLATION=1'))
  assert.ok(resolved.defines.includes('GEA_AUDIO_FULL_DUPLEX=1'))
})

test('dependency selection excludes unused SDKs without reading environment variables', () => {
  const catalog = {
    camera_sdk: { when: ['camera'], dependency: { version: '1' } },
    esp_sr: { when: ['aec'], dependency: { version: '2' } },
  }
  assert.deepEqual(selectDependencies(catalog, {}), {})
  assert.deepEqual(selectDependencies(catalog, { camera: true }), { camera_sdk: { version: '1', require: 'public' } })
  assert.deepEqual(selectDependencies(catalog, { aec: true }), { esp_sr: { version: '2', require: 'public' } })
})
