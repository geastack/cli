# @geastack/cli

Command-line front door for GeaStack.

This repo contains the `gea` CLI orchestrator and the `create-geastack`
scaffolder. The CLI turns GeaStack into an npm-first developer workflow while
keeping target-specific build logic behind stable backend contracts.

## Commands

```sh
npm install --global @geastack/cli
gea create my-panel
cd my-panel
gea doctor
gea setup
gea dev
gea build --target web
gea build --target ios
gea build --target tvos
gea flash --board <alias> --monitor
gea screenshot board.png --board <alias>
gea monitor --board <alias>
gea apps inspect --json
```

The CLI needs Node.js 22 or later. `gea --help` prints the full command
surface; `gea apps inspect --json` runs inside an app directory.

## Interactive Menu Map

```mermaid
flowchart TD
  create["gea create my-app"] --> identity["Resolve app identity<br/>argument, optional --id, optional --name"]
  identity --> starter{"What do you want to build?"}

  starter -->|"Blank application"| emptyTarget{"Where should this application run?"}
  emptyTarget -->|"Web browser"| emptyWeb["Generate browser entry, HTML, and Vite config"]
  emptyTarget -->|"ESP32 board"| emptyEsp["Generate native entry<br/>Ask whether to enable wireless firmware updates over Bluetooth"]
  emptyTarget -->|"RP2350, GeaOS, macOS, iOS, tvOS, Android, or Windows"| emptyNative["Generate native entry for the selected platform"]

  starter -->|"Example application"| pickExample["Pick from the example gallery<br/>bundled Component Counter first, then GitHub examples<br/>for web, ESP32, RP2350, GeaOS, iOS, macOS, Android, and Windows"]
  pickExample -->|"Component Counter"| counter["Copy the bundled touchscreen counter used in the embedded tutorial"]
  pickExample -->|"GitHub example"| fetchExample["Fetch selected app from GitHub"]
  fetchExample --> rewriteExample["Rewrite package name and gea manifest"]

  counter --> projectWiring["Add @geastack/core, @geastack/cli, @geajs/core, TypeScript<br/>+ @geastack/targets for ESP32/RP2350, @geastack/apple for macOS/iOS/tvOS,<br/>@geastack/windows for Windows, Vite for web"]
  rewriteExample --> projectWiring
  emptyWeb --> projectWiring
  emptyEsp --> projectWiring
  emptyNative --> projectWiring
  projectWiring --> boardConfig["Create .gea/boards.json"]
  boardConfig --> install["Install npm dependencies<br/>(interactive default; --no-install skips)"]
  install --> setup["Next: npx gea setup"]

  auto["Automation flags"] -.-> starter
  auto --> autoCounter["--yes or no terminal: Component Counter"]
  auto --> autoEmpty["--starter blank --yes"]
  auto --> autoExample["--starter example --example watch"]
```

```mermaid
flowchart TD
  setup["npx gea setup"] --> mode{"Mode?"}

  mode -->|"--esp-idf"| directIdf["Install or check ESP-IDF v6.0.2<br/>(--idf-version installs another release)<br/>plus the 6.2-dev line the ESP32-S31 builds with"]
  mode -->|"--board alias"| directBoard["Configure the build for that board alias"]
  mode -->|"--target target-id"| directTarget["Configure the build for that target directly"]

  mode -->|"Interactive"| interactive{"What do you want to set up?"}

  interactive -->|"Known supported board"| knownBoard["Which board do you have?"]
  knownBoard --> alias["Board alias"]
  alias --> serial["Is the board connected over USB right now?<br/>detect its USB serial (registry + GEADEV ping)"]
  serial --> ota["OTA host/IP (optional)"]
  ota --> reviewKnown["Review, then: Save this board setup?"]
  reviewKnown --> writeKnown["Write the alias to boards.json"]

  interactive -->|"Custom board profile"| custom["Custom board alias, then MCU / SoC (ESP32-S3)"]
  custom --> chipConfig["Display, touch, power, IMU, audio and I/O expander<br/>with bus and pin questions from @geastack/chips/catalog.json"]
  chipConfig --> features["Optional microSD slot and launcher button"]
  features --> connection["Detect the USB serial"]
  connection --> reviewCustom["Review, then: Save this custom board target?"]
  reviewCustom --> writeProfile["Write targets/alias.json next to boards.json"]
  writeProfile --> writeCustomAlias["Write the alias to boards.json"]

  interactive -->|"Only install/check project npm dependencies"| npmInstall["Run npm install when package.json exists"]
  interactive -->|"Only install/check ESP-IDF toolchain"| idfOnly["Same as --esp-idf"]

  writeKnown --> idfCheck["Check ESP-IDF for the board, offer to install it"]
  writeCustomAlias --> idfCheck
  idfCheck --> initialize["Initialize board target for an app"]
  initialize --> ready["Ready: npx gea flash --board alias --monitor"]
  npmInstall --> done
  idfOnly --> done
  directIdf --> done
  directBoard --> done
  directTarget --> done
```

The wizard writes `boards.json` (and a custom board's `targets/<alias>.json`)
to `<project>/.gea/` when the project already has a `.gea/boards.json`, which
every `gea create` project does, and to `~/.geastack/` otherwise. `--local`
forces the project directory, `--global` forces `~/.geastack/`, and
`--boards-config <file>` names the file outright.

The CLI resolves `@geastack/core`, `@geastack/targets`, the compiler, chips,
host bindings, and the other native packages from npm. A project can use a
local CLI with `npx gea` or a global installation with `gea`; neither command
depends on a GeaStack source checkout.

Boards are managed without editing JSON by hand; aliases live in
`~/.geastack/boards.json` (this machine) and the project's `.gea/boards.json`
(overrides):

```sh
gea boards discover                    # which registered board is on which USB port, its app and IP
gea boards list
gea boards set <alias> host 192.168.1.100
gea boards rename <alias> <new-alias>
gea boards remove <new-alias>
```

Custom boards remain editable after setup:

```sh
gea chips list
gea chips info co5300
gea chips add co5300 ft3168 --board my-board
gea chips remove ft3168 --board my-board
```

These commands update the custom board's target definition
(`targets/<alias>.json`). They do not copy native
sources into the application; the target adapter compiles the selected drivers
directly from the installed `@geastack/chips` package.

## Wi-Fi updates for offline apps

An ESP32 app with no network API calls normally omits networking. Set
`gea.ota.wifi` to `true` in the app's `package.json` to retain Wi-Fi OTA and
remote diagnostics. Supply the usual `GEA_WIFI_SSID` and `GEA_WIFI_PASSWORD`
settings at build time. This declaration keeps networking available without
adding a network call to the app; it does not supply credentials.

## Development

```sh
npm test
npm run check
```

Run from this repo during local development:

```sh
node bin/gea.mjs doctor
node bin/gea.mjs --help
```

`GEA_DEBUGGER_DIR` points `gea run --debug` at a debugger checkout instead of
the installed `@geastack/debugger`. Contributor native debug launches use the
sibling `apple` and `core` checkouts and the shared compiler; explicit
overrides win.

## Machine Setup

Use [docs/SETUP.md](docs/SETUP.md) for Node/npm, ESP-IDF, Emscripten, Xcode,
Python, and board configuration. For the Waveshare ESP32-S3 AMOLED path, use
[docs/ESP32-WAVESHARE-AMOLED-QUICKSTART.md](docs/ESP32-WAVESHARE-AMOLED-QUICKSTART.md).
`npx gea doctor` checks the same dependencies and prints warnings for optional
target toolchains that are not installed.

## Responsibilities

The CLI should own:

- command parsing and help output;
- project scaffolding;
- Gea app manifest validation;
- target discovery and target backend dispatch;
- consistent output, diagnostics, and exit codes;
- `doctor` checks for local toolchains, board config, and target backends.

The CLI should not own target implementation details. ESP32, GeaOS, Apple, and
web targets should keep their target-specific build logic in their own repos and
expose stable command contracts.

## Documentation

- [docs/PEBBLE-QUICKSTART.md](docs/PEBBLE-QUICKSTART.md): install the Pebble SDK,
  enable a TSX app, build a `.pbw`, and run on Pebble Time 2 or its emulator.
- [docs/SPEC.md](docs/SPEC.md): command surface, manifest expectations, and
  backend contract for the first implementation.
- [docs/SETUP.md](docs/SETUP.md): toolchains per target, the ESP-IDF version
  GeaStack resolves, and the board configuration files.
- [docs/DEVICE-CONTROL.md](docs/DEVICE-CONTROL.md): `gea devctl` in full, both
  wire protocols, and the display knobs.
- [docs/NATIVE-BUILD-CONFIG.md](docs/NATIVE-BUILD-CONFIG.md): native build
  settings, their precedence, and board overrides.
- [docs/LINUX-NATIVE-DEPLOYMENT.md](docs/LINUX-NATIVE-DEPLOYMENT.md): register
  and deploy to a Raspberry Pi OS board over SSH.
- [docs/qspi-panels.md](docs/qspi-panels.md): panel startup settings for custom
  boards with a `co5300` or `sh8601` QSPI display.

## Command Surface

- `gea create`, `gea setup`, `gea doctor`: scaffolding, guided board and
  toolchain setup, and dependency checks.
- `gea dev`, `gea simulate`, `gea build --target web`: browser development,
  device-viewport emulation, and static web builds.
- `gea build|run --target macos|ios|tvos|windows|raspberry-pi-os|pebble`:
  native desktop, mobile, TV, and watch apps through `@geastack/apple`,
  `@geastack/windows`, `@geastack/linux`, and `@geastack/pebble`.
- `gea build|flash|run|ota|clean --board <alias>`: ESP32 and RP2350 firmware
  through `@geastack/targets`, with USB flashing, WiFi and BLE OTA, and OTA
  slot management.
- `gea logs`, `gea monitor`, `gea screenshot`, `gea devctl`: device access over
  USB or WiFi.
- `gea run --debug`: Chrome DevTools for native macOS apps and ESP32 boards.
- `gea apps`, `gea boards`, `gea targets`, `gea chips`, `gea config`,
  `gea heap-report`: app, board, target, and chip catalogs, effective build
  settings, and heap analysis.

## Browser development and emulation

`gea dev` (equivalently `gea dev --target web`) runs the Gea DOM/CSS app with
Vite HMR. `gea simulate` uses that same pipeline inside a device viewport and
opens the browser. Use `--no-open` to suppress opening, and `--width`, `--height`,
`--zoom`, and `--dpr` to configure the preview. DPR is a simulated Display API
value; it does not override the browser's pixel ratio.

`gea simulate` uses the DOM renderer by default. For the embedded renderer and
framebuffer workflow, use `gea simulate --renderer wasm`; that mode requires
Emscripten. Unknown renderer values are rejected.

`gea build --target web` emits HTML/JS/CSS into `.gea/build/web/site` (override
with `--out-dir`). The app's `index.html` is honored. Web-only Vite customization
belongs in `vite.web.config.ts`; new web apps scaffold this file. Existing
`vite.config.*` files remain dedicated to their previous build pipeline.

Compatible component edits and CSS changes update without reloading the page;
reactive state is preserved for compatible component edits. Incompatible edits
reload. Browser previews use simulated device APIs and browser layout; use the
WASM renderer or a physical device to validate embedded rendering.

Native compiler, UI, renderer, and display settings belong in the app manifest. See [Native build settings](docs/NATIVE-BUILD-CONFIG.md) for precedence, board overrides, and `gea config --board <alias>`.


## Chrome DevTools debugger

`gea run --debug --target macos` builds and launches a native Gea app with CDP
at `127.0.0.1:9222`, then opens Chrome DevTools. A declared macOS deployment
target is not required for debugging; the source manifest is unchanged. On Mac,
`gea run --debug` defaults to native for an app that already declares macOS.
`gea run --debug --target web` uses the existing DOM/CSS runtime with Vite HMR.

`gea build --debug --target macos` produces the same instrumented native app
without launching it or opening Chrome. `gea build --debug --board <alias>`
builds ESP32 debug firmware without flashing or opening USB. Both commands use
the same debug configuration as `run`, including editable CSS. macOS retains
full symbols and unoptimized code by default; `--no-debug-sources` disables
that source-debugging build override.

Elements inspects the native tree, authored class CSS, common inline/computed
styles, text, attributes and layout. Inline CSS and tree edits affect the actual
AppKit window. The Console runs JavaScriptCore scripts with `document`, `$0`,
selectors, style edits, element creation/removal and click dispatch wired to the
native tree. Compiled C++ app modules/stores are not console globals; source
breakpoints, arbitrary class stylesheet edits and promise awaiting are not yet
implemented. Runtime edits do not save to source and can be replaced by app code.

Use `--debug-port 9223` for CDP and `--port 5182` for the DOM server. Native
`--no-open` exposes CDP without opening Chrome. Ctrl-C or closing the owned app
or browser stops the session. Other native targets, WASM and
direct AppKit widget graphs outside the Gea retained tree remain unsupported.

The CLI installs `@geastack/debugger` automatically. Debugging requires
Chrome/Chromium, and native builds need compiler and target runtimes with
debugger instrumentation. Set `GEA_CHROME_PATH` for a custom browser. Chrome uses its own app profile inside
`.gea/build/web`.


From your app directory, `gea run --debug --board <alias> --debug-fps 10` builds
and flashes debug firmware on a registered ESP32 board, then opens Chrome
DevTools through USB. `--attach` connects to already-running
debug firmware without flashing; regular firmware is rejected before JTAG or
Chrome starts. `--no-open` exposes only the CDP endpoint.
`--port` selects the USB device when using `--board`, while `--debug-port` selects
CDP. The debugger owns the serial stream; stop it before using `gea devctl` or
`gea monitor` on that port.

Device builds retain engine CSS features and authored rules for runtime edits.
The board contains no JavaScript VM. Its Console evaluates JavaScript on the
host against a snapshot; supported mutations are acknowledged by the device
before evaluation returns. A following evaluation reads fresh device state.
Use an async function and `await document.createElement(...)` to create nodes.
On ESP32-S3, add `--debug-sources` to explicitly start USB JTAG for original
TypeScript source maps, line/column hardware breakpoints and Step Over/Into/Out. Scope
shows native C++ locals; paused-frame evaluation accepts GDB C++ expressions.
The board has two breakpoint slots. Its matching ELF is verified before attach;
older firmware needs a fresh build. Tree/style inspection does not start JTAG
by default. `GEA_DEBUGGER_JTAG=1` also opts in; `--no-debug-sources` overrides it.
On macOS, source debugging is enabled by default. LLDB uses full symbols and
unoptimized native code for original TS/TSX breakpoints and Step Over/Into/Out.
Scopes expose native C++ values; paused expressions use C++ syntax. Use
`--no-debug-sources` to run tree/style inspection without LLDB. Inline
styles, authored class rules, attributes, text, append/remove and compiled event clicks affect the
actual device. Live changes are sampled every 750 ms. See the debugger README
for supported properties, USB bounds, and example scripts.

Add `--debug-fps 30` (or `--debug-fps 10`) to a board debug launch to reserve
more time for inspection and editing. Values are integers from 1 to 120. Debug
firmware enforces the cap across timer, TE and input/catch-up frame paths; app
FPS settings cannot exceed it. Use `--attach --debug-fps 10` to change the cap
on current debug firmware without rebuilding/flashing. Omitting the flag leaves
an existing attached app's cap alone; a fresh build defaults to normal pacing.
The cap persists after disconnecting. Firmware from before snapshot integrity
and FPS control support needs one rebuild.

DevTools edits on macOS and boards go into a shared Gea Changes history that you
can undo and save. `--save-overrides edits.json` writes the net edits when the
debugger exits. `--overrides edits.json` replays them as soon as it attaches:

```sh
gea run --debug --target macos --overrides edits.json --save-overrides edits.json
```

## License

Apache-2.0 (see `LICENSE`). You can ship closed-source products
built on it. The only GeaStack code under a different license is
the embedded board support (`targets` and `@geastack/chips`, GPL-3.0-only):
shipping closed-source firmware through those needs a commercial license.
Contact [contact@geastack.com](mailto:contact@geastack.com) for commercial terms, support and hosted builds.
