// PATH is spelled `Path` in a Windows environment. process.env answers
// `env.PATH` regardless because Node makes it case-insensitive there, but a
// plain object copied from it (`{ ...process.env, GEA_X: ... }`, which is how
// every child environment in this CLI is built) keeps the original key only,
// and `env.PATH` on that copy is undefined. Writing `PATH` next to `Path`
// then leaves two keys, and the child process picks one of them: on Windows
// it took the freshly written one, which held only the ESP-IDF tool dirs, so
// cmake could not find node or git and no ESP32 target could configure.
// Every read and write of PATH goes through here so there is only ever one
// key, whatever it is called.
export function envPathKey(env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, 'PATH')) return 'PATH'
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH'
}

export function envPath(env = process.env) {
  return String(env[envPathKey(env)] || '')
}

export function withEnvPath(env, value) {
  return { ...env, [envPathKey(env)]: value }
}
