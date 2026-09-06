import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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

export function normalizeCustomTarget(raw, catalog) {
  const definition = object(raw, 'Target definition')
  const id = text(definition.id, 'id')
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error('id may contain lowercase letters, digits, dots, underscores, and hyphens.')
  const base = exact(definition.extends, supportedBase, 'extends')
  const mcu = exact(definition.mcu, 'esp32s3', 'mcu')
  const adapter = definition.adapter ? exact(definition.adapter, 'esp32-idf', 'adapter') : 'esp32-idf'
  const chips = object(definition.chips, 'chips')
  const display = object(selectedChip(chips, 'display', 'display', adapter, mcu, catalog), 'chips.display')
  const touch = object(selectedChip(chips, 'touch', 'touch', adapter, mcu, catalog), 'chips.touch')
  const power = object(selectedChip(chips, 'power', 'power', adapter, mcu, catalog), 'chips.power')
  const imu = object(selectedChip(chips, 'imu', 'imu', adapter, mcu, catalog), 'chips.imu')
  const audio = object(selectedChip(chips, 'audio', 'audio', adapter, mcu, catalog), 'chips.audio')
  const buses = object(definition.buses, 'buses')
  const i2c = object(buses.i2c, 'buses.i2c')
  const storage = object(definition.storage, 'storage')
  const microSD = object(storage.microSD, 'storage.microSD')
  const controls = object(definition.controls, 'controls')
  const launcherButton = object(controls.launcherButton, 'controls.launcherButton')

  const displayPins = object(display.pins, 'chips.display.pins')
  const touchPins = object(touch.pins, 'chips.touch.pins')
  const audioPins = object(audio.pins, 'chips.audio.pins')
  const storagePins = object(microSD.pins, 'storage.microSD.pins')

  const spiHost = String(display.spiHost).toLowerCase()
  if (!['spi2', 'spi3'].includes(spiHost)) throw new Error("chips.display.spiHost must be 'spi2' or 'spi3'.")

  const target = {
    id,
    extends: base,
    adapter,
    mcu,
    buses: {
      i2c: {
        sda: pin(i2c.sda, 'buses.i2c.sda'),
        scl: pin(i2c.scl, 'buses.i2c.scl')
      }
    },
    chips: {
      display: {
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
      touch: {
        driver: touch.driver,
        interface: exact(touch.interface, 'i2c', 'chips.touch.interface'),
        nativeSources: touch.nativeSources,
        bindingSources: touch.bindingSources,
        pins: {
          reset: pin(touchPins.reset, 'chips.touch.pins.reset'),
          interrupt: pin(touchPins.interrupt, 'chips.touch.pins.interrupt')
        }
      },
      power: {
        driver: power.driver,
        interface: exact(power.interface, 'i2c', 'chips.power.interface'),
        nativeSources: power.nativeSources,
        bindingSources: power.bindingSources
      },
      imu: {
        driver: imu.driver,
        interface: exact(imu.interface, 'i2c', 'chips.imu.interface'),
        nativeSources: imu.nativeSources,
        bindingSources: imu.bindingSources
      },
      audio: {
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
      microSD: {
        interface: exact(microSD.interface, 'sdmmc-1bit', 'storage.microSD.interface'),
        pins: {
          clk: pin(storagePins.clk, 'storage.microSD.pins.clk', { optional: true }),
          cmd: pin(storagePins.cmd, 'storage.microSD.pins.cmd', { optional: true }),
          data0: pin(storagePins.data0, 'storage.microSD.pins.data0', { optional: true })
        }
      }
    },
    controls: {
      launcherButton: {
        pin: pin(launcherButton.pin, 'controls.launcherButton.pin', { optional: true }),
        activeLevel: integer(launcherButton.activeLevel, 'controls.launcherButton.activeLevel', { min: 0, max: 1 })
      }
    }
  }
  validatePinAssignments(target)
  return target
}

function validatePinAssignments(target) {
  const pins = [
    ['I2C SDA', target.buses.i2c.sda],
    ['I2C SCL', target.buses.i2c.scl],
    ['display CS', target.chips.display.pins.cs],
    ['display PCLK', target.chips.display.pins.pclk],
    ['display DATA0', target.chips.display.pins.data0],
    ['display DATA1', target.chips.display.pins.data1],
    ['display DATA2', target.chips.display.pins.data2],
    ['display DATA3', target.chips.display.pins.data3],
    ['display reset', target.chips.display.pins.reset],
    ['display TE', target.chips.display.pins.te],
    ['touch reset', target.chips.touch.pins.reset],
    ['touch interrupt', target.chips.touch.pins.interrupt],
    ['audio MCLK', target.chips.audio.pins.mclk],
    ['audio BCLK', target.chips.audio.pins.bclk],
    ['audio WS', target.chips.audio.pins.ws],
    ['audio DOUT', target.chips.audio.pins.dout],
    ['audio DIN', target.chips.audio.pins.din],
    ['audio amplifier', target.chips.audio.pins.powerAmplifier],
    ['microSD CLK', target.storage.microSD.pins.clk],
    ['microSD CMD', target.storage.microSD.pins.cmd],
    ['microSD DATA0', target.storage.microSD.pins.data0],
    ['launcher button', target.controls.launcherButton.pin]
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

export function renderBoardHeader(target) {
  const { i2c } = target.buses
  const { display, touch, audio } = target.chips
  const sd = target.storage.microSD
  const launcher = target.controls.launcherButton
  return `#pragma once

#include "driver/gpio.h"
#include "driver/i2s_types.h"
#include "driver/spi_master.h"

namespace gea::platform::board {

struct I2cBusConfig { gpio_num_t sda; gpio_num_t scl; };
struct Co5300DisplayConfig { spi_host_device_t spiHost; gpio_num_t cs; gpio_num_t pclk; gpio_num_t data0; gpio_num_t data1; gpio_num_t data2; gpio_num_t data3; gpio_num_t reset; gpio_num_t te; };
struct Ft3168TouchConfig { gpio_num_t reset; gpio_num_t interrupt; };
struct Es8311AudioConfig { int i2sPort; gpio_num_t mclk; gpio_num_t bclk; gpio_num_t ws; gpio_num_t dout; gpio_num_t din; gpio_num_t powerAmplifier; };
struct SdMmcConfig { gpio_num_t clk; gpio_num_t cmd; gpio_num_t data0; };
struct LauncherButtonConfig { gpio_num_t pin; int activeLevel; };

inline constexpr I2cBusConfig i2c{ .sda = ${gpio(i2c.sda)}, .scl = ${gpio(i2c.scl)} };
inline constexpr Co5300DisplayConfig display{
  .spiHost = ${display.spiHost === 'spi3' ? 'SPI3_HOST' : 'SPI2_HOST'}, .cs = ${gpio(display.pins.cs)}, .pclk = ${gpio(display.pins.pclk)},
  .data0 = ${gpio(display.pins.data0)}, .data1 = ${gpio(display.pins.data1)},
  .data2 = ${gpio(display.pins.data2)}, .data3 = ${gpio(display.pins.data3)},
  .reset = ${gpio(display.pins.reset)}, .te = ${gpio(display.pins.te)}
};
inline constexpr Ft3168TouchConfig touch{ .reset = ${gpio(touch.pins.reset)}, .interrupt = ${gpio(touch.pins.interrupt)} };
inline constexpr Es8311AudioConfig audio{
  .i2sPort = I2S_NUM_AUTO, .mclk = ${gpio(audio.pins.mclk)}, .bclk = ${gpio(audio.pins.bclk)},
  .ws = ${gpio(audio.pins.ws)}, .dout = ${gpio(audio.pins.dout)}, .din = ${gpio(audio.pins.din)},
  .powerAmplifier = ${gpio(audio.pins.powerAmplifier)}
};
inline constexpr SdMmcConfig storage{ .clk = ${gpio(sd.pins.clk)}, .cmd = ${gpio(sd.pins.cmd)}, .data0 = ${gpio(sd.pins.data0)} };
inline constexpr LauncherButtonConfig launcherButton{ .pin = ${gpio(launcher.pin)}, .activeLevel = ${launcher.activeLevel} };

}  // namespace gea::platform::board
`
}

function cmakeQuote(value) {
  return `"${String(value).replace(/\\/g, '/').replace(/"/g, '\\"')}"`
}

export function renderTargetCmake(target, includeDir) {
  const { display, touch, power, imu, audio } = target.chips
  const chipSource = (source) => `    "\${GEA_CHIPS}/${source}"`
  const bindingSource = (source) => `    "\${GEA_EMBEDDED_ROOT}/targets/esp32/${source}"`
  const displaySources = [...display.nativeSources.map(chipSource), ...display.bindingSources.map(bindingSource)]
  const peripheralSources = [power, imu, touch, audio]
    .flatMap((chip) => [...chip.nativeSources.map(chipSource), ...chip.bindingSources.map(bindingSource)])
  return `set(GEA_CUSTOM_TARGET_ACTIVE 1)
set(GEA_CUSTOM_TARGET_INCLUDE_DIR ${cmakeQuote(includeDir)})
set(GEA_CUSTOM_TARGET_DISPLAY_SOURCES
${displaySources.join('\n')}
)
set(GEA_CUSTOM_TARGET_PERIPHERAL_SOURCES
${peripheralSources.join('\n')}
)
set(GEA_CUSTOM_TARGET_COMPILE_DEFINITIONS
    GEA_EMBEDDED_DISPLAY_WIDTH=${display.width}
    GEA_EMBEDDED_DISPLAY_HEIGHT=${display.height}
)
`
}

export function writeCustomTarget({ definitionPath, outDir, catalog }) {
  const target = normalizeCustomTarget(JSON.parse(readFileSync(definitionPath, 'utf8')), catalog)
  mkdirSync(outDir, { recursive: true })
  const headerPath = path.join(outDir, 'board.h')
  const cmakePath = path.join(outDir, 'target.cmake')
  writeIfChanged(headerPath, renderBoardHeader(target))
  writeIfChanged(cmakePath, renderTargetCmake(target, outDir))
  return { target, headerPath, cmakePath }
}

function writeIfChanged(file, contents) {
  if (existsSync(file) && readFileSync(file, 'utf8') === contents) return
  writeFileSync(file, contents)
}
