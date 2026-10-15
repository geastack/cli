// A new STM32 user's path: gea doctor names the STM32 tools and how to install
// them, the board's ST-LINK is recognised by its USB IDs, and gea setup
// registers the board under the ST-LINK's serial.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { boardByUsbDevice } from '../src/board-catalog.mjs'
import { listMacUsbCalloutPorts } from '../src/boards/usb.mjs'
import { ExitCode } from '../src/errors.mjs'
import { runGea } from '../src/gea.mjs'
import { detectSerialDevices, windowsSerialPortDevice } from '../src/serial-devices.mjs'
import { capture, createFixture, readJson, scriptedPrompt, withPathPrefix, writeFakeCommand } from './helpers/fixture.mjs'

const stlinkSerial = '066AFF565588494867122023'
const stlinkDevice = `/dev/cu.usbmodem1103|STM32 STLink|${stlinkSerial}|0483:374b`

// Fake STM32 tools in their own toolchain root: bin/arm-none-eabi-gcc, cmake,
// and openocd, which prints its version on stderr as the real one does.
function fakeStm32Tools(t, { openocd = '0.12.0' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-stm32-tools-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  return {
    root,
    bin,
    gcc: fakeTool(bin, 'arm-none-eabi-gcc', '15.2.1', 'stdout'),
    cmake: fakeTool(bin, 'cmake', 'cmake version 3.30.0', 'stdout'),
    openocd: openocd ? fakeTool(bin, 'openocd', `Open On-Chip Debugger ${openocd}`, 'stderr') : ''
  }
}

function fakeTool(bin, name, output, stream) {
  const redirect = stream === 'stderr' ? ' >&2' : ''
  return writeFakeCommand(bin, name, {
    bash: `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(output)}${redirect}\n`,
    node: `process.${stream}.write(${JSON.stringify(`${output}\n`)})\n`
  })
}

// The fixture's environment with only the fake STM32 tools in front, and
// ARM_TOOLCHAIN_PATH naming them so an Arm toolchain installed on this
// machine is never the one found.
function stm32Env(fixture, tools, extra = {}) {
  return { ...withPathPrefix(fixture.env, tools.bin), ARM_TOOLCHAIN_PATH: tools.root, ...extra }
}

async function doctor(fixture, env, args = []) {
  const out = capture()
  const code = await runGea(['doctor', '--json', ...args], { ...out.io, cwd: fixture.appDir, env })
  const checks = JSON.parse(out.out.join('\n')).checks
  return { code, check: (name) => checks.find((entry) => entry.name === name) }
}

test('doctor reports the STM32 build and flash tools, optional unless --strict', async (t) => {
  const fixture = createFixture(t)
  const tools = fakeStm32Tools(t)
  const found = await doctor(fixture, stm32Env(fixture, tools))
  assert.deepEqual(found.check('arm-none-eabi-gcc (STM32)'), { name: 'arm-none-eabi-gcc (STM32)', ok: true, detail: `15.2.1 at ${tools.gcc}`, required: false })
  assert.equal(found.check('cmake 3.20+ (STM32)').detail, `3.30.0 at ${tools.cmake}`)
  assert.equal(found.check('openocd 0.12+ (STM32 flashing)').detail, `0.12.0 at ${tools.openocd}`)

  const old = await doctor(fixture, stm32Env(fixture, fakeStm32Tools(t, { openocd: '0.11.0' })))
  assert.equal(old.code, 0)
  assert.equal(old.check('openocd 0.12+ (STM32 flashing)').ok, false)
  assert.match(old.check('openocd 0.12+ (STM32 flashing)').detail, /^0\.11\.0 at .*, needs 0\.12\+; brew install open-ocd$/)

  const missing = await doctor(fixture, stm32Env(fixture, fakeStm32Tools(t, { openocd: '' })), ['--strict'])
  assert.equal(missing.code, ExitCode.missingDependency)
  assert.equal(missing.check('openocd 0.12+ (STM32 flashing)').detail, 'not found; brew install open-ocd')
})

test('an ST-LINK is recognised by its USB IDs on every platform', () => {
  const ioreg = () => [
    '+-o Root  <class IORegistryEntry>',
    '  +-o STM32 STLink@01100000  <class IOUSBHostDevice, id 0x1>',
    '  |   "idProduct" = 14155',
    '  |   "idVendor" = 1155',
    '  |   "USB Product Name" = "STM32 STLink"',
    `  |   "USB Serial Number" = "${stlinkSerial}"`,
    '  | +-o IOUSBHostInterface@2  <class IOUSBHostInterface, id 0x2>',
    '  |   +-o AppleUSBACMData  <class AppleUSBACMData, id 0x3>',
    '  |     +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x4>',
    '  |         "IOCalloutDevice" = "/dev/cu.usbmodem1103"'
  ].join('\n')
  const [mac] = listMacUsbCalloutPorts(ioreg)
  assert.deepEqual(mac, { path: '/dev/cu.usbmodem1103', serial: stlinkSerial, label: 'STM32 STLink', vendorId: '0483', productId: '374b' })

  const windows = windowsSerialPortDevice({
    DeviceID: 'COM5',
    Name: 'STMicroelectronics STLink Virtual COM Port (COM5)',
    PNPDeviceID: 'USB\\VID_0483&PID_374B&MI_02\\6&1A2B3C4D&0&0002',
    Parent: `USB\\VID_0483&PID_374B\\${stlinkSerial}`
  })
  assert.deepEqual([windows.serial, windows.vendorId, windows.productId], [stlinkSerial, '0483', '374b'])

  const [declared] = detectSerialDevices({ env: { GEA_SERIAL_DEVICES: stlinkDevice } })
  for (const device of [mac, windows, declared]) {
    assert.equal(boardByUsbDevice(device)?.target, 'stm32f746g-disco')
  }
  assert.equal(boardByUsbDevice({ vendorId: '303a', productId: '1001' }), null)
  assert.equal(boardByUsbDevice({ vendorId: '', productId: '' }), null)
})

test('boards discover names the STM32 board behind an unregistered ST-LINK', async (t) => {
  const fixture = createFixture(t)
  const out = capture()
  const env = { ...fixture.env, GEA_SERIAL_DEVICES: stlinkDevice }
  assert.equal(await runGea(['boards', 'discover'], { ...out.io, cwd: fixture.appDir, env }), 0)
  assert.match(out.out.join('\n'), new RegExp(`usbmodem1103  not configured, STMicroelectronics STM32F746G-Discovery  serial ${stlinkSerial}`))
})

test('setup offers the STM32 board behind a connected ST-LINK and registers its serial', async (t) => {
  const fixture = createFixture(t)
  const tools = fakeStm32Tools(t)
  const out = capture()
  // Board: the detected default; alias; connected over USB; save.
  const prompt = scriptedPrompt(['1', '', 'bench-disco', 'y', 'y'])
  const code = await runGea(['setup', '--dry-run'], {
    ...out.io,
    prompt,
    cwd: fixture.appDir,
    env: stm32Env(fixture, tools, { GEA_SERIAL_DEVICES: stlinkDevice })
  })
  assert.equal(code, 0, out.err.join('\n'))

  const board = readJson(path.join(fixture.root, '.geastack/boards.json'))['bench-disco']
  assert.deepEqual(board, { target: 'stm32f746g-disco', adapter: 'stm32-cube', transports: { usbSerial: { serial: stlinkSerial } } })
  assert.doesNotMatch(prompt.questions.join('\n'), /OTA host/, 'an STM32 board has no network to update over')

  const text = out.out.join('\n')
  assert.match(text, /Detected over USB: STMicroelectronics STM32F746G-Discovery/)
  assert.match(text, /openocd 0\.12\+ \(STM32 flashing\): 0\.12\.0 at /)
  assert.match(text, /Initializing board target 'bench-disco' for app 'watch'/)
  assert.match(text, /Build only: gea build --board bench-disco/)
  assert.match(text, /Ready: gea flash --board bench-disco --monitor/)
})

test('setup names the missing STM32 tool and leaves the build unconfigured', async (t) => {
  const fixture = createFixture(t)
  const tools = fakeStm32Tools(t, { openocd: '' })
  const out = capture()
  const prompt = scriptedPrompt(['1', '', 'bench-disco', 'y', 'y'])
  const code = await runGea(['setup', '--dry-run'], {
    ...out.io,
    prompt,
    cwd: fixture.appDir,
    env: stm32Env(fixture, tools, { GEA_SERIAL_DEVICES: stlinkDevice })
  })
  assert.equal(code, 0, out.err.join('\n'))

  const text = out.out.join('\n')
  assert.match(text, /openocd 0\.12\+ \(STM32 flashing\): not found; brew install open-ocd/)
  assert.doesNotMatch(text, /Initializing board target/)
  assert.match(text, /Install the missing tools, then: gea flash --board bench-disco --monitor/)
})
