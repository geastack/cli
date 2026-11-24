import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function pngChunk(type, data) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length)
  header.write(type, 4)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(data, crc32(header.subarray(4))))
  return [header, data, checksum]
}

export async function writePrerenderFrames({ executable, cwd, env, out, width, height, dpr, fps, start, end }) {
  await mkdir(out)
  const args = ['--gea-prerender-video', '-', ...[width, height, dpr, fps, start, end].map(String)]
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  // Resolve errors so a failure while consuming stdout cannot leave an unhandled rejection.
  const result = new Promise((resolve) => {
    child.once('error', resolve)
    child.once('close', (code, signal) => resolve(code === 0 ? null : new Error(`Native prerender failed (${signal ?? code})`)))
  })

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6 // RGBA
  const prefix = [signature, ...pngChunk('IHDR', header)]
  const suffix = pngChunk('IEND', Buffer.alloc(0))
  const rowBytes = width * 4
  const rows = Buffer.alloc((rowBytes + 1) * height)
  const expected = Math.ceil(((end - start) * fps) / 1000)
  const digits = Math.max(6, String(expected - 1).length)
  let count = 0
  let offset = 0

  try {
    for await (const chunk of child.stdout) {
      let position = 0
      while (position < chunk.length) {
        if (count === expected) throw new Error('Native prerender returned more frames than requested')
        const row = Math.floor(offset / rowBytes)
        const column = offset % rowBytes
        const length = Math.min(rowBytes - column, chunk.length - position)
        chunk.copy(rows, row * (rowBytes + 1) + column + 1, position, position + length)
        offset += length
        position += length

        if (offset === rowBytes * height) {
          const name = `frame-${String(count).padStart(digits, '0')}.png`
          const png = Buffer.concat([...prefix, ...pngChunk('IDAT', deflateSync(rows)), ...suffix])
          await writeFile(join(out, name), png, { flag: 'wx' })
          count++
          offset = 0
        }
      }
    }
    const error = await result
    if (error) throw error
    if (count !== expected || offset !== 0) throw new Error('Native prerender returned an incomplete PNG sequence')
    return count
  } catch (error) {
    child.kill()
    const nativeError = await result
    throw new Error(`PNG sequence stopped after ${count} complete frame(s): ${nativeError?.code === 'ENOENT' ? nativeError.message : error.message}`, { cause: error })
  }
}
