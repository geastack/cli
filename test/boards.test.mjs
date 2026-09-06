import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadChipCatalogFromDir, normalizeCustomTarget, renderBoardHeader, renderTargetCmake, writeCustomTarget } from '../src/boards/custom-target.mjs'
import { resolveBoardSelection } from '../src/boards/resolve.mjs'
import { resolvePicotoolSelection, resolveUsbSerialPort } from '../src/boards/usb.mjs'
import { createFixture } from './helpers/fixture.mjs'

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/custom-target')

const targets = {
  'esp32-s3': { adapter: 'esp32-idf', targetDir: '/pkg/targets/esp32-s3-touch-amoled-2.06', flashSize: '32MB', appPlatform: 'esp32', idfTarget: 'esp32s3', esptoolChip: 'esp32s3', ipcTaskStackSize: '4096' },
  'esp32-s3-touch-amoled-2.06': { adapter: 'esp32-idf', targetDir: '/pkg/targets/esp32-s3-touch-amoled-2.06', flashSize: '16MB', appPlatform: 'esp32', idfTarget: 'esp32s3', esptoolChip: 'esp32s3' },
  'esp32-s3-elecrow-rotary-2.1': { adapter: 'esp32-idf', targetDir: '/pkg/targets/esp32-s3-elecrow-rotary-2.1', flashSize: '16MB', appPlatform: 'esp32', idfTarget: 'esp32s3', esptoolChip: 'esp32s3' },
  'esp32-p4-waveshare-touch-lcd-7': { adapter: 'esp32-idf', targetDir: '/pkg/targets/esp32-p4-waveshare-touch-lcd-7', flashSize: '32MB', appPlatform: 'esp32', idfTarget: 'esp32p4', esptoolChip: 'esp32p4', ipcTaskStackSize: '4096' },
  'rp2350-waveshare-touch-amoled-2.41': { adapter: 'rp2350-pico', targetDir: '/pkg/targets/rp2350-waveshare-touch-amoled-2.41', flashSize: '16MB', appPlatform: 'rp2350' },
  'rp2350-tufty-2350': { adapter: 'rp2350-pico', targetDir: '/pkg/targets/rp2350-tufty-2350', flashSize: '16MB', appPlatform: 'rp2350', compatibleAppPlatforms: ['esp32'] },
  geaos: { adapter: 'geaos-linux', targetDir: '/geaos/targets/geaos', appPlatform: 'geaos' },
  'lokmat-applpmax': { adapter: 'geaos-arm64', targetDir: '/geaos/targets/geaos', appPlatform: 'geaos' },
  'esp32-s3-headless': { adapter: 'taurus-s3', targetDir: '/pkg/targets/esp32-s3-headless', flashSize: '16MB', appPlatform: 'taurus-pedal', idfTarget: 'esp32s3', esptoolChip: 'esp32s3' }
}

const config = {
  amoled: { target: 'esp32-s3-touch-amoled-2.06', adapter: 'esp32-idf', transports: { usbSerial: { serial: '14:C1:9F:26:65:08' }, ota: { host: '192.168.1.42' } } },
  rotary: { target: 'esp32-s3-elecrow-rotary-2.1', adapter: 'esp32-idf', transports: { usbSerial: { serial: '30:ED:A0:E3:23:9C', restartAfterFlash: 'manual' } } },
  linux: { target: 'geaos', adapter: 'geaos-linux', transports: { telnet: { host: '192.168.7.2', port: 2323 }, fastboot: { serial: 'GEAOSFASTBOOT' } } },
  lokmat: { target: 'lokmat-applpmax', adapter: 'geaos-arm64', transports: { usbSerial: { serial: 'LOKMAT1' }, mtk: { workdir: '/w', bootSlot: 'boot_a', method: 'rbl', monitorGlob: '/dev/cu.usbmodem*' } } },
  tufty: { target: 'rp2350-tufty-2350', adapter: 'rp2350-pico', transports: { usbSerial: { serial: 'fa59949adbb4802f' } } },
  noUsb: { target: 'esp32-s3-touch-amoled-2.06', adapter: 'esp32-idf', transports: {} },
  legacyPath: { target: 'esp32-s3-touch-amoled-2.06', adapter: 'esp32-idf', transports: { usbSerial: { path: '/dev/cu.usbmodem1' } } },
  headless: { target: 'esp32-s3-headless', adapter: 'taurus-s3', transports: { usbSerial: { serial: 'HEADLESS' } } }
}

const neverTouchHardware = () => {
  throw new Error('Build must not access hardware')
}

test('target metadata replaces one-script-per-board wrappers', () => {
  const rotary = resolveBoardSelection({ targetName: 'esp32-s3-elecrow-rotary-2.1', targets, config, usbSerialResolver: neverTouchHardware })
  assert.equal(rotary.adapter, 'esp32-idf')
  assert.equal(rotary.targetDir, '/pkg/targets/esp32-s3-elecrow-rotary-2.1')
  assert.equal(rotary.flashSize, '16MB')
  assert.equal(rotary.idfTarget, 'esp32s3')
  assert.equal(rotary.port, '')

  const p4 = resolveBoardSelection({ targetName: 'esp32-p4-waveshare-touch-lcd-7', targets, config, usbSerialResolver: neverTouchHardware })
  assert.equal(p4.esptoolChip, 'esp32p4')
  assert.equal(p4.ipcTaskStackSize, '4096')

  const tufty = resolveBoardSelection({ targetName: 'rp2350-tufty-2350', targets, config, usbSerialResolver: neverTouchHardware })
  assert.equal(tufty.adapter, 'rp2350-pico')
  assert.deepEqual(tufty.compatibleAppPlatforms, ['esp32'])

  const lokmat = resolveBoardSelection({ boardName: 'lokmat', targets, config, usbSerialResolver: neverTouchHardware })
  assert.equal(lokmat.adapter, 'geaos-arm64')
  assert.equal(lokmat.mtkWorkdir, '/w')
  assert.equal(lokmat.mtkBootSlot, 'boot_a')
  assert.equal(lokmat.mtkMethod, 'rbl')
})

test('a build never resolves hardware; flash resolves the USB serial to a port', () => {
  const build = resolveBoardSelection({ boardName: 'amoled', targets, config, usbSerialResolver: neverTouchHardware })
  assert.equal(build.usbSerial, '14:C1:9F:26:65:08')
  assert.equal(build.port, '')
  assert.equal(build.otaHost, '192.168.1.42')

  const flash = resolveBoardSelection({
    boardName: 'amoled',
    targets,
    config,
    needs: { usbPort: true },
    usbSerialResolver({ serial }) {
      assert.equal(serial, '14:C1:9F:26:65:08')
      return '/dev/selected-com'
    }
  })
  assert.equal(flash.port, '/dev/selected-com')

  const deferred = resolveBoardSelection({ boardName: 'amoled', targets, config, needs: { usbPort: true }, deferUsbPort: true, usbSerialResolver: neverTouchHardware })
  assert.equal(deferred.port, '')

  const explicit = resolveBoardSelection({ boardName: 'amoled', targets, config, needs: { usbPort: true }, requestedPort: '/dev/explicit', usbSerialResolver: neverTouchHardware })
  assert.equal(explicit.port, '/dev/explicit')

  const rotary = resolveBoardSelection({ boardName: 'rotary', targets, config, usbSerialResolver: neverTouchHardware })
  assert.equal(rotary.usbRestartAfterFlash, 'manual')
})

test('OTA needs a host from the board or the command line', () => {
  const ota = resolveBoardSelection({ boardName: 'amoled', targets, config, needs: { otaHost: true }, usbSerialResolver: neverTouchHardware })
  assert.equal(ota.host, '192.168.1.42')
  const override = resolveBoardSelection({ boardName: 'amoled', targets, config, needs: { otaHost: true }, requestedHost: '10.0.0.9', usbSerialResolver: neverTouchHardware })
  assert.equal(override.host, '10.0.0.9')
  assert.throws(() => resolveBoardSelection({ boardName: 'noUsb', targets, config, needs: { otaHost: true } }), /transports\.ota\.host/)
})

test('boards without a USB serial fail clearly and point at the wireless path', () => {
  assert.throws(() => resolveBoardSelection({ boardName: 'noUsb', targets, config, needs: { usbPort: true } }), /does not define transports\.usbSerial\.serial/)
  assert.throws(() => resolveBoardSelection({ boardName: 'legacyPath', targets, config }), /transports\.usbSerial\.path.*no longer supported/)
  assert.throws(() => resolveBoardSelection({ boardName: 'missing', targets, config }), /Unknown board 'missing'/)
  assert.throws(() => resolveBoardSelection({ targets, config }), /No board selected/)
  const wifiOnly = { ...config, wifi: { target: 'esp32-s3-touch-amoled-2.06', adapter: 'esp32-idf', transports: { ota: { host: '10.0.0.1' } } } }
  assert.throws(() => resolveBoardSelection({ boardName: 'wifi', targets, config: wifiOnly, needs: { usbPort: true } }), /gea logs --board wifi/)
})

test('geaos boards carry their telnet and fastboot transports', () => {
  const linux = resolveBoardSelection({ boardName: 'linux', targets, config, needs: { usbPort: true }, usbSerialResolver: neverTouchHardware })
  assert.equal(linux.adapter, 'geaos-linux')
  assert.equal(linux.telnetHost, '192.168.7.2')
  assert.equal(linux.telnetPort, '2323')
  assert.equal(linux.fastbootSerial, 'GEAOSFASTBOOT')
  assert.equal(linux.targetDir, '/geaos/targets/geaos')
})

test('the headless taurus target routes through its board.mjs hook', () => {
  const build = resolveBoardSelection({ boardName: 'headless', targets, config, usbSerialResolver: neverTouchHardware })
  assert.equal(build.adapter, 'taurus-s3')
  assert.equal(build.flashSize, '16MB')
  const flash = resolveBoardSelection({ boardName: 'headless', targets, config, needs: { usbPort: true }, usbSerialResolver: () => '/dev/selected-com' })
  assert.equal(flash.port, '/dev/selected-com')
})

test('picotool selection prefers bus/address on macOS and the serial elsewhere', () => {
  const ioreg = () => JSON.stringify([{ IORegistryEntryChildren: [{ 'USB Serial Number': 'fa59949adbb4802f', USBBusNumber: 2, 'USB Address': 5, locationID: 0x14200000, IORegistryEntryChildren: [] }] }])
  assert.deepEqual(resolvePicotoolSelection({ serial: 'fa59949adbb4802f' }, { platform: 'linux' }), ['--ser', 'fa59949adbb4802f'])
  const mac = resolvePicotoolSelection({ serial: 'fa59949adbb4802f' }, { platform: 'darwin', ioreg })
  assert.ok(mac.includes('--ser') || mac.includes('--bus'), `expected a picotool selector, got ${mac.join(' ')}`)
})

test('USB serial resolution requires a serial and never a path', () => {
  assert.throws(() => resolveUsbSerialPort({ serial: '' }, { platform: 'linux' }), /serial/i)
})

test('custom targets compose from the chip catalog', (t) => {
  const definitionPath = path.join(fixtureDir, 'manual-amoled.json')
  const definition = JSON.parse(readFileSync(definitionPath, 'utf8'))
  const catalog = loadChipCatalogFromDir(fixtureDir)
  const target = normalizeCustomTarget(definition, catalog)

  assert.equal(target.id, 'manual-amoled')
  assert.equal(target.chips.display.driver, 'co5300')
  assert.equal(target.chips.touch.pins.interrupt, 38)

  const header = renderBoardHeader(target)
  assert.match(header, /\.sda = GPIO_NUM_15/)
  assert.match(header, /\.cs = GPIO_NUM_12/)
  assert.match(header, /\.powerAmplifier = GPIO_NUM_46/)
  assert.match(header, /\.activeLevel = 0/)

  const cmake = renderTargetCmake(target, '/project/.gea/build/manual-amoled/gea-custom-target')
  assert.match(cmake, /\$\{GEA_CHIPS\}\/displays\/co5300\/co5300\.cpp/)
  assert.match(cmake, /chip_bindings\/touch\/ft3168\.cpp/)
  assert.match(cmake, /GEA_EMBEDDED_DISPLAY_WIDTH=410/)

  assert.throws(
    () => normalizeCustomTarget({ ...definition, chips: { ...definition.chips, display: { ...definition.chips.display, driver: 'unknown-panel' } } }, catalog),
    /has no esp32-idf binding/
  )
  assert.throws(
    () => normalizeCustomTarget({
      ...definition,
      chips: { ...definition.chips, touch: { ...definition.chips.touch, pins: { ...definition.chips.touch.pins, reset: definition.chips.display.pins.reset } } }
    }, catalog),
    /GPIO 8 is assigned to both display reset and touch reset/
  )

  const fixture = createFixture(t)
  const outDir = path.join(fixture.root, 'generated')
  const written = writeCustomTarget({ definitionPath, outDir, catalog })
  assert.equal(written.headerPath, path.join(outDir, 'board.h'))
  assert.equal(written.cmakePath, path.join(outDir, 'target.cmake'))
  assert.match(readFileSync(written.cmakePath, 'utf8'), /GEA_EMBEDDED_DISPLAY_WIDTH=410/)

  const selection = resolveBoardSelection({
    boardName: 'manual-amoled',
    targets,
    configDir: fixtureDir,
    config: { 'manual-amoled': { target: 'manual-amoled', targetDefinition: 'manual-amoled.json', appPlatform: 'esp32' } }
  })
  assert.equal(selection.target, 'manual-amoled')
  assert.equal(selection.targetDefinition, definitionPath)
  assert.equal(selection.targetDir, '/pkg/targets/esp32-s3-touch-amoled-2.06')
  assert.equal(selection.adapter, 'esp32-idf')
  assert.equal(selection.idfTarget, 'esp32s3')
})
