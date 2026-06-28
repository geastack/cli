import fs from 'node:fs'
import path from 'node:path'

import { flag, option, optionList, parseArgs } from './args.mjs'
import { createContext } from './context.mjs'
import { ExitCode, fail } from './errors.mjs'
import { exists, writeJson } from './fs-utils.mjs'

export async function runCreateGeastack(argv, io = {}) {
  const parsed = parseArgs(argv)
  const stdout = io.stdout || console.log
  const env = io.env || process.env
  const cwd = io.cwd || process.cwd()

  if (flag(parsed, 'help') || parsed.positionals[0] === 'help') {
    stdout(usage())
    return 0
  }

  const rawName = parsed.positionals[0]
  if (!rawName) fail('create-geastack requires an app name.', ExitCode.usage)

  const appId = slugify(option(parsed, 'id', rawName))
  if (!appId) fail(`Could not derive a valid app id from '${rawName}'.`, ExitCode.usage)

  const targetDir = path.resolve(cwd, option(parsed, 'dir', rawName))
  ensureWritableTarget(targetDir, flag(parsed, 'force'))

  const ctx = createContext(parsed, env, cwd)
  const displayName = option(parsed, 'name', titleFromId(appId))
  const targets = targetManifest(optionList(parsed, 'targets'))
  const coreDependency = option(parsed, 'core-dependency') || defaultCoreDependency(ctx, targetDir, flag(parsed, 'published'))

  fs.mkdirSync(targetDir, { recursive: true })
  writeJson(path.join(targetDir, 'package.json'), packageJson({ appId, displayName, targets, coreDependency }))
  fs.writeFileSync(path.join(targetDir, 'index.tsx'), indexTsx(displayName))
  fs.writeFileSync(path.join(targetDir, 'styles.css'), stylesCss())
  fs.writeFileSync(path.join(targetDir, 'index.html'), indexHtml(displayName))
  writeJson(path.join(targetDir, 'tsconfig.json'), tsconfigJson())
  fs.writeFileSync(path.join(targetDir, 'vite.config.ts'), viteConfigTs())
  fs.writeFileSync(path.join(targetDir, 'README.md'), readme({ appId, displayName }))

  stdout(`Created ${displayName} at ${targetDir}`)
  stdout(`Next: cd ${targetDir} && npm install && gea dev`)
  return 0
}

function ensureWritableTarget(targetDir, force) {
  if (!exists(targetDir)) return
  const entries = fs.readdirSync(targetDir).filter((entry) => entry !== '.DS_Store')
  if (entries.length > 0 && !force) {
    fail(`Target directory is not empty: ${targetDir}. Pass --force to write into it.`, ExitCode.usage)
  }
}

function targetManifest(requestedTargets) {
  const enabled = requestedTargets.length > 0 ? new Set(requestedTargets) : new Set(['web', 'esp32', 'geaos'])
  return {
    web: enabled.has('web'),
    esp32: enabled.has('esp32'),
    geaos: enabled.has('geaos'),
    macos: enabled.has('macos'),
    ios: enabled.has('ios')
  }
}

function defaultCoreDependency(ctx, targetDir, published) {
  if (!published && exists(path.join(ctx.corePackageDir, 'package.json'))) {
    return `file:${toPackageRelativePath(targetDir, ctx.corePackageDir)}`
  }
  return '^0.1.0'
}

function toPackageRelativePath(fromDir, toDir) {
  const relative = path.relative(fromDir, toDir) || '.'
  return relative.split(path.sep).join('/')
}

function packageJson({ appId, displayName, targets, coreDependency }) {
  return {
    name: `gea-${appId}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'gea dev',
      build: 'gea build --target web',
      check: 'tsc --noEmit'
    },
    dependencies: {
      '@geajs/core': '^1.3.0',
      '@geastack/core': coreDependency
    },
    devDependencies: {
      typescript: 'latest',
      vite: 'latest'
    },
    gea: {
      id: appId,
      name: displayName,
      entry: 'index.tsx',
      runtime: 'gea',
      targets
    },
    license: 'MIT'
  }
}

function indexTsx(displayName) {
  return `import { mount } from '@geastack/core'
import './styles.css'

function App() {
  return (
    <body class="app">
      <main class="panel">
        <p class="eyebrow">GeaStack</p>
        <h1>${escapeText(displayName)}</h1>
        <p class="copy">One TypeScript app, ready for simulator and native targets.</p>
      </main>
    </body>
  )
}

mount(App)
`
}

function stylesCss() {
  return `.app {
  width: 100vw;
  height: 100vh;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #101418;
  color: #f8fafc;
  font-family: Inter, system-ui, sans-serif;
}

.panel {
  width: min(320px, calc(100vw - 32px));
  padding: 24px;
  border: 1px solid #2dd4bf;
  background: #182026;
}

.eyebrow {
  margin: 0 0 8px;
  color: #2dd4bf;
  font-size: 12px;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  font-size: 28px;
}

.copy {
  margin: 12px 0 0;
  color: #cbd5e1;
}
`
}

function indexHtml(displayName) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeText(displayName)}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/index.tsx"></script>
  </body>
</html>
`
}

function tsconfigJson() {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM'],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      jsx: 'preserve',
      jsxImportSource: '@geajs/core',
      allowImportingTsExtensions: true
    },
    include: ['**/*.tsx', '**/*.ts', '**/*.d.ts'],
    exclude: ['vite.config.ts', 'dist']
  }
}

function viteConfigTs() {
  return `import { defineConfig } from 'vite'

export default defineConfig({
  root: __dirname,
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
`
}

function readme({ appId, displayName }) {
  return `# ${displayName}

GeaStack app id: \`${appId}\`.

\`\`\`sh
npm install
gea dev
gea build --target web
\`\`\`
`
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function titleFromId(id) {
  return id.split('-').filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')
}

function escapeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function usage() {
  return `Usage:
  create-geastack <name> [--dir <path>] [--id <app-id>] [--name <display-name>]

Options:
  --targets web,esp32,geaos,macos,ios
  --core-dependency <specifier>
  --published
  --force
`
}
