import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { flag, option, optionList, parseArgs } from './args.mjs'
import { createContext } from './context.mjs'
import { ExitCode, fail } from './errors.mjs'
import { exists, readJson, writeJson } from './fs-utils.mjs'
import { BACK, canPrompt, choose, confirm, createPrompt, ui } from './prompts.mjs'
import { runQuiet } from './run.mjs'
import {
  copyStarterFiles,
  discoverBundledStarters,
  discoverGithubExamples,
  fetchGithubExample,
  formatStarterChoice
} from './starter-catalog.mjs'

const cliPackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const cliVersion = cliPackage.version
// Versions the scaffold pins for packages the CLI itself does not depend on.
const starterDependencies = cliPackage.starterDependencies || {}
const coreDependencyDefault = starterDependencies['@geastack/core'] || 'latest'
const targetsDependencyDefault = starterDependencies['@geastack/targets'] || 'latest'
const starterFontPath = fileURLToPath(new URL('../starters/fonts/Inter-Regular.ttf', import.meta.url))

export async function runCreateGeastack(argv, io = {}) {
  const parsed = parseArgs(argv)
  const stdout = io.stdout || console.log
  const env = io.env || process.env
  const cwd = io.cwd || process.cwd()
  const commandName = io.commandName || 'create-geastack'

  if (flag(parsed, 'help') || parsed.positionals[0] === 'help') {
    stdout(usage(commandName))
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
  const coreDependency = option(parsed, 'core-dependency') || coreDependencyDefault
  const cliDependency = option(parsed, 'cli-dependency') || `^${cliVersion}`
  const starter = await resolveStarter(ctx, parsed, io)
  const entry = projectRelativePath(starter.starter?.entry || starter.example?.entry || 'src/index.tsx', 'entry')

  fs.mkdirSync(targetDir, { recursive: true })
  if (starter.kind === 'empty') {
    const entryPath = path.join(targetDir, entry)
    fs.mkdirSync(path.dirname(entryPath), { recursive: true })
    fs.writeFileSync(entryPath, indexTsx(displayName))
    fs.writeFileSync(path.join(path.dirname(entryPath), 'styles.css'), stylesCss())
    copyStarterFont(path.join(targetDir, 'assets', 'fonts'))
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
  const sourceManifest = sourcePackage.gea || starter.manifest || starter.starter?.manifest || starter.example?.manifest || {}
  const requestedTargets = optionList(parsed, 'targets')
  const targets = requestedTargets.length > 0
    ? targetManifest(requestedTargets)
    : starter.kind === 'empty'
      ? targetManifest(starter.targets || ['web'])
      : targetManifestFromObject(sourceManifest.targets)
  writeJson(path.join(targetDir, 'package.json'), packageJson({
    appId,
    displayName,
    targets,
    entry,
    coreDependency,
    cliDependency,
    sourcePackage,
    sourceManifest
  }))
  if (targets.web) ensureFile(path.join(targetDir, 'index.html'), () => indexHtml(displayName, entry))
  fs.mkdirSync(path.join(targetDir, '.gea'), { recursive: true })
  writeJson(path.join(targetDir, '.gea', 'boards.json'), {})
  ensureJson(path.join(targetDir, 'tsconfig.json'), () => tsconfigJson(targets))
  ensureFile(path.join(targetDir, '.gitignore'), gitignore)
  if (targets.web) ensureFile(path.join(targetDir, 'vite.config.ts'), viteConfigTs)
  fs.writeFileSync(path.join(targetDir, 'README.md'), readme({ appId, displayName, starter, targets }))

  const installDependencies = shouldInstallDependencies(parsed, io)
  if (installDependencies) {
    await runQuiet('npm', ['install'], {
      cwd: targetDir,
      env,
      dryRun: flag(parsed, 'dry-run'),
      verbose: flag(parsed, 'verbose'),
      label: 'Installing npm dependencies',
      logFile: path.join(targetDir, '.gea', 'npm-install.log'),
      failureCode: ExitCode.missingDependency,
      stdout
    })
  }

  const done = ui(io)
  done.step(`Created ${displayName} at ${targetDir}`, [
    starter.kind === 'bundled'
      ? `Starter: ${starter.starter.name}`
      : starter.kind === 'example'
        ? `Example: fetched ${starter.example.name}`
        : 'Starter: blank application'
  ])
  done.outro(installDependencies ? `Next: cd ${targetDir} && npx gea setup` : `Next: cd ${targetDir} && npm install && npx gea setup`)
  return 0
}

async function resolveStarter(ctx, parsed, io) {
  const interactive = canPrompt(io) && !flag(parsed, 'yes')
  const bundled = discoverBundledStarters(ctx)
  const examples = discoverGithubExamples(ctx, io.env || process.env)
  const requested = normalizeStarter(option(parsed, 'starter') || option(parsed, 'template') || '')
  const prompt = interactive ? createPrompt(io) : null
  try {
    // Each nested question offers Back, which returns to the top menu.
    while (true) {
      const starter = await resolveStarterOnce({ ctx, parsed, io, interactive, bundled, examples, requested, prompt })
      if (starter !== BACK) return starter
    }
  } finally {
    if (prompt) await prompt.close()
  }
}

async function resolveStarterOnce({ parsed, interactive, bundled, examples, requested, prompt }) {
  const mode = requested || await chooseStarterMode({ interactive, prompt, bundled, examples })

  if (mode === 'empty') {
    const requestedTargets = optionList(parsed, 'targets')
    if (!interactive || requestedTargets.length > 0) return { kind: 'empty' }

    const target = await chooseBlankTarget(prompt, { back: !requested })
    if (target === BACK) return BACK

    const enableBleOta = target === 'esp32'
      ? await confirm(prompt, {
          message: 'Enable wireless firmware updates over Bluetooth?',
          defaultValue: true
        })
      : false
    return {
      kind: 'empty',
      targets: [target],
      manifest: enableBleOta ? { ota: { ble: true } } : {}
    }
  }
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
    fail(`Unknown starter '${mode}'. Expected counter, blank, or example.`, ExitCode.usage)
  }

  // The gallery is every complete app the CLI can copy: bundled starters
  // first, then the GitHub examples.
  const gallery = [
    ...bundled.map((starter) => ({ kind: 'bundled', starter, id: starter.id, entry: starter })),
    ...examples.map((example) => ({ kind: 'example', example, id: example.id, entry: example }))
  ]
  if (gallery.length === 0) fail('No example applications are available. Use --starter blank.', ExitCode.usage)

  const requestedExample = option(parsed, 'example') || option(parsed, 'from-example') || ''
  const picked = requestedExample
    ? gallery.find((candidate) => candidate.id === requestedExample)
    : await chooseExample({ interactive, prompt, gallery, back: !requested })
  if (picked === BACK) return BACK
  if (!picked) {
    const available = gallery.map((candidate) => candidate.id).join(', ')
    fail(`Unknown starter example '${requestedExample}'. Available examples: ${available}`, ExitCode.usage)
  }

  return picked.kind === 'bundled' ? { kind: 'bundled', starter: picked.starter } : { kind: 'example', example: picked.example }
}

async function chooseStarterMode({ interactive, prompt, bundled, examples }) {
  if (!interactive) return bundled.length > 0 ? 'counter' : 'empty'
  return choose(prompt, {
    message: 'What do you want to build?',
    choices: [
      {
        value: 'empty',
        label: 'Blank application',
        description: 'A minimal screen for building your own Gea application.'
      },
      ...(bundled.length > 0 || examples.length > 0 ? [{
        value: 'example',
        label: 'Example application',
        description: 'Choose a complete application from the GeaStack example gallery.'
      }] : [])
    ],
    defaultValue: 'empty'
  })
}

async function chooseExample({ interactive, prompt, gallery, back }) {
  if (!interactive) {
    fail('Choosing --starter example in a non-interactive shell also requires --example <id>.', ExitCode.usage)
  }
  const id = await choose(prompt, {
    message: 'Example to copy',
    choices: gallery.map((candidate) => ({ value: candidate.id, label: formatStarterChoice(candidate.entry) })),
    defaultValue: gallery[0].id,
    back
  })
  if (id === BACK) return BACK

  return gallery.find((candidate) => candidate.id === id) || null
}

async function chooseBlankTarget(prompt, { back }) {
  return choose(prompt, {
    back,
    message: 'Where should this application run?',
    choices: [
      {
        value: 'web',
        label: 'Web browser',
        description: 'A browser app with a local development server.'
      },
      {
        value: 'esp32',
        label: 'ESP32 board',
        description: 'Native firmware for a supported ESP32 device.'
      },
      {
        value: 'rp2350',
        label: 'RP2350 board',
        description: 'Native firmware for a supported Raspberry Pi RP2350 device.'
      },
      {
        value: 'geaos',
        label: 'GeaOS device',
        description: 'A native application for GeaOS.'
      },
      {
        value: 'macos',
        label: 'macOS',
        description: 'A native Mac application.'
      },
      {
        value: 'ios',
        label: 'iPhone or iPad',
        description: 'A native iOS application.'
      },
      {
        value: 'android',
        label: 'Android',
        description: 'A native Android application.'
      },
      {
        value: 'windows',
        label: 'Windows',
        description: 'A native Windows desktop application.'
      }
    ],
    defaultValue: 'web'
  })
}

function ensureWritableTarget(targetDir, force) {
  if (!exists(targetDir)) return
  const entries = fs.readdirSync(targetDir).filter((entry) => entry !== '.DS_Store')
  if (entries.length > 0 && !force) {
    fail(`Target directory is not empty: ${targetDir}. Pass --force to write into it.`, ExitCode.usage)
  }
}

function targetManifest(requestedTargets) {
  const enabled = requestedTargets.length > 0 ? new Set(requestedTargets) : new Set(['web', 'esp32', 'rp2350', 'geaos'])
  return {
    web: enabled.has('web'),
    esp32: enabled.has('esp32'),
    rp2350: enabled.has('rp2350'),
    geaos: enabled.has('geaos'),
    macos: enabled.has('macos'),
    ios: enabled.has('ios'),
    android: enabled.has('android'),
    windows: enabled.has('windows')
  }
}

function targetManifestFromObject(targets = {}) {
  if (!targets || typeof targets !== 'object') return targetManifest([])
  return {
    web: targets.web === true,
    esp32: targets.esp32 === true,
    rp2350: targets.rp2350 === true,
    geaos: targets.geaos === true,
    macos: targets.macos === true,
    ios: targets.ios === true,
    android: targets.android === true,
    windows: targets.windows === true
  }
}

function packageJson({ appId, displayName, targets, entry, coreDependency, cliDependency, sourcePackage = {}, sourceManifest = {} }) {
  const geaManifest = {
    ...sourceManifest,
    id: appId,
    name: displayName,
    entry,
    targets
  }
  if (!geaManifest.runtime || geaManifest.runtime === 'gea') delete geaManifest.runtime

  return {
    name: `gea-${appId}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      ...(sourcePackage.scripts || {}),
      ...(targets.web ? { dev: 'gea dev', build: 'gea build --target web' } : {}),
      check: 'tsc --noEmit'
    },
    dependencies: {
      ...(sourcePackage.dependencies || {}),
      '@geajs/core': sourcePackage.dependencies?.['@geajs/core'] || '^1.3.0',
      '@geastack/core': coreDependency,
      '@geastack/cli': cliDependency,
      ...(needsTargetsPackage(targets) ? { '@geastack/targets': sourcePackage.dependencies?.['@geastack/targets'] || targetsDependencyDefault } : {}),
      ...(targets.windows ? { '@geastack/windows': sourcePackage.dependencies?.['@geastack/windows'] || windowsDependencyDefault } : {}),
      ...(targets.macos || targets.ios ? { '@geastack/apple': sourcePackage.dependencies?.['@geastack/apple'] || appleDependencyDefault } : {})
    },
    devDependencies: {
      ...(sourcePackage.devDependencies || {}),
      typescript: sourcePackage.devDependencies?.typescript || 'latest',
      ...(targets.web ? { vite: sourcePackage.devDependencies?.vite || 'latest' } : {})
    },
    gea: geaManifest,
    license: 'MIT'
  }
}

// Board firmware builds read the target project and board catalog from
// @geastack/targets; web and desktop apps do not need it.
function needsTargetsPackage(targets) {
  return targets.esp32 || targets.rp2350
}

// The Windows target ships inside @geastack/windows, resolved from the app's
// own dependencies by `gea build --target windows`.
const windowsDependencyDefault = '^0.1.0'

// The macOS and iOS targets ship inside @geastack/apple, resolved the same way
// by `gea build --target macos` and `gea build --target ios`. An app that
// declares either target without the package has nothing to build with.
const appleDependencyDefault = starterDependencies['@geastack/apple'] || '^0.2.9'

function indexTsx(displayName) {
  return `import { ReactiveComponent, mount } from '@geastack/core'
import './styles.css'

export class App extends ReactiveComponent {
  template() {
    return (
      <div class="app">
        <div class="panel">
          <span class="eyebrow">GEASTACK</span>
          <span class="title">${escapeText(displayName)}</span>
          <span class="copy">One TypeScript app, ready for simulator and native targets.</span>
        </div>
      </div>
    )
  }
}

mount(App)
`
}

// Embedded targets bake text from a TTF the app ships; without an @font-face
// the firmware falls back to a small bitmap font with a limited glyph set.
function copyStarterFont(fontsDir) {
  fs.mkdirSync(fontsDir, { recursive: true })
  fs.copyFileSync(starterFontPath, path.join(fontsDir, 'Inter-Regular.ttf'))
}

function stylesCss() {
  return `@font-face {
  font-family: 'Inter';
  src: url('../assets/fonts/Inter-Regular.ttf');
}

.app {
  display: flex;
  width: 100vw;
  height: 100vh;
  padding: 20px;
  align-items: center;
  background-color: #101418;
  color: #f8fafc;
  font-family: 'Inter';
}

.panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 10px;
  padding: 24px;
  border-width: 1px;
  border-color: #2dd4bf;
  background-color: #182026;
}

.eyebrow { color: #2dd4bf; font-size: 12px; }
.title { font-size: 28px; }
.copy { color: #cbd5e1; font-size: 15px; }
`
}

function indexHtml(displayName, entry = 'index.tsx') {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeText(displayName)}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/${entry}"></script>
  </body>
</html>
`
}

// No jsxImportSource: @geastack/core declares the JSX namespace itself, and
// naming @geajs/core here makes the firmware compiler type-check its minified
// runtime and refuse the build.
function tsconfigJson(targets) {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: targets.web ? ['ES2022', 'DOM'] : ['ES2022'],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      jsx: 'preserve',
      types: []
    },
    include: ['**/*.ts', '**/*.tsx', '**/*.d.ts'],
    exclude: ['node_modules', 'dist', '.gea', 'vite.config.ts']
  }
}

function gitignore() {
  return `node_modules/
dist/
.gea/build/
.env
`
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

function readme({ appId, displayName, starter, targets }) {
  const starterLine = starter.kind === 'example'
    ? `Started from GitHub example: \`${starter.example.name}\` (\`${starter.example.id}\`).`
    : starter.kind === 'bundled'
      ? `Started from bundled starter: \`${starter.starter.name}\` (\`${starter.starter.id}\`).`
      : 'Started from a blank app.'
  const commands = targets.web
    ? `npx gea setup
npx gea dev
npx gea build --target web`
    : targets.esp32
      ? `npx gea setup
npx gea build
npx gea flash --monitor`
      : targets.windows && !targets.macos
        ? `npx gea setup
npx gea build --target windows
npx gea run --target windows`
        : targets.ios && !targets.macos
          ? `npx gea setup
npx gea build --target ios
npx gea run --target ios`
          : `npx gea setup
npx gea build`
  return `# ${displayName}

GeaStack app id: \`${appId}\`.

${starterLine}

\`\`\`sh
${commands}
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

function projectRelativePath(value, label) {
  const normalized = path.posix.normalize(String(value || '').replaceAll('\\', '/')).replace(/^\.\//, '')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    fail(`--${label} must be a path inside the project.`, ExitCode.usage)
  }
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

function usage(commandName = 'create-geastack') {
  return `Usage:
  ${commandName} <name>

Run without options for guided setup. The CLI asks what you want to build and
derives the source layout, targets, and runtime configuration from your choice.

Options:
  --starter counter|blank|example
  --example <example-id>
  --no-install

Automation options:
  --dir <path>
  --id <app-id>
  --name <display-name>
  --examples-repo <git-url-or-local-path>
  --examples-ref <git-ref>
  --targets web,esp32,rp2350,geaos,macos,ios,android,windows
  --core-dependency <specifier>
  --cli-dependency <specifier>
  --install
  --dry-run
  --yes
  --force
`
}
