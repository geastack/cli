// Windows ships `npm`, `npx` and the ESP-IDF installer as `.cmd`/`.bat` shims
// rather than real executables. Without a shell, spawn resolves neither
// PATHEXT nor those shims, so the call dies with ENOENT, and Node refuses to
// launch a batch file directly anyway (CVE-2024-27980) — the shell is the only
// way through. cmd.exe gets one flat string either way, so we quote the parts
// and join them ourselves rather than handing spawn an argument array it would
// only concatenate unescaped (DEP0190).
export function spawnArgs(command, args, options = {}) {
  if (process.platform !== 'win32' || options.shell) return [command, args, options]
  return [[command, ...args].map(quoteForCmd).join(' '), [], { ...options, shell: true }]
}

function quoteForCmd(value) {
  const text = String(value)
  if (text !== '' && !/[\s"^&|<>()!,;=]/.test(text)) return text
  // Backslashes only escape a quote, so the run that meets the closing quote
  // has to be doubled; embedded quotes take a backslash of their own.
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
}
