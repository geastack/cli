import fs from 'node:fs'
import path from 'node:path'
import { resolveAppSourcePath } from '../manifest.mjs'

const families = ['css-line-height', 'css-display-explicit', 'css-width-percent', 'css-height-percent', 'css-custom-properties', 'css-margins', 'css-padding', 'css-flex-factors', 'css-gap', 'css-border-widths', 'css-border-colors', 'css-font-weight', 'css-text-align', 'css-white-space', 'css-text-overflow', 'css-flex-direction', 'css-justify-content', 'css-align-items', 'css-box-sizing', 'css-margin-auto', 'css-line-height-multiplier', 'css-width-expressions', 'css-min-height', 'css-max-width', 'css-active-background', 'css-pseudo-elements', 'css-text-alpha', 'css-border-alpha', 'css-animations', 'css-transforms', 'css-grid', 'css-floats', 'css-writing-mode', 'css-border-relief', 'css-blink', 'css-order', 'css-percent-radius', 'css-percent-gap', 'css-opacity', 'css-text-decoration', 'css-text-transform', 'css-visibility', 'css-pointer-events', 'css-mask', 'css-image-fit', 'css-filters', 'css-box-shadow', 'css-flex-wrap', 'css-justify-items', 'css-align-content', 'css-align-self', 'css-min-width', 'css-height-expressions', 'css-z-index', 'css-aspect-ratio', 'css-margin-trim', 'css-containment', 'css-justify-self', 'css-flex-line-count', 'css-box-expressions', 'css-axis-gap', 'css-corner-radius', 'css-first-line', 'css-side-borders', 'css-background-layers', 'css-line-height-expressions', 'css-scrolling', 'css-flex-basis-expressions', 'css-custom-property-lengths', 'css-max-height', 'css-flex-basis', 'css-overflow-axes', 'css-position-top', 'css-position-top-percent', 'css-position-right', 'css-position-right-percent', 'css-position-bottom', 'css-position-bottom-percent', 'css-position-left', 'css-position-left-percent']
const sourceExtension = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|S)$/
const ignored = new Set(['.git', '.gea', 'node_modules', 'build', 'dist', '.build', '.venv'])
const privateUiHeader = /(?:^|\/)(?:node(?:_model|_lifecycle)?|tree(?:_internal|_state)?|style(?:_values)?|document|internal|view_element|text_element)\.h$/

export function nativeCssSourceNeedsSupport(text) {
  // Native code using the mutable UI API can pass computed property names or
  // values at runtime. Retain all CSS automatically in that case. Read-only
  // inspection has a distinct header and exposes no mutable node/style data.
  if (/#\s*include\s+(?![<"])[A-Za-z_]/.test(text)) return true
  for (const match of text.matchAll(/#\s*include\s*[<"]([^>"\n]+)[>"]/g)) {
    const header = match[1].replaceAll('\\', '/')
    if (header.endsWith('ui/tree_inspection.h')) continue
    if (header.startsWith('css/') || header.startsWith('ui/') || privateUiHeader.test(header)) return true
  }
  return /\b(?:AnimationEngine|DeclarativeAnimations|ComputedStyle|StyleSheet|CssCompiledValue|CssDeclarationId|NodeText|NodeType|NodeClassList|ImageElement|InputElement|VirtualKeyboard)\b|\bProperty\s*::|(?:\.|->)\s*(?:style|cssText)\b|\b(?:setClassName|classList|setProperty|applyTransformComponentsFast|applyTransformSlotsFast|setDevicePixelRatio|setViewportMetrics|gea_style_set_device_pixel_ratio|gea_style_set_viewport_metrics)\s*\(/.test(text)
}

// App-supplied native drawing has no source-level CSS radius bound. Keep its
// span caches without unnecessarily retaining unrelated CSS fields.
export function nativeCircleSourceNeedsSupport(text) {
  return /#\s*include\s*[<"](?:[^>"\n]*\/)?(?:canvas|display|canvas_element)\.h[>"]|\b(?:Canvas|CanvasElement|CanvasContext|CircleEntry|Display)\b|\b(?:fillCircle\w*|strokeCircle|fillRoundedRect\w*|strokeRoundedRect|drawImageCircle|drawImageRounded)\b/.test(text)
}

export function withNativeCssFeatures(app, features) {
  if (!features.includes('renderer-occlusion-v1') && !features.includes('node-analysis-v1') && !features.includes('node-aux-v1') && !features.includes('css-storage-v1') && !features.some(feature => /^node-class-capacity-v1-[123]$/.test(feature)) && !features.some(feature => /^css-analysis-v(?:[1-9]|1[0123456789])$/.test(feature))) return features
  const sources = app.nativeSources || []
  const components = app.targetConfig?.esp32?.componentDirs || []
  if (!sources.length && !components.length) return features
  // The TS proof cannot bound custom native triangle producers, including
  // rendering hidden behind external headers or callback registration.
  features = [...new Set([...features, 'renderer-occlusion-triangles', 'node-listeners', 'node-attributes', 'node-default-styles'])]
  // Opaque native CSS writes can supply gradient/transform values even when
  // every source-visible custom property is a literal colour. Keep their
  // renderer caches as well as semantic fields.
  const retain = () => [...new Set([...features.filter(feature => !feature.startsWith('node-class-capacity-') && !feature.startsWith('node-class-storage-')), ...families, 'node-images', 'node-inputs', 'css-ranges-unknown', 'css-circle-cache-unbounded', 'renderer-circles', 'renderer-occlusion-triangles', 'renderer-transforms', 'renderer-linear-gradients', 'renderer-radial-gradients'])].sort()
  const root = path.resolve(app.root)
  const headers = new Map()
  const seen = new Set()
  const pending = []
  let opaque = false
  function walk(dir, collectSources = false) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) walk(file, collectSources)
      } else if (sourceExtension.test(entry.name)) {
        if (/\.(?:h|hh|hpp|hxx)$/.test(entry.name)) {
          const matches = headers.get(entry.name) || []
          matches.push(file)
          headers.set(entry.name, matches)
        }
        if (collectSources) pending.push(file)
      } else if (collectSources && /\.(?:a|so|dylib|lib)$/.test(entry.name)) opaque = true
    }
  }
  try {
    walk(root)
    for (const source of sources) {
      const resolved = resolveAppSourcePath(root, source)
      if (!resolved || !resolved.startsWith(root + path.sep)) return retain()
      pending.push(resolved)
    }
    for (const component of components) {
      const dir = path.resolve(root, component)
      if (!dir.startsWith(root + path.sep)) return retain()
      walk(dir, true)
    }
    while (pending.length && !opaque) {
      const file = pending.pop()
      if (seen.has(file)) continue
      seen.add(file)
      const text = fs.readFileSync(file, 'utf8')
      if (nativeCircleSourceNeedsSupport(text)) features = [...new Set([...features, 'css-circle-cache-unbounded', 'renderer-circles'])]
      if (nativeCssSourceNeedsSupport(text)) return retain()
      // Follow app headers, including headers provided by another component's
      // include directory. ESP-IDF and C/C++ platform headers do not depend on
      // the UI engine. An external native package is opaque above.
      for (const match of text.matchAll(/#\s*include\s*[<"]([^>"\n]+)[>"]/g)) {
        const header = match[1]
        const local = path.resolve(path.dirname(file), header)
        if (fs.existsSync(local)) pending.push(local)
        else for (const candidate of headers.get(path.basename(header)) || []) pending.push(candidate)
      }
    }
  } catch {
    return retain()
  }
  return opaque ? retain() : features
}
