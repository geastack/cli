# Device Control

`gea devctl` drives a board that is already running an app: read its state,
inject input, move files, and change display settings. It is the debugging and
automation surface, separate from building (`gea build`), installing
(`gea flash`, `gea ota`) and reading output (`gea monitor`, `gea logs`).

```sh
npx gea devctl <verb> [args] --board <alias> [--transport auto|usb|wifi]
```

A board is always named by its alias. There is no option that takes a `/dev`
path directly, because the numeric suffix on a serial device changes on every
re-plug and never identifies a particular board. Register aliases with
`gea setup` or `gea boards add`, and see which ones are plugged in right now
with `gea boards discover`.

Run `npx gea devctl` with no verb to print the same list the CLI enforces.

## Transports

Two independent paths reach a running board, and they carry different sets of
verbs.

| transport | how it reaches the board | what it carries |
| --- | --- | --- |
| `usb` | the board's USB serial port, GEADEV line protocol | every verb |
| `wifi` | HTTP on port 8080 at the board's recorded address | the three display knobs only |

Everything except the display knobs is GEADEV-only and therefore requires the
cable. Asking for one of them over WiFi fails with a message saying so rather
than hanging.

The default differs by verb, deliberately:

- **Display knobs** default to the cable whenever the board is actually
  attached, and fall back to its recorded address when it is not. A knob is a
  one-shot control, so the cable is the reliable path.
- **Every other verb** uses USB, since that is the only transport that carries
  it.

Pass `--transport usb` or `--transport wifi` to override, or `--host <ip>` to
aim at an address without consulting the alias. Naming a host implies WiFi.

The asymmetry matters for one specific case. GeaStack compiles WiFi into the
firmware only when the app's bindings need it, so an app that never touches the
network produces a board with no networking at all, while the alias still
records the address some earlier app answered on. Preferring the cable is what
keeps `hbm` working on that board.

## Display knobs

Three settings answer on both transports, which is why they are the only verbs
with a transport choice. Passing no value reports the current setting instead of
changing it. Every one replies with JSON on stdout.

```sh
npx gea devctl brightness --board amoled       # {"brightness":100}
npx gea devctl brightness 40 --board amoled    # {"brightness":40}
npx gea devctl hbm on --board amoled           # {"hbm":true,"supported":true}
npx gea devctl hbm off --board amoled          # {"hbm":false,"supported":true}
npx gea devctl vsync on --board amoled         # {"vsync":true}
```

| knob | argument | meaning |
| --- | --- | --- |
| `brightness` | `0`-`100` | panel backlight or equivalent, as a percentage |
| `hbm` | `on` \| `off` | the panel's high-brightness mode |
| `vsync` | `on` \| `off` | whether frames wait for the panel's vertical sync |

`on`, `1`, `true` and `yes` all read as on; `off`, `0`, `false` and `no` read as
off. Anything else is rejected rather than guessed at.

Not every panel implements high-brightness mode. On one that does not, the board
answers with `supported` false over USB and HTTP 501 over WiFi, and the CLI
reports that the board has no high-brightness control. This is a property of the
panel, not a failure of the command.

## Verbs

All of these need the USB transport.

### State and identity

| verb | what it does |
| --- | --- |
| `ping` | confirm the board answers the protocol at all |
| `app` | the id of the app currently running |
| `state` | the app's reported state |
| `mem` | heap and PSRAM figures |
| `summary` | a combined status report |
| `i2cscan` | addresses responding on the I2C bus |
| `reboot` | restart the board |

### Input injection

| verb | arguments |
| --- | --- |
| `tap` | `<x> <y> [holdMs]`, default hold 80 ms |
| `drag` | `<x1> <y1> <x2> <y2> [steps] [delayMs]`, defaults 6 steps and 24 ms |
| `swipe` | `<x> <y1> <y2>` |
| `key` | `<code>` |
| `back` | the platform back action |
| `notify` | `<text>`, the rest of the line is taken as the message |

Coordinates are in the panel's own pixels, origin top left.

### UI inspection

| verb | arguments |
| --- | --- |
| `node` | `<class>`, describe nodes matching a class |
| `hit` | `<x> <y>`, report what is under a point |

### Storage and files

| verb | arguments |
| --- | --- |
| `storage get` | `<key>` |
| `storage set` | `<key> <value>` |
| `ls` | `[path]`, defaults to `/sdcard` |
| `rm` | `<path>` |
| `push` | `<local> <remote>`, add `--base64` for a text-safe transfer |
| `pull` | `<remote> <local>` |
| `playfile` | `<path>` |

Local paths resolve against the working directory. `push` reports progress on
stderr, and both transfers verify a checksum, so a truncated file is an error
rather than a silently short one.

### Board defaults

| verb | arguments |
| --- | --- |
| `set-default` | `<app-id>`, the app the board launches on boot |
| `set-time` | `[epochSeconds]`, defaults to the host's current time |

## Wire protocols

Useful when working on the firmware side, or when reaching a board without the
CLI.

### GEADEV over USB serial

A line protocol. The host writes `GEADEV <VERB> [args]` and the board answers a
line beginning `GEADEV:`, with `GEADEV:OK <VERB> ...` on success and
`GEADEV:ERR <VERB> ...` on failure. Replies carry `key=value` pairs.

```text
GEADEV PING          -> GEADEV:PONG app=tilt-breakout ip=192.168.1.100 mac=...
GEADEV BRIGHTNESS    -> GEADEV:OK BRIGHTNESS value=100
GEADEV BRIGHTNESS 40 -> GEADEV:OK BRIGHTNESS value=40 readback=40
GEADEV HBM on        -> GEADEV:OK HBM value=1 supported=1
GEADEV VSYNC         -> GEADEV:OK VSYNC value=1
```

The port is opened without touching DTR or RTS. This is required, not
incidental: on the USB-Serial-JTAG boards, an ESP32-C3, S3 or P4, a DTR/RTS
sequence drops the chip into ROM download mode, where it stops answering and
waits for a firmware image. Any tool that asserts those lines will appear to
hang the board.

A board on firmware older than the alias-discovery work answers `PING` without
the `ip` and `mac` fields. Nothing breaks; the address simply reads as unknown.

### HTTP on port 8080

The same server that serves over-the-air updates carries the display knobs,
because it is the only HTTP surface a cable-free board has.

| route | query | reply |
| --- | --- | --- |
| `POST /display/brightness` | `value=0-100` | `{"ok":true,"brightness":40}` |
| `POST /display/hbm` | `on=1\|0` | `{"ok":true,"hbm":true}` |
| `POST /display/vsync` | `on=1\|0` | `{"ok":true,"vsync":true}` |

Omit the query string and the route reports rather than sets. A brightness
outside 0 to 100 is clamped rather than refused. `hbm` answers 501 on a panel
with no high-brightness mode.

```sh
curl -X POST "http://192.168.1.100:8080/display/hbm?on=1"
```

The same server also holds `POST /ota`, `POST /ota/erase`,
`GET /ota/status`, `GET /screenshot` and a flash benchmark. Port 8081 carries
the diagnostics log stream that `gea logs` reads.

One firmware detail is worth knowing before adding a route: ESP-IDF's default
server configuration caps registered URI handlers at 8, and registration past
that limit fails silently, leaving a route that returns 404 for no visible
reason. The board raises the cap explicitly.

## Troubleshooting

**`No such board` or an alias that resolves to nothing.** Aliases are read from
`~/.geastack/boards.json` and the project's `.gea/boards.json`. List what is
registered with `gea boards list`, which shows the file each alias came from.

**A display knob fails with a network error.** The board's recorded address
belongs to an app that had WiFi; the app running now may not. Add
`--transport usb` with the board plugged in.

**`firmware has no /display/<knob> endpoint`.** The board is running firmware
older than these routes. Reflash it, or use the cable.

**A verb reports that it needs the USB transport.** Only the three display knobs
answer over WiFi. Everything else needs the cable.

**The board stops answering and the log mentions waiting for download.** Some
other tool asserted DTR or RTS and put the chip in ROM download mode. Power
cycle it.

**A quoted argument arrives as one token.** A shell does not split an unquoted
variable the way it splits typed words. `devctl $ARGS` where `ARGS="hbm on"`
arrives as a single verb named `hbm on`. Pass the arguments separately.

## See also

- [`SETUP.md`](SETUP.md) for the board configuration files and their entry shapes
- [`NPX-COMMANDS.md`](NPX-COMMANDS.md) for `gea boards` and the setup wizard
- [`SPEC.md`](SPEC.md) for the full command surface and exit codes
