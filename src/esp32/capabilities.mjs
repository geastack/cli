import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { ExitCode, fail } from '../errors.mjs'
import { exists } from '../fs-utils.mjs'
import { withNativeCssFeatures } from './native-css-features.mjs'

// What the firmware must link for this app. The compiler analyses the entry
// (with the gea plugin) and reports the host bindings the program reaches;
// a network stack, the BLE host and the audio pipeline are only built when
// something actually uses them.
const networkBindings = ['wifi', 'fetch', 'http', 'websocket', 'rtc']

const cssFeatureDefines = [
  ['css-transforms', 'GEA_CSS_TRANSFORMS'],
  ['css-grid', 'GEA_CSS_GRID'],
  ['css-floats', 'GEA_CSS_FLOATS'],
  ['css-writing-mode', 'GEA_CSS_WRITING_MODE'],
  ['css-border-relief', 'GEA_CSS_BORDER_RELIEF']
]

const cssV2FeatureDefines = [
  ['css-blink', 'GEA_CSS_BLINK'],
  ['css-order', 'GEA_CSS_ORDER'],
  ['css-percent-radius', 'GEA_CSS_PERCENT_RADIUS'],
  ['css-percent-gap', 'GEA_CSS_PERCENT_GAP']
]

const cssV3FeatureDefines = [
  ['css-opacity', 'GEA_CSS_OPACITY'],
  ['css-text-decoration', 'GEA_CSS_TEXT_DECORATION'],
  ['css-text-transform', 'GEA_CSS_TEXT_TRANSFORM'],
  ['css-visibility', 'GEA_CSS_VISIBILITY'],
  ['css-pointer-events', 'GEA_CSS_POINTER_EVENTS'],
  ['css-mask', 'GEA_CSS_MASK'],
  ['css-image-fit', 'GEA_CSS_IMAGE_FIT']
]

const cssV4FeatureDefines = [
  ['css-filters', 'GEA_CSS_FILTERS'],
  ['css-box-shadow', 'GEA_CSS_BOX_SHADOW'],
  ['css-flex-wrap', 'GEA_CSS_FLEX_WRAP'],
  ['css-justify-items', 'GEA_CSS_JUSTIFY_ITEMS'],
  ['css-align-content', 'GEA_CSS_ALIGN_CONTENT'],
  ['css-align-self', 'GEA_CSS_ALIGN_SELF'],
  ['css-min-width', 'GEA_CSS_MIN_WIDTH'],
  ['css-height-expressions', 'GEA_CSS_HEIGHT_EXPRESSIONS']
]

const cssV5FeatureDefines = [
  ['css-z-index', 'GEA_CSS_Z_INDEX'],
  ['css-aspect-ratio', 'GEA_CSS_ASPECT_RATIO'],
  ['css-margin-trim', 'GEA_CSS_MARGIN_TRIM'],
  ['css-containment', 'GEA_CSS_CONTAINMENT'],
  ['css-justify-self', 'GEA_CSS_JUSTIFY_SELF'],
  ['css-flex-line-count', 'GEA_CSS_FLEX_LINE_COUNT'],
  ['css-box-expressions', 'GEA_CSS_BOX_EXPRESSIONS']
]

const cssV6FeatureDefines = [
  ['css-axis-gap', 'GEA_CSS_AXIS_GAP'],
  ['css-corner-radius', 'GEA_CSS_CORNER_RADIUS']
]

const cssV7FeatureDefines = [['css-first-line', 'GEA_CSS_FIRST_LINE']]

const cssV8FeatureDefines = [
  ['css-side-borders', 'GEA_CSS_SIDE_BORDERS'],
  ['css-background-layers', 'GEA_CSS_BACKGROUND_LAYERS'],
  ['css-line-height-expressions', 'GEA_CSS_LINE_HEIGHT_EXPRESSIONS']
]
const cssV9FeatureDefines = [['css-scrolling', 'GEA_CSS_SCROLLING']]
const cssV10FeatureDefines = [['css-flex-basis-expressions', 'GEA_CSS_FLEX_BASIS_EXPRESSIONS'], ['css-custom-property-lengths', 'GEA_CSS_CUSTOM_PROPERTY_LENGTHS']]
const cssV11FeatureDefines = [['css-max-height', 'GEA_CSS_MAX_HEIGHT'], ['css-flex-basis', 'GEA_CSS_FLEX_BASIS'], ['css-overflow-axes', 'GEA_CSS_OVERFLOW_AXES']]
const cssV12FeatureDefines = [['css-position-top', 'GEA_CSS_POSITION_TOP'], ['css-position-top-percent', 'GEA_CSS_POSITION_TOP_PERCENT'], ['css-position-right', 'GEA_CSS_POSITION_RIGHT'], ['css-position-right-percent', 'GEA_CSS_POSITION_RIGHT_PERCENT'], ['css-position-bottom', 'GEA_CSS_POSITION_BOTTOM'], ['css-position-bottom-percent', 'GEA_CSS_POSITION_BOTTOM_PERCENT'], ['css-position-left', 'GEA_CSS_POSITION_LEFT'], ['css-position-left-percent', 'GEA_CSS_POSITION_LEFT_PERCENT']]
const cssV13FeatureDefines = [['css-animations', 'GEA_CSS_ANIMATIONS']]
const cssV14FeatureDefines = [['css-text-alpha', 'GEA_CSS_TEXT_ALPHA'], ['css-border-alpha', 'GEA_CSS_BORDER_ALPHA']]
const cssV15FeatureDefines = [['css-pseudo-elements', 'GEA_CSS_PSEUDO_ELEMENTS']]
const cssV16FeatureDefines = [['css-flex-direction', 'GEA_CSS_FLEX_DIRECTION'], ['css-justify-content', 'GEA_CSS_JUSTIFY_CONTENT'], ['css-align-items', 'GEA_CSS_ALIGN_ITEMS'], ['css-box-sizing', 'GEA_CSS_BOX_SIZING'], ['css-margin-auto', 'GEA_CSS_MARGIN_AUTO'], ['css-line-height-multiplier', 'GEA_CSS_LINE_HEIGHT_MULTIPLIER'], ['css-width-expressions', 'GEA_CSS_WIDTH_EXPRESSIONS'], ['css-min-height', 'GEA_CSS_MIN_HEIGHT'], ['css-max-width', 'GEA_CSS_MAX_WIDTH'], ['css-active-background', 'GEA_CSS_ACTIVE_BACKGROUND']]
const cssV17FeatureDefines = [['css-margins', 'GEA_CSS_MARGINS'], ['css-padding', 'GEA_CSS_PADDING'], ['css-flex-factors', 'GEA_CSS_FLEX_FACTORS'], ['css-gap', 'GEA_CSS_GAP'], ['css-border-widths', 'GEA_CSS_BORDER_WIDTHS'], ['css-border-colors', 'GEA_CSS_BORDER_COLORS'], ['css-font-weight', 'GEA_CSS_FONT_WEIGHT'], ['css-text-align', 'GEA_CSS_TEXT_ALIGN'], ['css-white-space', 'GEA_CSS_WHITE_SPACE'], ['css-text-overflow', 'GEA_CSS_TEXT_OVERFLOW']]
const cssV18FeatureDefines = [['css-custom-properties', 'GEA_CSS_CUSTOM_PROPERTIES']]
const cssV19FeatureDefines = [['css-width-percent', 'GEA_CSS_WIDTH_PERCENT'], ['css-height-percent', 'GEA_CSS_HEIGHT_PERCENT']]
const cssFeatureVersions = [cssFeatureDefines, cssV2FeatureDefines, cssV3FeatureDefines, cssV4FeatureDefines, cssV5FeatureDefines, cssV6FeatureDefines, cssV7FeatureDefines, cssV8FeatureDefines, cssV9FeatureDefines, cssV10FeatureDefines, cssV11FeatureDefines, cssV12FeatureDefines, cssV13FeatureDefines, cssV14FeatureDefines, cssV15FeatureDefines, cssV16FeatureDefines, cssV17FeatureDefines, cssV18FeatureDefines, cssV19FeatureDefines]

const rendererFeatureDefines = [
  ['renderer-circles', 'GEA_EMBEDDED_RENDERER_CIRCLES'],
  ['renderer-transforms', 'GEA_EMBEDDED_RENDERER_TRANSFORMS'],
  ['renderer-linear-gradients', 'GEA_EMBEDDED_RENDERER_LINEAR_GRADIENTS'],
  ['renderer-radial-gradients', 'GEA_EMBEDDED_RENDERER_RADIAL_GRADIENTS']
]

const triangleOcclusionMacro = 'GEA_EMBEDDED_RENDERER_TRIANGLE_OCCLUSION'
const circleCacheMacros = ['GEA_EMBEDDED_CANVAS_CIRCLE_RADIUS_MAX', 'GEA_EMBEDDED_CANVAS_CIRCLE_BOX_SPAN_MAX', 'GEA_EMBEDDED_CANVAS_CIRCLE_SPAN_MAX', 'GEA_EMBEDDED_CANVAS_CIRCLE_BOX_SPAN_SLOTS']
const rangeFamilies = ['padding', 'gap', 'border', 'radius', 'font', 'line-height', 'flex']
const compactStyleDefines = [['css-line-height', 'GEA_CSS_LINE_HEIGHT'], ['css-display-explicit', 'GEA_CSS_DISPLAY_EXPLICIT']]
const nodeAuxFeatureDefines = [['node-listeners', 'GEA_UI_NODE_LISTENERS'], ['node-attributes', 'GEA_UI_NODE_ATTRIBUTES'], ['node-default-styles', 'GEA_UI_DEFAULT_STYLES']]
const nodeFeatureDefines = [['node-images', 'GEA_UI_IMAGE_NODES'], ['node-inputs', 'GEA_UI_INPUT_NODES']]
const rangeMacro = family => `GEA_CSS_U8_${family.replaceAll('-', '_').toUpperCase()}`

export function withRendererFeatureDefines(defines, features, { devicePixelRatio } = {}) {
  // An older plugin knows nothing about renderer features. Absence without the
  // version marker is not proof of unreachability: retain engine defaults.
  const generatedNames = new Set([...rendererFeatureDefines, ...cssFeatureVersions.flat(), ...nodeFeatureDefines, ...nodeAuxFeatureDefines, ...compactStyleDefines].map(([, name]) => name).concat(triangleOcclusionMacro, circleCacheMacros, rangeFamilies.map(rangeMacro), ['GEA_UI_CLASS_INLINE_TOKENS', 'GEA_UI_CLASS_OVERFLOW']))
  generatedNames.add('GEA_RUNTIME_REALMS')
  const result = defines.split(';').filter((define) => define && !generatedNames.has(define.split('=')[0]))
  if (features.includes('worker-realms')) result.push('GEA_RUNTIME_REALMS=1')
  if (features.includes('node-analysis-v1')) {
    for (const [feature, name] of nodeFeatureDefines) result.push(`${name}=${features.includes(feature) ? 1 : 0}`)
  }
  const storageProofs = features.filter(feature => feature.startsWith('css-storage-'))
  if (storageProofs.length && storageProofs.every(proof => proof === 'css-storage-v1')) {
    for (const [feature, name] of compactStyleDefines)
      result.push(`${name}=${features.includes(feature) || features.includes('node-inputs') || features.includes('node-images') ? 1 : 0}`)
  }
  const auxiliaryProofs = features.filter(feature => feature.startsWith('node-aux-'))
  if (auxiliaryProofs.length && auxiliaryProofs.every(proof => proof === 'node-aux-v1')) {
    for (const [feature, name] of nodeAuxFeatureDefines)
      result.push(`${name}=${features.includes(feature) || features.includes('node-inputs') || features.includes('node-images') ? 1 : 0}`)
  }
  const classBounds = features.filter(feature => feature.startsWith('node-class-capacity-v1-')).map(feature => feature.slice('node-class-capacity-v1-'.length))
  if (!features.includes('node-inputs') && !features.includes('node-images') && classBounds.length && classBounds.every(bound => /^[123]$/.test(bound))) {
    result.push(`GEA_UI_CLASS_INLINE_TOKENS=${Math.max(...classBounds.map(Number))}`)
    const storageProofs = features.filter(feature => feature.startsWith('node-class-storage-'))
    const complete = classBounds.every(bound => storageProofs.includes(`node-class-storage-v1-${bound}`))
    if (complete && storageProofs.every(proof => /^node-class-storage-v1-[123]$/.test(proof)) &&
        storageProofs.every(proof => classBounds.includes(proof.slice('node-class-storage-v1-'.length))))
      result.push('GEA_UI_CLASS_OVERFLOW=0')
  }
  const occlusionProofs = features.filter(feature => /^renderer-occlusion-v/.test(feature))
  if (occlusionProofs.length && occlusionProofs.every(feature => feature === 'renderer-occlusion-v1'))
    result.push(`${triangleOcclusionMacro}=${features.includes('renderer-occlusion-triangles') ? 1 : 0}`)
  if (features.includes('renderer-analysis-v1')) {
    for (const [feature, name] of rendererFeatureDefines) result.push(`${name}=${features.includes(feature) ? 1 : 0}`)
  }
  // Each marker proves only families known to that analyzer. Future/unknown
  // markers retain defaults until this CLI explicitly understands them.
  const version = cssFeatureVersions.reduce((known, _, index) => features.includes(`css-analysis-v${index + 1}`) ? index + 1 : known, 0)
  const sizePercentProofs = features.filter(feature => feature.startsWith('css-analysis-'))
  const completeSizePercentProof = sizePercentProofs.length > 0 && sizePercentProofs.every(feature => feature === 'css-analysis-v19')
  for (const families of cssFeatureVersions.slice(0, version)) {
    if (families === cssV19FeatureDefines && !completeSizePercentProof) continue
    for (const [feature, name] of families) {
      const nativeDefaults = /^(?:GEA_CSS_TEXT_ALPHA|GEA_CSS_BORDER_ALPHA|GEA_CSS_WIDTH_PERCENT|GEA_CSS_HEIGHT_PERCENT)$/.test(name) && (features.includes('node-inputs') || features.includes('node-images'))
      result.push(`${name}=${features.includes(feature) || nativeDefaults ? 1 : 0}`)
    }
  }
  // Width selection needs a positive whole-program range proof as well as
  // the actual layout DPR. Unknown/older analyzers keep the engine's wide types.
  if (features.includes('css-ranges-v1')) {
    const definedRatio = result.findLast(define => define.startsWith('GEA_EMBEDDED_CSS_LAYOUT_DEVICE_PIXEL_RATIO='))?.split('=')[1]
    const ratio = devicePixelRatio ?? (definedRatio === undefined ? 1 : Number(definedRatio))
    const known = !features.includes('css-ranges-unknown') && Number.isFinite(ratio) && ratio > 0
    for (const family of rangeFamilies) {
      const bound = unit => {
        const prefix = `css-range-${family}-${unit}-`
        const values = features.filter(feature => feature.startsWith(prefix)).map(feature => feature.slice(prefix.length))
        return values.length === 1 && /^\d+$/.test(values[0]) && Number.isSafeInteger(Number(values[0])) ? Number(values[0]) : Infinity
      }
      const maximum = Math.max(bound('raw'), bound('px') * ratio)
      result.push(`${rangeMacro(family)}=${known && maximum <= 255 ? 1 : 0}`)
      // Bound all circle paths only with the separate imperative-drawing proof.
      // Effects/borders may expand a painted radius beyond its CSS border box.
      const unboundedEffects = ['renderer-transforms', 'css-box-shadow', 'css-border-widths', 'css-border-relief', 'css-filters', 'css-text-decoration']
      if (family === 'radius' && version >= 18 && known && Number.isFinite(maximum) &&
          features.includes('renderer-analysis-v1') && features.includes('css-circle-cache-v1') &&
          !features.includes('css-circle-cache-unbounded') &&
          features.filter(feature => feature.startsWith('css-circle-cache-')).every(feature => feature === 'css-circle-cache-v1') && !unboundedEffects.some(feature => features.includes(feature))) {
        const radius = Math.max(1, Math.ceil(maximum))
        result.push(`${circleCacheMacros[0]}=${Math.min(63, radius)}`)
        // roundedRectIsCircleLike accepts floor(side / 2) - 1 <= radius,
        // so the largest square using the box cache is 2 * radius + 3.
        result.push(`${circleCacheMacros[1]}=${Math.min(128, radius * 2 + 3)}`)
        result.push(`${circleCacheMacros[2]}=${Math.min(32, radius * 2)}`)
        // The box shortcut starts at side 16. Retain one slot for every
        // possible cached side, up to the existing capacity of sixteen.
        result.push(`${circleCacheMacros[3]}=${Math.max(1, Math.min(16, radius * 2 + 3 - 15))}`)
      }
    }
  }
  return result.join(';')
}

export function parseAnalysis(output) {
  const bindings = output.match(/^bindings=(.*)$/m)?.[1]?.split(';').filter(Boolean) ?? []
  const features = output.match(/^features=(.*)$/m)?.[1]?.split(';').filter(Boolean) ?? []
  return { bindings, features }
}

export function manifestRequestsBleOta(packageJson) {
  return packageJson?.gea?.ota?.ble === true
}

export function analyzeApp(ctx, app, { env = ctx.env || process.env } = {}) {
  const compiler = path.join(ctx.compilerPackageDir || '', 'dist', 'cli.js')
  const plugin = path.join(ctx.pluginPackageDir || '', 'dist', 'index.js')
  if (!ctx.compilerPackageDir || !exists(compiler)) {
    fail(`@geastack/compiler is not installed in this project (expected ${compiler}).`, ExitCode.missingDependency)
  }
  if (!ctx.pluginPackageDir || !exists(plugin)) {
    fail(`@geastack/geatsc-plugin-gea is not installed in this project (expected ${plugin}).`, ExitCode.missingDependency)
  }
  const output = execFileSync(process.execPath, [compiler, 'analyze', path.join(app.root, app.entry), '--plugin', plugin], {
    cwd: ctx.compilerPackageDir,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'inherit']
  })
  return parseAnalysis(output)
}

export function resolveAppCapabilities(ctx, app, options = {}) {
  const analysis = analyzeApp(ctx, app, options)
  const bindings = new Set(analysis.bindings)
  const features = new Set(withNativeCssFeatures(app, analysis.features))
  const manifestBleOta = manifestRequestsBleOta(app.packageJson)
  return {
    network: networkBindings.some((binding) => bindings.has(binding)) || features.has('https') || app.packageJson?.gea?.ota?.wifi === true,
    ble: bindings.has('ble') || manifestBleOta,
    bleApi: bindings.has('ble'),
    audio: bindings.has('audio'),
    bindings: [...bindings].sort(),
    features: [...features].sort()
  }
}
