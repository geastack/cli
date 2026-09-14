# Gea CLI Specification

This document captures the first useful shape of the `gea` command. The first
implementation now ships in this repo; keep this spec aligned as the command
surface grows.

## Goals

The CLI should make GeaStack feel like one npm-first toolchain:

- start a web simulator for an app;
- build an app for a selected target;
- flash or install an app on hardware;
- monitor logs;
- diagnose missing toolchains, target backends, and board configuration;
- scaffold a new app with a valid `gea` manifest.

## Non-Goals

The CLI should not duplicate target internals. It should delegate to stable
backend commands owned by target repos.

Examples:

- ESP32 board flashing stays in `targets`.
- Web simulator launch stays in `simulator`.
- Apple project generation stays in `apple`.
- Android APK packaging stays in `android`.
- GeaOS image and device helpers stay in `geaos`.

## Command Surface

### `gea dev`

Starts the fastest local development loop for an app.

Expected behavior:

- Resolve the app from the current folder, `--app`, or `package.json`.
- Pick a default target of `web` unless `--target` says otherwise.
- For web, delegate to `simulator/targets/web/dev-web.mjs`.
- For hardware targets, print the intended build/deploy path and recommend
  `gea flash` when live dev is not available.

### `gea build`

Builds an app for a target without mutating hardware.

Expected options:

```sh
gea build --app bouncing-balls-jsx --target web
gea build --app bouncing-balls-jsx --target esp32-s3-touch-amoled-2.06
gea build --app notes-native --target macos
gea build --app css-3d-cube --target android
```

### `gea setup`

Runs one-time target initialization for a board or built-in target.

Expected options:

```sh
gea setup --board amoled
gea setup --target esp32-s3-touch-amoled-2.06
```

Without `--board` or `--target`, `gea setup` opens the interactive setup wizard.
The wizard should support known boards and rich custom board profiles. When the
selected profile is flash-ready, the wizard initializes the board target before
returning.

### `gea flash`

Builds and deploys an app to a physical target.

Expected options:

```sh
gea flash --app bouncing-balls-jsx --board amoled
gea flash --app bouncing-balls-jsx --board amoled --monitor
gea flash --app css-3d-cube --target android
```

The CLI resolves board aliases from two machine-local files merged project over
home: `~/.geastack/boards.json` (every board on the machine, `GEA_HOME`
relocates it) and the project's `.gea/boards.json`. `--boards-config` replaces
both. No package ships aliases. `gea boards` manages them: `list`, `show`,
`add`, `set <alias> <key> <value>`, `remove`, `rename`, and `discover`, which
identifies connected boards over USB (`GEADEV PING` reports app, IP and MAC).

### `gea chips`

Inspects the installed `@geastack/chips` catalog and composes a custom board
definition without copying native driver source into the app.

```sh
gea chips list
gea chips info co5300
gea chips add co5300 ft3168 --board my-board
gea chips remove ft3168 --board my-board
```

`add` asks only the interface and pin questions declared by each chip. Automation
can answer them with repeated `--set chip.path=value` options. The command rejects
chips without a binding for the board adapter and MCU before changing the target
definition.

### `gea boards`

Manages the board aliases every other command resolves `--board` against.

```sh
gea boards list
gea boards show amoled
gea boards add
gea boards set amoled host 192.168.1.100
gea boards rename amoled amoled-desk
gea boards remove amoled
gea boards discover --save
```

Aliases come from two files merged project over machine:
`~/.geastack/boards.json` holds every board on this machine, and the project's
`.gea/boards.json` holds project overrides. `--boards-config` or
`GEA_BOARDS_CONFIG` replaces both. `list` names the file each alias came from.

`--global` and `--local` choose where a write lands. By default an existing
alias is edited in the file it already lives in, and a new one joins the
project config when the project has one.

`set` takes a shorthand key or any dotted path into the entry: `host` for
`transports.ota.host`, `serial` for `transports.usbSerial.serial`, `restart`
for `transports.usbSerial.restartAfterFlash`, plus `target` and `adapter`. An
empty value removes the field.

`discover` sends one identity probe to each USB serial port and prints what
answered: the port, the matching alias, the USB serial number, the app running,
and the board's address. `--save` writes each discovered address into that
alias's `transports.ota.host`. A port whose board is not registered shows as
not configured, which is how an unknown board gets an alias.

### `gea devctl`

Controls a board that is already running an app: state, input injection, file
transfer, and display settings. Fully documented in
[DEVICE-CONTROL.md](DEVICE-CONTROL.md).

```sh
gea devctl ping --board amoled
gea devctl tap 120 240 --board amoled
gea devctl brightness 40 --board amoled
gea devctl hbm on --board amoled --transport usb
```

Most verbs speak the GEADEV line protocol over USB and require the cable. The
three display knobs (`brightness`, `hbm`, `vsync`) also answer over HTTP, so
they accept `--transport`; each reports the current setting when given no
value.

### `gea monitor`

Starts a log monitor for a configured board or target.

Expected options:

```sh
gea monitor --board amoled
gea monitor --target esp32-s3-touch-amoled-2.06
```

### `gea doctor`

Checks the local environment.

Minimum checks:

- Node/npm availability where required;
- ESP-IDF availability for ESP32 targets;
- Xcode availability for Apple targets;
- Android SDK and adb availability for Android targets;
- Python availability for device helpers;
- configured boards file validity;
- app manifest validity for the current folder.

Human-readable output should point to [SETUP.md](SETUP.md) whenever a required
or optional dependency is missing.

### `gea create`

Scaffolds a new app folder with:

- `package.json` containing a `gea` manifest;
- a bundled counter starter, a blank application, or a selected GitHub example;
- `index.tsx` or `index.ts`;
- `tsconfig.json`;
- `vite.config.ts`;
- `.gea/boards.json`;
- optional icons;
- target compatibility flags.

Interactive starter choices must explain the tradeoff in-line:

- `Embedded component counter`: create a touchscreen counter with local
  component state, an ESP32 target, and BLE updates enabled.
- `Blank application`: ask where the app should run, generate the matching
  minimal project, and ask whether to enable Bluetooth updates for ESP32.
- `Example application`: fetch a selected app from `geastack/examples`, then rewrite
  package name, app id, dependencies, and board config for the new project.

Rich example choices come from the hard-coded `examples/catalog.json`
included in the `@geastack/cli` package. The package does not vendor rich
example source files; it fetches the selected example from GitHub when the user
chooses it. Native examples are first-class catalog entries: an iOS example must
preserve `gea.targets.ios: true` so `npx gea build --target ios` routes through
the Apple backend, and a macOS example must preserve `gea.targets.macos: true`.

## App Manifest

The CLI should recognize the `gea` field in `package.json`.

Core fields:

```json
{
  "gea": {
    "id": "bouncing-balls-jsx",
    "name": "Balls JSX",
    "entry": "index.tsx",
    "targets": {
      "web": true,
      "esp32": true,
      "geaos": true,
      "macos": false,
      "ios": false,
      "android": false
    }
  }
}
```

Validation rules:

- `id` is required and should be stable.
- `entry` is required and must exist.
- `runtime` defaults to `gea`; only non-Gea native applications should set it.
- `targets` must be explicit for generated apps.
- target backends may reject apps whose runtime or capabilities they do not
  support.

### Native build contributions

A target entry is `true` for "enabled with defaults", or an object that both
enables the target and configures it. Keeping the two together makes the
contradictory state -- a disabled target carrying configuration -- impossible to
write. `defines` and `nativeSources` stay at the top level because they mean the
same thing for any native target.

```jsonc
{
  "gea": {
    "nativeSources": ["native/engine.cpp"],
    "compilerPlugins": ["scripts/host-functions.mjs"],
    "defines": { "GEA_EMBEDDED_UI_TRANSFORM_CACHE_SLOTS": 4 },
    "targets": {
      "web": true,
      "esp32": {
        "componentDirs": ["native/audio", "third_party/usb"],
        "componentRequires": ["audio", "usb"],
        "linkOptions": ["-Wl,--wrap=tlsf_memalign_offs"],
        "embedFiles": { "factory_model": "assets/model.namb" },
        "ldFragments": "native/memory.lf",
        "sdkconfig": "native/sdkconfig.defaults",
        "prebuild": "node scripts/pack-assets.mjs",
        "partitions": {
          "nvs":    { "type": "data", "subtype": "nvs",   "size": "24K", "offset": "0x9000" },
          "ota_0":  { "type": "app",  "subtype": "ota_0", "size": "4M" },
          "models": { "type": "data", "subtype": "0x40",  "size": "6M", "data": "build/models.bin" }
        }
      }
    }
  }
}
```

- `nativeSources` — C/C++/ObjC sources compiled into the board's main component.
  Their directories become include paths.
- `compilerPlugins` — the app's own geatsc plugins, e.g. one declaring the native
  host functions its TSX calls. They are passed to the compiler for every native
  target, because the boundary they describe is the app's, not a board's.
- `defines` — preprocessor macros, as an object or as `NAME=value` strings; a
  value of `true` emits a bare define and `false` drops the entry. These apply
  to the **whole** native build: a macro that sizes a framework type changes
  that type's layout, so the framework and the app must agree on it.
- `componentDirs` — extra ESP-IDF component directories. A component is not a
  list of files: it carries its own compile options, `REQUIRES` and conditions,
  which is why these cannot be folded into `nativeSources`.
- `componentRequires` — the component names the app's own `nativeSources` need
  headers or `PUBLIC` compile definitions from. Registering a component through
  `componentDirs` puts it in the build; it does not put it on the app sources'
  include path, because those sources are compiled into the board's `main`
  component and ESP-IDF resolves include paths through `REQUIRES`.
- `linkOptions` — linker flags, e.g. `-Wl,--wrap=<symbol>`.
- `embedFiles` — `{ symbol: file }`. The bytes go into the application image and
  the firmware reaches them by that symbol. Covers both `EMBED_FILES` and
  `target_add_binary_data(... RENAME_TO)`.
- `ldFragments` — ESP-IDF linker fragment files (`.lf`), for placing sections in
  a particular memory. Each mapping names the archive it applies to, so a
  fragment can target the framework as well as the app.
- `partitions` — a path to an existing partition CSV, or the table itself. The
  object form generates the CSV, and a partition's `data` file is flashed into
  it: keeping the payload on the same line as the size means a payload cannot
  name a partition that does not exist. Either form replaces the board's static
  table for this app -- for the build and for `gea flash`, which writes the
  payloads alongside the app and reads slot offsets from the app's table. `embedFiles` and `data` are different
  things; an app may want both, e.g. to repair a stale data partition at boot
  from the copy carried in the image.
- `sdkconfig` — the app's own `sdkconfig.defaults`, layered over the board's:
  ESP-IDF reads both files in order, so the app only has to state what it
  changes. Turning `CONFIG_BT_ENABLED` on here is how an app that drives a
  Bluetooth stack from its own native sources, rather than through the Gea BLE
  API, keeps the controller in the build.
- `prebuild` — a command run before the build, for generating the files the
  fields above refer to.

Boards need no per-board change to accept any of this.

## Backend Contract

Each target backend should expose enough metadata for the CLI to:

- list target id, display name, platform, and capabilities;
- check local prerequisites;
- build one app;
- deploy one app when supported;
- monitor logs when supported;
- report useful errors in a structured way.

A backend command can be a script, Node module, or binary. The CLI should keep
the user-facing command stable even if a backend changes implementation
language.

## Exit Codes

Use predictable exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Generic command failure. |
| `2` | Invalid CLI usage or manifest. |
| `3` | Missing local dependency. |
| `4` | Target/backend unavailable. |
| `5` | Build failed. |
| `6` | Deploy or monitor failed. |

## First Implementation Slice

1. Implement `gea doctor` for toolchain discovery and app manifest validation.
2. Implement `gea dev --target web` by delegating to the simulator repo.
3. Implement `gea build --target web`.
4. Implement `gea flash --board <alias>` natively (ESP-IDF, esptool, OTA and
   device transports live in `src/esp32` and `src/device`).
5. Add `create-geastack` with one JSX app template.

Status: implemented.
