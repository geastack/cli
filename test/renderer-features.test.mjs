import assert from 'node:assert/strict'
import test from 'node:test'
import { withRendererFeatureDefines } from '../src/esp32/capabilities.mjs'

test('analyzed apps automatically prune all unused renderer storage, despite size knobs', () => {
  assert.equal(withRendererFeatureDefines('GEA_EMBEDDED_UI_TRANSFORM_CACHE_SLOTS=64;APP_FLAG=1', ['renderer-analysis-v1']),
    'GEA_EMBEDDED_UI_TRANSFORM_CACHE_SLOTS=64;APP_FLAG=1;GEA_EMBEDDED_RENDERER_CIRCLES=0;GEA_EMBEDDED_RENDERER_TRANSFORMS=0;GEA_EMBEDDED_RENDERER_LINEAR_GRADIENTS=0;GEA_EMBEDDED_RENDERER_RADIAL_GRADIENTS=0')
})

test('used and conservative dynamic features enable just the analyzed caches', () => {
  assert.equal(withRendererFeatureDefines('', ['renderer-analysis-v1', 'renderer-transforms', 'renderer-radial-gradients']),
    'GEA_EMBEDDED_RENDERER_CIRCLES=0;GEA_EMBEDDED_RENDERER_TRANSFORMS=1;GEA_EMBEDDED_RENDERER_LINEAR_GRADIENTS=0;GEA_EMBEDDED_RENDERER_RADIAL_GRADIENTS=1')
})

test('older analyzers retain full engine defaults and app flags cannot override the analysis', () => {
  assert.equal(withRendererFeatureDefines('APP_FLAG=1', []), 'APP_FLAG=1')
  assert.equal(withRendererFeatureDefines('GEA_EMBEDDED_RENDERER_TRANSFORMS=0', ['renderer-analysis-v1', 'renderer-transforms']),
    'GEA_EMBEDDED_RENDERER_CIRCLES=0;GEA_EMBEDDED_RENDERER_TRANSFORMS=1;GEA_EMBEDDED_RENDERER_LINEAR_GRADIENTS=0;GEA_EMBEDDED_RENDERER_RADIAL_GRADIENTS=0')
})


test('CSS semantic support is automatically specialized without manifest flags', () => {
  const result = withRendererFeatureDefines('APP_FLAG=1', ['css-analysis-v1'])
  assert.equal(result, 'APP_FLAG=1;GEA_CSS_TRANSFORMS=0;GEA_CSS_GRID=0;GEA_CSS_FLOATS=0;GEA_CSS_WRITING_MODE=0;GEA_CSS_BORDER_RELIEF=0')
})

test('app-defined CSS overrides cannot contradict compiler reachability', () => {
  const result = withRendererFeatureDefines('GEA_CSS_TRANSFORMS=0;GEA_CSS_GRID=1', ['css-analysis-v1', 'css-transforms'])
  assert.match(result, /GEA_CSS_TRANSFORMS=1/)
  assert.match(result, /GEA_CSS_GRID=0/)
  assert.equal(withRendererFeatureDefines('GEA_CSS_TRANSFORMS=0', []), '')
})


import { nativeCssSourceNeedsSupport, withNativeCssFeatures } from '../src/esp32/native-css-features.mjs'

test('native UI mutation conservatively retains CSS without app switches', () => {
  for (const source of [
    '#include "ui/style.h"', '#include "tree_internal.h"', '#include NATIVE_UI_HEADER',
    'view.style().setProperty(key, value);', 'node.style.transform_rotate = angle;',
    'style.set(Property::TransformRotate, angle);',
  ]) assert.equal(nativeCssSourceNeedsSupport(source), true, source)
})

test('read-only native tree inspection and audio code introduce no CSS operations', () => {
  assert.equal(nativeCssSourceNeedsSupport('#include "ui/tree_inspection.h"\nTreeInspection::hasMountedText(label);'), false)
  assert.equal(nativeCssSourceNeedsSupport('#include "audio/effects.h"\nprocess(samples, count);'), false)
})

test('missing native input cannot prove CSS families absent', () => {
  const result = withNativeCssFeatures({ root: '/nonexistent-app', nativeSources: ['missing.cpp'] }, ['css-analysis-v1'])
  assert.ok(result.includes('css-transforms'))
  assert.ok(result.includes('css-grid'))
})


test('v2 analysis eliminates unused fields and preserves used fields', () => {
  const empty = withRendererFeatureDefines('', ['css-analysis-v2'])
  assert.match(empty, /GEA_CSS_BLINK=0/)
  assert.match(empty, /GEA_CSS_ORDER=0/)
  assert.match(empty, /GEA_CSS_PERCENT_RADIUS=0/)
  assert.match(empty, /GEA_CSS_PERCENT_GAP=0/)
  const used = withRendererFeatureDefines('', ['css-analysis-v2', 'css-blink', 'css-order'])
  assert.match(used, /GEA_CSS_BLINK=1/)
  assert.match(used, /GEA_CSS_ORDER=1/)
  const old = withRendererFeatureDefines('GEA_CSS_BLINK=0;GEA_CSS_ORDER=0;GEA_CSS_PERCENT_RADIUS=0;GEA_CSS_PERCENT_GAP=0', ['css-analysis-v1'])
  assert.doesNotMatch(old, /GEA_CSS_(?:BLINK|ORDER|PERCENT_RADIUS|PERCENT_GAP)=/)
  const unknown = withNativeCssFeatures({ root: '/nonexistent-app', nativeSources: ['missing.cpp'] }, ['css-analysis-v2'])
  assert.ok(unknown.includes('css-blink'))
  assert.ok(unknown.includes('css-order'))
  assert.ok(unknown.includes('css-percent-radius'))
  assert.ok(unknown.includes('css-percent-gap'))
})

test('v3 analysis removes only proven-unused presentation fields', () => {
  const fields = ['OPACITY', 'TEXT_DECORATION', 'TEXT_TRANSFORM', 'VISIBILITY', 'POINTER_EVENTS', 'MASK', 'IMAGE_FIT']
  const empty = withRendererFeatureDefines('', ['css-analysis-v3'])
  for (const field of fields) assert.ok(empty.includes(`GEA_CSS_${field}=0`))
  const used = withRendererFeatureDefines('', ['css-analysis-v3', 'css-opacity', 'css-mask'])
  assert.ok(used.includes('GEA_CSS_OPACITY=1'))
  assert.ok(used.includes('GEA_CSS_MASK=1'))
  for (const version of ['css-analysis-v1', 'css-analysis-v2']) {
    const old = withRendererFeatureDefines(fields.map(field => `GEA_CSS_${field}=0`).join(';'), [version])
    for (const field of fields) assert.ok(!old.includes(`GEA_CSS_${field}=`))
  }
  const unknown = withNativeCssFeatures({ root: '/nonexistent-app', nativeSources: ['missing.cpp'] }, ['css-analysis-v3'])
  for (const feature of ['css-opacity', 'css-text-decoration', 'css-text-transform', 'css-visibility', 'css-pointer-events', 'css-mask', 'css-image-fit']) assert.ok(unknown.includes(feature))
  assert.equal(nativeCssSourceNeedsSupport('#include "css/declarative.h"'), true)
})

test('v4 layout/effect pruning preserves older analyzers and unknown native code', () => {
  const fields = ['FILTERS', 'BOX_SHADOW', 'FLEX_WRAP', 'JUSTIFY_ITEMS', 'ALIGN_CONTENT', 'ALIGN_SELF', 'MIN_WIDTH', 'HEIGHT_EXPRESSIONS']
  const empty = withRendererFeatureDefines('', ['css-analysis-v4'])
  for (const field of fields) assert.ok(empty.includes(`GEA_CSS_${field}=0`))
  const used = withRendererFeatureDefines('', ['css-analysis-v4', 'css-filters', 'css-height-expressions'])
  assert.ok(used.includes('GEA_CSS_FILTERS=1'))
  assert.ok(used.includes('GEA_CSS_HEIGHT_EXPRESSIONS=1'))
  for (const version of ['css-analysis-v1', 'css-analysis-v2', 'css-analysis-v3']) {
    const old = withRendererFeatureDefines(fields.map(field => `GEA_CSS_${field}=0`).join(';'), [version])
    for (const field of fields) assert.ok(!old.includes(`GEA_CSS_${field}=`))
  }
  const unknown = withNativeCssFeatures({ root: '/nonexistent-app', nativeSources: ['missing.cpp'] }, ['css-analysis-v4'])
  for (const field of fields) assert.ok(unknown.includes(`css-${field.toLowerCase().replaceAll('_', '-')}`))
})


test('v5 sizing/stacking facts never prune using older or opaque analysis', () => {
  const fields = ['Z_INDEX', 'ASPECT_RATIO', 'MARGIN_TRIM', 'CONTAINMENT', 'JUSTIFY_SELF', 'FLEX_LINE_COUNT', 'BOX_EXPRESSIONS']
  const empty = withRendererFeatureDefines('', ['css-analysis-v5'])
  for (const field of fields) assert.ok(empty.includes(`GEA_CSS_${field}=0`))
  const used = withRendererFeatureDefines('', ['css-analysis-v5', 'css-z-index', 'css-box-expressions'])
  assert.ok(used.includes('GEA_CSS_Z_INDEX=1'))
  assert.ok(used.includes('GEA_CSS_BOX_EXPRESSIONS=1'))
  for (const version of ['css-analysis-v1', 'css-analysis-v2', 'css-analysis-v3', 'css-analysis-v4']) {
    const old = withRendererFeatureDefines(fields.map(field => `GEA_CSS_${field}=0`).join(';'), [version])
    for (const field of fields) assert.ok(!old.includes(`GEA_CSS_${field}=`))
  }
  const unknown = withNativeCssFeatures({ root: '/nonexistent-app', nativeSources: ['missing.cpp'] }, ['css-analysis-v5'])
  for (const field of fields) assert.ok(unknown.includes(`css-${field.toLowerCase().replaceAll('_', '-')}`))
})


test('opaque native CSS mutation retains gradient caches despite colour-only source facts', () => {
  const features = withNativeCssFeatures({ root: '/nonexistent-app', nativeSources: ['opaque.cpp'] }, ['renderer-analysis-v1', 'css-analysis-v5'])
  const defines = withRendererFeatureDefines('', features)
  assert.match(defines, /GEA_EMBEDDED_RENDERER_LINEAR_GRADIENTS=1/)
  assert.match(defines, /GEA_EMBEDDED_RENDERER_RADIAL_GRADIENTS=1/)
  assert.match(defines, /GEA_EMBEDDED_RENDERER_TRANSFORMS=1/)
})


test('v6 preserves independent gap/corner storage for used and unknown styles', () => {
  const empty = withRendererFeatureDefines('', ['css-analysis-v6'])
  assert.match(empty, /GEA_CSS_AXIS_GAP=0/)
  assert.match(empty, /GEA_CSS_CORNER_RADIUS=0/)
  assert.match(empty, /GEA_CSS_BOX_EXPRESSIONS=0/)
  const used = withRendererFeatureDefines('', ['css-analysis-v6', 'css-axis-gap', 'css-corner-radius'])
  assert.match(used, /GEA_CSS_AXIS_GAP=1/)
  assert.match(used, /GEA_CSS_CORNER_RADIUS=1/)
  for (const version of [1, 2, 3, 4, 5]) {
    const old = withRendererFeatureDefines('GEA_CSS_AXIS_GAP=0;GEA_CSS_CORNER_RADIUS=0', [`css-analysis-v${version}`])
    assert.doesNotMatch(old, /GEA_CSS_(AXIS_GAP|CORNER_RADIUS)=/)
  }
  const opaque = withNativeCssFeatures({ root: '/missing-app', nativeSources: ['opaque.cpp'] }, ['css-analysis-v6'])
  assert.ok(opaque.includes('css-axis-gap'))
  assert.ok(opaque.includes('css-corner-radius'))
})


test('v7 first-line facts preserve older analyzers and opaque native mutation', () => {
  assert.ok(withRendererFeatureDefines('', ['css-analysis-v7']).includes('GEA_CSS_FIRST_LINE=0'))
  assert.ok(withRendererFeatureDefines('', ['css-analysis-v7', 'css-first-line']).includes('GEA_CSS_FIRST_LINE=1'))
  for (let version = 1; version <= 6; version++) {
    const result = withRendererFeatureDefines('GEA_CSS_FIRST_LINE=0', [`css-analysis-v${version}`])
    assert.ok(!result.includes('GEA_CSS_FIRST_LINE='))
  }
  const features = withNativeCssFeatures({ root: '/nonexistent-app', nativeSources: ['missing.cpp'] }, ['css-analysis-v7'])
  assert.ok(features.includes('css-first-line'))
})

 test('v8 rare families require v8 proof and survive opaque native writes', () => {
  const names = ['SIDE_BORDERS', 'BACKGROUND_LAYERS', 'LINE_HEIGHT_EXPRESSIONS']
  const features = ['css-side-borders', 'css-background-layers', 'css-line-height-expressions']
  for (const [index, name] of names.entries()) {
    assert.ok(withRendererFeatureDefines('', ['css-analysis-v8']).includes(`GEA_CSS_${name}=0`))
    assert.ok(withRendererFeatureDefines('', ['css-analysis-v8', features[index]]).includes(`GEA_CSS_${name}=1`))
    for (let version = 1; version < 8; ++version) assert.ok(!withRendererFeatureDefines(`GEA_CSS_${name}=0`, [`css-analysis-v${version}`]).includes(`GEA_CSS_${name}=`))
  }
  const opaque = withNativeCssFeatures({ root: '/missing-app', nativeSources: ['unknown.cpp'] }, ['css-analysis-v8'])
  for (const feature of features) assert.ok(opaque.includes(feature))
  assert.equal(withRendererFeatureDefines('APP=1;GEA_CSS_SIDE_BORDERS=0', ['css-analysis-v99']), 'APP=1')
})

test('scroll state requires v9 proof, automatically retaining older and opaque use', () => {
  assert.ok(withRendererFeatureDefines('', ['css-analysis-v9']).includes('GEA_CSS_SCROLLING=0'))
  assert.ok(withRendererFeatureDefines('', ['css-analysis-v9', 'css-scrolling']).includes('GEA_CSS_SCROLLING=1'))
  for (let version = 1; version < 9; ++version) assert.ok(!withRendererFeatureDefines('GEA_CSS_SCROLLING=0', [`css-analysis-v${version}`]).includes('GEA_CSS_SCROLLING='))
  const opaque = withNativeCssFeatures({ root: '/missing-app', nativeSources: ['unknown.cpp'] }, ['css-analysis-v9'])
  assert.ok(opaque.includes('css-scrolling'))
  assert.equal(withRendererFeatureDefines('APP=1;GEA_CSS_SCROLLING=0', ['css-analysis-v99']), 'APP=1')
})

test('v10 rare-state and custom-length proofs preserve older/opaque defaults', () => {
  for (const [feature, name] of [['css-flex-basis-expressions', 'FLEX_BASIS_EXPRESSIONS'], ['css-custom-property-lengths', 'CUSTOM_PROPERTY_LENGTHS']]) {
    assert.ok(withRendererFeatureDefines('', ['css-analysis-v10']).includes(`GEA_CSS_${name}=0`))
    assert.ok(withRendererFeatureDefines('', ['css-analysis-v10', feature]).includes(`GEA_CSS_${name}=1`))
    for (let version = 1; version < 10; ++version) assert.ok(!withRendererFeatureDefines(`GEA_CSS_${name}=0`, [`css-analysis-v${version}`]).includes(`GEA_CSS_${name}=`))
    assert.ok(withNativeCssFeatures({ root: '/missing-app', nativeSources: ['unknown.cpp'] }, ['css-analysis-v10']).includes(feature))
  }
})

test('v11 common fields require current proof and retain opaque/native support', () => {
  for (const [feature, macro] of [['css-max-height', 'GEA_CSS_MAX_HEIGHT'], ['css-flex-basis', 'GEA_CSS_FLEX_BASIS'], ['css-overflow-axes', 'GEA_CSS_OVERFLOW_AXES']]) {
    assert.ok(withRendererFeatureDefines('', ['css-analysis-v11']).includes(`${macro}=0`))
    assert.ok(withRendererFeatureDefines('', ['css-analysis-v11', feature]).includes(`${macro}=1`))
    assert.ok(!withRendererFeatureDefines('', ['css-analysis-v10']).includes(`${macro}=`))
    const opaque = withNativeCssFeatures({ root: '/missing-native-css-root', nativeSources: ['opaque.cpp'] }, ['css-analysis-v11'])
    assert.ok(withRendererFeatureDefines('', opaque).includes(`${macro}=1`))
  }
})

const rangeProof = (family, raw, px) => ['css-ranges-v1', `css-range-${family}-raw-${raw}`, `css-range-${family}-px-${px}`]

test('range proofs select byte members only within target DPR bounds', () => {
  assert.match(withRendererFeatureDefines('', rangeProof('radius', 0, 65), { devicePixelRatio: 2 }), /GEA_CSS_U8_RADIUS=1/)
  assert.match(withRendererFeatureDefines('', rangeProof('radius', 0, 65), { devicePixelRatio: 4 }), /GEA_CSS_U8_RADIUS=0/)
  assert.match(withRendererFeatureDefines('', rangeProof('padding', 255, 0), { devicePixelRatio: 4 }), /GEA_CSS_U8_PADDING=1/)
  assert.match(withRendererFeatureDefines('', rangeProof('padding', 256, 0)), /GEA_CSS_U8_PADDING=0/)
  assert.match(withRendererFeatureDefines('GEA_EMBEDDED_CSS_LAYOUT_DEVICE_PIXEL_RATIO=4', rangeProof('radius', 0, 65)), /GEA_CSS_U8_RADIUS=0/)
  assert.match(withRendererFeatureDefines('GEA_EMBEDDED_CSS_LAYOUT_DEVICE_PIXEL_RATIO=(4)', rangeProof('radius', 0, 65)), /GEA_CSS_U8_RADIUS=0/)
  assert.match(withRendererFeatureDefines('GEA_EMBEDDED_CSS_LAYOUT_DEVICE_PIXEL_RATIO=4', rangeProof('radius', 0, 65), { devicePixelRatio: 2 }), /GEA_CSS_U8_RADIUS=1/)
})

test('range storage is proof-generated, never an app opt-in', () => {
  assert.ok(!withRendererFeatureDefines('GEA_CSS_U8_PADDING=1', []).includes('GEA_CSS_U8_PADDING='))
  for (const features of [
    ['css-ranges-v1'], ['css-ranges-v1', 'css-range-padding-px-1'],
    [...rangeProof('padding', 0, 1), 'css-range-padding-px-2'],
    [...rangeProof('padding', 0, 1), 'css-ranges-unknown'],
    ['css-ranges-v1', 'css-range-padding-raw-0', 'css-range-padding-px-NaN'],
  ]) assert.match(withRendererFeatureDefines('', features), /GEA_CSS_U8_PADDING=0/)
  const opaque = withNativeCssFeatures({ root: '/missing-native-css-root', nativeSources: ['opaque.cpp'] }, ['css-analysis-v11', ...rangeProof('padding', 0, 1)])
  assert.match(withRendererFeatureDefines('', opaque), /GEA_CSS_U8_PADDING=0/)
  for (const source of ['setDevicePixelRatio(8);', 'gea_style_set_viewport_metrics(600,450,8);']) assert.ok(nativeCssSourceNeedsSupport(source))
})


test('node payloads prune only with the known automatic proof', () => {
  assert.equal(withRendererFeatureDefines('', ['node-analysis-v1']), 'GEA_UI_IMAGE_NODES=0;GEA_UI_INPUT_NODES=0')
  assert.equal(withRendererFeatureDefines('', ['node-analysis-v1', 'node-images']), 'GEA_UI_IMAGE_NODES=1;GEA_UI_INPUT_NODES=0')
  assert.equal(withRendererFeatureDefines('GEA_UI_IMAGE_NODES=0;GEA_UI_INPUT_NODES=0', []), '')
  assert.equal(withRendererFeatureDefines('', ['node-analysis-v2']), '')
  const opaque = withNativeCssFeatures({ root: '/nonexistent-app', nativeSources: ['missing.cpp'] }, ['node-analysis-v1'])
  const defines = withRendererFeatureDefines('', opaque)
  assert.match(defines, /GEA_UI_IMAGE_NODES=1/)
  assert.match(defines, /GEA_UI_INPUT_NODES=1/)
  for (const source of ['NodeType::Image', 'NodeText copy;', 'VirtualKeyboard::instance()']) assert.ok(nativeCssSourceNeedsSupport(source), source)
})

test('v12 position edge proofs retain legacy and opaque native support', () => {
  for (const side of ['TOP', 'RIGHT', 'BOTTOM', 'LEFT']) for (const suffix of ['', '_PERCENT']) {
    const macro = `GEA_CSS_POSITION_${side}${suffix}`
    const feature = `css-position-${(side + suffix).toLowerCase().replaceAll('_', '-')}`
    assert.ok(withRendererFeatureDefines('', ['css-analysis-v12']).includes(`${macro}=0`))
    assert.ok(withRendererFeatureDefines('', ['css-analysis-v12', feature]).includes(`${macro}=1`))
    assert.ok(!withRendererFeatureDefines(`${macro}=0`, ['css-analysis-v11']).includes(`${macro}=`))
    const opaque = withNativeCssFeatures({ root: '/missing-app', nativeSources: ['opaque.cpp'] }, ['css-analysis-v12'])
    assert.ok(withRendererFeatureDefines('', opaque).includes(`${macro}=1`))
  }
})


test('class capacity requires a current positive proof and cannot be opted into', () => {
  assert.equal(withRendererFeatureDefines('APP=1;GEA_UI_CLASS_INLINE_TOKENS=1', []), 'APP=1')
  for (const capacity of [1, 2, 3]) assert.equal(withRendererFeatureDefines('', [`node-class-capacity-v1-${capacity}`]), `GEA_UI_CLASS_INLINE_TOKENS=${capacity}`)
  assert.equal(withRendererFeatureDefines('', ['node-class-capacity-v2-1']), '')
  for (const nativeFeature of ['node-inputs', 'node-images']) assert.equal(withRendererFeatureDefines('', ['node-class-capacity-v1-2', nativeFeature]), '')
  assert.equal(withRendererFeatureDefines('', ['node-class-capacity-v1-1', 'node-class-capacity-v1-3']), 'GEA_UI_CLASS_INLINE_TOKENS=3')
  assert.equal(withRendererFeatureDefines('', ['node-class-capacity-v1-2', 'node-class-capacity-v1-0']), '')
  const opaque = withNativeCssFeatures({ root: '/missing-app', nativeSources: ['opaque.cpp'] }, ['node-class-capacity-v1-2'])
  assert.ok(!opaque.some(feature => feature.startsWith('node-class-capacity-')))
  assert.ok(nativeCssSourceNeedsSupport('NodeClassList classes;'))
  assert.ok(nativeCssSourceNeedsSupport('tree.setClassName(node, name);'))
})


test('animation pruning requires the new proof and ignores manual opt-outs', () => {
  assert.ok(withRendererFeatureDefines('GEA_CSS_ANIMATIONS=1', ['css-analysis-v13']).includes('GEA_CSS_ANIMATIONS=0'))
  assert.ok(withRendererFeatureDefines('GEA_CSS_ANIMATIONS=0', ['css-analysis-v13', 'css-animations']).includes('GEA_CSS_ANIMATIONS=1'))
  for (let version = 1; version < 13; ++version) assert.ok(!withRendererFeatureDefines('GEA_CSS_ANIMATIONS=0', [`css-analysis-v${version}`]).includes('GEA_CSS_ANIMATIONS='))
  const opaque = withNativeCssFeatures({ root: '/missing-app', nativeSources: ['unknown.cpp'] }, ['css-analysis-v13'])
  assert.ok(opaque.includes('css-animations'))
  assert.ok(nativeCssSourceNeedsSupport('gea::css::AnimationEngine::instance().start(animation, now);'))
})


test('alpha storage requires v14 proof and cannot be manually disabled', () => {
  for (const [feature, macro] of [['css-text-alpha', 'GEA_CSS_TEXT_ALPHA'], ['css-border-alpha', 'GEA_CSS_BORDER_ALPHA']]) {
    assert.ok(withRendererFeatureDefines(`${macro}=1`, ['css-analysis-v14']).includes(`${macro}=0`))
    assert.ok(withRendererFeatureDefines(`${macro}=0`, ['css-analysis-v14',feature]).includes(`${macro}=1`))
    for (let version=1;version<14;++version) assert.ok(!withRendererFeatureDefines(`${macro}=0`, [`css-analysis-v${version}`]).includes(`${macro}=`))
    for (const native of ['node-inputs','node-images']) assert.ok(withRendererFeatureDefines('', ['css-analysis-v14',native]).includes(`${macro}=1`))
    const opaque=withNativeCssFeatures({root:'/missing-app',nativeSources:['opaque.cpp']}, ['css-analysis-v14'])
    assert.ok(withRendererFeatureDefines('',opaque).includes(`${macro}=1`))
  }
})

test('generated pseudo-element pruning requires v15 proof and ignores manual overrides', () => {
  const macro = 'GEA_CSS_PSEUDO_ELEMENTS'
  assert.ok(withRendererFeatureDefines(`${macro}=1`, ['css-analysis-v15']).includes(`${macro}=0`))
  assert.ok(withRendererFeatureDefines(`${macro}=0`, ['css-analysis-v15','css-pseudo-elements']).includes(`${macro}=1`))
  for (let version=1;version<15;++version) assert.ok(!withRendererFeatureDefines(`${macro}=0`, [`css-analysis-v${version}`]).includes(`${macro}=`))
  const opaque = withNativeCssFeatures({root:'/missing-app',nativeSources:['opaque.cpp']}, ['css-analysis-v15'])
  assert.ok(withRendererFeatureDefines('',opaque).includes(`${macro}=1`))
})
