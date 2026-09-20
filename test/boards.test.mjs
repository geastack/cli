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
  'lokmat-applpmax': { adapter: 'geaos-arm64', targetDir: '/geaos/targets/geaos', appPlatform: 'geaos' }
}

const config = {
  amoled: { target: 'esp32-s3-touch-amoled-2.06', adapter: 'esp32-idf', transports: { usbSerial: { serial: '14:C1:9F:26:65:08' }, ota: { host: '192.168.1.42' } } },
  rotary: { target: 'esp32-s3-elecrow-rotary-2.1', adapter: 'esp32-idf', transports: { usbSerial: { serial: '30:ED:A0:E3:23:9C', restartAfterFlash: 'manual' } } },
  linux: { target: 'geaos', adapter: 'geaos-linux', transports: { telnet: { host: '192.168.7.2', port: 2323 }, fastboot: { serial: 'GEAOSFASTBOOT' } } },
  lokmat: { target: 'lokmat-applpmax', adapter: 'geaos-arm64', transports: { usbSerial: { serial: 'LOKMAT1' }, mtk: { workdir: '/w', bootSlot: 'boot_a', method: 'rbl', monitorGlob: '/dev/cu.usbmodem*' } } },
  tufty: { target: 'rp2350-tufty-2350', adapter: 'rp2350-pico', transports: { usbSerial: { serial: 'fa59949adbb4802f' } } },
  noUsb: { target: 'esp32-s3-touch-amoled-2.06', adapter: 'esp32-idf', transports: {} },
  legacyPath: { target: 'esp32-s3-touch-amoled-2.06', adapter: 'esp32-idf', transports: { usbSerial: { path: '/dev/cu.usbmodem1' } } }
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
  assert.throws(
    () => resolveBoardSelection({ boardName: 'noUsb', targets, config, needs: { usbPort: true } }),
    /defines neither transports\.usbSerial\.serial nor transports\.usbSerial\.port/
  )
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

test('a bare module composes with no peripherals at all', (t) => {
  // A headless devkit has no panel, no touch, no PMIC, no IMU, no codec and no
  // card slot. Every chip role is optional, so the definition describes the
  // hardware rather than filling in a five-chip shape it does not have.
  const definitionPath = path.join(fixtureDir, 'bare-module.json')
  const catalog = loadChipCatalogFromDir(fixtureDir)
  const target = normalizeCustomTarget(JSON.parse(readFileSync(definitionPath, 'utf8')), catalog)

  assert.equal(target.chips.display, null)
  assert.equal(target.chips.touch, null)
  assert.equal(target.chips.power, null)
  assert.equal(target.chips.imu, null)
  assert.equal(target.chips.audio, null)
  assert.equal(target.buses.i2c, null)
  assert.equal(target.storage.microSD, null)
  assert.equal(target.flashSize, '16MB')
  // Console transport is the module's wiring: this one is reached over a
  // USB-UART bridge, not the base's native USB-Serial/JTAG port.
  assert.deepEqual(target.console, { transport: 'uart', uart: 0, baud: 115200 })
  // PSRAM wiring likewise: octal settings on a quad-wired part bring the device
  // up wrong rather than failing, so the module declares its own.
  assert.deepEqual(target.psram, { mode: 'octal', speed: 80 })

  const header = renderBoardHeader(target)
  assert.match(header, /#define GEA_BOARD_HAS_DISPLAY 0/)
  assert.match(header, /#define GEA_BOARD_HAS_TOUCH 0/)
  assert.match(header, /#define GEA_BOARD_HAS_LAUNCHER_BUTTON 1/)
  // The constants still exist so the NC-tolerant board sources keep compiling.
  assert.match(header, /\.sda = GPIO_NUM_NC/)
  assert.doesNotMatch(header, /Co5300DisplayConfig/)
  assert.match(header, /\.pin = GPIO_NUM_0/)

  const cmake = renderTargetCmake(target, '/project/.gea/build/bare-module/gea-custom-target')
  assert.match(cmake, /set\(GEA_CUSTOM_TARGET_HAS_DISPLAY 0\)/)
  assert.match(cmake, /targets\/esp32\/display_headless\.cpp/)
  assert.doesNotMatch(cmake, /displays\/co5300/)
  // An absent peripheral still has to link: the framework calls Power,
  // Accelerometer and Touchscreen whether or not the chip is on the board.
  assert.match(cmake, /targets\/esp32\/power_absent\.cpp/)
  assert.match(cmake, /targets\/esp32\/imu_absent\.cpp/)
  assert.match(cmake, /targets\/esp32\/touch_absent\.cpp/)
  // The canvas sizes the offscreen surface; without it display.h's 410x502
  // default would reserve a framebuffer for a panel that is not there.
  assert.match(cmake, /GEA_EMBEDDED_DISPLAY_WIDTH=240/)
  assert.match(cmake, /GEA_EMBEDDED_DISPLAY_HEADLESS=1/)

  const fixture = createFixture(t)
  const outDir = path.join(fixture.root, 'generated')
  const written = writeCustomTarget({ definitionPath, outDir, catalog })
  assert.match(readFileSync(written.partitionCsv, 'utf8'), /^factory, app, factory, 0x10000, 0x600000/m)

  // The module's own 16MB outranks the 32MB of the base whose stack it borrows.
  const selection = resolveBoardSelection({
    boardName: 'bare-module',
    targets,
    configDir: fixtureDir,
    config: { 'bare-module': { target: 'bare-module', targetDefinition: 'bare-module.json', appPlatform: 'esp32' } }
  })
  assert.equal(selection.flashSize, '16MB')
  assert.equal(selection.idfTarget, 'esp32s3')
})

test('a composed target shipped by @geastack/targets needs no per-project definition', () => {
  // The whole point of promoting a composed board into the targets package: an
  // alias names the target and nothing else, and every project resolves it the
  // same way. Before this, `targetDefinition` was an alias-only field, so a
  // composed board could only ever live in one project's .gea directory.
  const fixtureDir = path.join(import.meta.dirname, 'fixtures', 'custom-target')
  const shipped = {
    ...targets,
    'bare-module': {
      adapter: 'esp32-idf',
      targetDir: targets['esp32-s3-touch-amoled-2.06'].targetDir,
      definitionPath: path.join(fixtureDir, 'bare-module.json'),
      appPlatform: 'esp32',
      idfTarget: 'esp32s3',
      flashSize: '32MB'
    }
  }

  const selection = resolveBoardSelection({
    boardName: 'bare-module',
    targets: shipped,
    config: { 'bare-module': { target: 'bare-module' } }
  })
  assert.equal(selection.targetDefinition, path.join(fixtureDir, 'bare-module.json'))
  // Read through to the definition: the base it extends supplies the adapter
  // and the project directory, the definition supplies the module's own flash.
  assert.equal(selection.flashSize, '16MB')
  assert.equal(selection.adapter, 'esp32-idf')
  assert.equal(selection.idfTarget, 'esp32s3')

  // An alias that carries its own definition still wins: someone describing the
  // module on their desk outranks the registry's description of it in general.
  const overridden = resolveBoardSelection({
    boardName: 'bare-module',
    targets: shipped,
    configDir: fixtureDir,
    config: { 'bare-module': { target: 'bare-module', targetDefinition: 'bare-module.json' } }
  })
  assert.equal(overridden.targetDefinition, path.join(fixtureDir, 'bare-module.json'))

  // A registry entry that names a definition nobody shipped fails closed.
  const broken = { ...shipped, 'bare-module': { ...shipped['bare-module'], definitionPath: path.join(fixtureDir, 'absent.json') } }
  assert.throws(
    () => resolveBoardSelection({ boardName: 'bare-module', targets: broken, config: { 'bare-module': { target: 'bare-module' } } }),
    /not in @geastack\/targets/
  )
})

test('a board with no USB serial is identified by its recorded port', () => {
  // The ESP32-S3's built-in USB Serial/JTAG publishes no iSerialNumber, so
  // every platform reports an empty serial for it; the port is then the only
  // identity such a board can carry.
  const byPort = { ...config, jtag: { target: 'esp32-s3-touch-amoled-2.06', adapter: 'esp32-idf', transports: { usbSerial: { port: 'COM3' } } } }
  const selection = resolveBoardSelection({ boardName: 'jtag', targets, config: byPort, needs: { usbPort: true }, usbSerialResolver: neverTouchHardware })
  assert.equal(selection.port, 'COM3')
})

test('a recorded serial still wins over a recorded port', () => {
  const both = { ...config, dual: { target: 'esp32-s3-touch-amoled-2.06', adapter: 'esp32-idf', transports: { usbSerial: { serial: 'ABC123', port: 'COM9' } } } }
  const selection = resolveBoardSelection({ boardName: 'dual', targets, config: both, needs: { usbPort: true }, usbSerialResolver: () => '/dev/resolved-from-serial' })
  assert.equal(selection.port, '/dev/resolved-from-serial')
})

test("an app's own display size silences the board's canvas defines", () => {
  // Both used to reach the compiler on one command line, and a disagreement
  // between them is a redefinition error rather than something a build log
  // explains. An app that declares a display size has said something more
  // specific than the board's default canvas, so the board defers -- the same
  // way it already defers to the app's sdkconfig.
  const catalog = loadChipCatalogFromDir(fixtureDir)
  const target = normalizeCustomTarget(JSON.parse(readFileSync(path.join(fixtureDir, 'bare-module.json'), 'utf8')), catalog)

  const quiet = renderTargetCmake(target, '/out', new Set(['GEA_EMBEDDED_DISPLAY_WIDTH', 'GEA_EMBEDDED_DISPLAY_HEIGHT']))
  assert.doesNotMatch(quiet, /GEA_EMBEDDED_DISPLAY_WIDTH=/)
  assert.doesNotMatch(quiet, /GEA_EMBEDDED_DISPLAY_HEIGHT=/)
  // Whether the board has a panel is the board's own fact, not the app's, so it
  // is still declared -- otherwise a headless board would build the panel path.
  assert.match(quiet, /GEA_EMBEDDED_DISPLAY_HEADLESS=1/)

  // An app that says nothing still gets the board's canvas, unchanged.
  const unchanged = renderTargetCmake(target, '/out')
  assert.match(unchanged, /GEA_EMBEDDED_DISPLAY_WIDTH=240/)
  assert.match(unchanged, /GEA_EMBEDDED_DISPLAY_HEIGHT=240/)
  assert.match(unchanged, /GEA_EMBEDDED_DISPLAY_HEADLESS=1/)
})
