import { fail, ExitCode } from './errors.mjs'

export function debugFps(value) {
  if (value === undefined || value === '') return 0
  const fps = Number(value)
  if (typeof value === 'boolean' || !Number.isInteger(fps) || fps < 1 || fps > 120) fail('--debug-fps must be an integer from 1 to 120.', ExitCode.usage)
  return fps
}
