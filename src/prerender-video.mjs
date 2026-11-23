import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export function videoTime(value) {
  const match = typeof value === 'string' && /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(value)

  if (!match) return NaN

  return Math.round(Number(match[1]) * (match[2] === 's' ? 1000 : 1))
}

export async function encodePrerenderVideo({ executable, cwd, env, out, width, height, dpr, fps, quality = 8, start, end }) {
  const temporary = out + '.' + randomUUID() + '.mp4'
  const encoder = spawn(env.GEA_FFMPEG || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', width + 'x' + height,
    '-framerate', String(fps), '-i', 'pipe:0', '-an', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v', 'libx264', '-crf', String(50 - quality * 4), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', temporary,
  ], { cwd, env, stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true })
  const native = spawn(executable, [
    '--gea-prerender-video', '-', ...[width, height, dpr, fps, start, end].map(String),
  ], { cwd, env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })

  const done = (child, label) => new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new Error(label + ' could not start: ' + error.message)))
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(label + ' failed (' + (signal ?? code) + ')'))
    })
  })
  const encoding = done(encoder, 'FFmpeg')
  const rendering = done(native, 'Native prerender')
  const frameCount = (BigInt(end - start) * BigInt(fps) + 999n) / 1000n
  const expectedBytes = frameCount * BigInt(width * height * 4)
  let receivedBytes = 0n
  const measure = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += BigInt(chunk.length)
      callback(null, chunk)
    },
  })
  const transfer = pipeline(native.stdout, measure, encoder.stdin)

  try {
    await Promise.all([encoding, rendering, transfer])
    if (receivedBytes !== expectedBytes) {
      throw new Error('Native prerender returned an incomplete or invalid raw video stream')
    }
    await rename(temporary, out)
  } catch (error) {
    native.kill()
    encoder.kill()
    await Promise.allSettled([encoding, rendering, transfer])
    throw error
  } finally {
    await rm(temporary, { force: true })
  }
}
