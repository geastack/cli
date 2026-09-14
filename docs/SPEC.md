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

An app targeting a native board may also carry three optional fields. All three
are resolved against the app root and validated by `gea doctor`.

```jsonc
{
  "gea": {
    "nativeSources": ["native/engine.cpp"],  // compiled into the board's main component
    "defines": { "GEA_EMBEDDED_UI_TRANSFORM_CACHE_SLOTS": 4 },
    "ldFragments": "native/memory.lf"        // string or array
  }
}
```

- `nativeSources` — C/C++/ObjC sources. Their directories become include paths.
- `defines` — preprocessor macros, as an object or as `NAME=value` strings; a
  value of `true` emits a bare define and `false` drops the entry. These apply
  to the **whole** native build, not only the app's own sources: a macro that
  sizes a framework type (a cache-slot count, say) changes that type's layout,
  so the framework and the app must be compiled with the same value or they
  disagree about a struct at link.
- `ldFragments` — ESP-IDF linker fragment files (`.lf`). This is how an app
  places sections in a particular memory — for example moving Gea's
  zero-initialised statics to PSRAM so a realtime audio path keeps the scarce
  internal SRAM. Each mapping names the archive it applies to, so a fragment can
  target the framework as well as the app.

Boards need no change to accept any of them: the esp32 backend passes them to
CMake, `targets/esp32/gea_framework.cmake` applies the defines as a build
property, and the shared `gea_framework` component registers the fragments.

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
