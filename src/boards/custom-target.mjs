import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { writePartitionTable } from '../esp32/partitions-from-manifest.mjs'

// A composed board: a JSON definition (chips from @geastack/chips plus pins
// and buses) that extends a built-in base target. The CLI turns it into a
// generated board.h + target.cmake inside the app's build directory before
// IDF configures, so the target project only ever includes generated files.

const supportedBase = 'esp32-s3'

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`)
  return value.trim()
}

function integer(value, label, { min = 0, max = 48 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} through ${max}.`)
  }
  return value
}

function pin(value, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === 'none')) return -1
  return integer(value, label)
}

function exact(value, expected, label) {
  const actual = text(value, label).toLowerCase()
  if (actual !== expected) {
    throw new Error(`${label} '${actual}' is not supported by the ${supportedBase} base. Supported value: ${expected}.`)
  }
  return actual
}

export function loadChipCatalogFromDir(chipsDir) {
  const packageDir = text(chipsDir, 'chips package directory')
  const catalogPath = path.join(packageDir, 'catalog.json')
  if (!existsSync(catalogPath)) throw new Error(`Chip catalog not found: ${catalogPath}`)
  const catalog = object(JSON.parse(readFileSync(catalogPath, 'utf8')), 'Chip catalog')
  if (catalog.schemaVersion !== 1) throw new Error(`Unsupported chip catalog schema: ${catalog.schemaVersion}`)
  return object(catalog.chips, 'Chip catalog entries')
}

function selectedChip(chips, role, category, adapter, mcu, catalog) {
  const selection = object(chips[role], `chips.${role}`)
  const driver = text(selection.driver || selection.controller, `chips.${role}.driver`).toLowerCase()
  const descriptor = object(catalog[driver], `Catalog entry for '${driver}'`)
  if (descriptor.category !== category) {
    throw new Error(`Chip '${driver}' is a ${descriptor.category}, so it cannot fill the ${role} role.`)
  }
  const interfaceName = text(selection.interface, `chips.${role}.interface`).toLowerCase()
  if (!Array.isArray(descriptor.interfaces) || !descriptor.interfaces.includes(interfaceName)) {
    throw new Error(`Chip '${driver}' does not support the '${interfaceName}' interface.`)
  }
  const adapterInfo = descriptor.adapters?.[adapter]
  if (!adapterInfo) throw new Error(`Chip '${driver}' has no ${adapter} binding in the installed catalog.`)
  if (Array.isArray(adapterInfo.mcus) && !adapterInfo.mcus.includes(mcu)) {
    throw new Error(`Chip '${driver}' does not support MCU '${mcu}' through ${adapter}.`)
  }
  return {
    ...selection,
    driver,
    interface: interfaceName,
    nativeSources: Array.isArray(descriptor.sources) ? descriptor.sources : [],
    bindingSources: Array.isArray(adapterInfo.bindingSources) ? adapterInfo.bindingSources : []
  }
}

// A role a board simply does not have. Omitting the key — or spelling it
// `null` / `"none"` — means "this board has no chip in that role", which is the
// normal case for a bare module: a headless devkit has no display, no touch
// panel, no PMIC, no IMU and no codec. Every role is optional so that the
// composition describes the hardware instead of a fixed five-chip shape.
function absent(value) {
  return value === undefined || value === null || value === 'none'
}

function optionalChip(chips, role, category, adapter, mcu, catalog) {
  if (absent(chips[role])) return null
  return selectedChip(chips, role, category, adapter, mcu, catalog)
}

// A board with no panel still renders into a canvas: the framework's Display is
// canvas-backed everywhere (this is exactly how the native test host runs), so
// A board with no panel can still draw: `canvas` asks for an offscreen surface,
// PSRAM-resident, which the app renders into and a screenshot can read over OTA.
// That is what "headless" means here -- nothing is transmitted, not nothing is
// drawn.
//
// Declaring no canvas is the other thing, and it is not the same: the board has
// no display at all. Nothing sizes a surface because there is no surface, and
// the runtime builds no framebuffer, no app tree and no frame loop. A bare
// module gets what its hardware says it has, the same way it gets no PMIC
// driver -- not an emulated panel it can never show anyone.
function headlessCanvas(definition) {
  if (absent(definition.canvas)) return null
  const canvas = object(definition.canvas, 'canvas')
  return {
    width: integer(canvas.width, 'canvas.width', { min: 1, max: 4096 }),
    height: integer(canvas.height, 'canvas.height', { min: 1, max: 4096 })
  }
}

export function normalizeCustomTarget(raw, catalog) {
  const definition = object(raw, 'Target definition')
  const id = text(definition.id, 'id')
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error('id may contain lowercase letters, digits, dots, underscores, and hyphens.')
  const base = exact(definition.extends, supportedBase, 'extends')
  const mcu = exact(definition.mcu, 'esp32s3', 'mcu')
  const adapter = definition.adapter ? exact(definition.adapter, 'esp32-idf', 'adapter') : 'esp32-idf'
  const chips = absent(definition.chips) ? {} : object(definition.chips, 'chips')
  const display = optionalChip(chips, 'display', 'display', adapter, mcu, catalog)
  const touch = optionalChip(chips, 'touch', 'touch', adapter, mcu, catalog)
  const power = optionalChip(chips, 'power', 'power', adapter, mcu, catalog)
  const imu = optionalChip(chips, 'imu', 'imu', adapter, mcu, catalog)
  const audio = optionalChip(chips, 'audio', 'audio', adapter, mcu, catalog)
  const buses = absent(definition.buses) ? {} : object(definition.buses, 'buses')
  const storage = absent(definition.storage) ? {} : object(definition.storage, 'storage')
  const controls = absent(definition.controls) ? {} : object(definition.controls, 'controls')
  const microSD = absent(storage.microSD) ? null : object(storage.microSD, 'storage.microSD')
  const launcherButton = absent(controls.launcherButton) ? null : object(controls.launcherButton, 'controls.launcherButton')

  // The I2C bus is only required by the chips that sit on it. A board that
  // selects none of them does not need to invent pins for a bus nothing drives.
  const i2cChips = [
    [touch, 'chips.touch'],
    [power, 'chips.power'],
    [imu, 'chips.imu']
  ].filter(([chip]) => chip && chip.interface === 'i2c')
  if (absent(buses.i2c) && i2cChips.length > 0) {
    throw new Error(`buses.i2c is required because ${i2cChips.map(([, label]) => label).join(', ')} ${i2cChips.length > 1 ? 'are' : 'is'} on the I2C bus.`)
  }
  const i2c = absent(buses.i2c) ? null : object(buses.i2c, 'buses.i2c')

  const displayPins = display ? object(display.pins, 'chips.display.pins') : null
  const touchPins = touch ? object(touch.pins, 'chips.touch.pins') : null
  const audioPins = audio ? object(audio.pins, 'chips.audio.pins') : null
  const storagePins = microSD ? object(microSD.pins, 'storage.microSD.pins') : null

  const spiHost = display ? String(display.spiHost).toLowerCase() : 'spi2'
  if (display && !['spi2', 'spi3'].includes(spiHost)) throw new Error("chips.display.spiHost must be 'spi2' or 'spi3'.")

  // Flash size and the partition table are board geometry, not app policy: a
  // module with 16MB of flash cannot borrow its base's 32MB layout, and every
  // app built for it would otherwise inherit a table that does not fit. Both
  // stay optional — a board whose flash matches its base needs neither.
  const flashSize = absent(definition.flashSize) ? '' : text(definition.flashSize, 'flashSize')
  if (flashSize && !/^\d+MB$/i.test(flashSize)) throw new Error(`flashSize must look like '16MB', not '${flashSize}'.`)
  const partitions = absent(definition.partitions) ? null : object(definition.partitions, 'partitions')

  // Which physical port the log comes out of is the module's wiring, not the
  // base's. A devkit reached through a USB-UART bridge and one with its native
  // USB-Serial/JTAG plugged in are different boards, and inheriting the wrong
  // one produces firmware that runs perfectly while appearing completely dead.
  const console = absent(definition.console) ? null : object(definition.console, 'console')
  const consoleTransports = ['usb-serial-jtag', 'uart', 'none']
  const consoleTransport = console && !absent(console.transport) ? text(console.transport, 'console.transport').toLowerCase() : ''
  if (consoleTransport && !consoleTransports.includes(consoleTransport)) {
    throw new Error(`console.transport must be one of ${consoleTransports.join(', ')}, not '${consoleTransport}'.`)
  }
  const consoleBaud = console && !absent(console.baud) ? integer(console.baud, 'console.baud', { min: 9600, max: 921600 }) : 0
  const consoleUart = console && !absent(console.uart) ? integer(console.uart, 'console.uart', { min: 0, max: 2 }) : 0

  // PSRAM wiring is the module's too, and getting it wrong is worse than the
  // console: octal settings on a quad-wired part do not fail cleanly, they
  // bring up a device that reports the wrong size and corrupts under load.
  const psram = absent(definition.psram) ? null : object(definition.psram, 'psram')
  const psramModes = ['octal', 'quad', 'none']
  const psramMode = psram && !absent(psram.mode) ? text(psram.mode, 'psram.mode').toLowerCase() : ''
  if (psramMode && !psramModes.includes(psramMode)) {
    throw new Error(`psram.mode must be one of ${psramModes.join(', ')}, not '${psramMode}'.`)
  }
  const psramSpeed = psram && !absent(psram.speed) ? integer(psram.speed, 'psram.speed', { min: 40, max: 120 }) : 0
  if (psramSpeed && ![40, 80, 120].includes(psramSpeed)) {
    throw new Error(`psram.speed must be 40, 80 or 120 MHz, not ${psramSpeed}.`)
  }

  const target = {
    id,
    extends: base,
    adapter,
    mcu,
    flashSize: flashSize.toUpperCase(),
    partitions,
    console: consoleTransport ? { transport: consoleTransport, baud: consoleBaud, uart: consoleUart } : null,
    psram: psramMode ? { mode: psramMode, speed: psramSpeed } : null,
    buses: {
      i2c: i2c === null ? null : {
        sda: pin(i2c.sda, 'buses.i2c.sda'),
        scl: pin(i2c.scl, 'buses.i2c.scl')
      }
    },
    // No panel: the board draws into an offscreen canvas and transmits nothing.
    canvas: display ? null : headlessCanvas(definition),
    chips: {
      display: display === null ? null : {
        driver: display.driver,
        interface: exact(display.interface, 'qspi', 'chips.display.interface'),
        width: integer(display.width, 'chips.display.width', { min: 1, max: 4096 }),
        height: integer(display.height, 'chips.display.height', { min: 1, max: 4096 }),
        spiHost,
        nativeSources: display.nativeSources,
        bindingSources: display.bindingSources,
        pins: {
          cs: pin(displayPins.cs, 'chips.display.pins.cs'),
          pclk: pin(displayPins.pclk, 'chips.display.pins.pclk'),
          data0: pin(displayPins.data0, 'chips.display.pins.data0'),
          data1: pin(displayPins.data1, 'chips.display.pins.data1'),
          data2: pin(displayPins.data2, 'chips.display.pins.data2'),
          data3: pin(displayPins.data3, 'chips.display.pins.data3'),
          reset: pin(displayPins.reset, 'chips.display.pins.reset'),
          te: pin(displayPins.te, 'chips.display.pins.te', { optional: true })
        }
      },
      touch: touch === null ? null : {
        driver: touch.driver,
        interface: exact(touch.interface, 'i2c', 'chips.touch.interface'),
        nativeSources: touch.nativeSources,
        bindingSources: touch.bindingSources,
        pins: {
          reset: pin(touchPins.reset, 'chips.touch.pins.reset'),
          interrupt: pin(touchPins.interrupt, 'chips.touch.pins.interrupt')
        }
      },
      power: power === null ? null : {
        driver: power.driver,
        interface: exact(power.interface, 'i2c', 'chips.power.interface'),
        nativeSources: power.nativeSources,
        bindingSources: power.bindingSources
      },
      imu: imu === null ? null : {
        driver: imu.driver,
        interface: exact(imu.interface, 'i2c', 'chips.imu.interface'),
        nativeSources: imu.nativeSources,
        bindingSources: imu.bindingSources
      },
      audio: audio === null ? null : {
        driver: audio.driver,
        interface: exact(audio.interface, 'i2s', 'chips.audio.interface'),
        nativeSources: audio.nativeSources,
        bindingSources: audio.bindingSources,
        pins: {
          mclk: pin(audioPins.mclk, 'chips.audio.pins.mclk'),
          bclk: pin(audioPins.bclk, 'chips.audio.pins.bclk'),
          ws: pin(audioPins.ws, 'chips.audio.pins.ws'),
          dout: pin(audioPins.dout, 'chips.audio.pins.dout'),
          din: pin(audioPins.din, 'chips.audio.pins.din'),
          powerAmplifier: pin(audioPins.powerAmplifier, 'chips.audio.pins.powerAmplifier')
        }
      }
    },
    storage: {
      microSD: microSD === null ? null : {
        interface: exact(microSD.interface, 'sdmmc-1bit', 'storage.microSD.interface'),
        pins: {
          clk: pin(storagePins.clk, 'storage.microSD.pins.clk', { optional: true }),
          cmd: pin(storagePins.cmd, 'storage.microSD.pins.cmd', { optional: true }),
          data0: pin(storagePins.data0, 'storage.microSD.pins.data0', { optional: true })
        }
      }
    },
    controls: {
      launcherButton: launcherButton === null ? null : {
        pin: pin(launcherButton.pin, 'controls.launcherButton.pin', { optional: true }),
        activeLevel: integer(launcherButton.activeLevel, 'controls.launcherButton.activeLevel', { min: 0, max: 1 })
      }
    }
  }
  validatePinAssignments(target)
  return target
}

function validatePinAssignments(target) {
  const { display, touch, audio } = target.chips
  const { i2c } = target.buses
  const sd = target.storage.microSD
  const launcher = target.controls.launcherButton
  // Only the peripherals this board actually has contribute pins; an absent
  // role owns no GPIO and so can never collide with one.
  const pins = [
    ...(i2c ? [['I2C SDA', i2c.sda], ['I2C SCL', i2c.scl]] : []),
    ...(display ? [
      ['display CS', display.pins.cs],
      ['display PCLK', display.pins.pclk],
      ['display DATA0', display.pins.data0],
      ['display DATA1', display.pins.data1],
      ['display DATA2', display.pins.data2],
      ['display DATA3', display.pins.data3],
      ['display reset', display.pins.reset],
      ['display TE', display.pins.te]
    ] : []),
    ...(touch ? [
      ['touch reset', touch.pins.reset],
      ['touch interrupt', touch.pins.interrupt]
    ] : []),
    ...(audio ? [
      ['audio MCLK', audio.pins.mclk],
      ['audio BCLK', audio.pins.bclk],
      ['audio WS', audio.pins.ws],
      ['audio DOUT', audio.pins.dout],
      ['audio DIN', audio.pins.din],
      ['audio amplifier', audio.pins.powerAmplifier]
    ] : []),
    ...(sd ? [
      ['microSD CLK', sd.pins.clk],
      ['microSD CMD', sd.pins.cmd],
      ['microSD DATA0', sd.pins.data0]
    ] : []),
    ...(launcher ? [['launcher button', launcher.pin]] : [])
  ]
  const used = new Map()
  for (const [label, value] of pins) {
    if (value < 0) continue
    const previous = used.get(value)
    if (previous) throw new Error(`GPIO ${value} is assigned to both ${previous} and ${label}.`)
    used.set(value, label)
  }
}

function gpio(value) {
  return value < 0 ? 'GPIO_NUM_NC' : `GPIO_NUM_${value}`
}

// Absent roles still get their board.h constant, wired to GPIO_NUM_NC. The
// board-local sources (i2c.cpp, touch.cpp, launcher_button.cpp, sdcard_mount.cpp)
// compile on every board and check GEA_BOARD_HAS_* to decide whether to bring the
// peripheral up, so the constant has to exist even when the hardware does not.
const noPins = new Proxy({}, { get: () => -1 })

export function renderBoardHeader(target) {
  const i2c = target.buses.i2c || noPins
  const { display, touch, audio } = target.chips
  const displayPins = display ? display.pins : noPins
  const touchPins = touch ? touch.pins : noPins
  const audioPins = audio ? audio.pins : noPins
  const sdPins = target.storage.microSD ? target.storage.microSD.pins : noPins
  const launcher = target.controls.launcherButton || { pin: -1, activeLevel: 0 }
  // Only the drivers this board uses are included. `driver/i2s_types.h` lives in
  // the esp_driver_i2s component, which is not linked when no codec is selected,
  // so including it unconditionally fails the build of a board with no audio —
  // before anything has even looked at a pin.
  const includes = [
    '#include "driver/gpio.h"',
    audio ? '#include "driver/i2s_types.h"' : '',
    display ? '#include "driver/spi_master.h"' : ''
  ].filter(Boolean).join('\n')
  return `#pragma once

${includes}

// Which roles this board actually populates. A source that touches a peripheral
// guards on these rather than assuming the five-chip AMOLED shape.
#define GEA_BOARD_HAS_I2C ${target.buses.i2c ? 1 : 0}
#define GEA_BOARD_HAS_DISPLAY ${display ? 1 : 0}
#define GEA_BOARD_HAS_TOUCH ${touch ? 1 : 0}
#define GEA_BOARD_HAS_POWER ${target.chips.power ? 1 : 0}
#define GEA_BOARD_HAS_IMU ${target.chips.imu ? 1 : 0}
#define GEA_BOARD_HAS_AUDIO ${audio ? 1 : 0}
#define GEA_BOARD_HAS_MICROSD ${target.storage.microSD ? 1 : 0}
#define GEA_BOARD_HAS_LAUNCHER_BUTTON ${target.controls.launcherButton ? 1 : 0}

namespace gea::platform::board {

// The I2C bus, the card slot and the launcher button are declared on every
// board: i2c.cpp, sdcard_mount.cpp and launcher_button.cpp compile everywhere
// and already decline a GPIO_NUM_NC peripheral at runtime, so the constants have
// to exist even when the hardware does not. A display, touch or audio constant
// is only read by that chip's binding, which is not compiled when the chip is
// absent — so those are emitted only when the board really has one.
struct I2cBusConfig { gpio_num_t sda; gpio_num_t scl; };
struct SdMmcConfig { gpio_num_t clk; gpio_num_t cmd; gpio_num_t data0; };
struct LauncherButtonConfig { gpio_num_t pin; int activeLevel; };
${display ? 'struct Co5300DisplayConfig { spi_host_device_t spiHost; gpio_num_t cs; gpio_num_t pclk; gpio_num_t data0; gpio_num_t data1; gpio_num_t data2; gpio_num_t data3; gpio_num_t reset; gpio_num_t te; };' : ''}${touch ? '\nstruct Ft3168TouchConfig { gpio_num_t reset; gpio_num_t interrupt; };' : ''}${audio ? '\nstruct Es8311AudioConfig { int i2sPort; gpio_num_t mclk; gpio_num_t bclk; gpio_num_t ws; gpio_num_t dout; gpio_num_t din; gpio_num_t powerAmplifier; };' : ''}

inline constexpr I2cBusConfig i2c{ .sda = ${gpio(i2c.sda)}, .scl = ${gpio(i2c.scl)} };
inline constexpr SdMmcConfig storage{ .clk = ${gpio(sdPins.clk)}, .cmd = ${gpio(sdPins.cmd)}, .data0 = ${gpio(sdPins.data0)} };
inline constexpr LauncherButtonConfig launcherButton{ .pin = ${gpio(launcher.pin)}, .activeLevel = ${launcher.activeLevel} };
${display ? `inline constexpr Co5300DisplayConfig display{
  .spiHost = ${display.spiHost === 'spi3' ? 'SPI3_HOST' : 'SPI2_HOST'}, .cs = ${gpio(displayPins.cs)}, .pclk = ${gpio(displayPins.pclk)},
  .data0 = ${gpio(displayPins.data0)}, .data1 = ${gpio(displayPins.data1)},
  .data2 = ${gpio(displayPins.data2)}, .data3 = ${gpio(displayPins.data3)},
  .reset = ${gpio(displayPins.reset)}, .te = ${gpio(displayPins.te)}
};` : ''}${touch ? `
inline constexpr Ft3168TouchConfig touch{ .reset = ${gpio(touchPins.reset)}, .interrupt = ${gpio(touchPins.interrupt)} };` : ''}${audio ? `
inline constexpr Es8311AudioConfig audio{
  .i2sPort = I2S_NUM_AUTO, .mclk = ${gpio(audioPins.mclk)}, .bclk = ${gpio(audioPins.bclk)},
  .ws = ${gpio(audioPins.ws)}, .dout = ${gpio(audioPins.dout)}, .din = ${gpio(audioPins.din)},
  .powerAmplifier = ${gpio(audioPins.powerAmplifier)}
};` : ''}

}  // namespace gea::platform::board
`
}

function cmakeQuote(value) {
  return `"${String(value).replace(/\\/g, '/').replace(/"/g, '\\"')}"`
}

export function renderTargetCmake(target, includeDir, appDefines = new Set()) {
  const { display, touch, power, imu, audio } = target.chips
  const chipSource = (source) => `    "\${GEA_CHIPS}/${source}"`
  const bindingSource = (source) => `    "\${GEA_EMBEDDED_ROOT}/targets/esp32/${source}"`
  const sourcesFor = (chip) => (chip ? [...chip.nativeSources.map(chipSource), ...chip.bindingSources.map(bindingSource)] : [])
  // No panel: the base swaps the QSPI display layer for the headless one, which
  // keeps the canvas but transmits nothing. The canvas still needs dimensions —
  // display.h's 410x502 default would silently reserve a panel-sized framebuffer.
  const displaySources = display
    ? sourcesFor(display)
    : ['    "${GEA_EMBEDDED_ROOT}/targets/esp32/display_headless.cpp"']
  // An absent peripheral still needs its symbols: the framework calls Power,
  // Accelerometer and Touchscreen unconditionally, so a board without the chip
  // gets a backend that answers honestly instead of one that fails to link.
  const absentBinding = (file) => [`    "\${GEA_EMBEDDED_ROOT}/targets/esp32/${file}"`]
  const peripheralSources = [
    ...(power ? sourcesFor(power) : absentBinding('power_absent.cpp')),
    ...(imu ? sourcesFor(imu) : absentBinding('imu_absent.cpp')),
    ...(touch ? sourcesFor(touch) : absentBinding('touch_absent.cpp')),
    ...sourcesFor(audio)
  ]
  const surface = display || target.canvas
  const hasSurface = Boolean(surface)
  // An app that declares a display size has said something more specific than
  // the board's default canvas, and the two arriving together on one command
  // line is a redefinition error rather than a disagreement anyone can see. The
  // app wins, exactly as it does for sdkconfig, so the board stays quiet about
  // what the app has already answered.
  const boardDefine = (name, value) => (appDefines.has(name) ? '' : `\n    ${name}=${value}`)
  const displayDefines = [
    // With no surface there is nothing to size, and display.h's own defaults
    // keep the geometry constants compiling for code that still mentions them.
    hasSurface ? boardDefine('GEA_EMBEDDED_DISPLAY_WIDTH', surface.width) : '',
    hasSurface ? boardDefine('GEA_EMBEDDED_DISPLAY_HEIGHT', surface.height) : '',
    display || !hasSurface ? '' : boardDefine('GEA_EMBEDDED_DISPLAY_HEADLESS', 1),
    hasSurface ? '' : boardDefine('GEA_EMBEDDED_NO_DISPLAY', 1),
    // An app may configure a chip the framework only abstracts -- a PMIC's
    // current limits, say -- and that code cannot compile, let alone link, on a
    // module that has no such chip. board.h says the same thing, but only board
    // sources include it; this reaches the app's own sources, which is where
    // the board-specific configuration actually lives.
    boardDefine('GEA_BOARD_HAS_POWER', power ? 1 : 0)
  ].join('')
  return `set(GEA_CUSTOM_TARGET_ACTIVE 1)
set(GEA_CUSTOM_TARGET_INCLUDE_DIR ${cmakeQuote(includeDir)})
set(GEA_CUSTOM_TARGET_HAS_DISPLAY ${display ? 1 : 0})
set(GEA_CUSTOM_TARGET_HAS_TOUCH ${touch ? 1 : 0})
set(GEA_CUSTOM_TARGET_HAS_MICROSD ${target.storage.microSD ? 1 : 0})
set(GEA_CUSTOM_TARGET_DISPLAY_SOURCES
${displaySources.join('\n')}
)
set(GEA_CUSTOM_TARGET_PERIPHERAL_SOURCES
${peripheralSources.join('\n')}
)
set(GEA_CUSTOM_TARGET_COMPILE_DEFINITIONS${displayDefines}
)
`
}

export function writeCustomTarget({ definitionPath, outDir, catalog, appDefines = new Set() }) {
  const target = normalizeCustomTarget(JSON.parse(readFileSync(definitionPath, 'utf8')), catalog)
  mkdirSync(outDir, { recursive: true })
  const headerPath = path.join(outDir, 'board.h')
  const cmakePath = path.join(outDir, 'target.cmake')
  writeIfChanged(headerPath, renderBoardHeader(target))
  writeIfChanged(cmakePath, renderTargetCmake(target, outDir, appDefines))
  let partitionCsv = ''
  if (target.partitions) {
    const { file, payloads } = writePartitionTable({
      table: target.partitions,
      appRoot: path.dirname(definitionPath),
      outDir: path.join(outDir, 'partitions'),
      source: `the board definition ${path.basename(definitionPath)}`
    })
    // A payload is an app's data being flashed into a partition. A board
    // describes where partitions are, not what an app puts in them.
    if (payloads.length > 0) throw new Error('A board definition\'s partitions cannot carry `data` payloads; declare those in the app manifest.')
    partitionCsv = file
  }
  return { target, headerPath, cmakePath, partitionCsv }
}

function writeIfChanged(file, contents) {
  if (existsSync(file) && readFileSync(file, 'utf8') === contents) return
  writeFileSync(file, contents)
}
