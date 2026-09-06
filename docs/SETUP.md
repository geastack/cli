# GeaStack Setup

This guide gets a fresh machine ready to create, build, simulate, and flash Gea
apps through the npm-first GeaStack flow.

Start by running:

```sh
npx gea doctor
```

`doctor` checks the active app, board configuration, and the toolchains below.

## Minimum Setup

Private npmjs command shape:

```sh
npm login
npx @geastack/create-geastack my-app
cd my-app
npx gea setup
```

For simulator-only development:

- Node.js 20.19 or newer.
- npm.
- Emscripten SDK if you want `npx gea build --target web` and the WASM simulator
  bundle path.

For ESP32 hardware:

- Node.js 20.19 or newer.
- npm.
- Python 3.
- ESP-IDF v6.0.2 (GeaStack's pinned default; see ESP-IDF For ESP32 Targets below).
- a board alias for your board (`~/.geastack/boards.json` or the project's `.gea/boards.json`, see Board Configuration).

For the Waveshare ESP32-S3 AMOLED board, use
[ESP32-WAVESHARE-AMOLED-QUICKSTART.md](ESP32-WAVESHARE-AMOLED-QUICKSTART.md).

For Apple targets:

- macOS.
- Xcode with iOS/macOS SDKs.
- Xcode command line tools.
- iOS Simulator runtime if building/running iOS simulator apps.

For Android targets:

- Android SDK command-line tools and platform tools.
- `adb` on `PATH`.
- A Java JDK with `javac`.
- `ANDROID_HOME` or `ANDROID_SDK_ROOT` pointing at the Android SDK.

## Node And npm

Install Node.js from the official download page or your normal version manager.
GeaStack currently requires Node.js 20.19 or newer. Node 24 LTS is a good
default on new machines.

Verify:

```sh
node --version
npm --version
```

## ESP-IDF For ESP32 Targets

The embedded board scripts target ESP-IDF v6.0.2 by default. GeaStack resolves
the version it installs or verifies dynamically, in this order:

1. `--idf-version <tag>` (e.g. `npx gea setup --esp-idf --idf-version v6.1.0-rc1`)
   to pin an exact release or try a release candidate.
2. `GEA_ESP_IDF_VERSION` (same shape) when no `--idf-version` is given.
3. The latest stable ESP-IDF release on GitHub, when it can be determined
   (release candidates and betas are ignored).
4. The pinned default, v6.0.2, when nothing above applies (offline, GitHub
   unreachable, etc).

Verifying an existing install accepts any installed version whose
major.minor is the same as or newer than the resolved target -- an installed
6.0.2 is never rejected just because the resolved target moved on to, say,
6.1.0, unless it genuinely trails it.

Command-line install:

```sh
npx gea setup --esp-idf
```

Equivalent manual install:

```sh
mkdir -p "$HOME/esp"
cd "$HOME/esp"
git clone -b v6.0.2 --recursive https://github.com/espressif/esp-idf.git
cd esp-idf
./install.sh esp32,esp32s3,esp32p4
. ./export.sh
idf.py --version
```

For every new shell where you build or flash ESP32 firmware, source the export
script:

```sh
. "$HOME/esp/esp-idf/export.sh"
```

If ESP-IDF lives somewhere else, either source that location's `export.sh` before
running Gea commands or set:

```sh
export GEA_EMBEDDED_IDF_EXPORT="/path/to/esp-idf/export.sh"
```

The board script also checks common locations such as `$HOME/esp/esp-idf`,
`$HOME/esp32/esp-idf`, and `$HOME/esp32/esp-idf-v6.0.2`.

Verify through GeaStack:

```sh
npx gea doctor
npx gea setup
npx gea build --board amoled --dry-run
```

Remove `--dry-run` when your board config is ready.

## Emscripten For Web/WASM Simulator Builds

The live web dev loop uses Vite. The WASM simulator build path additionally
needs `emcc` from the Emscripten SDK.

Install with `emsdk`:

```sh
git clone https://github.com/emscripten-core/emsdk.git "$HOME/emsdk"
cd "$HOME/emsdk"
./emsdk install latest
./emsdk activate latest
. ./emsdk_env.sh
emcc --version
```

For every new shell where you run `npx gea build --target web`, source:

```sh
. "$HOME/emsdk/emsdk_env.sh"
```

Verify:

```sh
npx gea doctor
npx gea build --target web
```

## Xcode For Apple Targets

Install Xcode from the Mac App Store or Apple Developer resources. Then make
sure command line tools point at the Xcode installation:

```sh
xcode-select --install
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcodebuild -version
```

Open Xcode once to finish first-run setup and install any required simulator
runtimes from Xcode Settings > Platforms.

For signed iOS device builds, set your Apple development team:

```sh
export GEA_IOS_DEVELOPMENT_TEAM=ABCDE12345
```

Verify:

```sh
npx gea doctor
npx gea build --target macos
npx gea build --target ios --mode simulator
```

## Android SDK

Install Android Studio or the Android SDK command-line tools. Make sure the SDK
has at least one platform and build-tools package installed, then export:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

Verify:

```sh
adb version
javac --version
npx gea doctor
npx gea build css-3d-cube --target android
```

For an attached Android device or board with USB debugging enabled:

```sh
npx gea build css-3d-cube --target android --mode device
```

If more than one adb is installed, point Gea at the one you want:

```sh
GEA_ANDROID_ADB="$ANDROID_HOME/platform-tools/adb" \
GEA_ANDROID_SERIAL="<adb-serial>" \
npx gea build css-3d-cube --target android --mode device
```

## Python

Python 3 is used by device helpers, serial helpers, screenshots, and GeaOS
device scripts.

Verify:

```sh
python3 --version
```

If your platform does not provide Python 3, install it with your OS package
manager or from python.org.

## Board Configuration

A board alias names one physical unit: `gea flash --board amoled` resolves
`amoled` to a target, a USB serial and, optionally, an IP. Aliases are
machine-local configuration and never come from a package. The CLI merges two
files, project over home:

| file | holds | written by |
| --- | --- | --- |
| `~/.geastack/boards.json` | every board on this machine (`GEA_HOME` relocates the directory) | `gea boards add --global`, `gea boards set` |
| `<project>/.gea/boards.json` | aliases specific to one application; overrides a home alias of the same name | `create-geastack` (empty), `gea boards add` |

`--boards-config <file>` (or `GEA_BOARDS_CONFIG`) replaces both with exactly
that file. By default `gea boards add` writes to the project config when the
project has one and to the home config otherwise; an existing alias is always
edited where it lives.

```sh
npx gea boards discover                 # what is plugged in: alias, app, IP
npx gea boards add                      # register a board (guided)
npx gea boards list                     # every alias and which file it lives in
npx gea boards set amoled host 192.168.1.100
npx gea boards rename amoled desk-amoled
npx gea boards remove desk-amoled
npx gea doctor
```

`gea boards discover` sends one `GEADEV PING` to each serial device without
resetting it; a board running gea firmware answers with its app id, its IP
(when it has joined WiFi) and its MAC, and the CLI pairs the reply with an
alias by USB serial. `--save` writes a reported IP into
`transports.ota.host`, which is what `gea ota`, `gea logs` and
`gea screenshot` use over WiFi.

### Entry shapes

Every entry names a `target` (`gea targets list`) and its `adapter`, then the
transports the board offers. The USB serial is the stable identity: on ESP32
boards it is the station MAC, and the CLI resolves it to today's `/dev` port
at call time, so never record a port path.

```json
{
  "amoled": {
    "target": "esp32-s3-touch-amoled-2.06",
    "adapter": "esp32-idf",
    "transports": {
      "usbSerial": { "serial": "80:B5:4E:DA:73:88" },
      "ota": { "host": "192.168.1.100" }
    }
  },
  "rotary": {
    "target": "esp32-s3-elecrow-rotary-2.1",
    "adapter": "esp32-idf",
    "transports": {
      "usbSerial": { "serial": "14:C1:9F:26:65:08", "restartAfterFlash": "manual" }
    }
  },
  "tufty": {
    "target": "rp2350-tufty-2350",
    "adapter": "rp2350-pico",
    "transports": { "usbSerial": { "serial": "fa59949adbb4802f" } }
  },
  "linux": {
    "target": "geaos",
    "adapter": "geaos-linux",
    "transports": {
      "telnet": { "host": "192.168.7.2", "port": 2323 },
      "fastboot": { "serial": "geaos001" }
    }
  },
  "lokmat": {
    "target": "lokmat-applp2max",
    "adapter": "geaos-arm64",
    "transports": {
      "usbSerial": { "serial": "geaos01" },
      "fastboot": { "serial": "0123456789ABCDEF" },
      "mtk": { "workdir": "~/lokmat-root" }
    }
  },
  "my-board": {
    "target": "my-board",
    "targetDefinition": "targets/my-board.json",
    "adapter": "esp32-idf",
    "transports": { "usbSerial": { "serial": "YOUR_BOARD_USB_SERIAL" } }
  }
}
```

- `restartAfterFlash: "manual"` marks a board whose USB-Serial-JTAG port
  re-enters ROM download mode after a flash; the CLI stops and asks for a
  power cycle instead of pulsing the reset lines.
- `targetDefinition` points at a custom target composed by `gea setup` /
  `gea chips`, relative to the file the alias lives in.

## Common Verification Flow

After installing tools:

```sh
npx gea doctor
npx gea inspect
npx gea dev
npx gea build --target web
npx gea setup
npx gea build --board amoled --dry-run
npx gea flash --board amoled --monitor
```

Use `--dry-run` first when checking command routing. Remove it when the target
toolchain and board config are ready.

## Useful References

- ESP-IDF Programming Guide: https://docs.espressif.com/projects/esp-idf/
- Emscripten SDK downloads: https://emscripten.org/docs/getting_started/downloads.html
- Node.js downloads: https://nodejs.org/en/download
- Xcode resources: https://developer.apple.com/xcode/resources/
