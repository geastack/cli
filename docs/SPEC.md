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

The CLI should pass through board aliases from the active board config. A project
uses its own `.gea/boards.json`; otherwise the CLI reads the board catalog shipped
by the installed `@geastack/targets` package.

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
4. Implement `gea flash --board <alias>` by delegating to
   `targets/scripts/board`.
5. Add `create-geastack` with one JSX app template.

Status: implemented.
