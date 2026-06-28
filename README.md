# @geastack/cli

Command-line front door for GeaStack.

This repo contains the `gea` CLI orchestrator and the `create-geastack`
scaffolder. The CLI productizes the current split-repo scripts into a stable
developer workflow while keeping target-specific build logic in the target repos.

## Commands

```sh
gea doctor
gea dev watch
gea build watch --target web
gea flash watch --board amoled --monitor
gea monitor --board amoled
gea list apps
gea inspect watch --json
create-geastack my-panel
```

The implementation wraps the behavior that currently lives in:

- `../targets-embedded/scripts/board`
- `../simulator/targets/web/dev-web.mjs`
- `../simulator/targets/web/build-web.sh`
- `../core/packages/core/bin/gea-embedded.mjs`
- target-specific scripts under `../apple`, `../geaos`, and
  `../targets-embedded`

## Development

```sh
npm test
npm run check
```

Run from this repo during local development:

```sh
node bin/gea.mjs doctor
node bin/gea.mjs build watch --target web --dry-run
node bin/create-geastack.mjs scratch-panel --dir /tmp/scratch-panel
```

## Machine Setup

Use [docs/SETUP.md](docs/SETUP.md) for Node/npm, ESP-IDF, Emscripten, Xcode,
Python, and board configuration. `gea doctor` checks the same dependencies and
prints warnings for optional target toolchains that are not installed.

## Responsibilities

The CLI should own:

- command parsing and help output;
- project scaffolding;
- Gea app manifest validation;
- target discovery and target backend dispatch;
- consistent output, diagnostics, and exit codes;
- `doctor` checks for local toolchains and split-repo paths.

The CLI should not own target implementation details. ESP32, GeaOS, Apple, and
web targets should keep their target-specific build logic in their own repos and
expose stable command contracts.

## Documentation

- [docs/SPEC.md](docs/SPEC.md): command surface, manifest expectations, and
  backend contract for the first implementation.

## Current Status

First implementation is in place:

- `doctor` for split-repo and local toolchain checks;
- `dev` and `build` for the web simulator target;
- `build` for macOS/iOS and board-backed targets;
- `flash` and `monitor` via `targets-embedded/scripts/board`;
- `list` and `inspect` helpers;
- `create-geastack` for a minimal JSX app template.
