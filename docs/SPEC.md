# Gea CLI Specification

This document captures the first useful shape of the `gea` command. The first
implementation now ships in this repo; keep this spec aligned as the command
surface grows.

## Goals

The CLI should make the split GeaStack repos feel like one toolchain:

- start a web simulator for an app;
- build an app for a selected target;
- flash or install an app on hardware;
- monitor logs;
- diagnose missing toolchains, paths, and board configuration;
- scaffold a new app with a valid `gea` manifest.

## Non-Goals

The CLI should not duplicate target internals. It should delegate to stable
backend commands owned by target repos.

Examples:

- ESP32 board flashing stays in `targets-embedded`.
- Web simulator launch stays in `simulator`.
- Apple project generation stays in `apple`.
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
```

### `gea flash`

Builds and deploys an app to a physical target.

Expected options:

```sh
gea flash --app bouncing-balls-jsx --board amoled
gea flash --app bouncing-balls-jsx --board amoled --monitor
```

The CLI should pass through board aliases from `targets-embedded/boards.json`
and should show the resolved board, target, adapter, and port before flashing.

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

- split-repo sibling layout;
- Node/npm availability where required;
- ESP-IDF availability for ESP32 targets;
- Xcode availability for Apple targets;
- Python availability for device helpers;
- configured boards file validity;
- app manifest validity for the current folder.

Human-readable output should point to [SETUP.md](SETUP.md) whenever a required
or optional dependency is missing.

### `create-geastack`

Scaffolds a new app folder with:

- `package.json` containing a `gea` manifest;
- `index.tsx` or `index.ts`;
- `tsconfig.json`;
- `vite.config.ts`;
- optional icons;
- target compatibility flags.

## App Manifest

The CLI should recognize the `gea` field in `package.json`.

Core fields:

```json
{
  "gea": {
    "id": "bouncing-balls-jsx",
    "name": "Balls JSX",
    "entry": "index.tsx",
    "runtime": "gea",
    "targets": {
      "web": true,
      "esp32": true,
      "geaos": true,
      "macos": false,
      "ios": false
    }
  }
}
```

Validation rules:

- `id` is required and should be stable.
- `entry` is required and must exist.
- `runtime` defaults to `gea` when omitted.
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
the public command stable even if a backend changes implementation language.

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

1. Implement `gea doctor` for split-repo discovery and app manifest validation.
2. Implement `gea dev --target web` by delegating to the simulator repo.
3. Implement `gea build --target web`.
4. Implement `gea flash --board <alias>` by delegating to
   `targets-embedded/scripts/board`.
5. Add `create-geastack` with one JSX app template.

Status: implemented.
