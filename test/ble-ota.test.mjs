import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { bleOtaHelperPath } from '../src/esp32/ota.mjs'
import { cliRoot } from './helpers/fixture.mjs'

// The swift helper is the BLE OTA client; the firmware side of the contract is
// asserted in @geastack/targets (targets/esp32/test/ble-ota-*.test.mjs).
test('the BLE OTA client streams write-without-response chunks under CoreBluetooth flow control', () => {
  const client = readFileSync(bleOtaHelperPath(cliRoot), 'utf8')
  assert.match(client, /setbuf\(stdout, nil\)/, 'CLI progress should be unbuffered')
  assert.match(client, /let writeType: CBCharacteristicWriteType = \.withoutResponse/)
  assert.doesNotMatch(client, /\.withResponse : \.withoutResponse|\.withoutResponse : \.withResponse/)
  assert.match(client, /while offset < image\.count && peripheral\.canSendWriteWithoutResponse/, 'the client should use CoreBluetooth flow control rather than chunk acknowledgements')
  const writeCallback = client.match(/func peripheral\(_ peripheral: CBPeripheral, didWriteValueFor[\s\S]*?\n    \}/)?.[0] ?? ''
  assert.doesNotMatch(writeCallback, /sendNextChunk/, 'OTA data flow control must come from peripheralIsReady, not one ATT acknowledgement per chunk')
  assert.match(client, /retrieveConnectedPeripherals\(withServices: \[otaService\]\)/, 'the client should claim a bonded OTA peripheral already connected by macOS')
  assert.match(client, /MiB\/s/, 'the client should report measured OTA throughput')
})
