import assert from 'node:assert/strict'
import test from 'node:test'

import { listMacUsbCalloutPorts, resolveUsbSerialPort, waitForSerialPort } from '../src/boards/usb.mjs'
import { serialFromLinuxById } from '../src/serial-devices.mjs'

const amoled18 = '30:ED:A0:AC:90:DC'
const kitt = '80:B5:4E:DA:73:88'

test('Linux identity excludes the product label and USB interface suffix', () => {
  assert.equal(serialFromLinuxById('usb-Espressif_USB_JTAG_serial_debug_unit_30EDA0AC90DC-if00'), '30EDA0AC90DC')
  assert.equal(serialFromLinuxById('usb-30EDA0AC90DC_board_80B54EDA7388-if00'), '80B54EDA7388')
  assert.equal(serialFromLinuxById('usb-Espressif_board_30EDA0AC90DCFF-if00'), '30EDA0AC90DCFF')
})

function registry(devices) {
  return () => [
    '+-o Root <class IORegistryEntry>',
    ...devices.flatMap(({ serial, port }) => [
      '  +-o USB device@01000000 <class IOUSBHostDevice>',
      `  |   "USB Serial Number" = "${serial}"`,
      '  | +-o IOSerialBSDClient <class IOSerialBSDClient>',
      `  |     "IOCalloutDevice" = "${port}"`
    ])
  ].join('\n')
}

test('macOS selects the exact serial even when port numbers share location digits', () => {
  const ioreg = registry([
    { serial: kitt, port: '/dev/cu.usbmodem21301' },
    { serial: amoled18, port: '/dev/cu.usbmodem101' }
  ])
  assert.equal(resolveUsbSerialPort({ serial: amoled18 }, { platform: 'darwin', ioreg }), '/dev/cu.usbmodem101')
  assert.equal(resolveUsbSerialPort({ serial: kitt }, { platform: 'darwin', ioreg }), '/dev/cu.usbmodem21301')
})

test('a disconnected registered board never resolves to the remaining board', () => {
  const ioreg = registry([{ serial: kitt, port: '/dev/cu.usbmodem21301' }])
  assert.throws(() => resolveUsbSerialPort({ serial: amoled18 }, { platform: 'darwin', ioreg }), /Could not map USB serial/)
})

test('macOS inherits USB identity through nested interfaces drawn with spaces', () => {
  const ioreg = () => [
    '+-o Root <class IORegistryEntry>',
    '  +-o USB hub <class IOUSBHostDevice>',
    '  | +-o Board A <class IOUSBHostDevice>',
    `  | |   "USB Serial Number" = "${amoled18}"`,
    '  | |   "USB Product Name" = "AMOLED"',
    '  | | +-o IOUSBHostInterface <class IOUSBHostInterface>',
    '  | |   +-o AppleUSBACMData <class AppleUSBACMData>',
    '  |       +-o IOSerialBSDClient <class IOSerialBSDClient>',
    '  |           "IOCalloutDevice" = "/dev/cu.usbmodem101"',
    '  | +-o Board B <class IOUSBHostDevice>',
    `  |     "USB Serial Number" = "${kitt}"`,
    '  |     "USB Product Name" = "KITT"',
    '  |   +-o IOSerialBSDClient <class IOSerialBSDClient>',
    '  |       "IOCalloutDevice" = "/dev/cu.usbmodem201"'
  ].join('\n')
  assert.equal(resolveUsbSerialPort({ serial: amoled18 }, { platform: 'darwin', ioreg }), '/dev/cu.usbmodem101')
  assert.equal(resolveUsbSerialPort({ serial: kitt }, { platform: 'darwin', ioreg }), '/dev/cu.usbmodem201')
  assert.deepEqual(listMacUsbCalloutPorts(ioreg), [
    { path: '/dev/cu.usbmodem101', serial: amoled18, label: 'AMOLED' },
    { path: '/dev/cu.usbmodem201', serial: kitt, label: 'KITT' }
  ])
})

test('partial serial matches and serial-looking paths cannot identify a board', () => {
  const ioreg = registry([{ serial: `${amoled18}:FF`, port: '/dev/cu.usbmodem30EDA0AC90DC' }])
  assert.throws(() => resolveUsbSerialPort({ serial: amoled18 }, { platform: 'darwin', ioreg }), /Could not map USB serial/)
})

test('duplicate exact serials fail closed', () => {
  const ioreg = registry([
    { serial: amoled18, port: '/dev/cu.usbmodem101' },
    { serial: amoled18, port: '/dev/cu.usbmodem102' }
  ])
  assert.throws(() => resolveUsbSerialPort({ serial: amoled18 }, { platform: 'darwin', ioreg }), /multiple/)
})

test('USB retries wait for the selected serial to re-enumerate', async () => {
  let attempts = 0
  const port = await waitForSerialPort({
    serial: amoled18,
    pollSeconds: 0,
    timeoutSeconds: 1,
    log: () => {},
    portPresent: (value) => value === '/dev/cu.usbmodem301',
    resolver: ({ serial }) => {
      assert.equal(serial, amoled18)
      if (++attempts < 3) throw new Error('selected board is disconnected')
      return '/dev/cu.usbmodem301'
    }
  })
  assert.equal(port, '/dev/cu.usbmodem301')
  assert.equal(attempts, 3)
})

test('an explicit port cannot override a different registered USB identity', async () => {
  await assert.rejects(waitForSerialPort({
    port: '/dev/cu.usbmodem21301',
    serial: amoled18,
    pollSeconds: 0,
    timeoutSeconds: 0.01,
    log: () => {},
    portPresent: () => true,
    resolver: () => '/dev/cu.usbmodem101'
  }), /Timed out/)
})

test('an explicit port is accepted only when its registered serial matches', async () => {
  assert.equal(await waitForSerialPort({
    port: '/dev/cu.usbmodem101',
    serial: amoled18,
    log: () => {},
    portPresent: () => true,
    resolver: () => '/dev/cu.usbmodem101'
  }), '/dev/cu.usbmodem101')
})
