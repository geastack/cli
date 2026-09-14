import pc from 'picocolors'

// Colour for the handful of lines a reader scans for. picocolors turns itself
// off on pipes and under NO_COLOR, so scripted output stays plain.

export function success(write, line) {
  write(pc.green(line))
}

export function warn(write, line) {
  write(pc.yellow(line))
}

export function hint(write, line) {
  write(pc.dim(line))
}

export function heading(text) {
  return pc.bold(text)
}
