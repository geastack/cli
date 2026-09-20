import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const ICON_SIZES = [32, 64, 128, 256, 512]

export const ICON_STYLE_SYSTEM_PROMPT = [
  'GeaOS app icons must preserve a clean retro-synthwave identity: night-mode arcade OS energy, dark futuristic depth, neon cyan, magenta, violet, hot pink, electric blue, and amber accents.',
  'The style is clean synthwave emblem design, not flat corporate glyphs and not messy AI neon art. Use a bold vector-like central symbol with restrained neon rim light, subtle glow, glossy glass or chrome accents only where they clarify the shape.',
  'Each icon uses one large central glyph occupying about 75-85% of the canvas. The glyph must read as a single silhouette at 32x32 pixels, with at most one or two tiny synthwave accents such as a horizon line, small grid tick, glow edge, or motion streak.',
  'Use hard 90-degree square canvas corners and fill the whole source image edge to edge. The background may be a simple dark gradient or two-tone synthwave field, but should not become a scene.',
  'Use only a small palette per icon: one dark synthwave background, one high-contrast foreground color, and one or two neon accents. No beige corporate palette, no default teal set, no pastel mobile icon look, and no monochrome white pictogram on black.',
  'Diversify the set with different dark background hues, neon accent colors, and symbol silhouettes. Adjacent icons should not share the same dominant color or silhouette family.',
  'Proper app icon composition only: one simple symbol or one symbol plus one tiny accent. No poster scenes, no literal landscapes, no many-object compositions, no decorative clutter, no particles, no starfields, no cityscapes.',
  'Do not put the icon inside an inner rounded square, squircle, app mask, tile, badge, device frame, or inset plate. The full canvas itself is the square icon.',
  'No readable text anywhere: no words, app names, captions, dates, clock times, labels, digits, keypad numbers, UI numerals, or letter badges. Use ticks, dots, bars, abstract glyph shapes, and iconography instead.',
  'Use a clean centered subject with strong silhouette, no UI chrome, no device mockup, and enough contrast to read clearly at 32x32 pixels.'
].join(' ')

const APP_ICON_PALETTES = {
  'analog-clock': 'midnight teal to black background, ivory clock glyph, electric cyan and amber rim accents',
  'app-launcher': 'deep indigo background, neon magenta and cyan app dots, amber center glow',
  'bouncing-balls': 'electric blue background, hot pink and amber balls, cyan motion arc',
  'bouncing-balls-jsx': 'violet background, cyan and coral balls, amber highlight',
  'button-tetris': 'ultramarine background, cyan magenta and amber blocks, hot pink button',
  'camera-showcase': 'black to jade background, ivory lens glyph, cyan aperture glow, coral capture accent',
  'canvas-3d': 'black background, cyan wireframe cube, magenta and amber axis ticks',
  'counter-jsx': 'deep purple background, ivory control glyphs, cyan magenta amber meter accents',
  'css-3d-cube': 'cobalt to black background, cyan cube, magenta face, amber transform arc',
  'css-animation-showcase': 'black to plum background, cyan keyframe squares, hot pink motion curve',
  'dialer': 'deep indigo background, cyan keypad dots, magenta handset curve, amber call accent',
  'direct-psram-balls': 'black to olive background, cyan memory chip, magenta amber data balls',
  'gea-companion': 'black to coral background, cyan linked companion nodes, violet edge accent',
  'hid-clicker': 'black to violet background, ivory remote glyph, cyan buttons, amber signal chevron',
  'image-jsx': 'midnight teal background, ivory image frame, magenta mountain, amber sun',
  'ios-device-showcase': 'ultramarine background, cyan nested surface glyphs, magenta and amber component accents',
  'ios-metal-shader-demo': 'black to plum background, cyan shader prism, magenta facet, amber edge',
  'ios-metal-showcase': 'cobalt background, cyan faceted metal mark, violet shadow, amber core',
  'ios-metal-world-game': 'black to burgundy background, cyan horizon ring, magenta terrain facets, amber notch',
  'ios-native-showcase': 'deep jade background, ivory native-control glyph, cyan toggle, hot pink accent',
  'notes-jsx': 'plum background, ivory note glyph, cyan lines, hot pink folded corner',
  'notes-native': 'midnight teal background, ivory document glyph, cyan lines, amber folded corner',
  'sky-hop': 'black to violet background, ivory leap glyph, cyan edge glow, hot pink platform',
  'sky-hop-jsx': 'black to burgundy background, ivory comet glyph, magenta trail, amber platform',
  'static-card': 'black to plum background, cyan layout glyph, ivory bars, hot pink thumbnail block',
  'stopwatch-jsx': 'black to orange background, ivory stopwatch glyph, cyan dial ticks, hot pink hand accent',
  'tic-tac-toe': 'black to burgundy background, cyan board lines, hot pink and amber tokens',
  'tilt-breakout': 'midnight teal background, cyan bricks, ivory paddle, hot pink ball accent',
  'todo-jsx': 'black to jade background, ivory checklist marks, cyan rows, magenta accent',
  'typography': 'plum background, ivory abstract type curves, cyan baseline, amber pen accent',
  'virtual-list': 'black to indigo background, cyan list rows, hot pink highlighted viewport',
  'watch': 'midnight teal background, ivory watch face, cyan ticks, amber hand accent',
  'watch-analog': 'cobalt to black background, ivory clock face, cyan ticks, magenta hand accent',
  'watch-date': 'black to burgundy background, ivory calendar glyph, cyan date blocks, hot pink empty date block'
}

const APP_ICON_DIRECTIONS = {
  'analog-clock': [
    'For Analog Clock, use a bold analog clock symbol: circular face, thick hands, simple tick marks.',
    'Do not show readable numbers, text, or a flat clock glyph.'
  ],
  'app-launcher': [
    'For App Launcher, use a simple launcher hub symbol: five to seven app dots arranged around a central dot.',
    'Do not show a phone home screen, orbital scene, or many tiny icons.'
  ],
  'bouncing-balls': [
    'For Balls Canvas, use three bold balls and one simple bounce arc.',
    'Do not show flat colored dots inside a black rounded tile.'
  ],
  'bouncing-balls-jsx': [
    'For Balls JSX, use a simple cluster of three balls in varied sizes.',
    'Do not show flat emoji-like circles, a simple molecule, or a black rounded tile.'
  ],
  'button-tetris': [
    'For Tetris, use three tetromino blocks and one small arcade button accent.',
    'Do not show a flat Tetris board inside a rounded black app tile.'
  ],
  'camera-showcase': [
    'For Camera, use a bold camera lens symbol with one simple capture beam or aperture mark.',
    'Do not show a flat white camera pictogram or rounded black camera icon.'
  ],
  'canvas-3d': [
    'For Canvas 3D, use one clean wireframe cube or mesh diamond with three short axis ticks.',
    'Do not show a simple flat white cube outline on black.'
  ],
  'counter-jsx': [
    'For Counter, use a compact counter badge with plus/minus buttons and three abstract indicator bars.',
    'Do not show readable digits, tally marks, hash marks, a calculator, or a flat white glyph.'
  ],
  'css-3d-cube': [
    'For CSS 3D Cube, use one solid isometric cube with simple face shading and a short transform arc.',
    'Do not show a plain flat cube pictogram or a generic box logo.'
  ],
  'css-animation-showcase': [
    'For CSS Animations, use three keyframe squares connected by one smooth motion curve.',
    'Do not show a static flat slider, plain CSS badge, or rounded black tile.'
  ],
  'dialer': [
    'For Dialer, use a simple keypad matrix of unlabeled dots with a small handset curve.',
    'Do not show readable keypad numbers, a flat handset glyph, white keypad dots, or old phone clipart.'
  ],
  'direct-psram-balls': [
    'For Direct PSRAM Balls, use one memory chip and three small balls moving through it.',
    'Do not show generic computer hardware without the animated-ball/performance idea.'
  ],
  'hid-clicker': [
    'For HID Clicker, use a compact presentation remote with two buttons and one small signal chevron.',
    'Use plain round or triangular control buttons with no play icon, no app video symbol, and no screen UI.',
    'Do not show a human hand, finger press, tap target, Wi-Fi logo, accessibility tap icon, generic touch gesture, or media player remote.'
  ],
  'image-jsx': [
    'For Image, use a simple image-frame symbol with mountain and sun shapes.',
    'Do not show a flat green mountain photo icon or a rounded black image tile.'
  ],
  'ios-device-showcase': [
    'For iOS Device Showcase, use nested flat surface panels and component blocks.',
    'Do not show a phone outline, tablet outline, device mockup, home button, notch, screen UI, or rounded inner app tile.'
  ],
  'ios-metal-shader-demo': [
    'For iOS Metal Shader Demo, use one faceted shader prism or angular lightning shard.',
    'Do not show a rounded square tile, app mask, letter mark, device, gradient mesh, or detailed scene.'
  ],
  'ios-metal-showcase': [
    'For iOS Metal Showcase, use one faceted metal prism, diamond, or triangular core mark.',
    'Do not show a rounded square tile, app mask, letter mark, device, gradient mesh, or detailed scene.'
  ],
  'ios-metal-world-game': [
    'For iOS Metal World Game, use a simplified abstract world mark: horizon arc, compass notch, or terrain facets inside a bold ring.',
    'Do not show a helmet, character, gear, weapon, readable logo, map scene, or rounded inner app tile.'
  ],
  'ios-native-showcase': [
    'For iOS Native Showcase, use a clean native-controls symbol: one toggle, one segmented bar, and one simple control dot.',
    'Do not show a bird, animal, mascot, phone mockup, app window, rounded inner app tile, or letter mark.'
  ],
  'notes-jsx': [
    'For Notes JSX, use one note page with two or three thick content lines and a folded corner.',
    'Do not show readable writing, app UI chrome, a notebook spiral, or a rounded inner app tile.'
  ],
  'notes-native': [
    'For Notes Native, use one document page with two or three thick content lines and a folded corner.',
    'Do not show readable writing, app UI chrome, a notebook spiral, or a rounded inner app tile.'
  ],
  'sky-hop': [
    'For Sky Hop, use a simple leaping comet or wing shape above one platform.',
    'Do not show a blue daytime sky, white clouds, green grass, cute cartoon mascot, black stick-figure silhouette, side-scroller mobile game tile, or rounded sky-blue app icon.'
  ],
  'sky-hop-jsx': [
    'For Sky Hop JSX, use a simple leaping comet or wing shape above one platform.',
    'Do not show a blue daytime sky, white clouds, green grass, cute cartoon mascot, black stick-figure silhouette, side-scroller mobile game tile, or rounded sky-blue app icon.'
  ],
  'static-card': [
    'For Static Card, use a single UI content-card symbol: one header bar, two body bars, one thumbnail block.',
    'This is a software layout card, not a playing card.',
    'Do not show playing cards, card suits, spades, hearts, clubs, diamonds, tarot cards, deck cards, or casino imagery.'
  ],
  'stopwatch-jsx': [
    'For Stopwatch, use a bold stopwatch face with tick marks and two hands.',
    'Do not show readable numbers, text, or a flat white stopwatch pictogram on black.'
  ],
  'tilt-breakout': [
    'For Breakout, use one tilted paddle, one ball, and four or five simple bricks.',
    'Do not show a flat brick wall and paddle inside a rounded black tile.'
  ],
  'tic-tac-toe': [
    'For Tic Tac Toe, use a bold 3x3 board with abstract cross and ring tokens.',
    'Do not show a flat textbook grid, plain red/blue marks on black, or a simple classroom game diagram.'
  ],
  'todo-jsx': [
    'For Todos, use a checklist symbol with three check rows.',
    'Do not show a flat blue clipboard app icon or generic checklist emoji.'
  ],
  'typography': [
    'For Typography, use abstract font curves, baseline ticks, and a pen-nib shape.',
    'Letterlike shapes are allowed here, but do not render readable words, a single flat T icon, or plain white typography on black.'
  ],
  'virtual-list': [
    'For Virtual List, use a stack of list rows with one highlighted viewport row.',
    'Do not show flat up/down arrows, accessibility glyphs, or a generic menu icon.'
  ],
  'watch': [
    'For Watch, use a bold watch-face symbol with ticks and hands, no full watch device.',
    'Do not show readable clock time, dates, numbers, text, or a real device mockup.'
  ],
  'watch-analog': [
    'For Analog Watch, use an analog watch-face symbol with ticks and hands, no full watch device.',
    'Do not show readable numbers, text, or a real device mockup.'
  ],
  'watch-date': [
    'For Date, use a calendar/date symbol with abstract blocks, ticks, and one small empty window.',
    'Do not show readable dates, words, clock time, numbers, or text.'
  ]
}

function appSpecificIconDirection(app) {
  return (APP_ICON_DIRECTIONS[app.id] || []).join(' ')
}

export function iconPrompt(app) {
  const description = app.launcher.description ? ` Purpose: ${app.launcher.description}.` : ''
  const appSpecific = appSpecificIconDirection(app)
  const palette = APP_ICON_PALETTES[app.id]
  return [
    ICON_STYLE_SYSTEM_PROMPT,
    `Create square launcher source art for a tiny wearable operating system app named "${app.name}".`,
    description,
    palette ? `Assigned synthwave palette for this exact app: ${palette}. Use these colors as the dominant palette; do not default to teal unless teal is explicitly named here.` : '',
    appSpecific,
    'Make the result a proper clean synthwave app icon: simple, bold, centered, iconic, luminous, and readable at tiny sizes.'
  ].filter(Boolean).join(' ')
}

function iconSheetConcept(app, index) {
  const description = app.launcher.description ? ` ${app.launcher.description}.` : ''
  const direction = appSpecificIconDirection(app)
  const palette = APP_ICON_PALETTES[app.id] ? ` Palette: ${APP_ICON_PALETTES[app.id]}.` : ''
  return `${index + 1}. ${app.name} (${app.id}):${description}${palette} ${direction}`.trim()
}

export function iconStyleSheetPrompt(apps, { columns = 5 } = {}) {
  const rows = Math.ceil(apps.length / columns)
  return [
    ICON_STYLE_SYSTEM_PROMPT,
    'Create ONE style approval contact sheet, not final production assets.',
    `The sheet is a clean ${columns} column by ${rows} row grid of square icon concepts with even gutters. Each cell shows one full square icon concept.`,
    'Do not put text, numbers, labels, captions, or app names inside the image. The list below is only generation guidance.',
    'Make the set cohesive, but deliberately vary dominant colors and silhouettes from cell to cell.',
    'Every cell should be a proper clean synthwave app icon: one large readable luminous symbol, hard square corners, dark synthwave background, restrained glow, no clutter.',
    'Prefer iconic reduction over literal depiction. If an app concept is complex, reduce it to the simplest recognizable geometric mark.',
    'Generate concepts in this exact order:',
    apps.map(iconSheetConcept).join('\n')
  ].join('\n')
}

async function generateImagePng({ prompt, model, apiKey }) {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'high',
      output_format: 'png'
    })
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = body?.error?.message || `${response.status} ${response.statusText}`
    throw new Error(`OpenAI image generation failed: ${message}`)
  }
  const b64 = body?.data?.[0]?.b64_json
  if (!b64) throw new Error('OpenAI image generation returned no b64_json')
  return Buffer.from(b64, 'base64')
}

async function generateSourcePng({ app, model, apiKey }) {
  return generateImagePng({ prompt: iconPrompt(app), model, apiKey })
}

async function resizeWithSharp(sourcePath, outputPath, size) {
  const sharp = await import('sharp').then((mod) => mod.default || mod).catch(() => null)
  if (!sharp) return false
  await sharp(sourcePath).resize(size, size, { fit: 'cover' }).png().toFile(outputPath)
  return true
}

function resizeWithSips(sourcePath, outputPath, size) {
  const result = spawnSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), sourcePath, '--out', outputPath], {
    encoding: 'utf8'
  })
  return result.status === 0
}

async function writeResizedIconSet(sourcePath, iconDir) {
  for (const size of ICON_SIZES) {
    const outputPath = path.join(iconDir, `icon-${size}.png`)
    const resized = await resizeWithSharp(sourcePath, outputPath, size)
    if (!resized && !resizeWithSips(sourcePath, outputPath, size)) {
      throw new Error('Icon resizing requires the optional sharp package or macOS sips.')
    }
  }
}

export async function generateIconSet({ repoRoot, app, model, apiKey = process.env.OPENAI_API_KEY }) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is required to generate icons')
  const iconDir = path.resolve(repoRoot, app.root, 'icons')
  mkdirSync(iconDir, { recursive: true })
  const sourcePath = path.join(iconDir, 'icon-source.png')
  const source = await generateSourcePng({ app, model, apiKey })
  writeFileSync(sourcePath, source)
  await writeResizedIconSet(sourcePath, iconDir)
  return ICON_SIZES.map((size) => path.join(iconDir, `icon-${size}.png`))
}

export async function generateIconStyleSheet({
  apps,
  model,
  outputPath,
  columns = 5,
  apiKey = process.env.OPENAI_API_KEY
}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is required to generate icon style sheets')
  const prompt = iconStyleSheetPrompt(apps, { columns })
  mkdirSync(path.dirname(outputPath), { recursive: true })
  const sheet = await generateImagePng({ prompt, model, apiKey })
  writeFileSync(outputPath, sheet)
  writeFileSync(outputPath.replace(/\.[^.]+$/, '.prompt.txt'), prompt)
  return { outputPath, prompt }
}

async function generateOneIconSet({ repoRoot, app, model }) {
  console.error(`[gea] generating icons for ${app.id} with ${model}`)
  const oldSource = path.resolve(repoRoot, app.root, 'icons', 'icon-source.png')
  if (existsSync(oldSource)) rmSync(oldSource, { force: true })
  await generateIconSet({ repoRoot, app, model })
  console.error(`[gea] generated icons for ${app.id}`)
}

export async function generateIconSets({ repoRoot, apps, model, concurrency = 1 }) {
  const queue = [...apps]
  const failures = []
  const workerCount = Math.max(1, Math.min(concurrency, queue.length || 1))

  async function worker() {
    while (queue.length > 0) {
      const app = queue.shift()
      try {
        await generateOneIconSet({ repoRoot, app, model })
      } catch (error) {
        failures.push(error)
        console.error(`[gea] failed icons for ${app.id}: ${error.message}`)
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  if (failures.length > 0) {
    throw new Error(`${failures.length} icon generation job(s) failed:\n${failures.map((error) => error.message).join('\n')}`)
  }
}

export function packageIconConfig() {
  return Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icons/icon-${size}.png`]))
}

export function iconSourceExists(repoRoot, app) {
  return existsSync(path.resolve(repoRoot, app.root, 'icons', 'icon-source.png'))
}

export function iconBytes(repoRoot, app, size) {
  return readFileSync(path.resolve(repoRoot, app.root, 'icons', `icon-${size}.png`))
}
