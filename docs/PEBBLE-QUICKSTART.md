# Pebble Time 2 quickstart

Requires Gea CLI 0.1.85 or newer, Node.js 20.19 or newer, Bash, and the Pebble
SDK. This target builds ordinary `.pbw` apps for Pebble Time 2 (`emery`);
it does not flash watch firmware. The build script supports macOS and Linux.

## Install

Install the SDK and its toolchain:

```sh
uv tool install --python 3.13 pebble-tool
pebble sdk install latest
```

In an existing Gea TSX app:

```sh
npm install @geastack/core@^0.1.26 @geastack/pebble@^0.1.0
npm install --save-dev @geastack/cli@^0.1.85
```

The Pebble package installs the native engine, host, elements and geaos
packages it needs; core supplies the compiler and Gea compiler plugin.
Keep your existing app dependencies and add `pebble` to its manifest:

```json
{
  "gea": {
    "id": "my-watch-app",
    "name": "My Watch App",
    "entry": "index.tsx",
    "runtime": "gea",
    "targets": { "pebble": true }
  }
}
```

This is a fragment to merge into `package.json`. Preserve other targets you
already use. A custom entry such as `src/watch.tsx` is supported.
The generic scaffold wizard does not yet offer a Pebble preset; enable the
platform on an existing app as above. No board alias is required.

## Build and run

Run from the app directory:

```sh
npx gea build --target pebble
npx gea run --target pebble
npx gea run --target pebble --phone 192.168.1.23
```

Build writes `dist/pebble/<gea.id>.pbw`. Run builds first, then installs on the
`emery` emulator by default. For a physical watch, enable the developer
connection in the Pebble phone app, keep the watch connected to the phone,
and pass the phone's reachable IP address. UP/DOWN move focus, SELECT presses
the focused control, BACK exits, and touch taps controls.

In a workspace, select an app with `--app <gea.id>`. `--dry-run` prints the
build command without compiling or installing; it still requires the Pebble
package to be installed.

## Troubleshooting and limits

- Missing `@geastack/pebble`: run the npm install commands in the app directory.
- Missing SDK toolchain: run `pebble sdk install latest`, or set
  `PEBBLE_SDK_ROOT` to your SDK directory. Ensure `pebble` is on `PATH`.
- Build failure: inspect `dist/pebble/obj/codegen.log` and
  `dist/pebble/obj/pebble-build.log`; the command prints the failing log's tail.
- Failed phone installation: check the phone's developer connection, IP and
  network reachability. A successful build alone does not verify installation.
- This target has a 64 KB app-image limit and shares 128 KB between code and
  heap. Only the `emery` platform is supported. JavaScript exceptions end the
  app; `catch` does not run on this target.

LLVM plus a matching `ld.lld` is optional and produces smaller programs.
`GEA_PEBBLE_TOOLCHAIN=gcc` forces the SDK's GCC;
`GEA_PEBBLE_UI=engine` disables build-time UI specialization.

See the [Pebble package documentation](https://github.com/geastack/pebble/tree/main/packages/geastack-pebble)
for rendering support, memory limits, diagnostics and implementation details.
