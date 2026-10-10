# Native build settings

Applications declare build choices in package.json. An app ID selects an app; it
never selects compiler flags, a framework slice, renderer shortcuts, or a pixel
ratio.

## Precedence and inspection

Settings merge by leaf, in this order:

1. Platform defaults shipped by @geastack/targets.
2. Board defaults shipped by @geastack/targets.
3. `gea.build`.
4. `gea.targets.<platform>.build`.
5. `gea.targets.<platform>.boards.<board-id>.build`.

Board keys are stable target IDs, not machine-local aliases. An object target
enables that target just as `true` does. False and zero are explicit values, not
requests to inherit. Unknown fields and unsupported explicit board choices are
errors. Two panel preferences, `renderer.fuseReplayFlush` and
`display.presentStream`, may also live in a shared base. When the selected
driver does not support them, they generate no native definitions; `gea config`
lists their values, source paths and reason under `inapplicable`. Other
unsupported settings remain errors at every level.

Run `gea config --board <alias> --app <id>` to print the resolved settings,
their individual origins, native definitions, and CSS pixel ratio. Builds use
the same resolver. The existing build directory contains
`gea-build-config.json` and `gea-build-config.cmake`; they are generated
artifacts, never another source of settings. The configuration hash participates
in the configure signature, and the JSON file is a code-generation dependency.

```json
{
  "gea": {
    "targets": {
      "esp32": {
        "build": {
          "ui": {
            "styleStorage": "shared"
          },
          "compiler": {
            "numberPrecision": "float32"
          },
          "renderer": {
            "subtreeRevealChecks": false,
            "recordInlinePositions": false,
            "fuseReplayFlush": true
          },
          "diagnostics": {
            "performanceCounters": false,
            "frameTiming": false
          },
          "display": {
            "presentStream": "continuous"
          }
        },
        "boards": {
          "esp32-s3-touch-amoled-1.8": {
            "build": {
              "compiler": {
                "generatedCodeOptimization": "O2"
              },
              "renderer": {
                "adaptiveCoalescing": true,
                "broadDirtyBounds": true
              },
              "display": {
                "framebufferStream": "continuous"
              }
            }
          },
          "esp32-s3-touch-amoled-2.41": {
            "build": {
              "display": {
                "presentStream": "independent"
              }
            }
          },
          "esp32-s3-lilygo-t-display-s3-long": {
            "build": {
              "renderer": {
                "fuseReplayFlush": false
              }
            }
          }
        }
      }
    }
  }
}
```

`gea.build` is the application base across platforms. Use
`gea.targets.<platform>.build` for choices shared by every board on one platform;
board entries contain only differences. Nested groups merge by individual field:
the 1.8 board's `generatedCodeOptimization` keeps `numberPrecision` from the ESP32
base. Hardware constraints still apply after inheritance.

The example above is the complete bouncing-balls JSX ESP32 configuration. Shared
numeric precision, style storage, renderer bookkeeping and diagnostics appear
once. Fused replay and continuous presentation are base preferences; LILYGO
turns fused replay off, and the 2.41 board requests independent presentation.
The 2.06 board needs no override. Copying the app under another name leaves its
effective build choices unchanged.

## Options

| Field under build | Values / meaning |
| --- | --- |
| compiler.generatedCodeOptimization | O0, O1, O2, O3, Os, Og; native optimization of the generated app archive |
| compiler.numberPrecision | float64 or float32; selects the existing GEA_NUMBER_FLOAT native storage mode |
| compiler.staticCssRules | boolean; default true |
| compiler.staticCssTape | boolean; default true |
| compiler.staticCssTapeMinChunk | positive integer; default 5 |
| compiler.translationUnits | default, per-file, balanced |
| compiler.storeRelowering | boolean; default true |
| compiler.moduleGraph | auto, compile, only, disabled |
| compiler.allowAny | boolean; default false |
| ui.styleStorage | inline or shared; the existing default remains inline |
| renderer.bandedUi | boolean; default false; app opt-in for DMA band rendering on ESP32 and RP2350 |
| renderer.fuseReplayFlush | boolean |
| renderer.subtreeRevealChecks | boolean; keep true when content can move into view from outside a recorded clip |
| renderer.recordInlinePositions | boolean; false requires the app to refresh positions through its reactive updates |
| renderer.adaptiveCoalescing | boolean |
| renderer.broadDirtyBounds | boolean |
| display.framebufferStream | independent or continuous |
| display.presentStream | independent or continuous |
| display.flushPoolBytes | non-negative integer |
| diagnostics.performanceCounters | boolean; master performance instrumentation switch |
| diagnostics.frameTiming | boolean; scheduler lightweight timing instrumentation |
| services.wifi | auto or disabled; disabled conflicts with reachable network APIs |

Float32 is the existing generated numeric-storage optimization, not a promise
that every TypeScript expression becomes single-precision arithmetic. It can
reduce precision. The removed NUMBER_F32 environment setting had no active
consumer and is not forwarded.

Common compiler-pipeline settings also reach script-based native builds. The web
settings configure the native WASM simulator; the DOM build keeps browser
semantics. macOS resolves settings separately for each resident app.

Availability and defaults are explicit in @geastack/targets/build-config.json.
The general ESP32 and RP2350 paths support shared-style storage and the common
compiler-pipeline settings. ESP32 also supports common numeric precision,
renderer bookkeeping and diagnostic settings independently of board identity. AMOLED boards additionally support the renderer and
display settings they implement. The 2.06 base implements the optional
canvas-only framework. Unsupported options fail, except for the explicitly reported inapplicable
shared panel preferences described above.

Canvas-only execution is inferred, not configured. The analyzer must prove a
complete source graph using direct display drawing without JSX, DOM access,
unknown globals, or host services. Unknown imports, native extensions, OTA
services, and older analyzers retain the full runtime. The target must also
implement the canvas-only path. `gea config` reports the decision and its reason
under `inferred.runtime`; the same result selects the native frame loop,
framework sources, and boot services before CMake configures the build.

The former `compiler.runtime`, `runtime.directCanvasContext`,
`runtime.framework`, and `services.boot` settings are rejected. Remove them;
there is no replacement opt-in. The current compiler already emits native
canvas calls automatically. Runtime inference does not change browser DOM builds.

Panel constraints cannot be overridden by an app. For example, the 2.41 panel
requires independent framebuffer/present transfers; the LILYGO Long currently
requires independent framebuffer transfers and an unfused renderer.

`cssDevicePixelRatio` keeps its existing root spelling and also accepts
platform and board overrides alongside `build`. The resolved value reaches both
font generation and native layout.

## Migration and environment

The formerly special-cased examples are bouncing-balls-jsx, bubble-grid,
canvas-3d, gea3d-cube, sky-hop-jsx, css-3d-cube and three-angle-metal.
The obsolete canvas switches are removed from both manifests and WASM scripts. The obsolete minimal
global-object define, like NUMBER_F32, has no active consumer and is removed;
sky-hop-jsx therefore needs no replacement option. This migration relocates their
settings; it does not make their renderer shortcuts global defaults.

Known raw `gea.defines` remain readable during migration. A raw definition and
a typed setting for the same choice are an error, even if they agree. Unrelated
application-native defines remain supported.

Former tuning environment variables (NUMBER_F32, direct-canvas context, board
optimization presets, static CSS generator switches, translation-unit layout,
store relowering, and the mapped native option macros) are rejected with the
manifest replacement. Toolchain paths, credentials, build job count and device
selection are separate concerns. Internally, IDF's requirements subprocess
receives the path to the CLI-generated configuration; it does not infer options
from inherited tuning values.

CSS reachability, numeric field narrowing, packing, and removal of unused node
owners remain automatic compiler analysis. They are not manifest feature lists.

## Validation

The migration checks option precedence and origins, unknown/unsupported options,
raw-define conflicts, environment contamination, config-cache invalidation,
hardware restrictions, and app-rename invariance. Compiler tests verify that
runtime inference retains UI/services for mixed or unproven applications.

A configuration-preserving refactor still needs a native build and a device
performance check before claiming a new hardware performance result.

The CLI unit tests use independent fixtures. To also verify the migrated source
examples and target glue, run from the CLI checkout:

```sh
GEA_TEST_TARGETS_ROOT=/path/to/targets \
GEA_TEST_EXAMPLES_ROOT=/path/to/examples \
node --test test/build-config.test.mjs
```

These two variables locate integration-test inputs; they do not set app build
options. Without them, the source-migration checks are skipped.
