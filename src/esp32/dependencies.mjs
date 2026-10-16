import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function selectDependencies(catalog, capabilities) {
  const dependencies = {}
  for (const [name, entry] of Object.entries(catalog)) {
    if (entry.when.some(capability => capabilities[capability] === true)) {
      // This component aggregates SDKs used by the application, so their headers
      // and compile requirements must propagate beyond the aggregate itself.
      dependencies[name] = { ...entry.dependency, require: 'public' }
    }
  }
  return dependencies
}

export function prepareCapabilityDependencies(targetDir, buildDir, capabilities) {
  const file = path.join(targetDir, 'main', 'gea-dependencies.json')
  if (!existsSync(file)) {
    const manifest = path.join(targetDir, 'main', 'idf_component.yml')
    if (existsSync(manifest) && readFileSync(manifest, 'utf8').includes('$GEA_EMBEDDED_CAPABILITY_')) {
      throw new Error('This target uses legacy environment-based SDK selection. Update @geastack/targets together with @geastack/cli.')
    }
    return ''
  }
  const dependencies = selectDependencies(JSON.parse(readFileSync(file, 'utf8')), capabilities)
  const directory = path.join(buildDir, 'gea_app_dependencies')
  mkdirSync(directory, { recursive: true })
  for (const [name, contents] of [
    ['idf_component.yml', JSON.stringify({ dependencies }, null, 2) + '\n'],
    ['CMakeLists.txt', 'idf_component_register()\n'],
  ]) {
    const destination = path.join(directory, name)
    if (!existsSync(destination) || readFileSync(destination, 'utf8') !== contents) writeFileSync(destination, contents)
  }
  return directory
}
