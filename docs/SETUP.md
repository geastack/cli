# GeaStack Setup

This guide gets a fresh machine ready to create, build, simulate, and flash Gea
apps from the split-repo checkout.

Start by running:

```sh
gea doctor
```

`doctor` checks the local repo layout, app catalog, board configuration, and the
toolchains below.

## Minimum Setup

For simulator-only development:

- Node.js 20.19 or newer.
- npm.
- Emscripten SDK if you want `gea build --target web` and the WASM simulator
  bundle path.

For ESP32 hardware:

- Node.js 20.19 or newer.
- npm.
- Python 3.
- ESP-IDF v6.0.1.
- `targets-embedded/boards.json` configured for your board.

For Apple targets:

- macOS.
- Xcode with iOS/macOS SDKs.
- Xcode command line tools.
- iOS Simulator runtime if building/running iOS simulator apps.

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

The embedded board scripts currently target ESP-IDF v6.0.1. Newer ESP-IDF
6.0.x releases may work, but v6.0.1 is the known target until the board scripts
are updated.

Command-line install:

```sh
mkdir -p "$HOME/esp"
cd "$HOME/esp"
git clone -b v6.0.1 --recursive https://github.com/espressif/esp-idf.git
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
`$HOME/esp32/esp-idf`, and `$HOME/esp32/esp-idf-v6.0.1`.

Verify through GeaStack:

```sh
gea doctor
gea build watch --board amoled --dry-run
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

For every new shell where you run `gea build --target web`, source:

```sh
. "$HOME/emsdk/emsdk_env.sh"
```

Verify:

```sh
gea doctor
gea build watch --target web
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
gea doctor
gea build watch --target macos
gea build watch --target ios --mode simulator
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

Board aliases are local machine configuration. Start from the example file:

```sh
cd targets-embedded
cp boards.example.json boards.json
```

Edit `boards.json` with your board alias, target, serial adapter, and optional
OTA host. Example:

```json
{
  "amoled": {
    "target": "esp32-s3-touch-amoled-2.06",
    "adapter": "esp32-idf",
    "transports": {
      "usbSerial": {
        "serial": "YOUR_BOARD_USB_SERIAL"
      }
    }
  }
}
```

Then check discovery:

```sh
gea list boards
gea list targets
gea doctor
```

## Common Verification Flow

After installing tools:

```sh
gea doctor
gea list apps
gea dev watch
gea build watch --target web
gea build watch --board amoled --dry-run
gea flash watch --board amoled --monitor
```

Use `--dry-run` first when checking command routing. Remove it when the target
toolchain and board config are ready.

## Useful References

- ESP-IDF Programming Guide: https://docs.espressif.com/projects/esp-idf/
- Emscripten SDK downloads: https://emscripten.org/docs/getting_started/downloads.html
- Node.js downloads: https://nodejs.org/en/download
- Xcode resources: https://developer.apple.com/xcode/resources/
