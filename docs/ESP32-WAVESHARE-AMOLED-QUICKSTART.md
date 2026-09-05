# ESP32 Waveshare AMOLED Quickstart

Goal: fresh computer to flashed Waveshare ESP32-S3 Touch AMOLED app without cloning any GeaStack repo.

You should only need four moves:

1. Install the system basics.
2. Create a Gea app.
3. Run the setup wizard.
4. Flash the board.

## 1. Install The Basics

Install:

- Git
- Node.js 20.19 or newer
- npm
- Python 3

On macOS, also make sure Apple command line tools are installed:

```sh
xcode-select --install
```

You do not clone GeaStack.

## 2. Create The App

```sh
npm login
npm install --global @geastack/cli
gea create my-app
cd my-app
```

When the wizard asks what to create, choose:

```text
? What do you want to create?
  Counter starter - bundled minimal JSX app
  Empty app - minimal blank Gea app
  Rich example - fetch from GitHub examples repo
```

For the fastest first flash, choose `Counter starter`.

That creates a tiny JSX app and installs all of its project dependencies.

## 3. Set Up The Board

```sh
gea setup
```

Choose:

```text
? What do you want to set up?
  Known supported board

? Board
  Waveshare ESP32-S3 Touch AMOLED 2.06

? Board alias
  amoled

? Save this board setup?
  Yes
```

If ESP-IDF is not installed, accept the installer when offered:

```text
? ESP-IDF was not found. Install it now?
  Yes
```

If ESP-IDF was installed, the CLI prints this for future shells:

```sh
. "$HOME/esp/esp-idf/export.sh"
```

You do not need to run that before every command unless `gea doctor` says ESP-IDF is not active.

If the wizard finds a connected serial device, pick it. If no board is plugged in yet, that is fine; you can provide the port later.

The wizard writes the board config into your app at `.gea/boards.json` and initializes the selected board target.

## 4. Flash

Flash and open the serial monitor:

```sh
gea flash --board amoled --monitor
```

If you need to specify the serial port manually:

```sh
gea flash --board amoled --port /dev/cu.usbmodemXXXX --monitor
```

## Rich Examples

The bundled starter is intentionally tiny. Rich examples live in the GeaStack examples repo and are fetched on demand by name.

For example:

```sh
gea create watch-demo --starter example --example watch
cd watch-demo
gea setup
gea flash --board amoled --monitor
```

The CLI owns the example catalog, so the user does not need to clone the examples repo.

## If Something Fails

Run:

```sh
gea doctor
```

Most first-run issues are one of:

- ESP-IDF is not activated in the current shell.
- The USB cable is power-only.
- The serial port needs to be passed with `--port`.
- The board alias does not match the name in `.gea/boards.json`.
