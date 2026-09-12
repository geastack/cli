import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { knownBoards } from './board-catalog.mjs'
import { boardConfigWritePath, loadBoardConfig } from './boards/config.mjs'
import { discoverBoards, probeSerialDevice } from './commands/boards.mjs'
import { discoverApps, findCurrentApp, resolveRequestedApp, targetEnabledForApp } from './manifest.mjs'
import { configureChipSelection, loadChipCatalog, validateGpioAssignments } from './chips.mjs'
import { flag, option } from './args.mjs'
import { ExitCode, fail } from './errors.mjs'
import { espIdfVersion as readInstalledEspIdfVersion, findEspIdf } from './esp32/idf-env.mjs'
import { extractIdfVersionFromText, fetchLatestEspIdfVersion, idfVersionMeetsTarget, resolveEspIdfVersion } from './esp32/idf-version.mjs'
import { exists, readJson, writeJson } from './fs-utils.mjs'
import { ask, choose, confirm, createPrompt } from './prompts.mjs'
import { runExternal } from './run.mjs'
import { detectSerialDevices } from './serial-devices.mjs'
import { commandVersion } from './toolchain.mjs'

const espIdfInstallTargets = 'esp32,esp32s3,esp32p4'

export async function runSetupWizard(ctx, parsed, io) {
  const stdout = io.stdout || console.log
  const prompt = createPrompt(io)
  try {
    const targetIdfVersion = await resolveEspIdfVersionForWizard(parsed, io)
    renderHeader(io, 'GeaStack setup', [
      `Project: ${ctx.projectRoot}`,
      `Boards: ${boardConfigPath(ctx, parsed)}`
    ])
    if (option(parsed, 'esp-idf') === true) {
      renderStep(io, 'Toolchain', ['Checking ESP-IDF for ESP32 builds.'])
      await maybeSetupEspIdf(ctx, parsed, io, prompt, { force: true, targetVersion: targetIdfVersion })
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
          description: `Installs or verifies ESP-IDF ${targetIdfVersion}.`
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
      await maybeSetupEspIdf(ctx, parsed, io, prompt, { force: true, targetVersion: targetIdfVersion })
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
    await maybeSetupEspIdf(ctx, parsed, io, prompt, { targetVersion: targetIdfVersion })
    if (option(parsed, 'install') === true) {
      await maybeInstallNpmDependencies(ctx, parsed, io, prompt, { force: true })
    }
    await maybeInitializeBoardTarget(ctx, parsed, io, prompt, boardSetup)
    if (boardSetup?.flashReady) {
      const appFlag = boardSetup.app && boardSetup.app.root !== findCurrentApp(ctx.cwd)?.root ? ` --app ${boardSetup.app.id}` : ''
      stdout(`Ready: npx gea flash --board ${boardSetup.alias}${appFlag} --monitor`)
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
  const serial = await selectUsbSerial(prompt, io, ctx, {
    message: 'The USB serial identifies this board whatever port it lands on.'
  })
  const otaHost = await ask(prompt, {
    message: 'OTA host/IP (optional)',
    defaultValue: '',
    validate: validateOtaHost
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
  renderStep(io, 'Board', ['Create an app-local hardware target from the installed chip catalog.'])
  const alias = await ask(prompt, {
    message: 'Custom board alias',
    defaultValue: 'custom-board',
    validate: validateAlias
  })
  const mcu = await choose(prompt, {
    message: 'MCU / SoC',
    choices: [
      {
        value: 'esp32s3',
        label: 'ESP32-S3',
        description: 'Composable ESP-IDF target with display, touch, power, IMU, audio, WiFi, BLE, and OTA support.'
      }
    ],
    defaultValue: 'esp32s3'
  })

  const definition = {
    id: alias,
    extends: 'esp32-s3',
    adapter: 'esp32-idf',
    mcu,
    buses: {},
    chips: {},
    storage: {
      microSD: {
        interface: 'sdmmc-1bit',
        pins: { clk: null, cmd: null, data0: null }
      }
    },
    controls: {
      launcherButton: { pin: null, activeLevel: 0 }
    }
  }

  const catalog = loadChipCatalog(ctx)
  const roles = [
    ['display', 'Display controller'],
    ['touch', 'Touch controller'],
    ['power', 'Power-management controller'],
    ['imu', 'Inertial measurement unit'],
    ['audio', 'Audio codec']
  ]
  renderStep(io, 'Chips', ['Choose each controller from @geastack/chips. Pin questions come from the installed catalog.'])
  for (const [role, label] of roles) {
    const compatible = Object.entries(catalog)
      .filter(([, chip]) => chip.category === role && chip.adapters?.['esp32-idf']?.mcus?.includes(mcu))
    const selected = await choose(prompt, {
      message: label,
      choices: [
        ...compatible.map(([id, chip]) => ({ value: id, label: `${id} — ${chip.label}` })),
        { value: '', label: 'None / configure later' }
      ],
      defaultValue: compatible[0]?.[0] || ''
    })
    if (!selected) continue
    await configureChipSelection({
      definition,
      id: selected,
      descriptor: catalog[selected],
      prompt,
      io,
      replace: true,
      boardName: alias
    })
  }

  renderStep(io, 'Board features', ['Configure physical features that are not separate chip drivers.'])
  if (await confirm(prompt, { message: 'Does this board expose a microSD slot?', defaultValue: false })) {
    definition.storage.microSD.pins.clk = await askPin(prompt, 'microSD clock pin')
    definition.storage.microSD.pins.cmd = await askPin(prompt, 'microSD command pin')
    definition.storage.microSD.pins.data0 = await askPin(prompt, 'microSD data 0 pin')
  }
  if (await confirm(prompt, { message: 'Use a hardware button to return to the launcher?', defaultValue: false })) {
    definition.controls.launcherButton.pin = await askPin(prompt, 'Launcher button pin')
    definition.controls.launcherButton.activeLevel = Number(await choose(prompt, {
      message: 'Launcher button active level',
      choices: [
        { value: '0', label: 'Active low' },
        { value: '1', label: 'Active high' }
      ],
      defaultValue: '0'
    }))
  }

  renderStep(io, 'Connection', ['The first flash uses USB. BLE OTA can take over after the initial firmware is running.'])
  const usbSerial = await selectUsbSerial(prompt, io, ctx, {
    message: 'The USB serial identifies this board whatever port it lands on.'
  })

  const configPath = boardConfigPath(ctx, parsed)
  const definitionPath = path.join(path.dirname(configPath), 'targets', `${alias}.json`)
  const relativeDefinition = path.relative(path.dirname(configPath), definitionPath)
  const entry = compactObject({
    target: alias,
    targetDefinition: relativeDefinition,
    adapter: 'esp32-idf',
    appPlatform: 'esp32',
    transports: compactObject({
      usbSerial: usbSerial ? { serial: usbSerial } : undefined
    })
  })
  const requiredRoles = roles.map(([role]) => role)
  const missingRoles = requiredRoles.filter((role) => !definition.chips[role])
  validateGpioAssignments(definition)
  renderCustomBoardReview(io, { alias, definition, definitionPath, configPath, entry, missingRoles })
  if (!await shouldSaveSetup(parsed, prompt, 'Save this custom board target?')) {
    return { alias, cancelled: true }
  }

  writeJsonEnsured(definitionPath, definition)
  const config = readBoardConfig(configPath)
  config[alias] = entry
  writeJsonEnsured(configPath, config)
  io.stdout(`Wrote custom target to ${definitionPath}`)
  io.stdout(`Wrote board alias '${alias}' to ${configPath}`)
  if (missingRoles.length) {
    io.stdout(`Add the remaining roles with: npx gea chips add <chip> --board ${alias}`)
  }
  return { alias, flashReady: missingRoles.length === 0 }
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

function renderCustomBoardReview(io, { alias, definition, definitionPath, configPath, entry, missingRoles }) {
  renderStep(io, 'Review', [
    'This is what GeaStack will save.'
  ])
  writeRows(io, [
    ['Alias', alias],
    ['MCU / SoC', definition.mcu],
    ['Platform base', definition.extends],
    ['Display', describeObject(definition.chips.display)],
    ['Touch', describeObject(definition.chips.touch)],
    ['Power', describeObject(definition.chips.power)],
    ['IMU', describeObject(definition.chips.imu)],
    ['Audio', describeObject(definition.chips.audio)],
    ['I2C', describeObject(definition.buses.i2c)],
    ['USB serial', entry.transports?.usbSerial?.serial || 'auto / pass --port'],
    ['Missing roles', missingRoles.join(', ') || 'none'],
    ['Target definition', definitionPath],
    ['Board config', configPath]
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

// A board target is configured for one app (the firmware is built per app,
// and its CMake refuses to run without one), so initialization needs an
// app: the current one when the wizard runs inside an app, else the only
// app in the project that targets this board, else the user's pick.
async function maybeInitializeBoardTarget(ctx, parsed, io, prompt, boardSetup) {
  if (!boardSetup?.alias || !boardSetup.flashReady) return 0
  if (option(parsed, 'initialize') === false) {
    io.stdout(`Board initialization skipped. Later: npx gea setup --board ${boardSetup.alias} --app <id>`)
    return 0
  }
  if (!ctx.targetsRoot) {
    io.stdout(`@geastack/targets is not installed. Later: npx gea setup --board ${boardSetup.alias} --app <id>`)
    return 0
  }
  const app = await chooseAppForBoard(ctx, parsed, io, prompt, boardSetup.alias)
  if (!app) return 0
  // The Ready hint must repeat the app when the wizard chose it: from a
  // project root the next command cannot infer one.
  boardSetup.app = app
  io.stdout(`Initializing board target '${boardSetup.alias}' for app '${app.id}'...`)
  const { buildCommand } = await import('./commands/board.mjs')
  const setupParsed = { ...parsed, options: { ...parsed.options, board: boardSetup.alias, app: app.id, 'configure-only': true } }
  return buildCommand(ctx, setupParsed, [], io)
}

async function chooseAppForBoard(ctx, parsed, io, prompt, alias) {
  let current = null
  try {
    current = resolveRequestedApp(ctx, parsed, [])
  } catch {
    current = null
  }
  if (current && targetEnabledForApp(ctx, current, alias)) return current
  const candidates = discoverApps(ctx).filter((app) => targetEnabledForApp(ctx, app, alias))
  if (candidates.length === 0) {
    io.stdout(`No app in ${ctx.projectRoot} targets '${alias}' yet; skipping board initialization. Later: npx gea setup --board ${alias} --app <id>`)
    return null
  }
  if (candidates.length === 1) return candidates[0]
  const picked = await choose(prompt, {
    message: `Which app should the first '${alias}' build target?`,
    choices: [
      ...candidates.map((app) => ({ value: app.id, label: app.id, description: app.root })),
      { value: '', label: 'Skip board initialization for now' }
    ],
    defaultValue: candidates[0].id
  })
  return picked ? candidates.find((app) => app.id === picked) : null
}

// Resolves the ESP-IDF version target once for the whole wizard run:
// --idf-version / GEA_ESP_IDF_VERSION win outright; otherwise a best-effort
// GitHub "latest release" lookup, falling back to the pinned default when it
// cannot be determined. `io.fetchEspIdfLatest` lets callers (tests) inject a
// fake fetch instead of touching the network -- mirrors `probeSerialDevice`.
async function resolveEspIdfVersionForWizard(parsed, io) {
  return resolveEspIdfVersion({
    override: option(parsed, 'idf-version'),
    env: io.env || process.env,
    fetchLatest: io.fetchEspIdfLatest || fetchLatestEspIdfVersion,
    log: io.stderr || (() => {})
  })
}

async function maybeSetupEspIdf(ctx, parsed, io, prompt, { force = false, targetVersion } = {}) {
  const env = io.env || process.env
  const resolvedVersion = targetVersion || await resolveEspIdfVersionForWizard(parsed, io)
  const status = detectEspIdf(env, resolvedVersion)
  if (status.available) {
    if (force) io.stdout(`ESP-IDF found: ${status.detail}`)
    return 0
  }

  const install = force || await confirm(prompt, {
    message: `ESP-IDF ${resolvedVersion} was not found${status.detail ? ` (found ${status.detail})` : ''}. Install it now?`,
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
    runExternal('git', ['clone', '-b', resolvedVersion, '--recursive', 'https://github.com/espressif/esp-idf.git', idfDir], {
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

// Prefers the same conventional-directory detection the build path uses
// (`findEspIdf` + its version.cmake), which lets a version-floor check run;
// falls back to a bare `idf.py --version` on PATH when no such directory is
// found but some ESP-IDF install has still put idf.py on PATH.
function detectEspIdf(env, targetVersion) {
  const idfDir = findEspIdf(env)
  if (idfDir) {
    const installed = readInstalledEspIdfVersion(idfDir)
    const detail = `${installed?.full || 'unknown version'} at ${idfDir}`
    return { available: idfVersionMeetsTarget(installed, targetVersion), detail }
  }
  const legacyOutput = commandVersion('idf.py', ['--version'], env)
  if (legacyOutput) {
    const installed = extractIdfVersionFromText(legacyOutput)
    const available = !installed || idfVersionMeetsTarget(installed, targetVersion)
    return { available, detail: legacyOutput }
  }
  return { available: false, detail: '' }
}

// Nobody knows their board's USB serial by heart, so the wizard never asks
// for one. It asks whether the board is plugged in, reads the serial from the
// USB registry, and PINGs each port so the user picks by what the board says
// it is running rather than by a /dev name. A board that is not connected is
// registered without a serial; `gea boards discover --save` fills it in later.
async function selectUsbSerial(prompt, io, ctx, { message }) {
  const env = io.env || process.env
  io.stdout(message)
  const connected = await confirm(prompt, { message: 'Is the board connected over USB right now?', defaultValue: true })
  if (!connected) {
    io.stdout('No USB serial recorded. Later, with the board plugged in: gea boards discover --save')
    return ''
  }
  const known = loadBoardConfig(ctx)
  const probe = io.probeSerialDevice || ((device) => probeSerialDevice(device, { env }))
  while (true) {
    const devices = detectSerialDevices({ env }).filter((device) => device.serial)
    if (devices.length === 0) {
      io.stdout('No USB board detected. Check the cable (some are power-only) and that the board is on.')
      const retry = await confirm(prompt, { message: 'Retry detection?', defaultValue: true })
      if (retry) continue
      io.stdout('No USB serial recorded. Later, with the board plugged in: gea boards discover --save')
      return ''
    }
    const results = await discoverBoards({ devices, boards: known, probe })
    const describe = (result) => {
      const bits = [result.label && result.label !== result.path ? `${result.label} on ${result.path}` : result.path, `serial ${result.serial}`]
      if (result.responds) bits.push(result.app ? `running ${result.app}` : 'gea firmware')
      if (result.alias) bits.push(`already registered as '${result.alias}'`)
      return bits.join(', ')
    }
    if (results.length === 1) {
      io.stdout(`Detected ${describe(results[0])}`)
      return results[0].serial
    }
    const selected = await choose(prompt, {
      message: 'Several USB devices are connected. Which one is this board?',
      choices: [
        ...results.map((result, index) => ({ value: `device-${index}`, label: describe(result) })),
        { value: 'retry', label: 'Unplug the others and detect again' },
        { value: 'skip', label: 'Skip for now' }
      ],
      defaultValue: 'device-0'
    })
    if (selected === 'skip') return ''
    if (selected === 'retry') continue
    return results[Number.parseInt(selected.slice('device-'.length), 10)].serial
  }
}

// --global writes the alias to ~/.geastack/boards.json, --local to the
// project's .gea/boards.json; otherwise the project config when it exists,
// else the home one (src/boards/config.mjs owns that rule).
function boardConfigPath(ctx, parsed) {
  const explicit = option(parsed, 'boards-config')
  if (explicit) return path.resolve(ctx.cwd, explicit)
  return boardConfigWritePath(ctx, { scope: flag(parsed, 'global') ? 'global' : flag(parsed, 'local') ? 'project' : '' })
}

function readBoardConfig(filePath) {
  if (!exists(filePath)) return {}
  return readJson(filePath)
}

function writeJsonEnsured(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  writeJson(filePath, value)
}

function validateOtaHost(value) {
  if (!value) return ''
  const ipv4 = /^(\d{1,3})(\.\d{1,3}){3}$/.test(value)
  const hostname = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value)
  if (ipv4 || hostname) return ''
  return 'enter an IP address such as 192.168.1.20 or a hostname such as board.local, or leave it empty'
}

function validateAlias(value) {
  if (!value) return 'alias is required'
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) return 'use letters, numbers, dot, dash, or underscore'
  return ''
}

async function askPin(prompt, message) {
  return Number(await ask(prompt, {
    message,
    defaultValue: '',
    validate: (value) => {
      if (!/^\d+$/.test(value)) return 'enter a GPIO number from 0 through 48'
      const pin = Number(value)
      return pin >= 0 && pin <= 48 ? '' : 'enter a GPIO number from 0 through 48'
    }
  }))
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => {
    if (entry === undefined || entry === null || entry === '') return false
    if (Array.isArray(entry)) return entry.length > 0
    if (typeof entry === 'object') return Object.keys(entry).length > 0
    return true
  }))
}
