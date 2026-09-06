import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { runGea } from "../src/gea.mjs"
import { capture } from "./helpers/fixture.mjs"

const testDir = path.dirname(fileURLToPath(import.meta.url))
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gea-heap-report-"))
const logPath = path.join(workDir, "fixture.txt")
const mapPath = path.join(workDir, "fixture.map")
const reportPath = path.join(workDir, "report.html")

test("gea heap-report renders the ESP32 heap map from a monitor log and linker map", async () => {
try {
    fs.writeFileSync(
        logPath,
        [
            "I (100) heap_init: At 3FCC7020 len 000226F0 (137 KiB): RAM",
            "I (110) gea_esp32_diag: heap probe [runtime:start] internal_free=115031 delta=+0 internal_largest=31744 internal_min=115031 psram_free=8271144 psram_delta=+0",
            "[heap-map] stage=runtime:start caps=dma_internal total_free=53248 largest=32020 min=53248 free_blocks=2 alloc_blocks=1 total_blocks=3",
            "[heap-free] stage=runtime:start caps=dma_internal heap=0 ptr=0x3fcd6434 size=32020",
            "[heap-map] stage=runtime:start caps=dma_internal heap=0 range=0x3fcd6150-0x3fcde14f free=32020 used=0 largest_free=32020 free_blocks=1 used_blocks=0",
            "[heap-free] stage=runtime:start caps=dma_internal heap=1 ptr=0x3fcf02e4 size=21228",
            "[heap-map] stage=runtime:start caps=dma_internal heap=1 range=0x3fcf0000-0x3fcf8000 free=21228 used=11540 largest_free=21228 free_blocks=1 used_blocks=1",
            "[heap-free] stage=runtime:start caps=internal8 heap=0 ptr=0x600fe180 size=7780",
            "[heap-map] stage=runtime:start caps=internal8 heap=0 range=0x600fe000-0x600fffe8 free=7780 used=0 largest_free=7780 free_blocks=1 used_blocks=0",
            "[heap-free] stage=runtime:start caps=internal8 heap=1 ptr=0x3fcd6434 size=32020",
            "[heap-map] stage=runtime:start caps=internal8 heap=1 range=0x3fcd6150-0x3fcde14f free=32020 used=0 largest_free=32020 free_blocks=1 used_blocks=0",
            "[heap-live] scope=app_init ptr=0x3fcf02e4 size=26240 pc0=0x403763fb pc1=0x42078504",
            "--- 0x42078504: gea::platform::esp32::display::DisplayBackend::tryConfigureFlushPipelineCandidate(int, int, int, int) at /repo/targets/esp32/display.cpp:1568",
            "",
        ].join("\n"),
    )
    fs.writeFileSync(
        mapPath,
        [
            "Memory Configuration",
            "",
            "Name             Origin             Length             Attributes",
            "dram0_0_seg      0x3fc88000         0x00053700         rw",
            "iram0_0_seg      0x40374000         0x00057700         xr",
            "*default*        0x00000000         0xffffffff",
            "",
            "Linker script and memory map",
            "",
            ".dram0.data     0x3fc9e800      0x1000",
            ".dram0.bss      0x3fcb59a0      0x2000",
            ".dram0.heap_start",
            "                0x3fcc7020        0x0",
            ".iram0.text     0x40374404      0x3000",
            "",
        ].join("\n"),
    )

    const out = capture()
    const code = await runGea(["heap-report", logPath, "--map", mapPath, "--out", reportPath], { ...out.io, cwd: workDir })
    assert.equal(code, 0, out.err.join('\n'))
    const html = fs.readFileSync(reportPath, "utf8")
    assert.match(html, /ESP32 Heap Memory Map/)
    assert.match(html, /window\.__HEAP_MAP_DATA__/)
    assert.match(html, /runtime:start/)
    assert.match(html, /dma_internal/)
    assert.match(html, /1070531300/)
    assert.match(html, /LCD flush staging slot/)
    assert.match(html, /tryConfigureFlushPipelineCandidate/)
    assert.match(html, /Memory Over Time/)
    assert.match(html, /Static Linker Map/)
    assert.match(html, /\.dram0\.bss/)
    assert.match(html, /dram0_0_seg/)
    assert.match(html, /Contiguous Address Matrix/)
    assert.match(html, /id="addressMatrix"/)
    assert.match(html, /id="matrixCellSizeSelect"/)
    assert.match(html, /matrix-cell/)
    assert.match(html, /matrix-live/)
    assert.match(html, /4 KiB per cell/)

    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
    assert.ok(script, "report should contain a client-side render script")

    class FakeElement {
        constructor(id) {
            this.id = id
            this._innerHTML = ""
            this.value = id === "matrixCellSizeSelect" ? "4096" : ""
        }

        set innerHTML(value) {
            this._innerHTML = String(value)
            const firstOption = this._innerHTML.match(/<option value="([^"]+)"/)
            if (firstOption && !this.value) this.value = firstOption[1]
        }

        get innerHTML() {
            return this._innerHTML
        }

        addEventListener() {}

        querySelectorAll() {
            return []
        }
    }

    const elements = new Map()
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new FakeElement(id))
            return elements.get(id)
        },
    }
    const window = {}
    new Function("window", "document", script)(window, document)
    const matrixHtml = elements.get("addressMatrix").innerHTML
    assert.match(matrixHtml, /ESP32-S3 internal DRAM window/)
    assert.match(matrixHtml, /0x3fc80000-0x3fcfffff/)
    assert.match(matrixHtml, /512\.0 KiB total/)
    assert.doesNotMatch(matrixHtml, /MiB total/)
    assert.doesNotMatch(matrixHtml, /0x600fe000/)
} finally {
    fs.rmSync(workDir, { recursive: true, force: true })
}
})
