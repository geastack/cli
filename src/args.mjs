export function parseArgs(argv) {
  const options = {}
  const positionals = []
  const passthrough = []
  let pass = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (pass) {
      passthrough.push(arg)
      continue
    }
    if (arg === '--') {
      pass = true
      continue
    }
    if (arg === '-h') {
      setOption(options, 'help', true)
      continue
    }
    if (arg === '-v') {
      setOption(options, 'version', true)
      continue
    }
    if (arg.startsWith('--')) {
      const raw = arg.slice(2)
      if (raw.startsWith('no-') && !raw.includes('=')) {
        setOption(options, raw.slice(3), false)
        continue
      }
      const eq = raw.indexOf('=')
      if (eq !== -1) {
        setOption(options, raw.slice(0, eq), raw.slice(eq + 1))
        continue
      }
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        setOption(options, raw, next)
        i += 1
      } else {
        setOption(options, raw, true)
      }
      continue
    }
    positionals.push(arg)
  }

  return { options, positionals, passthrough }
}

export function option(parsed, name, fallback = undefined) {
  const value = parsed.options[name]
  if (value === undefined) return fallback
  return Array.isArray(value) ? value[value.length - 1] : value
}

export function optionList(parsed, name) {
  const value = parsed.options[name]
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function flag(parsed, name) {
  return option(parsed, name, false) !== false && option(parsed, name, false) !== undefined
}

function setOption(options, name, value) {
  if (options[name] === undefined) {
    options[name] = value
  } else if (Array.isArray(options[name])) {
    options[name].push(value)
  } else {
    options[name] = [options[name], value]
  }
}
