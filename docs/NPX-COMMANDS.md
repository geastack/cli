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

`create-geastack` should add `@geastack/cli` as a dependency in generated
projects and install dependencies by default in interactive terminals. After
that, inside the project, `npx gea ...` works because npm finds the local
`node_modules/.bin/gea` binary. It does not require an npm package named `gea`.

If someone is wiring an existing app by hand, install the package first:

```sh
npm install @geastack/cli
npx gea setup
```

Creator-style scaffolding is:

```sh
npx @geastack/create-geastack my-app
```

In an interactive terminal, `create-geastack` asks:

```text
What do you want to build?
1. Embedded component counter
2. Blank application
3. Example application
```

`Embedded component counter` is the bundled tutorial starter. It uses local
component state, targets ESP32, and enables BLE updates.

`Blank application` asks where the app should run. It creates the smallest
project for that target and, for ESP32, asks whether to enable wireless
firmware updates over Bluetooth. Browser-only files such as `index.html` and
`vite.config.ts` are added only when the web target is selected.

`Example application` opens an example picker populated from the hard-coded
`examples/catalog.json` shipped inside `@geastack/cli`. The catalog contains web,
ESP32, GeaOS, iOS, macOS, and Android examples with names, descriptions, target
flags, and GitHub paths. When the user selects an example, the CLI fetches that app from
`geastack/examples`, copies it into the new project, then rewrites
`package.json`, app id, app name, `@geastack/core`, `@geastack/cli`, and
`.gea/boards.json`.

Automation can skip prompts:

```sh
npx @geastack/create-geastack my-app --starter counter
npx @geastack/create-geastack my-app --starter blank --yes
npx @geastack/create-geastack my-app --starter example --example watch
npx @geastack/create-geastack my-ios-app --starter example --example ios-native-showcase
npx gea build --target ios --mode simulator
npx @geastack/create-geastack cube-app --starter example --example css-3d-cube
npx gea build --target android --mode device
```

The private npmjs flow does not depend on a cloned examples repo. The rich
examples are fetched by the CLI when selected.

Do not change GitHub repository privacy while preparing this shape. The npm
packages are scoped and configured for restricted npmjs publication.

## Setup Wizard Contract

`gea setup` with no `--board` or `--target` opens a guided setup flow:

- known supported board, with descriptions for each board;
- custom board target composed from the installed chip catalog;
- npm dependency check/install only;
- ESP-IDF toolchain check/install only.

Known-board setup detects attached serial devices, asks for a stable USB serial,
shows a review screen, writes a board alias into the active boards config
(`--global` for `~/.geastack/boards.json`, `--local` for the project's
`.gea/boards.json`; by default the project config when it exists), then
initializes the selected board target so the next command can be
`npx gea flash --board <alias> --monitor`. In generated apps, that config is:

```text
.gea/boards.json
```

Custom-board setup reads `@geastack/chips/catalog.json`, offers only drivers
with a compatible platform binding, and asks the configuration questions
declared by each selected driver. It shows a review before writing the target:

```text
.gea/targets/<alias>.json
```

The target captures:

- MCU / SoC;
- the generic platform base and adapter;
- display controller, interface, dimensions, bus, and pins;
- touch controller, bus, reset, and interrupt pins;
- power, IMU, and audio drivers;
- shared buses and audio pins;
- optional storage and launcher-button pins;
- the initial USB serial connection.

The wizard also writes `.gea/boards.json`, where the physical board alias points
to that definition. A partial composition is saved but is not described as
flash-ready. It can be completed later with:

```sh
npx gea chips list
npx gea chips info co5300
npx gea chips add co5300 --board my-board
npx gea chips remove co5300 --board my-board
```

ESP-IDF setup is available as:

```sh
npx gea setup --esp-idf
```

It installs or dry-runs ESP-IDF v6.0.1 with the ESP32, ESP32-S3, and ESP32-P4
toolchains.
