import path from 'node:path'
import fs from 'node:fs'
/** Explicit app-owned static archives; never arbitrary linker flags or search paths. */
export function resolveNativeLink(root, target, config = {}) {
  const realRoot = fs.realpathSync(root)
  const libraries = config.nativeLibraries ?? []
  const frameworks = config.frameworks ?? []
  const includeDirectories = config.nativeIncludeDirectories ?? []
  const systemLibraries = config.nativeSystemLibraries ?? []
  for (const [name, values] of [['nativeLibraries', libraries], ['frameworks', frameworks], ['nativeIncludeDirectories', includeDirectories], ['nativeSystemLibraries', systemLibraries]]) {
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value)) throw new Error(`${name} must be an array of nonempty strings`)
  }
  if (libraries.length && !['macos', 'raspberry-pi-os'].includes(target)) throw new Error(`nativeLibraries are not supported by ${target}`)
  if (frameworks.length && target !== 'macos') throw new Error('frameworks are supported only by macos')
  if ((includeDirectories.length || systemLibraries.length) && target !== 'raspberry-pi-os') throw new Error('Native include/system library extensions are supported only by raspberry-pi-os')
  const includes = includeDirectories.map(value => {
    if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..') || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid nativeIncludeDirectories entry')
    const directory = fs.realpathSync(path.join(realRoot,value)), relative=path.relative(realRoot,directory)
    if (relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative) || !fs.statSync(directory).isDirectory()) throw new Error('nativeIncludeDirectories escapes app or is not directory')
    return directory
  })
  for (const name of systemLibraries) if (!/^[A-Za-z][A-Za-z0-9_.+-]*$/.test(name)) throw new Error('Invalid nativeSystemLibraries identifier')
  const resolved = libraries.map(value => {
    if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..') || /[\x00-\x1f\x7f]/.test(value) || !value.endsWith('.a')) throw new Error(`Invalid nativeLibraries archive: ${value}`)
    const file = fs.realpathSync(path.join(realRoot, value))
    const relative = path.relative(realRoot, file)
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.statSync(file).isFile()) throw new Error(`nativeLibraries archive escapes app or is not regular: ${value}`)
    const fd = fs.openSync(file, 'r')
    try {
      const magic = Buffer.alloc(8)
      if (fs.readSync(fd, magic, 0, 8, 0) !== 8 || magic.toString() !== '!<arch>\n') throw new Error(`nativeLibraries requires a regular static archive: ${value}`)
    } finally { fs.closeSync(fd) }
    return file
  })
  for (const name of frameworks) if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid framework: ${name}`)
  return { nativeLibraries: [...new Set(resolved)], frameworks: [...new Set(frameworks)], nativeIncludeDirectories: [...new Set(includes)], nativeSystemLibraries: [...new Set(systemLibraries)] }
}
