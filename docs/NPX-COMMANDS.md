# Private npm Command Shape

The intended private npmjs onboarding should not require cloning GeaStack repos.

Desired user flow:

```sh
npm login
npx @geastack/create-geastack my-app
cd my-app
npx gea setup
npx gea flash --board amoled --monitor
```

## Package Name Reality

There should not be an unscoped npm package. Private npmjs packages must be
scoped.

Use these release packages instead:

- `@geastack/create-geastack`: scoped private project/app scaffolder exposing
  the `create-geastack` bin.
- `@geastack/cli`: scoped private Gea CLI package exposing the `gea` bin.

`create-geastack` should add `@geastack/cli` as a devDependency in generated
projects and install dependencies by default in interactive terminals. After
that, inside the project, `npx gea ...` works because npm finds the local
`node_modules/.bin/gea` binary. It does not require an npm package named `gea`.

If someone is wiring an existing app by hand, install the package first:

```sh
npm install --save-dev @geastack/cli
npx gea setup
```

Creator-style scaffolding is:

```sh
npx @geastack/create-geastack my-app
```

In an interactive terminal, `create-geastack` asks:

```text
Starter app
1. Counter starter - bundled minimal JSX app
2. Empty app - minimal blank Gea app
3. Rich example - fetch from GitHub examples repo
```

`Counter starter` is the only bundled source starter. It is intentionally tiny:
JSX, one `store.ts`, and enough styling to run.

`Empty app` creates the smallest starter: `index.tsx`, `styles.css`,
`index.html`, `tsconfig.json`, `vite.config.ts`, `package.json`, and
`.gea/boards.json`.

`Rich example` opens an example picker populated from the hard-coded
`examples/catalog.json` shipped inside `@geastack/cli`. The catalog contains web,
ESP32, GeaOS, iOS, and macOS examples with names, descriptions, target flags, and
GitHub paths. When the user selects an example, the CLI fetches that app from
`geastack/examples`, copies it into the new project, then rewrites
`package.json`, app id, app name, `@geastack/core`, `@geastack/cli`, and
`.gea/boards.json`.

Automation can skip prompts:

```sh
npx @geastack/create-geastack my-app --starter counter
npx @geastack/create-geastack my-app --starter empty --yes
npx @geastack/create-geastack my-app --starter example --example watch
npx @geastack/create-geastack my-ios-app --starter example --example ios-native-showcase
npx gea build --target ios --mode simulator
```

The private npmjs flow does not depend on a cloned examples repo. The rich
examples are fetched by the CLI when selected.

Do not change GitHub repository privacy while preparing this shape. The npm
packages are scoped and configured for restricted npmjs publication.

## Setup Wizard Contract

`gea setup` with no `--board` or `--target` opens a guided setup flow:

- known supported board, with descriptions for each board;
- custom board profile, with fast and full hardware paths;
- npm dependency check/install only;
- ESP-IDF toolchain check/install only.

Known-board setup detects attached serial devices, asks for a stable USB serial,
shows a review screen, writes a board alias into the active boards config, then
initializes the selected board target so the next command can be
`npx gea flash --board <alias> --monitor`. In generated apps, that config is:

```text
.gea/boards.json
```

Custom-board setup can run in two depths:

- `Full hardware profile`: display, touch, WiFi/BLE, GPS, audio, storage,
  sensors, power, transport, and notes.
- `Fast profile`: core board identity, display/touch, transport, and inferred
  defaults for optional peripherals.

Both paths show a review screen before writing a profile under:

```text
.gea/boards/<alias>.json
```

The full profile captures:

- MCU / SoC;
- closest existing base target;
- display type, controller, interface, resolution;
- touch controller and interface;
- WiFi and BLE;
- GPS module and interface;
- audio codec, input, and output;
- storage;
- sensors;
- power path;
- USB serial and OTA transports;
- notes/datasheet links.

If the user selects a base target, the wizard also writes an experimental board
alias that points at that base target and references the custom profile. If no
base target is selected, the profile is generated without claiming the board is
flash-ready.

ESP-IDF setup is available as:

```sh
npx gea setup --esp-idf
```

It installs or dry-runs ESP-IDF v6.0.1 with the ESP32, ESP32-S3, and ESP32-P4
toolchains.
