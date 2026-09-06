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

Known-board setup asks whether the board is plugged in, reads each USB
device's serial from the OS and pings it (so a board is picked by the app it
reports running, never by a `/dev` name), shows a review screen, writes a board alias into the active boards config
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

It installs or dry-runs ESP-IDF with the ESP32, ESP32-S3, and ESP32-P4
toolchains. The version is resolved dynamically: `--idf-version <tag>` or
`GEA_ESP_IDF_VERSION` pins an exact release, otherwise GeaStack tries the
latest stable ESP-IDF release on GitHub and falls back to its pinned default
(currently v6.0.2) when that cannot be determined.

## Board Management

Board aliases are machine state, not package content. They live in
`~/.geastack/boards.json` for every board on the machine, and in the project's
`.gea/boards.json` for project overrides, merged project over machine. Nothing
ships aliases inside an npm package, so installing or updating GeaStack can
never overwrite the boards someone has registered.

```sh
npx gea boards list
npx gea boards discover
npx gea boards set amoled host 192.168.1.100 --global
```

`--global` writes the machine file, `--local` the project's. Without either, an
existing alias is edited where it already lives and a new one joins the project
config when there is one. `--boards-config <file>` or `GEA_BOARDS_CONFIG`
replaces both tiers for a single run.

`gea boards discover` answers "which board is this, and what is it doing". It
probes each USB serial port, reads the port's real USB serial number from the
operating system, matches it against the registered aliases, and asks the
firmware to identify itself:

```text
/dev/cu.usbmodemXXXX  amoled (esp32-s3-touch-amoled-2.06)  serial ...  app tilt-breakout  ip 192.168.1.100
```

Add `--save` to record each discovered address in the matching alias, which is
the reliable way to fix a stale over-the-air host after a board changes
address.

Two details are deliberate. Only call-out devices are listed, not their
`tty` twins, because a single board otherwise appears twice under two names.
And a board is identified by what it reports, never by its `/dev` path, whose
numeric suffix changes on every re-plug.

## Choosing An App

ESP32 and RP2350 firmware is built for exactly one app. The app decides which
capabilities are compiled in, so WiFi, Bluetooth and audio exist in the binary
only when that app's bindings need them.

Because of that, `build`, `flash` and `ota` for those boards refuse to run
without an app rather than falling back to a placeholder, and the error lists
the apps they can see:

```text
Board 'amoled' builds one app at a time: pass --app <id> or run inside the app folder
```

Run the command from inside an app folder, or name it with `--app <id>`. The
setup wizard picks an app while registering a board and prints the complete
next command, including `--app` when the chosen app is not the folder you are
standing in.
