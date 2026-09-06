import path from 'node:path'

import { flag, option } from './args.mjs'
import { ExitCode, fail } from './errors.mjs'
import { exists, readJson, writeJson } from './fs-utils.mjs'
import { ask, choose, createPrompt } from './prompts.mjs'

export async function runChips(ctx, parsed, rest, io = {}) {
  const action = rest[0] || 'list'
  const chipIds = rest.slice(1)
  const stdout = io.stdout || console.log
  const catalog = loadChipCatalog(ctx)

  if (action === 'list') {
    const entries = Object.entries(catalog).sort((a, b) => a[0].localeCompare(b[0]))
    if (flag(parsed, 'json')) stdout(JSON.stringify(Object.fromEntries(entries), null, 2))
    else {
      for (const [id, chip] of entries) {
        const adapters = Object.keys(chip.adapters || {})
        stdout(`${id}\t${chip.category}\t${chip.label}${adapters.length ? `\t${adapters.join(',')}` : '\tunbound'}`)
      }
    }
    return 0
  }

  if (action === 'info') {
    if (chipIds.length !== 1) fail('chips info requires one chip id.', ExitCode.usage)
    const chip = catalog[chipIds[0]]
    if (!chip) failUnknownChip(chipIds[0], catalog)
    if (flag(parsed, 'json')) stdout(JSON.stringify({ id: chipIds[0], ...chip }, null, 2))
    else {
      stdout(`${chipIds[0]}: ${chip.label}`)
      stdout(`Category: ${chip.category}`)
      stdout(`Interfaces: ${(chip.interfaces || []).join(', ') || 'none'}`)
      stdout(`Adapters: ${Object.keys(chip.adapters || {}).join(', ') || 'no platform binding yet'}`)
      for (const field of chip.configuration || []) stdout(`Configure: ${field.path} (${field.label})`)
    }
    return 0
  }

  if (action !== 'add' && action !== 'remove') {
    fail(`Unknown chips action '${action}'. Expected list, info, add, or remove.`, ExitCode.usage)
  }
  if (chipIds.length === 0) fail(`chips ${action} requires at least one chip id.`, ExitCode.usage)

  const location = resolveTargetDefinition(ctx, parsed)
  const definition = readJson(location.definitionPath)
  definition.chips ||= {}

  if (action === 'remove') {
    for (const id of chipIds) {
      const role = Object.keys(definition.chips).find((key) => selectedDriver(definition.chips[key]) === id)
      if (!role) fail(`Chip '${id}' is not selected by board '${location.boardName}'.`, ExitCode.usage)
      delete definition.chips[role]
      stdout(`Removed ${id} from ${location.boardName}.`)
    }
    writeJson(location.definitionPath, definition)
    return 0
  }

  const prompt = createPrompt(io)
  try {
    const provided = parseSetOptions(parsed)
    for (const id of chipIds) {
      const descriptor = catalog[id]
      if (!descriptor) failUnknownChip(id, catalog)
      const role = await configureChipSelection({
        definition,
        id,
        descriptor,
        provided,
        prompt,
        io,
        replace: flag(parsed, 'replace'),
        boardName: location.boardName
      })
      stdout(`Added ${id} as ${role} on ${location.boardName}.`)
    }
    if (provided.size > 0) {
      fail(`Unused --set values: ${[...provided.keys()].join(', ')}`, ExitCode.usage)
    }
    validateGpioAssignments(definition)
    writeJson(location.definitionPath, definition)
    stdout(`Updated ${location.definitionPath}`)
    return 0
  } finally {
    await prompt.close()
  }
}

export async function configureChipSelection({ definition, id, descriptor, provided = new Map(), prompt, io = {}, replace = false, boardName = definition.id }) {
  definition.chips ||= {}
  const adapter = definition.adapter || 'esp32-idf'
  const binding = descriptor.adapters?.[adapter]
  if (!binding) fail(`Chip '${id}' has no ${adapter} binding. 'gea chips info ${id}' shows its current support.`, ExitCode.targetUnavailable)
  if (Array.isArray(binding.mcus) && !binding.mcus.includes(definition.mcu)) {
    fail(`Chip '${id}' does not support MCU '${definition.mcu}' through ${adapter}.`, ExitCode.targetUnavailable)
  }

  const role = descriptor.category
  const previous = definition.chips[role]
  if (previous && selectedDriver(previous) !== id && !replace) {
    fail(`Board '${boardName}' already uses '${selectedDriver(previous)}' as ${role}. Pass --replace to change it.`, ExitCode.usage)
  }
  const selection = previous && selectedDriver(previous) === id ? structuredClone(previous) : { driver: id }
  selection.driver = id
  delete selection.controller
  selection.interface = await configuredInterface({ id, descriptor, selection, provided, prompt, io })
  if (selection.interface === 'i2c') {
    definition.buses ||= {}
    definition.buses.i2c ||= {}
    await configureFields({
      id: 'i2c',
      target: definition.buses.i2c,
      fields: [
        { path: 'sda', label: 'Shared I2C SDA pin', type: 'pin' },
        { path: 'scl', label: 'Shared I2C SCL pin', type: 'pin' }
      ],
      provided,
      prompt,
      io
    })
  }
  await configureFields({ id, target: selection, fields: descriptor.configuration || [], provided, prompt, io })
  definition.chips[role] = selection
  return role
}

export function loadChipCatalog(ctx) {
  const catalogPath = path.join(ctx.chipsPackageDir || '', 'catalog.json')
  if (!ctx.chipsPackageDir || !exists(catalogPath)) {
    fail(`Missing @geastack/chips catalog: ${catalogPath || '@geastack/chips/catalog.json'}`, ExitCode.missingDependency)
  }
  const catalog = readJson(catalogPath)
  if (catalog.schemaVersion !== 1 || !catalog.chips || typeof catalog.chips !== 'object') {
    fail(`Unsupported @geastack/chips catalog schema in ${catalogPath}.`, ExitCode.missingDependency)
  }
  return catalog.chips
}

export function resolveTargetDefinition(ctx, parsed) {
  const configPath = option(parsed, 'boards-config')
    ? path.resolve(ctx.cwd, option(parsed, 'boards-config'))
    : ctx.projectBoardsConfig
  if (!configPath || !exists(configPath)) fail(`No board config was found at ${configPath || '.gea/boards.json'}. Run gea setup and create a custom board first.`, ExitCode.usage)
  const boards = readJson(configPath)
  const requested = option(parsed, 'board', '')
  const customBoards = Object.entries(boards).filter(([, entry]) => typeof entry?.targetDefinition === 'string' && entry.targetDefinition)
  const boardName = requested || (customBoards.length === 1 ? customBoards[0][0] : '')
  if (!boardName) fail('Select a custom board with --board <alias>.', ExitCode.usage)
  const board = boards[boardName]
  if (!board) fail(`Unknown board '${boardName}' in ${configPath}.`, ExitCode.usage)
  if (!board.targetDefinition) fail(`Board '${boardName}' is a preset and has no editable target definition.`, ExitCode.usage)
  const definitionPath = path.resolve(path.dirname(configPath), board.targetDefinition)
  if (!exists(definitionPath)) fail(`Target definition for '${boardName}' does not exist: ${definitionPath}`, ExitCode.usage)
  return { boardName, board, configPath, definitionPath }
}

export function validateGpioAssignments(definition) {
  const pins = []
  collectGpioAssignments(definition, [], false, pins)
  const used = new Map()
  for (const [label, pin] of pins) {
    const previous = used.get(pin)
    if (previous) fail(`GPIO ${pin} is assigned to both ${previous} and ${label}.`, ExitCode.usage)
    used.set(pin, label)
  }
}

function collectGpioAssignments(value, pathParts, pinMap, out) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = [...pathParts, key]
    const nextPinMap = pinMap || key === 'pins' || pathParts[0] === 'buses'
    if (typeof entry === 'number' && entry >= 0 && (nextPinMap || key === 'pin')) {
      out.push([nextPath.join('.'), entry])
    } else if (entry && typeof entry === 'object') {
      collectGpioAssignments(entry, nextPath, nextPinMap, out)
    }
  }
}

async function configuredInterface({ id, descriptor, selection, provided, prompt, io }) {
  const interfaces = Array.isArray(descriptor.interfaces) ? descriptor.interfaces : []
  const supplied = provided.get(`${id}.interface`)
  if (supplied !== undefined) {
    provided.delete(`${id}.interface`)
    if (!interfaces.includes(supplied)) fail(`Chip '${id}' does not support interface '${supplied}'.`, ExitCode.usage)
    return supplied
  }
  if (selection.interface && interfaces.includes(selection.interface)) return selection.interface
  if (interfaces.length === 1) return interfaces[0]
  if (!canAnswer(prompt, io)) fail(`Set ${id}.interface with --set ${id}.interface=<value>.`, ExitCode.usage)
  return choose(prompt, {
    message: `${descriptor.label} interface`,
    choices: interfaces.map((value) => ({ value, label: value.toUpperCase() })),
    defaultValue: interfaces[0]
  })
}

async function configureFields({ id, target, fields, provided, prompt, io }) {
  for (const field of fields) {
    const supplied = provided.get(`${id}.${field.path}`)
    if (supplied !== undefined) {
      provided.delete(`${id}.${field.path}`)
      const error = validateFieldValue(supplied, field)
      if (error) fail(`Invalid ${id}.${field.path}: ${error}.`, ExitCode.usage)
      setPath(target, field.path, parseFieldValue(supplied, field))
      continue
    }
    const current = getPath(target, field.path)
    if (current !== undefined && current !== null) continue
    if (!canAnswer(prompt, io)) {
      if (field.default !== undefined) {
        setPath(target, field.path, field.default)
        continue
      }
      if (field.optional) {
        setPath(target, field.path, null)
        continue
      }
      fail(`Missing ${id}.${field.path}. Pass --set ${id}.${field.path}=<value> or run interactively.`, ExitCode.usage)
    }
    if (field.type === 'choice') {
      const value = await choose(prompt, {
        message: field.label,
        choices: field.values.map((entry) => ({ value: entry, label: entry })),
        defaultValue: field.default || field.values[0]
      })
      setPath(target, field.path, value)
      continue
    }
    const value = await ask(prompt, {
      message: field.optional ? `${field.label} (blank for none)` : field.label,
      defaultValue: field.default === undefined ? '' : String(field.default),
      validate: (entry) => validateFieldValue(entry, field)
    })
    setPath(target, field.path, field.optional && value === '' ? null : parseFieldValue(value, field))
  }
}

function parseSetOptions(parsed) {
  const raw = parsed.options.set
  const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  const out = new Map()
  for (const entry of entries) {
    const index = String(entry).indexOf('=')
    if (index <= 0) fail(`Invalid --set '${entry}'. Expected --set chip.path=value.`, ExitCode.usage)
    out.set(String(entry).slice(0, index), String(entry).slice(index + 1))
  }
  return out
}

function parseFieldValue(value, field) {
  if (field.optional && (value === '' || value === 'none' || value === 'null')) return null
  if (field.type === 'integer' || field.type === 'pin') return Number.parseInt(value, 10)
  return String(value)
}

function validateFieldValue(value, field) {
  if (field.optional && value === '') return ''
  if (field.type === 'choice') return field.values.includes(value) ? '' : `choose one of ${field.values.join(', ')}`
  if (field.type !== 'integer' && field.type !== 'pin') return ''
  if (!/^-?\d+$/.test(String(value))) return 'enter an integer'
  const number = Number(value)
  const min = field.type === 'pin' ? 0 : field.min
  const max = field.type === 'pin' ? 48 : field.max
  if (min !== undefined && number < min) return `minimum is ${min}`
  if (max !== undefined && number > max) return `maximum is ${max}`
  return ''
}

function getPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, part) => current?.[part], value)
}

function setPath(value, dottedPath, next) {
  const parts = dottedPath.split('.')
  let current = value
  for (const part of parts.slice(0, -1)) current = current[part] ||= {}
  current[parts.at(-1)] = next
}

function selectedDriver(selection) {
  return String(selection?.driver || selection?.controller || '')
}

function failUnknownChip(id, catalog) {
  const available = Object.keys(catalog).sort().join(', ')
  fail(`Unknown chip '${id}'. Available chips: ${available}`, ExitCode.usage)
}

function canAnswer(prompt, io) {
  return Boolean(io.prompt || io.stdin?.isTTY || (!io.stdin && process.stdin.isTTY))
}
