import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { knownBoards } from './board-catalog.mjs'
import { flag, option } from './args.mjs'
import { createChildEnv } from './context.mjs'
import { ExitCode, fail } from './errors.mjs'
import { exists, readJson, writeJson } from './fs-utils.mjs'
import { ask, choose, confirm, createPrompt } from './prompts.mjs'
import { runExternal } from './run.mjs'
import { detectSerialDevices, formatSerialDevice } from './serial-devices.mjs'
import { commandVersion } from './toolchain.mjs'

const espIdfVersion = 'v6.0.1'
const espIdfInstallTargets = 'esp32,esp32s3,esp32p4'

export async function runSetupWizard(ctx, parsed, io) {
  const stdout = io.stdout || console.log
  const prompt = createPrompt(io)
  try {
    renderHeader(io, 'GeaStack setup', [
      `Project: ${ctx.projectRoot}`,
      `Boards: ${boardConfigPath(ctx, parsed)}`
    ])
    if (option(parsed, 'esp-idf') === true) {
      renderStep(io, 'Toolchain', ['Checking ESP-IDF for ESP32 builds.'])
      await maybeSetupEspIdf(ctx, parsed, io, prompt, { force: true })
      return 0
    }
    const mode = await choose(prompt, {
      message: 'What do you want to set up?',
      choices: [
        {
          value: 'known',
          label: 'Known supported board',
          description: 'Fast path for Waveshare and other boards GeaStack already knows.'
        },
        {
          value: 'custom',
          label: 'Custom board profile',
          description: 'Guided hardware profile for your own MCU, display, touch, wireless, audio, sensors, and transport.'
        },
        {
          value: 'deps',
          label: 'Only install/check project npm dependencies',
          description: 'Runs npm install in the current app.'
        },
        {
          value: 'esp-idf',
          label: 'Only install/check ESP-IDF toolchain',
          description: `Installs or verifies ESP-IDF ${espIdfVersion}.`
        }
      ],
      defaultValue: 'known'
    })

    if (mode === 'deps') {
      renderStep(io, 'Dependencies', ['Installing project npm dependencies.'])
      await maybeInstallNpmDependencies(ctx, parsed, io, prompt, { force: true })
      return 0
    }

    if (mode === 'esp-idf') {
      renderStep(io, 'Toolchain', ['Checking ESP-IDF for ESP32 builds.'])
      await maybeSetupEspIdf(ctx, parsed, io, prompt, { force: true })
      return 0
    }

    const boardSetup = mode === 'custom'
      ? await setupCustomBoard(ctx, parsed, io, prompt)
      : await setupKnownBoard(ctx, parsed, io, prompt)
    if (boardSetup?.cancelled) {
      stdout('Setup cancelled. No board files were changed.')
      return 0
    }

    renderStep(io, 'Toolchain', ['Checking ESP-IDF before board initialization.'])
    await maybeSetupEspIdf(ctx, parsed, io, prompt)
    if (option(parsed, 'install') === true) {
      await maybeInstallNpmDependencies(ctx, parsed, io, prompt, { force: true })
    }
    await maybeInitializeBoardTarget(ctx, parsed, io, boardSetup)
    if (boardSetup?.flashReady) {
      stdout(`Ready: npx gea flash --board ${boardSetup.alias} --monitor`)
    } else {
      stdout('Profile saved. Add or select a target backend before flashing this board.')
    }
    return 0
  } finally {
    await prompt.close()
  }
}

async function setupKnownBoard(ctx, parsed, io, prompt) {
  renderStep(io, 'Board', ['Pick a board GeaStack can already flash.'])
  const boardId = await choose(prompt, {
    message: 'Which board do you have?',
    choices: knownBoards.map((board) => ({
      value: board.id,
      label: board.label,
      description: boardDescription(board)
    })),
    defaultValue: knownBoards[0].id
  })
  const board = knownBoards.find((candidate) => candidate.id === boardId)
  if (!board) fail(`Unknown board selection '${boardId}'.`, ExitCode.usage)

  renderStep(io, 'Identity', ['Give this physical board a short local alias.'])
  const alias = await ask(prompt, {
    message: 'Board alias',
    defaultValue: board.alias,
    validate: validateAlias
  })
  renderStep(io, 'Connection', ['Use a detected serial device, enter one manually, or skip it for now.'])
  const serial = await selectUsbSerial(prompt, io, {
    message: 'USB serial number (leave blank to pass --port manually)'
  })
  const otaHost = await ask(prompt, {
    message: 'OTA host/IP (optional)',
    defaultValue: ''
  })

  const configPath = boardConfigPath(ctx, parsed)
  const entry = {
    target: board.target,
    adapter: board.adapter,
    transports: compactObject({
      usbSerial: serial ? { serial } : undefined,
      ota: otaHost ? { host: otaHost } : undefined
    })
  }
  renderKnownBoardReview(io, { alias, board, configPath, entry })
  if (!await shouldSaveSetup(parsed, prompt, 'Save this board setup?')) {
    return { alias, cancelled: true }
  }
  const config = readBoardConfig(configPath)
  config[alias] = entry
  writeJsonEnsured(configPath, config)
  io.stdout(`Wrote board alias '${alias}' to ${configPath}`)
  io.stdout(`Target: ${board.target}`)
  return { alias, flashReady: true }
}

async function setupCustomBoard(ctx, parsed, io, prompt) {
  renderStep(io, 'Board', ['Name the profile and pick the closest target backend.'])
  const alias = await ask(prompt, {
    message: 'Custom board alias',
    defaultValue: 'custom-board',
    validate: validateAlias
  })
  const mcu = await choose(prompt, {
    message: 'MCU / SoC',
    choices: [
      { value: 'esp32-s3', label: 'ESP32-S3' },
      { value: 'esp32-p4', label: 'ESP32-P4' },
      { value: 'esp32-c6', label: 'ESP32-C6' },
      { value: 'esp32', label: 'ESP32' },
      { value: 'other', label: 'Other / not listed' }
    ],
    defaultValue: 'esp32-s3'
  })
  const mcuName = mcu === 'other' ? await ask(prompt, { message: 'MCU / SoC name', defaultValue: '' }) : mcu
  const baseTarget = await choose(prompt, {
    message: 'Closest existing target to start from',
    choices: [
      { value: '', label: 'None yet, generate profile only' },
      ...knownBoards.map((board) => ({ value: board.target, label: `${board.label} (${board.target})` }))
    ],
    defaultValue: ''
  })
  const depth = await choose(prompt, {
    message: 'How much hardware detail do you want to enter?',
    choices: [
      {
        value: 'full',
        label: 'Full hardware profile',
        description: 'Display, touch, wireless, GPS, audio, storage, sensors, power, and transport.'
      },
      {
        value: 'quick',
        label: 'Fast profile',
        description: 'Core board, display/touch, transport, and sensible defaults for everything else.'
      }
    ],
    defaultValue: 'full'
  })

  renderStep(io, 'Display and touch', ['Describe what the user can see and touch on the board.'])
  const displayKind = await choose(prompt, {
    message: 'Display type',
    choices: [
      { value: 'amoled', label: 'AMOLED' },
      { value: 'tft-lcd', label: 'TFT LCD' },
      { value: 'epaper', label: 'E-paper' },
      { value: 'monochrome-oled', label: 'Monochrome OLED' },
      { value: 'none', label: 'No display' },
      { value: 'other', label: 'Other' }
    ],
    defaultValue: 'tft-lcd'
  })
  const displayController = displayKind === 'none' ? '' : await ask(prompt, { message: 'Display controller/chip', defaultValue: '' })
  const displayInterface = displayKind === 'none' ? '' : await choose(prompt, {
    message: 'Display interface',
    choices: [
      { value: 'spi', label: 'SPI' },
      { value: 'qspi', label: 'QSPI' },
      { value: 'rgb', label: 'RGB parallel' },
      { value: 'i8080', label: '8080 parallel' },
      { value: 'mipi-dsi', label: 'MIPI DSI' },
      { value: 'i2c', label: 'I2C' },
      { value: 'other', label: 'Other' }
    ],
    defaultValue: 'spi'
  })
  const resolution = displayKind === 'none' ? '' : await ask(prompt, { message: 'Display resolution, for example 480x480', defaultValue: '' })
  const touchController = await ask(prompt, { message: 'Touch controller/chip (blank for none)', defaultValue: '' })
  const touchInterface = touchController ? await choose(prompt, {
    message: 'Touch interface',
    choices: [
      { value: 'i2c', label: 'I2C' },
      { value: 'spi', label: 'SPI' },
      { value: 'gpio', label: 'GPIO buttons/interrupts' },
      { value: 'other', label: 'Other' }
    ],
    defaultValue: 'i2c'
  }) : ''

  const defaults = defaultCustomPeripherals(mcuName)
  let wifi = defaults.wifi
  let ble = defaults.ble
  let gpsModule = ''
  let gpsInterface = ''
  let audioCodec = ''
  let audioOutput = ''
  let audioInput = ''
  let storage = defaults.storage
  let sensors = ''
  let power = 'USB'

  if (depth === 'full') {
    renderStep(io, 'Peripherals', ['Add wireless, location, audio, storage, sensors, and power details.'])
    wifi = await choose(prompt, {
      message: 'WiFi',
      choices: [
        { value: 'built-in', label: 'Built into MCU/module' },
        { value: 'external', label: 'External WiFi chip/module' },
        { value: 'none', label: 'None' }
      ],
      defaultValue: defaults.wifi
    })
    ble = await choose(prompt, {
      message: 'BLE',
      choices: [
        { value: 'built-in', label: 'Built into MCU/module' },
        { value: 'external', label: 'External BLE chip/module' },
        { value: 'none', label: 'None' }
      ],
      defaultValue: defaults.ble
    })
    gpsModule = await ask(prompt, { message: 'GPS module/chip (blank for none)', defaultValue: '' })
    gpsInterface = gpsModule ? await choose(prompt, {
      message: 'GPS interface',
      choices: [
        { value: 'uart', label: 'UART' },
        { value: 'i2c', label: 'I2C' },
        { value: 'spi', label: 'SPI' },
        { value: 'other', label: 'Other' }
      ],
      defaultValue: 'uart'
    }) : ''
    audioCodec = await ask(prompt, { message: 'Audio codec/chip (blank for none)', defaultValue: '' })
    audioOutput = audioCodec ? await choose(prompt, {
      message: 'Audio output',
      choices: [
        { value: 'i2s-speaker', label: 'I2S speaker/output' },
        { value: 'dac', label: 'DAC output' },
        { value: 'pwm', label: 'PWM/buzzer' },
        { value: 'other', label: 'Other' }
      ],
      defaultValue: 'i2s-speaker'
    }) : ''
    audioInput = audioCodec ? await choose(prompt, {
      message: 'Audio input',
      choices: [
        { value: 'none', label: 'None' },
        { value: 'i2s-mic', label: 'I2S microphone' },
        { value: 'pdm-mic', label: 'PDM microphone' },
        { value: 'analog-mic', label: 'Analog microphone' },
        { value: 'other', label: 'Other' }
      ],
      defaultValue: 'none'
    }) : ''
    storage = await ask(prompt, { message: 'Storage chips/features, comma-separated', defaultValue: defaults.storage })
    sensors = await ask(prompt, { message: 'Sensors, comma-separated (IMU, light, temp, etc.)', defaultValue: '' })
    power = await ask(prompt, { message: 'Power path (USB, battery charger, PMIC, etc.)', defaultValue: 'USB' })
  } else {
    renderStep(io, 'Peripherals', [
      `Using defaults: WiFi ${wifi}, BLE ${ble}, storage ${storage}, power USB.`,
      `You can edit .gea/boards/${alias}.json later if the board has GPS, audio, or sensors.`
    ])
  }

  renderStep(io, 'Connection', ['Choose how GeaStack should flash and monitor the board.'])
  const transport = await choose(prompt, {
    message: 'Primary flash/monitor transport',
    choices: [
      { value: 'usbSerial', label: 'USB serial' },
      { value: 'ota', label: 'WiFi OTA' },
      { value: 'both', label: 'USB serial + OTA' },
      { value: 'custom', label: 'Custom' }
    ],
    defaultValue: 'usbSerial'
  })
  const usbSerial = transport === 'usbSerial' || transport === 'both'
    ? await selectUsbSerial(prompt, io, { message: 'USB serial number (optional)' })
    : ''
  const otaHost = transport === 'ota' || transport === 'both'
    ? await ask(prompt, { message: 'OTA host/IP (optional)', defaultValue: '' })
    : ''
  const notes = await ask(prompt, { message: 'Notes / links to schematic, display datasheet, etc. (optional)', defaultValue: '' })

  const profile = compactObject({
    alias,
    kind: 'custom-board-profile',
    targetFamily: 'esp32',
    adapter: 'esp32-idf',
    baseTarget,
    mcu: mcuName,
    display: compactObject({
      kind: displayKind,
      controller: displayController,
      interface: displayInterface,
      resolution
    }),
    touch: compactObject({
      controller: touchController,
      interface: touchInterface
    }),
    wireless: compactObject({ wifi, ble }),
    gps: compactObject({ module: gpsModule, interface: gpsInterface }),
    audio: compactObject({ codec: audioCodec, output: audioOutput, input: audioInput }),
    storage: csv(storage),
    sensors: csv(sensors),
    power,
    transports: compactObject({
      usbSerial: usbSerial ? { serial: usbSerial } : undefined,
      ota: otaHost ? { host: otaHost } : undefined
    }),
    notes
  })

  const profilePath = path.join(ctx.cwd, '.gea', 'boards', `${alias}.json`)
  const configPath = boardConfigPath(ctx, parsed)
  renderCustomBoardReview(io, { alias, profile, profilePath, configPath, flashReady: Boolean(baseTarget) })
  if (!await shouldSaveSetup(parsed, prompt, 'Save this custom board profile?')) {
    return { alias, cancelled: true }
  }
  writeJsonEnsured(profilePath, profile)
  io.stdout(`Wrote custom board profile to ${profilePath}`)

  if (baseTarget) {
    const config = readBoardConfig(configPath)
    config[alias] = compactObject({
      target: baseTarget,
      adapter: 'esp32-idf',
      customProfile: profilePath,
      transports: profile.transports
    })
    writeJsonEnsured(configPath, config)
    io.stdout(`Wrote experimental board alias '${alias}' to ${configPath}`)
    return { alias, flashReady: true }
  } else {
    io.stdout('No board alias was added because no base target was selected.')
    io.stdout('Add a target backend before flashing this custom profile.')
    return { alias, flashReady: false }
  }
}

function renderHeader(io, title, lines = []) {
  io.stdout('')
  io.stdout(title)
  io.stdout('-'.repeat(title.length))
  for (const line of lines.filter(Boolean)) io.stdout(line)
}

function renderStep(io, title, lines = []) {
  io.stdout('')
  io.stdout(`[ ${title} ]`)
  for (const line of lines.filter(Boolean)) io.stdout(line)
}

function renderKnownBoardReview(io, { alias, board, configPath, entry }) {
  renderStep(io, 'Review', [
    'This is what GeaStack will save.'
  ])
  writeRows(io, [
    ['Alias', alias],
    ['Board', board.label],
    ['Target', entry.target],
    ['Adapter', entry.adapter],
    ['USB serial', entry.transports?.usbSerial?.serial || 'manual / not set'],
    ['OTA host', entry.transports?.ota?.host || 'not set'],
    ['Config', configPath]
  ])
}

function renderCustomBoardReview(io, { alias, profile, profilePath, configPath, flashReady }) {
  renderStep(io, 'Review', [
    'This is what GeaStack will save.'
  ])
  writeRows(io, [
    ['Alias', alias],
    ['MCU / SoC', profile.mcu],
    ['Base target', profile.baseTarget || 'none yet'],
    ['Display', describeObject(profile.display)],
    ['Touch', describeObject(profile.touch)],
    ['Wireless', describeObject(profile.wireless)],
    ['GPS', describeObject(profile.gps)],
    ['Audio', describeObject(profile.audio)],
    ['Storage', list(profile.storage)],
    ['Sensors', list(profile.sensors)],
    ['Power', profile.power || 'not set'],
    ['Transport', describeObject(profile.transports)],
    ['Profile', profilePath],
    ['Board config', flashReady ? configPath : 'not written until a base target is selected']
  ])
}

async function shouldSaveSetup(parsed, prompt, message) {
  if (flag(parsed, 'yes')) return true
  return confirm(prompt, { message, defaultValue: true })
}

function writeRows(io, rows) {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0)
  for (const [label, value] of rows) {
    io.stdout(`${label.padEnd(width)} : ${value || 'not set'}`)
  }
}

function boardDescription(board) {
  const parts = [
    board.mcu,
    board.capabilities?.display,
    board.capabilities?.wireless?.length ? board.capabilities.wireless.join('/') : '',
    board.target
  ].filter(Boolean)
  return parts.join(' - ')
}

function describeObject(value) {
  if (!value || typeof value !== 'object') return 'not set'
  const entries = Object.entries(value)
    .flatMap(([key, entry]) => {
      if (entry === undefined || entry === null || entry === '') return []
      if (Array.isArray(entry)) return entry.length ? [`${key}: ${entry.join(', ')}`] : []
      if (typeof entry === 'object') return Object.keys(entry).length ? [`${key}: ${describeObject(entry)}`] : []
      return [`${key}: ${entry}`]
    })
  return entries.length ? entries.join('; ') : 'not set'
}

function defaultCustomPeripherals(mcuName) {
  const normalized = String(mcuName || '').toLowerCase()
  const espWithWireless = ['esp32', 'esp32-s3', 'esp32-c3', 'esp32-c6', 'esp32-h2'].includes(normalized)
  const hasPsramByDefault = ['esp32-s3', 'esp32-p4'].includes(normalized)
  return {
    wifi: espWithWireless && normalized !== 'esp32-h2' ? 'built-in' : 'none',
    ble: espWithWireless ? 'built-in' : 'none',
    storage: hasPsramByDefault ? 'flash, psram' : 'flash'
  }
}

async function maybeInstallNpmDependencies(ctx, parsed, io, prompt, { force = false } = {}) {
  const install = force || option(parsed, 'install') === true || await confirm(prompt, {
    message: 'Install npm dependencies now if package.json exists?',
    defaultValue: true
  })
  if (!install) return
  if (!exists(path.join(ctx.cwd, 'package.json'))) {
    io.stdout(`No package.json in ${ctx.cwd}; skipping npm install.`)
    return
  }
  runExternal('npm', ['install'], {
    cwd: ctx.cwd,
    env: io.env || process.env,
    dryRun: option(parsed, 'dry-run') === true,
    stdout: io.stdout
  })
}

async function maybeInitializeBoardTarget(ctx, parsed, io, boardSetup) {
  if (!boardSetup?.alias || !boardSetup.flashReady) return 0
  if (option(parsed, 'initialize') === false) {
    io.stdout(`Board initialization skipped. Later: npx gea setup --board ${boardSetup.alias}`)
    return 0
  }
  if (!exists(ctx.scripts.board)) {
    io.stdout(`Board backend not found. Later: npx gea setup --board ${boardSetup.alias}`)
    return 0
  }
  io.stdout(`Initializing board target '${boardSetup.alias}'...`)
  return runExternal(ctx.scripts.board, ['setup', `--board=${boardSetup.alias}`], {
    cwd: ctx.targetsRoot,
    env: createChildEnv(ctx, io.env || process.env),
    dryRun: flag(parsed, 'dry-run'),
    failureCode: ExitCode.buildFailed,
    stdout: io.stdout
  })
}

async function maybeSetupEspIdf(ctx, parsed, io, prompt, { force = false } = {}) {
  const env = io.env || process.env
  const status = detectEspIdf(env)
  if (status.available) {
    if (force) io.stdout(`ESP-IDF found: ${status.detail}`)
    return 0
  }

  const install = force || await confirm(prompt, {
    message: `ESP-IDF ${espIdfVersion} was not found. Install it now?`,
    defaultValue: false
  })
  if (!install) {
    io.stdout(`ESP-IDF install later: npx gea setup --esp-idf`)
    return 0
  }

  const idfDir = option(parsed, 'idf-dir') || env.GEA_ESP_IDF_DIR || path.join(os.homedir(), 'esp', 'esp-idf')
  const dryRun = flag(parsed, 'dry-run')
  if (!dryRun) fs.mkdirSync(path.dirname(idfDir), { recursive: true })
  if (!exists(path.join(idfDir, 'install.sh')) && !exists(path.join(idfDir, 'install.bat'))) {
    runExternal('git', ['clone', '-b', espIdfVersion, '--recursive', 'https://github.com/espressif/esp-idf.git', idfDir], {
      cwd: ctx.cwd,
      env,
      dryRun,
      failureCode: ExitCode.missingDependency,
      stdout: io.stdout
    })
  }

  const installScript = process.platform === 'win32' ? path.join(idfDir, 'install.bat') : path.join(idfDir, 'install.sh')
  runExternal(installScript, [espIdfInstallTargets], {
    cwd: idfDir,
    env,
    dryRun,
    failureCode: ExitCode.missingDependency,
    stdout: io.stdout
  })

  const exportScript = process.platform === 'win32' ? path.join(idfDir, 'export.bat') : path.join(idfDir, 'export.sh')
  io.stdout(`ESP-IDF installed at ${idfDir}`)
  io.stdout(process.platform === 'win32' ? `For future shells: ${exportScript}` : `For future shells: . "${exportScript}"`)
  return 0
}

function detectEspIdf(env) {
  const idfVersion = commandVersion('idf.py', ['--version'], env)
  if (idfVersion) return { available: true, detail: idfVersion }
  if (env.IDF_PATH) return { available: true, detail: env.IDF_PATH }
  return { available: false, detail: '' }
}

async function selectUsbSerial(prompt, io, { message }) {
  const devices = detectSerialDevices({ env: io.env || process.env })
  if (devices.length === 0) {
    return ask(prompt, {
      message,
      defaultValue: ''
    })
  }

  const selected = await choose(prompt, {
    message: 'Detected serial devices. Which board is connected?',
    choices: [
      ...devices.map((device, index) => ({ value: `device-${index}`, label: formatSerialDevice(device) })),
      { value: 'manual', label: 'Enter stable USB serial manually' },
      { value: 'skip', label: 'Skip for now' }
    ],
    defaultValue: 'device-0'
  })
  if (selected === 'skip') return ''
  if (selected === 'manual') return ask(prompt, { message, defaultValue: '' })
  const index = Number.parseInt(selected.slice('device-'.length), 10)
  const device = devices[index]
  return ask(prompt, {
    message: `Stable USB serial for ${device.path}`,
    defaultValue: device.serial || ''
  })
}

function boardConfigPath(ctx, parsed) {
  const explicit = option(parsed, 'boards-config') || ctx.boardsConfig
  if (explicit) return path.resolve(ctx.cwd, explicit)
  return ctx.projectBoardsConfig || path.join(ctx.cwd, '.gea', 'boards.json')
}

function readBoardConfig(filePath) {
  if (!exists(filePath)) return {}
  return readJson(filePath)
}

function writeJsonEnsured(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  writeJson(filePath, value)
}

function validateAlias(value) {
  if (!value) return 'alias is required'
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) return 'use letters, numbers, dot, dash, or underscore'
  return ''
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => {
    if (entry === undefined || entry === null || entry === '') return false
    if (Array.isArray(entry)) return entry.length > 0
    if (typeof entry === 'object') return Object.keys(entry).length > 0
    return true
  }))
}

function csv(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function list(value) {
  return Array.isArray(value) && value.length ? value.join(', ') : 'not set'
}
