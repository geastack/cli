import fs from 'node:fs'
import path from 'node:path'

import { flag, option, optionList, parseArgs } from './args.mjs'
import { createContext } from './context.mjs'
import { ExitCode, fail } from './errors.mjs'
import { exists, readJson, writeJson } from './fs-utils.mjs'
import { canPrompt, choose, createPrompt } from './prompts.mjs'
import { runExternal } from './run.mjs'
import {
  copyStarterFiles,
  discoverBundledStarters,
  discoverGithubExamples,
  fetchGithubExample,
  formatStarterChoice
} from './starter-catalog.mjs'

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
  const coreDependency = option(parsed, 'core-dependency') || defaultCoreDependency(ctx, targetDir, flag(parsed, 'published'))
  const cliDependency = option(parsed, 'cli-dependency') || defaultCliDependency(ctx, targetDir, flag(parsed, 'published'))
  const starter = await resolveStarter(ctx, parsed, io)

  fs.mkdirSync(targetDir, { recursive: true })
  if (starter.kind === 'empty') {
    fs.writeFileSync(path.join(targetDir, 'index.tsx'), indexTsx(displayName))
    fs.writeFileSync(path.join(targetDir, 'styles.css'), stylesCss())
  } else if (starter.kind === 'bundled') {
    copyStarterFiles(starter.starter.root, targetDir)
  } else if (starter.kind === 'example') {
    const repo = option(parsed, 'examples-repo') || env.GEA_EXAMPLES_REPO || starter.example.repo
    const ref = option(parsed, 'examples-ref') || env.GEA_EXAMPLES_REF || starter.example.ref
    fetchGithubExample(starter.example, targetDir, {
      repo,
      ref,
      env,
      cwd,
      dryRun: flag(parsed, 'dry-run'),
      stdout
    })
  }

  const sourcePackage = readPackageJson(targetDir)
  const sourceManifest = sourcePackage.gea || starter.starter?.manifest || starter.example?.manifest || {}
  const targets = optionList(parsed, 'targets').length === 0
    ? targetManifestFromObject(sourceManifest.targets)
    : targetManifest(optionList(parsed, 'targets'))
  writeJson(path.join(targetDir, 'package.json'), packageJson({
    appId,
    displayName,
    targets,
    coreDependency,
    cliDependency,
    sourcePackage,
    sourceManifest
  }))
  ensureFile(path.join(targetDir, 'index.html'), () => indexHtml(displayName))
  fs.mkdirSync(path.join(targetDir, '.gea'), { recursive: true })
  writeJson(path.join(targetDir, '.gea', 'boards.json'), {})
  ensureJson(path.join(targetDir, 'tsconfig.json'), tsconfigJson)
  ensureFile(path.join(targetDir, 'vite.config.ts'), viteConfigTs)
  fs.writeFileSync(path.join(targetDir, 'README.md'), readme({ appId, displayName, starter }))

  const installDependencies = shouldInstallDependencies(parsed, io)
  if (installDependencies) {
    stdout('Installing npm dependencies...')
    runExternal('npm', ['install'], {
      cwd: targetDir,
      env,
      dryRun: flag(parsed, 'dry-run'),
      failureCode: ExitCode.missingDependency,
      stdout
    })
  }

  stdout(`Created ${displayName} at ${targetDir}`)
  if (starter.kind === 'bundled') stdout(`Starter: ${starter.starter.name}`)
  else if (starter.kind === 'example') stdout(`Example: fetched ${starter.example.name}`)
  else stdout('Starter: empty app')
  if (installDependencies) stdout(`Next: cd ${targetDir} && npx gea setup`)
  else stdout(`Next: cd ${targetDir} && npm install && npx gea setup`)
  return 0
}

async function resolveStarter(ctx, parsed, io) {
  const interactive = canPrompt(io) && !flag(parsed, 'yes')
  const bundled = discoverBundledStarters(ctx)
  const examples = discoverGithubExamples(ctx, io.env || process.env)
  const requested = normalizeStarter(option(parsed, 'starter') || option(parsed, 'template') || '')
  const prompt = interactive ? createPrompt(io) : null
  try {
    const mode = requested || await chooseStarterMode({ interactive, prompt, bundled, examples })

    if (mode === 'empty') return { kind: 'empty' }
    if (mode === 'bundled' || mode === 'counter') {
      const requestedBundled = mode === 'counter' ? 'counter' : option(parsed, 'bundled') || option(parsed, 'starter-id') || ''
      const starter = requestedBundled
        ? bundled.find((candidate) => candidate.id === requestedBundled)
        : bundled[0]
      if (!starter) {
        const available = bundled.map((candidate) => candidate.id).join(', ')
        fail(`Unknown bundled starter '${requestedBundled}'. Available starters: ${available}`, ExitCode.usage)
      }
      return { kind: 'bundled', starter }
    }
    if (mode !== 'example') {
      fail(`Unknown starter '${mode}'. Expected counter, empty, or example.`, ExitCode.usage)
    }
    if (examples.length === 0) {
      fail('No GitHub examples are available. Use --starter counter or --starter empty.', ExitCode.usage)
    }

    const requestedExample = option(parsed, 'example') || option(parsed, 'from-example') || ''
    const example = requestedExample
      ? examples.find((candidate) => candidate.id === requestedExample)
      : await chooseExample({ interactive, prompt, examples })
    if (!example) {
      const available = examples.map((candidate) => candidate.id).join(', ')
      fail(`Unknown starter example '${requestedExample}'. Available examples: ${available}`, ExitCode.usage)
    }
    return { kind: 'example', example }
  } finally {
    if (prompt) await prompt.close()
  }
}

async function chooseStarterMode({ interactive, prompt, bundled, examples }) {
  if (!interactive) return bundled.length > 0 ? 'counter' : 'empty'
  return choose(prompt, {
    message: 'Starter app',
    choices: [
      ...(bundled.length > 0 ? [{ value: 'counter', label: 'Counter starter - bundled minimal JSX app' }] : []),
      { value: 'empty', label: 'Empty app - minimal blank Gea app' },
      ...(examples.length > 0 ? [{ value: 'example', label: 'Rich example - fetch from GitHub examples repo' }] : [])
    ],
    defaultValue: bundled.length > 0 ? 'counter' : 'empty'
  })
}

async function chooseExample({ interactive, prompt, examples }) {
  if (!interactive) {
    fail('Choosing --starter example in a non-interactive shell also requires --example <id>.', ExitCode.usage)
  }
  const id = await choose(prompt, {
    message: 'Example to copy',
    choices: examples.map((example) => ({ value: example.id, label: formatStarterChoice(example) })),
    defaultValue: examples[0].id
  })
  return examples.find((example) => example.id === id) || null
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

function targetManifestFromObject(targets = {}) {
  if (!targets || typeof targets !== 'object') return targetManifest([])
  return {
    web: targets.web === true,
    esp32: targets.esp32 === true,
    geaos: targets.geaos === true,
    macos: targets.macos === true,
    ios: targets.ios === true
  }
}

function defaultCoreDependency(ctx, targetDir, published) {
  if (!published && exists(path.join(ctx.corePackageDir, 'package.json'))) {
    return `file:${toPackageRelativePath(targetDir, ctx.corePackageDir)}`
  }
  return '^0.1.0'
}

function defaultCliDependency(ctx, targetDir, published) {
  if (!published && exists(path.join(ctx.cliPackageRoot, 'package.json'))) {
    return `file:${toPackageRelativePath(targetDir, ctx.cliPackageRoot)}`
  }
  return '^0.1.0'
}

function toPackageRelativePath(fromDir, toDir) {
  const relative = path.relative(fromDir, toDir) || '.'
  return relative.split(path.sep).join('/')
}

function packageJson({ appId, displayName, targets, coreDependency, cliDependency, sourcePackage = {}, sourceManifest = {} }) {
  return {
    name: `gea-${appId}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      ...(sourcePackage.scripts || {}),
      dev: 'gea dev',
      build: 'gea build --target web',
      check: 'tsc --noEmit'
    },
    dependencies: {
      ...(sourcePackage.dependencies || {}),
      '@geajs/core': sourcePackage.dependencies?.['@geajs/core'] || '^1.3.0',
      '@geastack/core': coreDependency
    },
    devDependencies: {
      ...(sourcePackage.devDependencies || {}),
      '@geastack/cli': cliDependency,
      typescript: sourcePackage.devDependencies?.typescript || 'latest',
      vite: sourcePackage.devDependencies?.vite || 'latest'
    },
    gea: {
      ...sourceManifest,
      id: appId,
      name: displayName,
      entry: sourceManifest.entry || 'index.tsx',
      runtime: sourceManifest.runtime || 'gea',
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

function readme({ appId, displayName, starter }) {
  const starterLine = starter.kind === 'example'
    ? `Started from GitHub example: \`${starter.example.name}\` (\`${starter.example.id}\`).`
    : starter.kind === 'bundled'
      ? `Started from bundled starter: \`${starter.starter.name}\` (\`${starter.starter.id}\`).`
      : 'Started from an empty app.'
  return `# ${displayName}

GeaStack app id: \`${appId}\`.

${starterLine}

\`\`\`sh
npx gea setup
npx gea dev
npx gea build --target web
\`\`\`
`
}

function shouldInstallDependencies(parsed, io) {
  const explicit = option(parsed, 'install')
  if (explicit !== undefined) return explicit === true || explicit === 'true'
  return canPrompt(io)
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

function normalizeStarter(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return ''
  if (['empty', 'blank', 'minimal'].includes(normalized)) return 'empty'
  if (['counter', 'starter', 'bundled', 'hello', 'hello-world'].includes(normalized)) return normalized === 'counter' ? 'counter' : 'bundled'
  if (['example', 'examples', 'from-example', 'from_example'].includes(normalized)) return 'example'
  return normalized
}

function readPackageJson(targetDir) {
  const packagePath = path.join(targetDir, 'package.json')
  if (!exists(packagePath)) return {}
  return readJson(packagePath)
}

function ensureFile(filePath, create) {
  if (!exists(filePath)) fs.writeFileSync(filePath, create())
}

function ensureJson(filePath, create) {
  if (!exists(filePath)) writeJson(filePath, create())
}

function usage() {
  return `Usage:
  create-geastack <name> [--dir <path>] [--id <app-id>] [--name <display-name>]

Options:
  --starter counter|empty|example
  --example <example-id>
  --examples-repo <git-url-or-local-path>
  --examples-ref <git-ref>
  --targets web,esp32,geaos,macos,ios
  --core-dependency <specifier>
  --cli-dependency <specifier>
  --published
  --install / --no-install
  --dry-run
  --yes
  --force
`
}
