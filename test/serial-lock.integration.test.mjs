import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { SerialDevice, geadev } from '../src/device/serial.mjs'

const devicePath = process.env.GEA_SERIAL_TEST_PORT

test(
  'serial ownership rejects another process immediately and releases the port on close',
  { skip: !devicePath, timeout: 20000 },
  async () => {
    const first = await SerialDevice.open({ path: devicePath })
    try {
      assert.match(await geadev.ping(first), /^GEADEV:PONG(?:\s|$)/)
      const script = `
      const {SerialDevice}=await import(${JSON.stringify(new URL('../src/device/serial.mjs', import.meta.url).href)});
      try { const serial=await SerialDevice.open({path:process.argv[1]});await serial.close();process.exitCode=1; }
      catch(error) { if(!/already in use/.test(error.message))throw error;console.log(error.message); }
    `
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, devicePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (chunk) => (output += chunk))
      child.stderr.on('data', (chunk) => (output += chunk))
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      assert.equal(code, 0, output)
      assert.match(output, /already in use/)
      assert.match(
        await geadev.ping(first),
        /^GEADEV:PONG(?:\s|$)/,
        'the rejected contender did not consume replies',
      )
    } finally {
      await first.close()
    }
    const reopened = await SerialDevice.open({ path: devicePath })
    try {
      assert.match(await geadev.ping(reopened), /^GEADEV:PONG(?:\s|$)/)
    } finally {
      await reopened.close()
    }
  },
)
