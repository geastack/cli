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
