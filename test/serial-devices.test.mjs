import assert from 'node:assert/strict'
import test from 'node:test'

import { detectSerialDevices, formatSerialDevice } from '../src/serial-devices.mjs'

test('serial device detection supports deterministic setup wizard fixtures', () => {
  const devices = detectSerialDevices({
    env: {
      GEA_SERIAL_DEVICES: '/dev/cu.usbmodem101|ESP32-S3 USB/JTAG|USB123,/dev/ttyACM0'
    },
    platform: 'darwin'
  })

  assert.equal(devices.length, 2)
  assert.deepEqual(devices[0], {
    path: '/dev/cu.usbmodem101',
    label: 'ESP32-S3 USB/JTAG',
    serial: 'USB123'
  })
  assert.equal(formatSerialDevice(devices[0]), '/dev/cu.usbmodem101 - ESP32-S3 USB/JTAG - serial USB123')
  assert.equal(devices[1].path, '/dev/ttyACM0')
})

test('macOS ports take their serial from the USB registry, never from the usbmodem number', async () => {
  const { listMacUsbCalloutPorts } = await import('../src/boards/usb.mjs')
  const { mergeRegistryDevices } = await import('../src/serial-devices.mjs')
  const ioreg = () => [
    '+-o Root  <class IORegistryEntry>',
    '  +-o USB JTAG/serial debug unit@01100000  <class IOUSBHostDevice, id 0x1>',
    '  |   "USB Product Name" = "USB JTAG_serial debug unit"',
    '  |   "USB Serial Number" = "80:B5:4E:DA:73:88"',
    '  | +-o IOUSBHostInterface@1  <class IOUSBHostInterface, id 0x2>',
    '  | |   "USB Serial Number" = "80:B5:4E:DA:73:88"',
    '  | | +-o AppleUSBACMData  <class AppleUSBACMData, id 0x3>',
    '  | |   +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x4>',
    '  | |       "IOCalloutDevice" = "/dev/cu.usbmodem1101"',
    '  | |       "IODialinDevice" = "/dev/tty.usbmodem1101"',
    '  +-o RP2350 Boot@01200000  <class IOUSBHostDevice, id 0x5>',
    '  |   "USB Product Name" = "Tufty 2350"',
    '  |   "USB Serial Number" = "fa59949adbb4802f"',
    '  | +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x6>',
    '  |     "IOCalloutDevice" = "/dev/cu.usbmodem1201"'
  ].join('\n')
  const registry = listMacUsbCalloutPorts(ioreg)
  assert.deepEqual(registry, [
    { path: '/dev/cu.usbmodem1101', serial: '80:B5:4E:DA:73:88', label: 'USB JTAG_serial debug unit' },
    { path: '/dev/cu.usbmodem1201', serial: 'fa59949adbb4802f', label: 'Tufty 2350' }
  ])

  const devices = new Map([
    ['/dev/cu.usbmodem1101', { path: '/dev/cu.usbmodem1101', label: 'cu.usbmodem1101', serial: '' }],
    ['/dev/cu.usbserial-0001', { path: '/dev/cu.usbserial-0001', label: 'cu.usbserial-0001', serial: '' }]
  ])
  const merged = [...mergeRegistryDevices(devices, registry).values()]
  assert.deepEqual(merged.map((device) => [device.path, device.serial, device.label]), [
    ['/dev/cu.usbmodem1101', '80:B5:4E:DA:73:88', 'USB JTAG_serial debug unit'],
    ['/dev/cu.usbserial-0001', '', 'cu.usbserial-0001'],
    ['/dev/cu.usbmodem1201', 'fa59949adbb4802f', 'Tufty 2350']
  ])
  assert.equal(listMacUsbCalloutPorts(() => { throw new Error('no ioreg') }).length, 0)
})
