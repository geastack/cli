import assert from 'node:assert/strict'

import { iconPrompt, iconStyleSheetPrompt } from '../src/apps/openai-icons.mjs'

const prompt = iconPrompt({
  id: 'app-launcher',
  name: 'App Launcher',
  launcher: {
    description: 'launch apps'
  }
})

assert.match(prompt, /clean retro-synthwave identity/)
assert.match(prompt, /not messy AI neon art/)
assert.match(prompt, /not flat corporate glyphs/)
assert.match(prompt, /clean synthwave emblem design/)
assert.match(prompt, /hard 90-degree square canvas corners/)
assert.match(prompt, /one large central glyph/)
assert.match(prompt, /restrained neon rim light/)
assert.match(prompt, /one dark synthwave background/)
assert.match(prompt, /No beige corporate palette/)
assert.match(prompt, /no default teal set/)
assert.match(prompt, /Diversify the set/)
assert.match(prompt, /Proper app icon composition/)
assert.match(prompt, /No poster scenes/)
assert.match(prompt, /Do not put the icon inside an inner rounded square/)
assert.match(prompt, /No readable text anywhere/)
assert.match(prompt, /no words/)
assert.match(prompt, /no .*digits/)
assert.match(prompt, /Assigned synthwave palette for this exact app/)
assert.match(prompt, /amber center glow/)
assert.match(prompt, /do not default to teal unless teal is explicitly named/)
assert.match(prompt, /proper clean synthwave app icon/)
assert.match(prompt, /32x32/)

const hidPrompt = iconPrompt({
  id: 'hid-clicker',
  name: 'HID Clicker',
  launcher: {
    description: 'BLE remote'
  }
})

assert.match(hidPrompt, /presentation remote/)
assert.match(hidPrompt, /two buttons/)
assert.match(hidPrompt, /no play icon/)
assert.match(hidPrompt, /Do not show a human hand/)
assert.match(hidPrompt, /tap target/)

const skyPrompt = iconPrompt({
  id: 'sky-hop',
  name: 'Sky Hop Canvas',
  launcher: {
    description: 'canvas game'
  }
})

assert.match(skyPrompt, /leaping comet/)
assert.match(skyPrompt, /one platform/)
assert.match(skyPrompt, /Do not show a blue daytime sky/)
assert.match(skyPrompt, /green grass/)

const staticCardPrompt = iconPrompt({
  id: 'static-card',
  name: 'Static Card',
  launcher: {
    description: 'static layout'
  }
})

assert.match(staticCardPrompt, /UI content-card symbol/)
assert.match(staticCardPrompt, /not a playing card/)
assert.match(staticCardPrompt, /card suits/)
assert.match(staticCardPrompt, /casino imagery/)

const virtualListPrompt = iconPrompt({
  id: 'virtual-list',
  name: 'Virtual List',
  launcher: {
    description: 'scroll probe'
  }
})

assert.match(virtualListPrompt, /stack of list rows/)
assert.match(virtualListPrompt, /Do not show flat up\/down arrows/)

const ticTacToePrompt = iconPrompt({
  id: 'tic-tac-toe',
  name: 'Tic Tac Toe',
  launcher: {
    description: 'tap board'
  }
})

assert.match(ticTacToePrompt, /bold 3x3 board/)
assert.match(ticTacToePrompt, /Do not show a flat textbook grid/)

const dialerPrompt = iconPrompt({
  id: 'dialer',
  name: 'Dialer',
  launcher: {
    description: 'phone keypad'
  }
})

assert.match(dialerPrompt, /unlabeled dots/)
assert.match(dialerPrompt, /Do not show readable keypad numbers/)

const iosShaderPrompt = iconPrompt({
  id: 'ios-metal-shader-demo',
  name: 'iOS Metal Shader Demo',
  launcher: {
    description: 'shader demo'
  }
})

assert.match(iosShaderPrompt, /faceted shader prism/)
assert.match(iosShaderPrompt, /Do not show a rounded square tile/)
assert.match(iosShaderPrompt, /black to plum background/)

const iosNativePrompt = iconPrompt({
  id: 'ios-native-showcase',
  name: 'iOS Native Showcase',
  launcher: {
    description: 'native controls'
  }
})

assert.match(iosNativePrompt, /native-controls symbol/)
assert.match(iosNativePrompt, /Do not show a bird/)
assert.match(iosNativePrompt, /deep jade background/)

const companionPrompt = iconPrompt({
  id: 'gea-companion',
  name: 'gea Companion',
  launcher: {
    description: 'desktop companion'
  }
})

assert.match(companionPrompt, /linked companion nodes/)
assert.match(companionPrompt, /black to coral background/)

const sheetPrompt = iconStyleSheetPrompt([
  {
    id: 'static-card',
    name: 'Static Card',
    launcher: { description: 'static layout' }
  },
  {
    id: 'sky-hop',
    name: 'Sky Hop',
    launcher: { description: 'jump game' }
  }
])

assert.match(sheetPrompt, /ONE style approval contact sheet/)
assert.match(sheetPrompt, /Do not put text, numbers, labels/)
assert.match(sheetPrompt, /deliberately vary dominant colors/)
assert.match(sheetPrompt, /proper clean synthwave app icon/)
assert.match(sheetPrompt, /hard square corners/)
assert.match(sheetPrompt, /dark synthwave background/)
assert.match(sheetPrompt, /iconic reduction/)
assert.match(sheetPrompt, /Generate concepts in this exact order/)
assert.match(sheetPrompt, /Static Card \(static-card\)/)
assert.match(sheetPrompt, /Palette: black to plum background/)
assert.match(sheetPrompt, /Sky Hop \(sky-hop\)/)
