import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { SerialDevice } from '../src/device/serial.mjs'
import { runGea } from '../src/gea.mjs'
import { capture, createFixture } from './helpers/fixture.mjs'

function diagnosticPort(reply) {
  const port = new EventEmitter()
  port.requests = []
  port.write = (data, callback) => {
    port.requests.push(data.toString().trim())
    setImmediate(() => port.emit('data', Buffer.from(reply)))
    callback()
  }
  port.drain = (callback) => callback()
  port.close = (callback) => {
    port.closed = true
    port.emit('close')
    callback()
  }
  return port
}

for (const verb of ['netdiag', 'taskstats']) {
  test(`devctl ${verb} collects its complete USB report through END`, async (t) => {
    const fixture = createFixture(t)
    const command = verb.toUpperCase()
    const lines = [
      `GEADEV:${command} BEGIN`,
      `GEADEV:${command} task=wifi priority=23 core=0 cpu_ticks=100`,
      ...(verb === 'netdiag' ? ['Wi-Fi RX/TX statistics: tx_success=42', 'GEADEV:NETDIAG wifi-dump-result=ESP_OK'] : []),
      `GEADEV:${command} END`
    ]
    const port = diagnosticPort([
      'unrelated startup output',
      `I (1234) gea: ${lines[0]}`,
      ...lines.slice(1),
      'output after the report',
      ''
    ].join('\n'))
    t.mock.method(SerialDevice, 'open', async (options) => {
      assert.equal(options.path, fixture.fakePort)
      return new SerialDevice(port, options)
    })
    const output = capture()

    assert.equal(await runGea(['devctl', verb, '--board', 'amoled', '--transport', 'usb'], {
      ...output.io, cwd: fixture.appDir, env: fixture.env
    }), 0)
    assert.deepEqual(port.requests, [`GEADEV ${command}`])
    assert.deepEqual(output.out, [lines.join('\n')])
    assert.equal(port.closed, true)
  })

  test(`devctl ${verb} reports firmware errors and releases USB`, async (t) => {
    const fixture = createFixture(t)
    const port = diagnosticPort(`GEADEV:ERR ${verb.toUpperCase()} unavailable\n`)
    t.mock.method(SerialDevice, 'open', async (options) => new SerialDevice(port, options))
    const output = capture()

    await assert.rejects(runGea(['devctl', verb, '--board', 'amoled'], {
      ...output.io, cwd: fixture.appDir, env: fixture.env
    }), new RegExp(`GEADEV:ERR ${verb.toUpperCase()} unavailable`))
    assert.deepEqual(output.out, [])
    assert.equal(port.closed, true)
  })

  test(`devctl ${verb} rejects WiFi without opening USB`, async (t) => {
    const fixture = createFixture(t)
    t.mock.method(SerialDevice, 'open', async () => assert.fail('must not open USB'))
    const output = capture()

    await assert.rejects(runGea(['devctl', verb, '--board', 'amoled-wifi', '--transport', 'wifi'], {
      ...output.io, cwd: fixture.appDir, env: fixture.env
    }), /needs the USB transport/)
  })
}

test('devctl diagnostics are listed in command help', async () => {
  const output = capture()
  assert.equal(await runGea(['devctl', 'help'], output.io), 0)
  assert.match(output.out.join('\n'), /\bnetdiag\b/)
  assert.match(output.out.join('\n'), /\btaskstats\b/)
})
