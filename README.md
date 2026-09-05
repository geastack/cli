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
gea flash --board amoled --monitor
gea monitor --board amoled
gea inspect --json
```

## Interactive Menu Map

```mermaid
flowchart TD
  create["gea create my-app"] --> identity["Resolve app identity<br/>argument, optional --id, optional --name"]
  identity --> starter{"Starter app?"}

  starter -->|"Counter starter"| counter["Copy bundled minimal JSX counter"]

  starter -->|"Empty app"| empty["Generate minimal app files"]
  empty --> emptyFiles["index.tsx, styles.css, index.html,<br/>tsconfig.json, vite.config.ts"]

  starter -->|"Rich example"| pickExample["Pick from hard-coded example list<br/>web, ESP32, GeaOS, iOS, macOS, Android"]
  pickExample --> fetchExample["Fetch selected app from GitHub"]
  fetchExample --> copyExample["Copy fetched example files"]
  copyExample --> rewriteExample["Rewrite package name and gea manifest"]

  counter --> projectWiring["Add @geastack/core and @geastack/cli"]
  rewriteExample --> projectWiring["Add @geastack/core and @geastack/cli"]
  emptyFiles --> projectWiring
  projectWiring --> boardConfig["Create .gea/boards.json"]
  boardConfig --> install["Install npm dependencies<br/>(interactive default)"]
  install --> setup["Next: npx gea setup"]

  auto["Automation flags"] -.-> starter
  auto --> autoEmpty["--starter empty --yes"]
  auto --> autoExample["--starter example --example watch"]
```

```mermaid
flowchart TD
  setup["npx gea setup"] --> mode{"Mode?"}

  mode -->|"--esp-idf"| directIdf["Install or check ESP-IDF v6.0.1"]
  mode -->|"--board alias"| directBoard["Run target setup for board alias"]
  mode -->|"--target target-id"| directTarget["Run target setup directly"]

  mode -->|"Interactive"| interactive{"What do you want to set up?"}

  interactive -->|"Known supported board"| knownBoard["Pick board"]
  knownBoard --> alias["Set board alias"]
  alias --> serial["Detect serial devices"]
  serial --> saveSerial["Save stable USB serial"]
  saveSerial --> ota["Optional OTA host"]
  ota --> reviewKnown["Review board setup"]
  reviewKnown --> writeKnown["Write .gea/boards.json"]

  interactive -->|"Custom board profile"| custom["Collect hardware profile"]
  custom --> core["Alias, MCU, closest base target"]
  core --> depth{"Detail level?"}
  depth -->|"Full"| chips["Display, touch,<br/>WiFi/BLE, GPS, audio"]
  depth -->|"Fast"| fast["Display, touch,<br/>default peripherals"]
  chips --> peripherals["Storage, sensors, power,<br/>USB serial or OTA"]
  fast --> connection["USB serial or OTA"]
  peripherals --> connection
  connection --> notes["Notes and datasheet links"]
  notes --> reviewCustom["Review custom profile"]
  reviewCustom --> writeProfile["Write .gea/boards/alias.json"]
  writeProfile --> maybeAlias{"Base target selected?"}
  maybeAlias -->|"Yes"| writeCustomAlias["Write alias to .gea/boards.json"]
  maybeAlias -->|"No"| profileOnly["Profile only, not flash-ready yet"]

  interactive -->|"npm dependencies only"| npmInstall["Run npm install when package.json exists"]
  interactive -->|"ESP-IDF toolchain only"| idfOnly["Install or check ESP-IDF v6.0.1"]

  writeKnown --> initialize["Initialize board target"]
  writeCustomAlias --> initialize
  initialize --> ready["Ready: npx gea flash --board alias --monitor"]
  profileOnly --> done["Done"]
  npmInstall --> done
  idfOnly --> done
  directIdf --> done
  directBoard --> done
  directTarget --> done
```

The CLI resolves `@geastack/core`, `@geastack/targets`, the compiler, chips,
host bindings, and the other native packages from npm. A project can use a
local CLI with `npx gea` or a global installation with `gea`; neither command
depends on a GeaStack source checkout.

## Development

```sh
npm test
npm run check
```

Run from this repo during local development:

```sh
node bin/gea.mjs doctor
node bin/gea.mjs --help
node bin/create-geastack.mjs demo-panel --dir ./demo-panel --dry-run
```

## Machine Setup

Use [docs/SETUP.md](docs/SETUP.md) for Node/npm, ESP-IDF, Emscripten, Xcode,
Python, and board configuration. For the Waveshare ESP32-S3 AMOLED path, use
[docs/ESP32-WAVESHARE-AMOLED-QUICKSTART.md](docs/ESP32-WAVESHARE-AMOLED-QUICKSTART.md).
`npx gea doctor` checks the same dependencies and prints warnings for optional
target toolchains that are not installed.

[docs/NPX-COMMANDS.md](docs/NPX-COMMANDS.md) captures the private npmjs
`npx` command shape for release.

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

- [docs/SPEC.md](docs/SPEC.md): command surface, manifest expectations, and
  backend contract for the first implementation.

## Current Status

First implementation is in place:

- `doctor` for local toolchain checks;
- npm-resolved embedded board builds for ESP32 and RP2350;
- `flash`, `monitor`, WiFi OTA, and BLE OTA through `@geastack/targets`;
- `list` and `inspect` helpers;
- `create-geastack` with a bundled counter starter, an empty starter, and a
  GitHub-backed rich example flow for web, embedded, GeaOS, iOS, macOS, and Android apps,
  all with `.gea/boards.json`.
