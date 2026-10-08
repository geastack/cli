# Custom QSPI panel startup

Custom ESP32-S3 boards can select the `co5300` or `sh8601` display binding and supply panel-specific startup settings under `chips.display.panel`:

```json
{
  "driver": "sh8601",
  "interface": "qspi",
  "width": 410,
  "height": 502,
  "pclkHz": 40000000,
  "panel": {
    "transferMode": "bitmap",
    "xGap": 22,
    "yGap": 0,
    "initCommands": [
      { "command": 17, "delayMs": 120 },
      { "command": 196, "data": [128] },
      { "command": 41, "delayMs": 10 }
    ]
  }
}
```

This shortened list illustrates the schema; use the panel manufacturer's complete sequence. Commands and data are byte values; each command permits up to 32 bytes and a delay of 0–65535 ms. The list must contain 1–256 commands. Omitted data means a zero-length payload, not a zero byte.

`initCommands` replaces the binding's vendor initialization list. The ESP-IDF component still initializes pixel format and color order. Omit the list to retain the binding's existing startup behavior. Each omitted gap retains the binding's existing offset.

`pclkHz` optionally selects the QSPI clock from 1–80 MHz. Omit it to preserve the base target clock.

Offsets apply to both ESP-IDF bitmap draws and Gea's streamed address windows. They are added once; they do not change the logical width or height.

Register the profile using a local board entry with `targetDefinition` relative to `.gea/boards.json`, `appPlatform: "esp32"`, and its USB serial identity. Build and flash with `gea flash --board <alias> --app <id>`.

`panel.transferMode` selects `bitmap` (ESP-IDF sets each chunk window), `stream` (RAMWR/RAMWRC continuations), or `cs-held` (data-only continuations with chip select held). Omit it to preserve the base target mode. Use bitmap when reproducing a vendor reference before testing streaming optimizations.

`panel.minChunkRows` can be 1 or 2. Set it to 2 for panels whose address windows require even row starts and row counts; the flush pipeline must retain that minimum when reserving RAM for radios.
