import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { loadBoardConfig, normalizeBoardConfig } from './config.mjs'
import { loadTargets } from './targets.mjs'
import { resolveUsbSerialPort } from './usb.mjs'

export const usbSerialAdapters = new Set(['esp32-idf', 'rp2350-pico', 'taurus-s3'])
export const geaosAdapters = new Set(['geaos-linux', 'geaos-arm64'])

function boardTransport(board, name) {
  return board?.transports?.[name] || {}
}

function isAuto(value) {
  return !value || /^auto$/i.test(value) || value === '<auto>'
}

// Turns a board alias (or a bare target id) into everything a command needs:
// the target project directory, its adapter, chip/flash metadata and the
// transports the command asked for. `needs.usbPort` resolves the board's USB
// serial to today's /dev port; `needs.otaHost` resolves transports.ota.host.
// Commands state what they need instead of the resolver guessing from names.
export function resolveBoardSelection({
  ctx = null,
  boardName = '',
  targetName = '',
  requestedPort = '',
  requestedHost = '',
  needs = {},
  targets = ctx ? loadTargets(ctx) : {},
  config = ctx ? loadBoardConfig(ctx) : {},
  configDir = ctx ? (ctx.boardsConfig ? path.dirname(ctx.boardsConfig) : path.dirname(ctx.projectBoardsConfig)) : process.cwd(),
  usbSerialResolver = resolveUsbSerialPort,
  deferUsbPort = false
} = {}) {
  const boards = normalizeBoardConfig(config)
  const board = boardName ? boards[boardName] : null
  if (boardName && !board) {
    throw new Error(`Unknown board '${boardName}'. Add it to .gea/boards.json (gea boards add) or run gea boards list.`)
  }

  let target = board?.target || targetName || ''
  if (!target) throw new Error('No board selected. Pass --board <alias> (gea boards list) or --target <id>.')
  let targetBase = target
  let targetDefinition = ''
  let definition = null
  if (board?.targetDefinition) {
    targetDefinition = path.resolve(configDir, board.targetDefinition)
    if (!existsSync(targetDefinition)) {
      throw new Error(`Target definition for board '${boardName}' was not found: ${targetDefinition}`)
    }
    definition = JSON.parse(readFileSync(targetDefinition, 'utf8'))
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new Error(`Target definition must be a JSON object: ${targetDefinition}`)
    }
    if (!definition.id) throw new Error(`Target definition is missing id: ${targetDefinition}`)
    if (!definition.extends) throw new Error(`Target definition is missing extends: ${targetDefinition}`)
    if (board.target && board.target !== definition.id) {
      throw new Error(`Board '${boardName}' selects target '${board.target}', but ${targetDefinition} defines '${definition.id}'.`)
    }
    target = definition.id
    targetBase = definition.extends
  }
  const targetInfo = targets[targetBase] || {}
  const adapter = board?.adapter || definition?.adapter || targetInfo.adapter || ''
  if (!adapter) throw new Error(`Unknown target '${target}'. It is not in targets.json and the board declares no adapter.`)

  const usb = boardTransport(board, 'usbSerial')
  if (usb.path) {
    throw new Error(`Board '${boardName}' uses transports.usbSerial.path, which is no longer supported; set transports.usbSerial.serial instead.`)
  }
  let port = ''
  let host = ''
  const usbSerial = usb.serial || ''

  if (needs.usbPort && usbSerialAdapters.has(adapter)) {
    if (!isAuto(requestedPort)) {
      port = requestedPort
    } else if (usbSerial) {
      if (!deferUsbPort) port = usbSerialResolver({ serial: usbSerial })
    } else if (boardName) {
      // A WiFi-only board hits this on monitor/screenshot. Point at the
      // cable-free command instead of dead-ending on USB.
      const wireless = boardTransport(board, 'ota').host
        ? ` This board has transports.ota.host, so 'gea logs --board ${boardName}' and 'gea screenshot --board ${boardName}' work with no cable.`
        : ''
      throw new Error(`Board '${boardName}' does not define transports.usbSerial.serial, and no USB port was passed.${wireless}`)
    }
  }

  // geaos devices are identified by USB serial too, but tolerantly: a build
  // with the watch detached must still work, so an unresolved port stays
  // empty and the adapter errors at the point it needs the device.
  if (needs.usbPort && geaosAdapters.has(adapter)) {
    if (!isAuto(requestedPort)) {
      port = requestedPort
    } else if (usbSerial && !deferUsbPort) {
      try {
        port = usbSerialResolver({ serial: usbSerial })
      } catch {
        port = ''
      }
    }
  }

  if (needs.otaHost) {
    if (!isAuto(requestedHost)) {
      host = requestedHost
    } else {
      host = boardTransport(board, 'ota').host || ''
      if (!host) throw new Error(`Board '${boardName || target}' does not define transports.ota.host, and no --host was passed.`)
    }
  }

  const selection = {
    boardName,
    target,
    adapter,
    targetDir: board?.targetDir || targetInfo.targetDir || '',
    flashSize: board?.flashSize || targetInfo.flashSize || '',
    appPlatform: board?.appPlatform || targetInfo.appPlatform || '',
    compatibleAppPlatforms: Array.isArray(targetInfo.compatibleAppPlatforms) ? targetInfo.compatibleAppPlatforms : [],
    idfTarget: board?.idfTarget || targetInfo.idfTarget || '',
    esptoolChip: board?.esptoolChip || targetInfo.esptoolChip || '',
    mainTaskStackSize: board?.mainTaskStackSize || targetInfo.mainTaskStackSize || '',
    ipcTaskStackSize: board?.ipcTaskStackSize || targetInfo.ipcTaskStackSize || '',
    port,
    host,
    usbSerial,
    usbRestartAfterFlash: usb.restartAfterFlash || '',
    otaHost: boardTransport(board, 'ota').host || '',
    telnetHost: boardTransport(board, 'telnet').host || board?.telnetHost || targetInfo.telnetHost || '',
    telnetPort: String(boardTransport(board, 'telnet').port || board?.telnetPort || targetInfo.telnetPort || ''),
    fastbootSerial: boardTransport(board, 'fastboot').serial || board?.fastbootSerial || '',
    mtkWorkdir: boardTransport(board, 'mtk').workdir || board?.mtkWorkdir || '',
    mtkBootSlot: boardTransport(board, 'mtk').bootSlot || board?.mtkBootSlot || '',
    mtkMethod: boardTransport(board, 'mtk').method || board?.mtkMethod || '',
    mtkMonitorGlob: boardTransport(board, 'mtk').monitorGlob || board?.mtkMonitorGlob || '',
    targetDefinition
  }
  return selection
}
