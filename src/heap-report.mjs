#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

export const DEFAULT_TITLE = "ESP32 Heap Memory Map"

function usage() {
    console.error("Usage: node scripts/esp32-heap-map-report.mjs <log...> --out <report.html> [--map <gea_embedded.map>] [--title <title>]")
}

function parseArgs(argv) {
    const inputs = []
    const maps = []
    let out = ""
    let title = DEFAULT_TITLE

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === "--out") {
            out = argv[++i] || ""
        } else if (arg.startsWith("--out=")) {
            out = arg.slice("--out=".length)
        } else if (arg === "--title") {
            title = argv[++i] || title
        } else if (arg.startsWith("--title=")) {
            title = arg.slice("--title=".length)
        } else if (arg === "--map") {
            maps.push(argv[++i] || "")
        } else if (arg.startsWith("--map=")) {
            maps.push(arg.slice("--map=".length))
        } else if (arg === "--help" || arg === "-h") {
            usage()
            process.exit(0)
        } else {
            inputs.push(arg)
        }
    }

    if (inputs.length === 0) {
        usage()
        throw new Error("at least one log file is required")
    }
    if (!out) {
        usage()
        throw new Error("--out <report.html> is required")
    }
    return { inputs, maps: maps.filter(Boolean), out, title }
}

function stripAnsi(line) {
    return line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

function toNumber(value) {
    if (value === undefined || value === null || value === "") return null
    return Number.parseInt(value, 10)
}

function parseHex(value) {
    return Number.parseInt(value, 16)
}

function relPath(file) {
    return path.relative(process.cwd(), path.resolve(file)) || path.basename(file)
}

function parseKeyValues(text) {
    const out = {}
    const re = /\b([A-Za-z_][A-Za-z0-9_]*)=([+-]?\d+)/g
    for (const match of text.matchAll(re)) {
        out[match[1]] = Number.parseInt(match[2], 10)
    }
    return out
}

function parseLogTimeMs(line) {
    const match = line.match(/\b[VDIWE]\s*\((\d+)\)\s+[A-Za-z0-9_]+:/)
    return match ? Number.parseInt(match[1], 10) : null
}

function normalizeStackLine(line) {
    return stripAnsi(line).trim()
}

function inferLiveLabel(allocation) {
    const stack = allocation.stack.join("\n")
    if (stack.includes("tryConfigureFlushPipelineCandidate") || stack.includes("configureFlushPipeline")) {
        return "LCD flush staging slot"
    }
    if (stack.includes("xTaskCreate") || stack.includes("xTaskCreatePinnedToCore")) {
        return "FreeRTOS task stack/control block"
    }
    if (stack.includes("operator new")) {
        return "C++ heap allocation"
    }
    return "live internal allocation"
}

function sourceRef(file, line) {
    return `${relPath(file)}:${line}`
}

function parseLinkerMap(file) {
    const absolute = path.resolve(file)
    const text = fs.readFileSync(absolute, "utf8")
    const lines = text.split(/\r?\n/)
    const linkerMap = {
        file: absolute,
        label: relPath(absolute),
        bytes: Buffer.byteLength(text),
        memoryRegions: [],
        sections: [],
    }
    let inMemoryConfig = false
    let inMemoryMap = false
    let pendingTopLevelSection = ""

    function addSection(name, start, size, line) {
        if (start === 0 && size === 0) return
        if (size === 0 && !name.includes("heap_start")) return
        const section = {
            name,
            start,
            end: start + size,
            size,
            line,
            ref: sourceRef(absolute, line),
            memoryRegion: "",
        }
        const candidates = linkerMap.memoryRegions.filter((region) => section.start >= region.start && section.end <= region.end)
        let region = candidates[0]
        if (section.name.startsWith(".ext_ram")) {
            region = candidates.find((candidate) => candidate.name === "extern_ram_seg") || region
        } else if (section.name.startsWith(".flash.rodata") || section.name.startsWith(".flash.appdesc")) {
            region = candidates.find((candidate) => candidate.name === "drom0_0_seg") || region
        }
        if (!region) return
        section.memoryRegion = region.name
        region.sectionIndexes.push(linkerMap.sections.length)
        linkerMap.sections.push(section)
    }

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (line.trim() === "Memory Configuration") {
            inMemoryConfig = true
            continue
        }
        if (line.trim() === "Linker script and memory map") {
            inMemoryConfig = false
            inMemoryMap = true
            continue
        }

        if (inMemoryConfig) {
            const match = line.match(/^(\S+)\s+0x([0-9A-Fa-f]+)\s+0x([0-9A-Fa-f]+)\s+([A-Za-z]*)/)
            if (!match || match[1] === "Name" || match[1] === "*default*") continue
            const start = parseHex(match[2])
            const size = parseHex(match[3])
            linkerMap.memoryRegions.push({
                name: match[1],
                start,
                end: start + size,
                size,
                attributes: match[4],
                sectionIndexes: [],
            })
            continue
        }

        if (inMemoryMap) {
            const match = line.match(/^(\.[^\s]+)\s+0x([0-9A-Fa-f]+)\s+0x([0-9A-Fa-f]+)/)
            if (match) {
                pendingTopLevelSection = ""
                addSection(match[1], parseHex(match[2]), parseHex(match[3]), index + 1)
                continue
            }
            const headerOnly = line.match(/^(\.[^\s]+)\s*$/)
            if (headerOnly) {
                pendingTopLevelSection = headerOnly[1]
                continue
            }
            if (pendingTopLevelSection) {
                const continuation = line.match(/^\s+0x([0-9A-Fa-f]+)\s+0x([0-9A-Fa-f]+)/)
                if (continuation) {
                    addSection(pendingTopLevelSection, parseHex(continuation[1]), parseHex(continuation[2]), index + 1)
                    pendingTopLevelSection = ""
                    continue
                }
                if (line.trim() === "") {
                    pendingTopLevelSection = ""
                }
            }
        }
    }

    return linkerMap
}

function attachFreeBlock(snapshot, block) {
    snapshot.freeBlocks.push(block)
}

function findSnapshot(currentByKey, stage, caps) {
    return currentByKey.get(`${stage}\u0000${caps}`)
}

function parseLogs(files, mapFiles = []) {
    const data = {
        generatedAt: new Date().toISOString(),
        inputs: [],
        linkerMaps: [],
        bootRegions: [],
        heapEvents: [],
        probes: [],
        snapshots: [],
        liveAllocations: [],
        warnings: [],
    }

    let pendingLive = null

    function finishPendingLive() {
        if (!pendingLive) return
        pendingLive.label = inferLiveLabel(pendingLive)
        data.liveAllocations.push(pendingLive)
        pendingLive = null
    }

    for (const file of files) {
        const absolute = path.resolve(file)
        const text = fs.readFileSync(absolute, "utf8")
        const lines = text.split(/\r?\n/)
        data.inputs.push({ file: absolute, label: relPath(absolute), bytes: Buffer.byteLength(text), lines: lines.length })
        const currentByKey = new Map()

        for (let index = 0; index < lines.length; index += 1) {
            const raw = lines[index]
            const lineNumber = index + 1
            const line = stripAnsi(raw)
            const trimmed = line.trim()
            const timeMs = parseLogTimeMs(line)

            if (pendingLive) {
                const isStack = trimmed.startsWith("--- ") || trimmed.startsWith("at ") || trimmed.includes(" at /")
                const startsNewRecord =
                    trimmed.startsWith("[heap-") ||
                    trimmed.includes(" heap probe [") ||
                    trimmed.includes("heap_init: At ") ||
                    trimmed === ""
                if (isStack && !startsNewRecord) {
                    pendingLive.stack.push(normalizeStackLine(raw))
                    continue
                }
                finishPendingLive()
            }

            const bootMatch = trimmed.match(/heap_init: At ([0-9A-Fa-f]+) len ([0-9A-Fa-f]+) \(([^)]+)\): ([A-Za-z0-9_]+)/)
            if (bootMatch) {
                const start = parseHex(bootMatch[1])
                const size = parseHex(bootMatch[2])
                data.bootRegions.push({
                    file: absolute,
                    line: lineNumber,
                    ref: sourceRef(absolute, lineNumber),
                    timeMs,
                    start,
                    end: start + size,
                    size,
                    printableSize: bootMatch[3],
                    type: bootMatch[4],
                })
                continue
            }

            const probeMatch = trimmed.match(/heap probe \[([^\]]+)\]\s+(.+)$/)
            if (probeMatch) {
                data.probes.push({
                    file: absolute,
                    line: lineNumber,
                    ref: sourceRef(absolute, lineNumber),
                    timeMs,
                    stage: probeMatch[1],
                    values: parseKeyValues(probeMatch[2]),
                })
                continue
            }

            const flushPoolMatch = trimmed.match(/display:\s+LCD flush pool reserved:\s+(\d+)\s+bytes/)
            if (flushPoolMatch) {
                data.heapEvents.push({
                    type: "flush_pool_reserved",
                    label: "LCD flush pool reserved",
                    bytes: toNumber(flushPoolMatch[1]),
                    file: absolute,
                    line: lineNumber,
                    ref: sourceRef(absolute, lineNumber),
                    timeMs,
                })
                continue
            }

            const summaryMatch = trimmed.match(/\[heap-map\]\s+stage=(\S+)\s+caps=(\S+)\s+total_free=(\d+)\s+largest=(\d+)\s+min=(\d+)\s+free_blocks=(\d+)\s+alloc_blocks=(\d+)\s+total_blocks=(\d+)/)
            if (summaryMatch) {
                const snapshot = {
                    id: data.snapshots.length,
                    file: absolute,
                    fileLabel: relPath(absolute),
                    line: lineNumber,
                    ref: sourceRef(absolute, lineNumber),
                    timeMs,
                    stage: summaryMatch[1],
                    caps: summaryMatch[2],
                    totalFree: toNumber(summaryMatch[3]),
                    largestFree: toNumber(summaryMatch[4]),
                    minFree: toNumber(summaryMatch[5]),
                    freeBlockCount: toNumber(summaryMatch[6]),
                    allocBlockCount: toNumber(summaryMatch[7]),
                    totalBlockCount: toNumber(summaryMatch[8]),
                    regions: [],
                    freeBlocks: [],
                }
                data.snapshots.push(snapshot)
                currentByKey.set(`${snapshot.stage}\u0000${snapshot.caps}`, snapshot)
                continue
            }

            const freeMatch = trimmed.match(/\[heap-free\]\s+stage=(\S+)\s+caps=(\S+)\s+heap=(\d+)\s+ptr=0x([0-9A-Fa-f]+)\s+size=(\d+)/)
            if (freeMatch) {
                const snapshot = findSnapshot(currentByKey, freeMatch[1], freeMatch[2])
                if (!snapshot) {
                    data.warnings.push(`free block without summary at ${sourceRef(absolute, lineNumber)}`)
                    continue
                }
                const start = parseHex(freeMatch[4])
                const size = toNumber(freeMatch[5])
                attachFreeBlock(snapshot, {
                    heap: toNumber(freeMatch[3]),
                    start,
                    end: start + size,
                    size,
                    ref: sourceRef(absolute, lineNumber),
                })
                continue
            }

            const regionMatch = trimmed.match(/\[heap-map\]\s+stage=(\S+)\s+caps=(\S+)\s+heap=(\d+)\s+range=0x([0-9A-Fa-f]+)-0x([0-9A-Fa-f]+)\s+free=(\d+)\s+used=(\d+)\s+largest_free=(\d+)\s+free_blocks=(\d+)\s+used_blocks=(\d+)/)
            if (regionMatch) {
                const snapshot = findSnapshot(currentByKey, regionMatch[1], regionMatch[2])
                if (!snapshot) {
                    data.warnings.push(`heap region without summary at ${sourceRef(absolute, lineNumber)}`)
                    continue
                }
                const start = parseHex(regionMatch[4])
                const endInclusive = parseHex(regionMatch[5])
                snapshot.regions.push({
                    heap: toNumber(regionMatch[3]),
                    start,
                    end: endInclusive + 1,
                    size: endInclusive - start + 1,
                    free: toNumber(regionMatch[6]),
                    used: toNumber(regionMatch[7]),
                    largestFree: toNumber(regionMatch[8]),
                    freeBlocks: toNumber(regionMatch[9]),
                    usedBlocks: toNumber(regionMatch[10]),
                    ref: sourceRef(absolute, lineNumber),
                })
                continue
            }

            const liveMatch = trimmed.match(/\[heap-live\]\s+scope=(\S+)\s+ptr=0x([0-9A-Fa-f]+)\s+size=(\d+)(.*)$/)
            if (liveMatch) {
                const start = parseHex(liveMatch[2])
                const size = toNumber(liveMatch[3])
                pendingLive = {
                    id: data.liveAllocations.length,
                    file: absolute,
                    fileLabel: relPath(absolute),
                    line: lineNumber,
                    ref: sourceRef(absolute, lineNumber),
                    timeMs,
                    scope: liveMatch[1],
                    start,
                    end: start + size,
                    size,
                    pcs: [...liveMatch[4].matchAll(/\bpc\d+=0x([0-9A-Fa-f]+)/g)].map((m) => `0x${m[1]}`),
                    stack: [],
                    label: "",
                }
            }
        }
    }

    for (const mapFile of mapFiles) {
        data.linkerMaps.push(parseLinkerMap(mapFile))
    }

    finishPendingLive()

    const labelByPcSignature = new Map()
    for (const allocation of data.liveAllocations) {
        const signature = allocation.pcs.join("|")
        if (signature && allocation.label !== "live internal allocation") {
            labelByPcSignature.set(signature, allocation.label)
        }
    }
    for (const allocation of data.liveAllocations) {
        const signature = allocation.pcs.join("|")
        const inferred = labelByPcSignature.get(signature)
        if (inferred && allocation.label === "live internal allocation") {
            allocation.label = `${inferred} (same PC signature)`
        }
    }

    for (const snapshot of data.snapshots) {
        snapshot.regions.sort((a, b) => a.start - b.start)
        snapshot.freeBlocks.sort((a, b) => a.start - b.start)
        for (const region of snapshot.regions) {
            region.freeBlockIndexes = snapshot.freeBlocks
                .map((block, index) => ({ block, index }))
                .filter(({ block }) => block.heap === region.heap && block.start >= region.start && block.end <= region.end)
                .map(({ index }) => index)
        }
    }

    return data
}

function htmlEscape(text) {
    return String(text).replace(/[&<>"']/g, (char) => {
        switch (char) {
            case "&":
                return "&amp;"
            case "<":
                return "&lt;"
            case ">":
                return "&gt;"
            case '"':
                return "&quot;"
            case "'":
                return "&#39;"
            default:
                return char
        }
    })
}

function renderHtml(data, title) {
    const safeJson = JSON.stringify(data).replace(/</g, "\\u003c")
    const safeTitle = htmlEscape(title)
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
:root {
  color-scheme: dark;
  --bg: #101418;
  --panel: #171d22;
  --panel-2: #1d242a;
  --ink: #e8eef2;
  --muted: #a2adb5;
  --line: #303a42;
  --line-2: #43505a;
  --free: #46bf86;
  --free-soft: rgba(70, 191, 134, 0.18);
  --used: #844b3e;
  --used-soft: rgba(132, 75, 62, 0.58);
  --new-used: #c76b58;
  --new-used-soft: rgba(199, 107, 88, 0.66);
  --static: #d4a056;
  --static-soft: rgba(212, 160, 86, 0.42);
  --gap: #26313a;
  --live: #5bc4d8;
  --warn: #e1b85b;
  --bad: #df7d72;
  --focus: #8ecae6;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--ink); font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { padding: 24px; }
header, main { max-width: 1480px; margin: 0 auto; }
header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: end; margin-bottom: 18px; }
h1 { margin: 0; font-size: 26px; letter-spacing: 0; }
h2 { margin: 0 0 10px; font-size: 15px; letter-spacing: 0; }
p { margin: 4px 0 0; color: var(--muted); }
.meta { text-align: right; color: var(--muted); font-size: 12px; }
.toolbar { display: grid; grid-template-columns: minmax(180px, 240px) minmax(280px, 1fr) auto auto auto; gap: 10px; align-items: end; padding: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 14px; }
label { display: grid; gap: 5px; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
select, button { height: 34px; border-radius: 6px; border: 1px solid var(--line-2); background: #11171b; color: var(--ink); font: inherit; }
select { min-width: 0; padding: 0 10px; }
button { min-width: 38px; padding: 0 11px; cursor: pointer; }
button:hover, select:hover { border-color: var(--focus); }
.grid { display: grid; gap: 14px; }
.summary { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.metric { min-width: 0; padding: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.metric .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.metric .value { margin-top: 6px; font-size: 19px; font-weight: 700; overflow-wrap: anywhere; }
.metric .sub { margin-top: 3px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; min-width: 0; }
.split { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(330px, 0.9fr); gap: 14px; }
.timeline { width: 100%; height: 210px; display: block; border: 1px solid var(--line); border-radius: 6px; background: #11171b; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 18px; height: 8px; border-radius: 999px; display: inline-block; }
.swatch.free { background: var(--free); }
.swatch.used { background: var(--used); }
.swatch.new-used { background: var(--new-used); }
.swatch.live { background: var(--live); }
.swatch.static { background: var(--static); }
.swatch.gap { background: var(--gap); }
.memory-map { display: grid; gap: 12px; }
.region-row { display: grid; grid-template-columns: 190px minmax(0, 1fr) 138px; gap: 10px; align-items: center; }
.region-label { color: var(--muted); min-width: 0; }
.region-label strong { color: var(--ink); font-weight: 650; display: block; }
.region-bar { position: relative; height: 34px; overflow: hidden; border-radius: 5px; border: 1px solid var(--line-2); background: #0c1114; }
.segment { position: absolute; top: 0; bottom: 0; min-width: 1px; }
.segment.used { background: linear-gradient(90deg, var(--used-soft), rgba(132, 75, 62, 0.36)); }
.segment.new-used { background: repeating-linear-gradient(135deg, var(--new-used-soft) 0, var(--new-used-soft) 5px, rgba(239, 159, 132, 0.32) 5px, rgba(239, 159, 132, 0.32) 10px); border-left: 1px solid rgba(255, 191, 168, 0.74); border-right: 1px solid rgba(255, 191, 168, 0.44); z-index: 2; }
.segment.free { background: linear-gradient(90deg, var(--free-soft), rgba(70, 191, 134, 0.35)); border-left: 1px solid rgba(96, 230, 168, 0.7); border-right: 1px solid rgba(96, 230, 168, 0.25); }
.segment.static { background: linear-gradient(90deg, var(--static-soft), rgba(212, 160, 86, 0.28)); border-left: 1px solid rgba(234, 193, 126, 0.72); }
.segment.gap { background: var(--gap); }
.heap-marker { position: absolute; top: 0; bottom: 0; width: 2px; background: #f0d99a; z-index: 4; }
.live-overlay { position: absolute; top: 3px; bottom: 3px; min-width: 2px; background: repeating-linear-gradient(135deg, rgba(91, 196, 216, 0.92) 0, rgba(91, 196, 216, 0.92) 3px, rgba(91, 196, 216, 0.32) 3px, rgba(91, 196, 216, 0.32) 7px); border: 1px solid rgba(181, 241, 251, 0.8); border-radius: 3px; z-index: 3; }
.region-stat { color: var(--muted); text-align: right; font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
.matrix-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 10px; color: var(--muted); }
.matrix-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-bottom: 10px; }
.matrix-controls label { min-width: 150px; }
.matrix-wrap { display: grid; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
.matrix-row { display: grid; grid-template-columns: 92px max-content; gap: 8px; align-items: center; }
.matrix-address { color: var(--muted); font: 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
.matrix-cells { display: grid; grid-template-columns: repeat(var(--matrix-cols), 10px); gap: 2px; }
.matrix-cell { width: 10px; height: 10px; border-radius: 2px; background: var(--gap); border: 1px solid rgba(255, 255, 255, 0.04); }
.matrix-cell:hover { outline: 2px solid var(--focus); outline-offset: 1px; }
.matrix-static { background: var(--static); }
.matrix-used { background: var(--used); }
.matrix-newUsed { background: var(--new-used); box-shadow: 0 0 0 1px rgba(255, 207, 190, 0.62) inset; }
.matrix-free { background: var(--free); }
.matrix-live { background: var(--live); box-shadow: 0 0 0 1px rgba(221, 253, 255, 0.76) inset; }
.matrix-gap { background: var(--gap); }
.matrix-mixed { border-color: rgba(255, 255, 255, 0.36); }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { padding: 8px 9px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 650; }
td { overflow-wrap: anywhere; }
tbody tr:hover { background: rgba(255, 255, 255, 0.035); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
.small { color: var(--muted); font-size: 12px; }
.warn { color: var(--warn); }
.empty { padding: 20px; color: var(--muted); text-align: center; border: 1px dashed var(--line-2); border-radius: 6px; }
.scroll-table { max-height: 360px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; }
.scroll-table table { border-collapse: separate; border-spacing: 0; }
.scroll-table th { position: sticky; top: 0; background: var(--panel-2); z-index: 1; }
.two-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
.stack { white-space: pre-wrap; color: var(--muted); font-size: 12px; max-height: 92px; overflow: auto; }
@media (max-width: 980px) {
  body { padding: 14px; }
  header { grid-template-columns: 1fr; }
  .meta { text-align: left; }
  .toolbar { grid-template-columns: 1fr 1fr; }
  .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .split, .two-cols { grid-template-columns: 1fr; }
  .region-row { grid-template-columns: 1fr; }
  .region-stat { text-align: left; }
}
</style>
</head>
<body>
<header>
  <div>
    <h1>${safeTitle}</h1>
    <p>Free holes are from <span class="mono">[heap-free]</span>. Used spans are inferred as everything between holes. Brighter used spans were free in the first snapshot for the same caps.</p>
  </div>
  <div class="meta" id="reportMeta"></div>
</header>
<main class="grid">
  <section class="toolbar">
    <label>Caps<select id="capsSelect"></select></label>
    <label>Snapshot<select id="snapshotSelect"></select></label>
    <button id="prevButton" title="Previous snapshot">Prev</button>
    <button id="nextButton" title="Next snapshot">Next</button>
    <button id="latestButton" title="Latest snapshot for selected caps">Latest</button>
  </section>
  <section class="summary" id="summary"></section>
  <section class="split">
    <div class="panel">
      <h2>Memory Over Time</h2>
      <svg class="timeline" id="timeline" viewBox="0 0 920 210" role="img" aria-label="Heap memory over time"></svg>
      <div class="legend">
        <span><i class="swatch free"></i>Total free</span>
        <span><i class="swatch live"></i>Largest free block</span>
        <span><i class="swatch used"></i>Minimum ever free</span>
      </div>
    </div>
    <div class="panel">
      <h2>Boot Heap Regions</h2>
      <div class="scroll-table" id="bootRegions"></div>
    </div>
  </section>
  <section class="panel">
    <h2>Contiguous Address Matrix</h2>
    <div class="matrix-controls">
      <label>Cell Size
        <select id="matrixCellSizeSelect">
          <option value="1024">1 KiB</option>
          <option value="2048">2 KiB</option>
          <option value="4096" selected>4 KiB</option>
          <option value="8192">8 KiB</option>
          <option value="16384">16 KiB</option>
        </select>
      </label>
      <span class="small">Default: 4 KiB per cell. Use smaller cells only when zooming into a suspect range.</span>
    </div>
    <div id="addressMatrix"></div>
    <div class="legend">
      <span><i class="swatch static"></i>Static section</span>
      <span><i class="swatch used"></i>Heap used</span>
      <span><i class="swatch new-used"></i>New heap used since first snapshot</span>
      <span><i class="swatch free"></i>Heap free</span>
      <span><i class="swatch live"></i>Live allocation</span>
      <span><i class="swatch gap"></i>Unclaimed gap</span>
    </div>
  </section>
  <section class="panel">
    <h2>Static Linker Map</h2>
    <div id="linkerMap"></div>
  </section>
  <section class="panel">
    <h2>Snapshot Memory Map</h2>
    <div class="memory-map" id="memoryMap"></div>
  </section>
  <section class="two-cols">
    <div class="panel">
      <h2>Free Blocks In Snapshot</h2>
      <div class="scroll-table" id="freeBlocks"></div>
    </div>
    <div class="panel">
      <h2>Heap Regions In Snapshot</h2>
      <div class="scroll-table" id="regionsTable"></div>
    </div>
  </section>
  <section class="panel">
    <h2>Heap Used Spans In Snapshot</h2>
    <p>These brown ranges are inferred from heap region boundaries minus free holes. The introduced range column shows bytes that were free in the first snapshot for the same caps.</p>
    <div class="scroll-table" id="usedSpans"></div>
  </section>
  <section class="panel">
    <h2>Live Allocation Evidence</h2>
    <div class="scroll-table" id="liveAllocations"></div>
  </section>
  <section class="panel">
    <h2>Probe Timeline</h2>
    <div class="scroll-table" id="probeTimeline"></div>
  </section>
</main>
<script>
window.__HEAP_MAP_DATA__ = ${safeJson};

const data = window.__HEAP_MAP_DATA__;
const ESP32_S3_INTERNAL_DRAM_START = 0x3fc80000;
const ESP32_S3_INTERNAL_DRAM_END = ESP32_S3_INTERNAL_DRAM_START + 512 * 1024;
const capsSelect = document.getElementById("capsSelect");
const snapshotSelect = document.getElementById("snapshotSelect");
const summaryEl = document.getElementById("summary");
const timelineEl = document.getElementById("timeline");
const memoryMapEl = document.getElementById("memoryMap");
const freeBlocksEl = document.getElementById("freeBlocks");
const usedSpansEl = document.getElementById("usedSpans");
const regionsTableEl = document.getElementById("regionsTable");
const bootRegionsEl = document.getElementById("bootRegions");
const addressMatrixEl = document.getElementById("addressMatrix");
const matrixCellSizeSelect = document.getElementById("matrixCellSizeSelect");
const linkerMapEl = document.getElementById("linkerMap");
const liveAllocationsEl = document.getElementById("liveAllocations");
const probeTimelineEl = document.getElementById("probeTimeline");
const reportMetaEl = document.getElementById("reportMeta");

function fmtBytes(value) {
  if (value == null || Number.isNaN(value)) return "-";
  if (Math.abs(value) >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(2) + " MiB";
  if (Math.abs(value) >= 1024) return (value / 1024).toFixed(1) + " KiB";
  return String(value) + " B";
}

function hex(value) {
  if (value == null || Number.isNaN(value)) return "-";
  return "0x" + Math.round(value).toString(16).padStart(8, "0");
}

function rangeText(start, endExclusive) {
  return hex(start) + "-" + hex(Math.max(start, endExclusive - 1));
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function snapshotsForCaps(caps) {
  return data.snapshots.filter((snapshot) => snapshot.caps === caps);
}

function firstSnapshotForCaps(caps) {
  return snapshotsForCaps(caps)[0] || null;
}

function selectedSnapshot() {
  return data.snapshots.find((snapshot) => String(snapshot.id) === snapshotSelect.value) || data.snapshots[0] || null;
}

function table(headers, rows) {
  if (rows.length === 0) return '<div class="empty">No rows in this view.</div>';
  return '<table><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join("") + '</tr></thead><tbody>' + rows.join("") + '</tbody></table>';
}

function cell(text, className = "") {
  return '<td' + (className ? ' class="' + className + '"' : '') + '>' + esc(text) + '</td>';
}

function bootTable() {
  const rows = data.bootRegions.map((region) => {
    return '<tr>' +
      cell(region.type) +
      cell(rangeText(region.start, region.end), "mono") +
      cell(fmtBytes(region.size)) +
      cell(region.printableSize) +
      cell(region.ref, "small") +
      '</tr>';
  });
  bootRegionsEl.innerHTML = table(["Type", "Range", "Bytes", "Boot text", "Source"], rows);
}

function sectionKind(section) {
  if (section.name.includes("heap_start")) return "marker";
  if (section.size === 0) return "marker";
  return "static";
}

function linkerRegionSegments(map, region) {
  const sections = (region.sectionIndexes || [])
    .map((index) => map.sections[index])
    .filter((section) => section.size > 0)
    .sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = region.start;
  for (const section of sections) {
    if (section.start > cursor) {
      segments.push({ type: "gap", name: "not statically allocated / heap candidate", start: cursor, end: Math.min(section.start, region.end), size: Math.min(section.start, region.end) - cursor });
    }
    segments.push({ type: "static", name: section.name, start: section.start, end: section.end, size: section.size, ref: section.ref });
    cursor = Math.max(cursor, section.end);
  }
  if (cursor < region.end) {
    segments.push({ type: "gap", name: "not statically allocated / heap candidate", start: cursor, end: region.end, size: region.end - cursor });
  }
  return segments.filter((segment) => segment.size > 0);
}

function overlapBytes(start, end, interval) {
  return Math.max(0, Math.min(end, interval.end) - Math.max(start, interval.start));
}

function subtractIntervals(span, blockers) {
  let parts = [{ start: span.start, end: span.end }];
  for (const blocker of blockers) {
    const next = [];
    for (const part of parts) {
      const start = Math.max(part.start, blocker.start);
      const end = Math.min(part.end, blocker.end);
      if (start >= end) {
        next.push(part);
        continue;
      }
      if (part.start < start) next.push({ start: part.start, end: start });
      if (end < part.end) next.push({ start: end, end: part.end });
    }
    parts = next;
    if (parts.length === 0) break;
  }
  return parts.map((part) => ({ ...part, size: part.end - part.start })).filter((part) => part.size > 0);
}

function usedSpansForSnapshot(snapshot) {
  if (!snapshot) return [];
  return snapshot.regions.flatMap((region) => {
    return regionSegments(snapshot, region)
      .filter((segment) => segment.type === "used")
      .map((segment) => ({
        ...segment,
        heap: region.heap,
        regionRef: region.ref,
      }));
  }).sort((a, b) => a.start - b.start);
}

function introducedUsedSpans(snapshot) {
  if (!snapshot) return [];
  const first = firstSnapshotForCaps(snapshot.caps);
  if (!first || first.id === snapshot.id) return [];
  const baselineUsed = usedSpansForSnapshot(first);
  return usedSpansForSnapshot(snapshot).flatMap((span) => {
    return subtractIntervals(span, baselineUsed).map((part) => ({
      ...part,
      heap: span.heap,
      baselineStage: first.stage,
      regionRef: span.regionRef,
    }));
  });
}

function introducedPartsForSpan(snapshot, span) {
  return introducedUsedSpans(snapshot).filter((introduced) => overlapBytes(span.start, span.end, introduced) > 0);
}

function matchingFlushPoolEvent(size) {
  return (data.heapEvents || []).find((event) => event.type === "flush_pool_reserved" && Math.abs((event.bytes || 0) - size) <= 64) || null;
}

function isInternalDramRange(region) {
  return region && region.start >= ESP32_S3_INTERNAL_DRAM_START && region.start < ESP32_S3_INTERNAL_DRAM_END;
}

function matrixSpan(snapshot) {
    const map = data.linkerMaps && data.linkerMaps[0];
    const dram = map && map.memoryRegions.find((region) => region.name === "dram0_0_seg");
    const ranges = [];
    if (dram) ranges.push(dram);
    if (snapshot) ranges.push(...snapshot.regions.filter(isInternalDramRange));
    ranges.push(...data.bootRegions.filter((region) => region.type === "RAM" || region.type === "DRAM"));
    if (ranges.some(isInternalDramRange)) {
      return {
        start: ESP32_S3_INTERNAL_DRAM_START,
        end: ESP32_S3_INTERNAL_DRAM_END,
        label: "ESP32-S3 internal DRAM window",
      };
    }
    if (ranges.length === 0) return null;
    const rawStart = Math.min(...ranges.map((region) => region.start));
    const rawEnd = Math.max(...ranges.map((region) => region.end));
    const alignment = 64 * 1024;
    return {
    start: Math.floor(rawStart / alignment) * alignment,
    end: Math.ceil(rawEnd / alignment) * alignment,
    label: dram ? "internal DRAM span" : "captured internal RAM span",
  };
}

function matrixIntervals(snapshot, span) {
  const intervals = [];
  const map = data.linkerMaps && data.linkerMaps[0];
  const dram = map && map.memoryRegions.find((region) => region.name === "dram0_0_seg");
  if (map && dram) {
    for (const index of dram.sectionIndexes || []) {
      const section = map.sections[index];
      if (!section || section.size <= 0) continue;
      intervals.push({ type: "static", start: section.start, end: section.end, name: section.name, ref: section.ref });
    }
  }
  if (snapshot) {
    for (const region of snapshot.regions) {
      for (const segment of regionSegments(snapshot, region)) {
        intervals.push({
          type: segment.type === "free" ? "free" : "used",
          start: segment.start,
          end: segment.end,
          name: segment.type === "free" ? "heap free" : "heap used",
          ref: segment.ref || region.ref,
        });
      }
      for (const live of liveForRegion(snapshot, region)) {
        intervals.push({ type: "live", start: live.start, end: live.end, name: live.label, ref: live.ref });
      }
    }
    for (const introduced of introducedUsedSpans(snapshot)) {
      intervals.push({
        type: "newUsed",
        start: introduced.start,
        end: introduced.end,
        name: "new heap used since " + introduced.baselineStage,
        ref: introduced.regionRef,
      });
    }
  }
  return intervals.filter((interval) => interval.end > span.start && interval.start < span.end);
}

function matrixStateForCell(start, end, intervals) {
  const coverage = { static: 0, used: 0, newUsed: 0, free: 0, live: 0 };
  const names = [];
  for (const interval of intervals) {
    const bytes = overlapBytes(start, end, interval);
    if (bytes <= 0) continue;
    coverage[interval.type] += bytes;
    names.push(interval.name + " " + rangeText(interval.start, interval.end) + " " + fmtBytes(interval.end - interval.start) + (interval.ref ? " " + interval.ref : ""));
  }
  const present = Object.entries(coverage).filter(([, bytes]) => bytes > 0).map(([type]) => type);
  const type = ["live", "newUsed", "free", "used", "static"].find((candidate) => coverage[candidate] > 0) || "gap";
  return {
    type,
    mixed: present.length > 1,
    title: rangeText(start, end) + " " + fmtBytes(end - start) + (names.length ? "\\n" + names.join("\\n") : "\\nunclaimed gap"),
  };
}

function renderAddressMatrix(snapshot) {
  const span = matrixSpan(snapshot);
  if (!span) {
    addressMatrixEl.innerHTML = '<div class="empty">No contiguous address span is available.</div>';
    return;
  }
  const cellBytes = Number.parseInt(matrixCellSizeSelect.value, 10) || 4096;
  const cols = 64;
  const cellCount = Math.ceil((span.end - span.start) / cellBytes);
  const intervals = matrixIntervals(snapshot, span);
  const rows = [];
  for (let rowStart = 0; rowStart < cellCount; rowStart += cols) {
    const rowAddress = span.start + rowStart * cellBytes;
    const cells = [];
    for (let col = 0; col < cols && rowStart + col < cellCount; col += 1) {
      const cellStart = span.start + (rowStart + col) * cellBytes;
      const cellEnd = Math.min(cellStart + cellBytes, span.end);
      const state = matrixStateForCell(cellStart, cellEnd, intervals);
      cells.push('<div class="matrix-cell matrix-' + state.type + (state.mixed ? ' matrix-mixed' : '') + '" title="' + esc(state.title) + '"></div>');
    }
    rows.push('<div class="matrix-row"><div class="matrix-address">' + esc(hex(rowAddress)) + '</div><div class="matrix-cells">' + cells.join("") + '</div></div>');
  }
  const staticBytes = intervals.filter((interval) => interval.type === "static").reduce((sum, interval) => sum + Math.max(0, Math.min(span.end, interval.end) - Math.max(span.start, interval.start)), 0);
  const freeBytes = intervals.filter((interval) => interval.type === "free").reduce((sum, interval) => sum + Math.max(0, Math.min(span.end, interval.end) - Math.max(span.start, interval.start)), 0);
  const liveBytes = intervals.filter((interval) => interval.type === "live").reduce((sum, interval) => sum + Math.max(0, Math.min(span.end, interval.end) - Math.max(span.start, interval.start)), 0);
  addressMatrixEl.innerHTML =
    '<div class="matrix-meta">' +
    '<span>Span <span class="mono">' + esc(span.label) + '</span> ' + esc(rangeText(span.start, span.end)) + '</span>' +
    '<span>' + esc(fmtBytes(span.end - span.start)) + ' total</span>' +
    '<span>' + esc(fmtBytes(cellBytes)) + ' per cell</span>' +
    '<span>static ' + esc(fmtBytes(staticBytes)) + '</span>' +
    '<span>free ' + esc(fmtBytes(freeBytes)) + '</span>' +
    '<span>live ' + esc(fmtBytes(liveBytes)) + '</span>' +
    '</div>' +
    '<div class="matrix-wrap" style="--matrix-cols:' + cols + '">' + rows.join("") + '</div>';
}

function renderLinkerMap() {
  if (!data.linkerMaps || data.linkerMaps.length === 0) {
    linkerMapEl.innerHTML = '<div class="empty">No linker map supplied. Re-run with <span class="mono">--map path/to/gea_embedded.map</span> to add static sections.</div>';
    return;
  }
  linkerMapEl.innerHTML = data.linkerMaps.map((map) => {
    const internalRegions = map.memoryRegions.filter((region) => /dram|iram|rtc|extern/i.test(region.name));
    const regionRows = internalRegions.map((region) => {
      const segments = linkerRegionSegments(map, region).map((segment) => {
        const left = ((segment.start - region.start) / Math.max(region.size, 1)) * 100;
        const width = Math.max((segment.size / Math.max(region.size, 1)) * 100, 0.16);
        const title = segment.name + " " + rangeText(segment.start, segment.end) + " " + fmtBytes(segment.size) + (segment.ref ? " " + segment.ref : "");
        return '<div class="segment ' + segment.type + '" title="' + esc(title) + '" style="left:' + left.toFixed(4) + '%;width:' + width.toFixed(4) + '%"></div>';
      }).join("");
      const markers = map.sections.filter((section) => section.memoryRegion === region.name && sectionKind(section) === "marker").map((section) => {
        const left = ((section.start - region.start) / Math.max(region.size, 1)) * 100;
        return '<div class="heap-marker" title="' + esc(section.name + " " + hex(section.start) + " " + section.ref) + '" style="left:' + left.toFixed(4) + '%"></div>';
      }).join("");
      const staticBytes = map.sections
        .filter((section) => section.memoryRegion === region.name && section.size > 0)
        .reduce((sum, section) => sum + section.size, 0);
      return '<div class="region-row">' +
        '<div class="region-label"><strong>' + esc(region.name) + '</strong><span class="mono">' + esc(rangeText(region.start, region.end)) + '</span></div>' +
        '<div class="region-bar">' + segments + markers + '</div>' +
        '<div class="region-stat">' + esc(fmtBytes(staticBytes)) + ' static<br>' + esc(fmtBytes(Math.max(region.size - staticBytes, 0))) + ' gap</div>' +
        '</div>';
    }).join("");
    const topSections = [...map.sections]
      .filter((section) => section.memoryRegion && (section.size > 0 || section.name.includes("heap_start")))
      .sort((a, b) => b.size - a.size)
      .slice(0, 24)
      .map((section) => '<tr>' +
        cell(section.name) +
        cell(section.memoryRegion) +
        cell(section.size === 0 ? hex(section.start) : rangeText(section.start, section.end), "mono") +
        cell(fmtBytes(section.size)) +
        cell(section.ref, "small") +
        '</tr>');
    return '<div class="small" style="margin-bottom:10px">' + esc(map.label) + '</div>' +
      '<div class="memory-map" style="margin-bottom:14px">' + regionRows + '</div>' +
      '<div class="scroll-table">' + table(["Section", "Memory", "Range", "Size", "Source"], topSections) + '</div>';
  }).join("");
}

function renderSummary(snapshot) {
  if (!snapshot) {
    summaryEl.innerHTML = '<div class="empty">No heap-map snapshots found.</div>';
    return;
  }
  const regionBytes = snapshot.regions.reduce((sum, region) => sum + region.size, 0);
  const used = snapshot.regions.reduce((sum, region) => sum + region.used, 0);
  const cards = [
    ["Stage", snapshot.stage, snapshot.ref],
    ["Caps", snapshot.caps, snapshot.fileLabel],
    ["Total free", fmtBytes(snapshot.totalFree), snapshot.freeBlockCount + " free blocks"],
    ["Largest hole", fmtBytes(snapshot.largestFree), "min ever " + fmtBytes(snapshot.minFree)],
    ["Used in regions", fmtBytes(used), snapshot.allocBlockCount + " allocated blocks"],
    ["Mapped region bytes", fmtBytes(regionBytes), snapshot.regions.length + " heap regions"],
  ];
  summaryEl.innerHTML = cards.map(([label, value, sub]) => '<div class="metric"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div><div class="sub">' + esc(sub) + '</div></div>').join("");
}

function regionSegments(snapshot, region) {
  const blocks = (region.freeBlockIndexes || []).map((index) => snapshot.freeBlocks[index]).sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = region.start;
  for (const block of blocks) {
    if (block.start > cursor) {
      segments.push({ type: "used", start: cursor, end: Math.min(block.start, region.end), size: Math.min(block.start, region.end) - cursor });
    }
    segments.push({ type: "free", start: block.start, end: block.end, size: block.size, ref: block.ref });
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < region.end) {
    segments.push({ type: "used", start: cursor, end: region.end, size: region.end - cursor });
  }
  return segments.filter((segment) => segment.size > 0);
}

function liveForRegion(snapshot, region) {
  const byStart = new Map();
  for (const allocation of data.liveAllocations) {
    if (!snapshot || allocation.file !== snapshot.file || allocation.line > snapshot.line) continue;
    if (allocation.start < region.start || allocation.end > region.end) continue;
    const existing = byStart.get(allocation.start);
    if (!existing || allocation.line > existing.line) byStart.set(allocation.start, allocation);
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

function renderMemoryMap(snapshot) {
  if (!snapshot || snapshot.regions.length === 0) {
    memoryMapEl.innerHTML = '<div class="empty">No heap regions in this snapshot.</div>';
    return;
  }
  memoryMapEl.innerHTML = snapshot.regions.map((region) => {
    const segments = regionSegments(snapshot, region).map((segment) => {
      const left = ((segment.start - region.start) / region.size) * 100;
      const width = Math.max((segment.size / region.size) * 100, 0.18);
      const title = segment.type + " " + rangeText(segment.start, segment.end) + " " + fmtBytes(segment.size) + (segment.ref ? " " + segment.ref : "");
      return '<div class="segment ' + segment.type + '" title="' + esc(title) + '" style="left:' + left.toFixed(4) + '%;width:' + width.toFixed(4) + '%"></div>';
    }).join("");
    const introduced = introducedUsedSpans(snapshot).filter((span) => span.heap === region.heap && span.start >= region.start && span.end <= region.end).map((span) => {
      const left = ((span.start - region.start) / region.size) * 100;
      const width = Math.max((span.size / region.size) * 100, 0.24);
      const event = matchingFlushPoolEvent(span.size);
      const label = "new heap used since " + span.baselineStage + (event ? " - matches " + event.label + " (" + fmtBytes(event.bytes) + ")" : "");
      const title = label + " " + rangeText(span.start, span.end) + " " + fmtBytes(span.size) + (event ? " " + event.ref : "");
      return '<div class="segment new-used" title="' + esc(title) + '" style="left:' + left.toFixed(4) + '%;width:' + width.toFixed(4) + '%"></div>';
    }).join("");
    const live = liveForRegion(snapshot, region).map((allocation) => {
      const left = ((allocation.start - region.start) / region.size) * 100;
      const width = Math.max((allocation.size / region.size) * 100, 0.24);
      const title = allocation.label + " " + hex(allocation.start) + " " + fmtBytes(allocation.size) + " " + allocation.ref;
      return '<div class="live-overlay" title="' + esc(title) + '" style="left:' + left.toFixed(4) + '%;width:' + width.toFixed(4) + '%"></div>';
    }).join("");
    return '<div class="region-row">' +
      '<div class="region-label"><strong>heap ' + esc(region.heap) + '</strong><span class="mono">' + esc(rangeText(region.start, region.end)) + '</span></div>' +
      '<div class="region-bar">' + segments + introduced + live + '</div>' +
      '<div class="region-stat">' + esc(fmtBytes(region.free)) + ' free<br>' + esc(fmtBytes(region.used)) + ' used</div>' +
      '</div>';
  }).join("");
}

function renderFreeBlocks(snapshot) {
  if (!snapshot) {
    freeBlocksEl.innerHTML = '<div class="empty">No selected snapshot.</div>';
    return;
  }
  const largest = Math.max(...snapshot.freeBlocks.map((block) => block.size), 1);
  const rows = snapshot.freeBlocks.map((block) => {
    const pct = ((block.size / largest) * 100).toFixed(1) + "%";
    return '<tr>' + cell(block.heap) + cell(hex(block.start), "mono") + cell(hex(Math.max(block.start, block.end - 1)), "mono") + cell(fmtBytes(block.size)) + cell(pct) + cell(block.ref, "small") + '</tr>';
  });
  freeBlocksEl.innerHTML = table(["Heap", "Start", "End", "Size", "Of largest", "Source"], rows);
}

function renderRegionsTable(snapshot) {
  if (!snapshot) {
    regionsTableEl.innerHTML = '<div class="empty">No selected snapshot.</div>';
    return;
  }
  const rows = snapshot.regions.map((region) => '<tr>' +
    cell(region.heap) +
    cell(rangeText(region.start, region.end), "mono") +
    cell(fmtBytes(region.size)) +
    cell(fmtBytes(region.free)) +
    cell(fmtBytes(region.used)) +
    cell(fmtBytes(region.largestFree)) +
    cell(region.freeBlocks + " / " + region.usedBlocks) +
    '</tr>');
  regionsTableEl.innerHTML = table(["Heap", "Range", "Region bytes", "Free", "Used", "Largest free", "Free / used blocks"], rows);
}

function renderUsedSpans(snapshot) {
  if (!snapshot) {
    usedSpansEl.innerHTML = '<div class="empty">No selected snapshot.</div>';
    return;
  }
  const rows = usedSpansForSnapshot(snapshot)
    .filter((span) => span.size > 16)
    .map((span) => {
      const introducedParts = introducedPartsForSpan(snapshot, span);
      const introducedBytes = introducedParts.reduce((sum, part) => sum + overlapBytes(span.start, span.end, part), 0);
      const introducedText = introducedParts.length
        ? introducedParts.map((part) => rangeText(part.start, part.end) + " " + fmtBytes(part.size)).join("\\n")
        : "-";
      const event = matchingFlushPoolEvent(introducedBytes);
      const note = event
        ? "Contains newly used bytes matching " + event.label + " (" + fmtBytes(event.bytes) + ") at " + event.ref
        : (introducedBytes > 0 ? "Newly used since " + introducedParts[0].baselineStage : "Already used in first snapshot for " + snapshot.caps);
      return '<tr>' +
        cell(span.heap) +
        cell(rangeText(span.start, span.end), "mono") +
        cell(fmtBytes(span.size)) +
        '<td class="mono">' + esc(introducedText).replace(/\\n/g, "<br>") + '</td>' +
        cell(fmtBytes(introducedBytes)) +
        cell(note, "small") +
        cell(span.regionRef, "small") +
        '</tr>';
    });
  usedSpansEl.innerHTML = table(["Heap", "Used range", "Used size", "Introduced range", "Introduced bytes", "What changed", "Source"], rows);
}

function renderLiveAllocations(snapshot) {
  const rows = data.liveAllocations.map((allocation) => {
    const inSelected = snapshot && snapshot.regions.some((region) => liveForRegion(snapshot, region).some((live) => live.id === allocation.id));
    return '<tr>' +
      cell(allocation.label + (inSelected ? " (in selected map)" : "")) +
      cell(hex(allocation.start), "mono") +
      cell(fmtBytes(allocation.size)) +
      cell(allocation.scope) +
      cell(allocation.ref, "small") +
      '<td><div class="stack">' + esc(allocation.stack.slice(0, 5).join("\\n")) + '</div></td>' +
      '</tr>';
  });
  liveAllocationsEl.innerHTML = table(["Label", "Pointer", "Size", "Scope", "Source", "Stack"], rows);
}

function renderProbeTimeline() {
  const rows = data.probes.map((probe) => {
    const values = probe.values;
    return '<tr>' +
      cell(probe.timeMs == null ? "-" : probe.timeMs + " ms") +
      cell(probe.stage) +
      cell(fmtBytes(values.internal_free)) +
      cell(fmtBytes(values.internal_largest)) +
      cell(fmtBytes(values.internal_min)) +
      cell(fmtBytes(values.psram_free)) +
      cell(probe.ref, "small") +
      '</tr>';
  });
  probeTimelineEl.innerHTML = table(["Time", "Stage", "Internal free", "Largest", "Min", "PSRAM free", "Source"], rows);
}

function polyline(points, key, minValue, maxValue, width, height, padX, padY) {
  if (points.length === 0) return "";
  const span = Math.max(maxValue - minValue, 1);
  return points.map((point, index) => {
    const x = padX + (points.length === 1 ? width / 2 : (index / (points.length - 1)) * width);
    const y = padY + height - ((point[key] - minValue) / span) * height;
    return x.toFixed(2) + "," + y.toFixed(2);
  }).join(" ");
}

function renderTimeline(caps, selectedId) {
  const snapshots = snapshotsForCaps(caps);
  if (snapshots.length === 0) {
    timelineEl.innerHTML = "";
    return;
  }
  const width = 840;
  const height = 150;
  const padX = 58;
  const padY = 24;
  const values = snapshots.flatMap((snapshot) => [snapshot.totalFree, snapshot.largestFree, snapshot.minFree].filter((v) => v != null));
  const minValue = Math.min(...values, 0);
  const maxValue = Math.max(...values, 1);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = padY + height - ratio * height;
    const value = minValue + (maxValue - minValue) * ratio;
    return '<line x1="' + padX + '" y1="' + y + '" x2="' + (padX + width) + '" y2="' + y + '" stroke="rgba(255,255,255,0.08)"/><text x="8" y="' + (y + 4) + '" fill="#a2adb5" font-size="11">' + esc(fmtBytes(value)) + '</text>';
  }).join("");
  const totalPoints = polyline(snapshots, "totalFree", minValue, maxValue, width, height, padX, padY);
  const largestPoints = polyline(snapshots, "largestFree", minValue, maxValue, width, height, padX, padY);
  const minPoints = polyline(snapshots, "minFree", minValue, maxValue, width, height, padX, padY);
  const dots = snapshots.map((snapshot, index) => {
    const x = padX + (snapshots.length === 1 ? width / 2 : (index / (snapshots.length - 1)) * width);
    const y = padY + height - ((snapshot.totalFree - minValue) / Math.max(maxValue - minValue, 1)) * height;
    const selected = snapshot.id === selectedId;
    return '<circle class="timeline-point" data-id="' + snapshot.id + '" cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="' + (selected ? 5 : 3.5) + '" fill="' + (selected ? '#e8eef2' : '#46bf86') + '" stroke="#11171b" stroke-width="2"><title>' + esc(snapshot.stage + " " + fmtBytes(snapshot.totalFree) + " at " + snapshot.ref) + '</title></circle>';
  }).join("");
  timelineEl.innerHTML =
    grid +
    '<polyline points="' + esc(minPoints) + '" fill="none" stroke="#844b3e" stroke-width="2" opacity="0.85"/>' +
    '<polyline points="' + esc(largestPoints) + '" fill="none" stroke="#5bc4d8" stroke-width="3"/>' +
    '<polyline points="' + esc(totalPoints) + '" fill="none" stroke="#46bf86" stroke-width="3"/>' +
    dots +
    '<text x="' + padX + '" y="200" fill="#a2adb5" font-size="11">' + esc(snapshots[0].stage) + '</text>' +
    '<text x="' + (padX + width) + '" y="200" text-anchor="end" fill="#a2adb5" font-size="11">' + esc(snapshots[snapshots.length - 1].stage) + '</text>';
  timelineEl.querySelectorAll(".timeline-point").forEach((point) => {
    point.addEventListener("click", () => {
      snapshotSelect.value = point.getAttribute("data-id");
      render();
    });
  });
}

function populateControls(keepSelected = true) {
  const currentCaps = capsSelect.value;
  const currentSnapshot = snapshotSelect.value;
  const caps = [...new Set(data.snapshots.map((snapshot) => snapshot.caps))];
  capsSelect.innerHTML = caps.map((cap) => '<option value="' + esc(cap) + '">' + esc(cap) + '</option>').join("");
  if (caps.includes(currentCaps)) capsSelect.value = currentCaps;
  const snapshots = snapshotsForCaps(capsSelect.value);
  snapshotSelect.innerHTML = snapshots.map((snapshot) => '<option value="' + snapshot.id + '">' + esc("#" + snapshot.id + " " + snapshot.stage + " - " + snapshot.fileLabel + ":" + snapshot.line) + '</option>').join("");
  if (keepSelected && snapshots.some((snapshot) => String(snapshot.id) === currentSnapshot)) {
    snapshotSelect.value = currentSnapshot;
  } else if (snapshots.length > 0) {
    snapshotSelect.value = String(snapshots[snapshots.length - 1].id);
  }
}

function moveSnapshot(delta) {
  const snapshots = snapshotsForCaps(capsSelect.value);
  const index = snapshots.findIndex((snapshot) => String(snapshot.id) === snapshotSelect.value);
  if (index < 0) return;
  const next = Math.max(0, Math.min(snapshots.length - 1, index + delta));
  snapshotSelect.value = String(snapshots[next].id);
  render();
}

function render() {
  const snapshot = selectedSnapshot();
  renderSummary(snapshot);
  renderTimeline(capsSelect.value, snapshot ? snapshot.id : null);
  renderAddressMatrix(snapshot);
  renderMemoryMap(snapshot);
  renderFreeBlocks(snapshot);
  renderUsedSpans(snapshot);
  renderRegionsTable(snapshot);
  renderLiveAllocations(snapshot);
}

reportMetaEl.innerHTML = esc("Generated " + data.generatedAt) + "<br>" + esc(data.inputs.length + " input log(s), " + data.snapshots.length + " snapshot(s), " + data.probes.length + " probe(s)");
bootTable();
renderLinkerMap();
renderProbeTimeline();
populateControls(false);
render();

capsSelect.addEventListener("change", () => {
  populateControls(false);
  render();
});
snapshotSelect.addEventListener("change", render);
matrixCellSizeSelect.addEventListener("change", () => renderAddressMatrix(selectedSnapshot()));
document.getElementById("prevButton").addEventListener("click", () => moveSnapshot(-1));
document.getElementById("nextButton").addEventListener("click", () => moveSnapshot(1));
document.getElementById("latestButton").addEventListener("click", () => {
  const snapshots = snapshotsForCaps(capsSelect.value);
  if (snapshots.length > 0) {
    snapshotSelect.value = String(snapshots[snapshots.length - 1].id);
    render();
  }
});
</script>
</body>
</html>
`
}

export { parseArgs as parseHeapReportArgs, parseLogs, renderHtml }
