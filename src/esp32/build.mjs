import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadChipCatalogFromDir, writeCustomTarget } from '../boards/custom-target.mjs'
import { CliError, ExitCode, fail } from '../errors.mjs'
import { appCmakeMeta, appCmakeDefines, appCmakeLdFragments, appTargetConfig, appTargetPaths } from '../manifest.mjs'
import { quietSteps, runQuiet } from '../run.mjs'
import { resolveAppCapabilities } from './capabilities.mjs'
import { activateEspIdf, idfPyCommand } from './idf-env.mjs'
import { Sdkconfig, prepareBuildLocalSdkconfig } from './sdkconfig.mjs'
import { writePartitionTable } from './partitions-from-manifest.mjs'
import { listAppSources } from './source-set.mjs'
import { writeFlashPlan } from './partitions.mjs'
import { generateWifiConfig } from './wifi-config.mjs'
import { hint, warn } from '../report.mjs'

// The ESP-IDF build. Everything the old bash board script decided about a
// build lives here: where the build directory is, what the app-local
// sdkconfig must say, which capabilities the firmware links, and when a
// reconfigure is actually needed.

function safePathFragment(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_')
}

export function esp32BuildDir(ctx, selection, appId, env = ctx.env || process.env) {
  if (!appId) return path.join(ctx.buildRoot, selection.target, 'default')
  let key = safePathFragment(appId)
  const variant = env.GEA_IDF_BUILD_VARIANT || ''
  if (variant) {
    if (!/^[A-Za-z0-9._-]+$/.test(variant)) {
      fail("GEA_IDF_BUILD_VARIANT may contain only letters, digits, '.', '_' and '-'.", ExitCode.usage)
    }
    key = `${key}__variant-${variant}`
  }
  return path.join(ctx.buildRoot, selection.target, 'app-builds', key)
}

export function buildImages(buildDir) {
  return {
    app: path.join(buildDir, 'gea_embedded.bin'),
    bootloader: path.join(buildDir, 'bootloader', 'bootloader.bin'),
    partitionTable: path.join(buildDir, 'partition_table', 'partition-table.bin'),
    otaData: path.join(buildDir, 'ota_data_initial.bin')
  }
}

export function requireEspIdf(env, log) {
  let idf
  try {
    idf = activateEspIdf({ env, log })
  } catch (error) {
    fail(error.message, ExitCode.missingDependency)
  }
  if (!idf) {
    fail('ESP-IDF was not found. Install it and set IDF_PATH (or place it under ~/esp or ~/esp32).', ExitCode.missingDependency)
  }
  return idf
}

// The per-app sdkconfig policy: development logging, the board's stack
// sizes, the S3 instruction cache and the BLE host exactly as the app needs.
export function applySdkconfigPolicy(sdkconfig, { selection, app, capabilities, bleOta, partitionCsv }) {
  const set = (key, value) => sdkconfig.set(key, value)
  const unset = (key) => sdkconfig.unset(key)
  // A board value the app's own defaults may replace. Every value this policy
  // writes lands in the generated sdkconfig, which outranks every defaults file
  // (IDF's "Defaults policy: sdkconfig") -- so a board value written here does
  // not merely win a tie, it silently overrules what the app asked for, and no
  // edit to the app's defaults can ever take effect. The app is the more
  // specific declaration, so it wins.
  const board = (key, value) => sdkconfig.set(key, sdkconfig.appDefaultValue(key) || value)

  // An app that declares its own partitions replaces the board's table. The
  // path is absolute because a generated table lives in the build directory,
  // not beside the target's own CMakeLists.
  if (partitionCsv) {
    unset('CONFIG_PARTITION_TABLE_SINGLE_APP')
    unset('CONFIG_PARTITION_TABLE_SINGLE_APP_LARGE')
    unset('CONFIG_PARTITION_TABLE_TWO_OTA')
    set('CONFIG_PARTITION_TABLE_CUSTOM', 'y')
    set('CONFIG_PARTITION_TABLE_CUSTOM_FILENAME', `"${partitionCsv}"`)
  }

  // These four are all internal-DRAM decisions, which is the memory an app's
  // own DMA buffers and real-time arenas come from: the two task stacks are
  // allocated from it, and the two PSRAM settings decide how much of the rest
  // stays available. An app that sizes them itself knows its own budget better
  // than the board does.
  board('CONFIG_ESP_MAIN_TASK_STACK_SIZE', String(selection.mainTaskStackSize || 32768))
  board('CONFIG_ESP_IPC_TASK_STACK_SIZE', String(selection.ipcTaskStackSize || 16384))
  board('CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY', 'y')
  board('CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL', '0')

  // The S3's default 16 KB instruction cache is too small for a frame's code
  // working set; 32 KB cut a whole frame ~35% for 16 KB of internal SRAM.
  // Cache config lives in the generated (sticky) sdkconfig, so defaults alone
  // would never reach an existing build directory -- which is exactly why an
  // app that asks for the 16 KB cache in its own defaults has to be honoured
  // here rather than silently overruled. The 32 KB cache claims SRAM0's
  // IRAM-only region, so the whole of .iram0.text moves into DIRAM and is
  // mirrored there as .dram0.dummy: 16 KB off the internal heap. An app whose
  // own arenas need that SRAM more than it needs frame time has no other way
  // to buy it back.
  if ((selection.idfTarget || 'esp32s3') === 'esp32s3') {
    if (sdkconfig.appDefaultIsSet('CONFIG_ESP32S3_INSTRUCTION_CACHE_16KB')) {
      unset('CONFIG_ESP32S3_INSTRUCTION_CACHE_32KB')
      set('CONFIG_ESP32S3_INSTRUCTION_CACHE_16KB', 'y')
    } else {
      unset('CONFIG_ESP32S3_INSTRUCTION_CACHE_16KB')
      set('CONFIG_ESP32S3_INSTRUCTION_CACHE_32KB', 'y')
    }

    // The data cache is what a PSRAM framebuffer is read and written through.
    // This board's is 410x502x2 = 411 KB in octal PSRAM, so every rasterized
    // pixel and every flush read is a cache transaction; IDF's default 32 KB
    // with a 32-byte line spends two transactions on every 64-byte burst the
    // PSRAM controller would have served in one. 64 KB / 64 B matches the
    // controller's burst and holds more of a scanline's working set. The cost
    // is 32 KB of internal SRAM off the heap, and like the instruction cache
    // it lives in the generated (sticky) sdkconfig, so defaults alone would
    // never reach an existing build directory -- which is why an app that asks
    // for a smaller cache or line in its own defaults is honoured rather than
    // silently overruled.
    if (sdkconfig.appDefaultIsSet('CONFIG_ESP32S3_DATA_CACHE_16KB')) {
      unset('CONFIG_ESP32S3_DATA_CACHE_32KB')
      unset('CONFIG_ESP32S3_DATA_CACHE_64KB')
      set('CONFIG_ESP32S3_DATA_CACHE_16KB', 'y')
    } else if (sdkconfig.appDefaultIsSet('CONFIG_ESP32S3_DATA_CACHE_32KB')) {
      unset('CONFIG_ESP32S3_DATA_CACHE_16KB')
      unset('CONFIG_ESP32S3_DATA_CACHE_64KB')
      set('CONFIG_ESP32S3_DATA_CACHE_32KB', 'y')
    } else {
      unset('CONFIG_ESP32S3_DATA_CACHE_16KB')
      unset('CONFIG_ESP32S3_DATA_CACHE_32KB')
      set('CONFIG_ESP32S3_DATA_CACHE_64KB', 'y')
    }
    // A 64-byte line needs a 32 KB or 64 KB data cache; a board that pinned
    // itself to 16 KB keeps the 32-byte line it is allowed.
    if (sdkconfig.appDefaultIsSet('CONFIG_ESP32S3_DATA_CACHE_LINE_32B') ||
        sdkconfig.appDefaultIsSet('CONFIG_ESP32S3_DATA_CACHE_16KB')) {
      unset('CONFIG_ESP32S3_DATA_CACHE_LINE_64B')
      set('CONFIG_ESP32S3_DATA_CACHE_LINE_32B', 'y')
    } else {
      unset('CONFIG_ESP32S3_DATA_CACHE_LINE_16B')
      unset('CONFIG_ESP32S3_DATA_CACHE_LINE_32B')
      set('CONFIG_ESP32S3_DATA_CACHE_LINE_64B', 'y')
    }
  }

  unset('CONFIG_GEA_EMBEDDED_PRODUCTION_LOCKDOWN')
  for (const level of ['NONE', 'ERROR', 'WARN', 'DEBUG', 'VERBOSE']) unset(`CONFIG_LOG_DEFAULT_LEVEL_${level}`)
  set('CONFIG_LOG_DEFAULT_LEVEL_INFO', 'y')
  set('CONFIG_LOG_DEFAULT_LEVEL', '3')
  set('CONFIG_LOG_MAXIMUM_EQUALS_DEFAULT', 'y')
  unset('CONFIG_LOG_MAXIMUM_LEVEL_DEBUG')
  unset('CONFIG_LOG_MAXIMUM_LEVEL_VERBOSE')
  set('CONFIG_LOG_MAXIMUM_LEVEL', '3')

  // The M5StickC S3's OTA partitions are small and the binary sits at the
  // ceiling; assertion strings push it over. Boards that already disable or
  // silence assertions in their defaults keep that choice.
  if (selection.boardName === 'sticks3' || sdkconfig.defaultIsSet('CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_DISABLE')) {
    unset('CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_ENABLE')
    unset('CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_SILENT')
    set('CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_DISABLE', 'y')
    set('CONFIG_COMPILER_OPTIMIZATION_ASSERTION_LEVEL', '0')
  } else if (sdkconfig.defaultIsSet('CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_SILENT')) {
    unset('CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_ENABLE')
    unset('CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_DISABLE')
    set('CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_SILENT', 'y')
    set('CONFIG_COMPILER_OPTIMIZATION_ASSERTION_LEVEL', '1')
  } else {
    unset('CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_DISABLE')
    unset('CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_SILENT')
    set('CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_ENABLE', 'y')
    set('CONFIG_COMPILER_OPTIMIZATION_ASSERTION_LEVEL', '2')
  }

  for (const level of ['NONE', 'ERROR', 'WARN', 'DEBUG', 'VERBOSE']) unset(`CONFIG_BOOTLOADER_LOG_LEVEL_${level}`)
  set('CONFIG_BOOTLOADER_LOG_LEVEL_INFO', 'y')
  set('CONFIG_BOOTLOADER_LOG_LEVEL', '3')

  if (!app) return sdkconfig
  if (capabilities.ble) {
    set('CONFIG_BT_ENABLED', 'y')
    unset('CONFIG_BT_BLUEDROID_ENABLED')
    set('CONFIG_BT_NIMBLE_ENABLED', 'y')
    set('CONFIG_BT_NIMBLE_MEM_ALLOC_MODE_EXTERNAL', 'y')
    set('CONFIG_BT_NIMBLE_ROLE_BROADCASTER', 'y')
    set('CONFIG_BT_NIMBLE_ROLE_PERIPHERAL', 'y')
    if (bleOta && !capabilities.bleApi) {
      set('CONFIG_BT_NIMBLE_MAX_CONNECTIONS', '1')
      unset('CONFIG_BT_NIMBLE_ROLE_CENTRAL')
      unset('CONFIG_BT_NIMBLE_ROLE_OBSERVER')
    } else {
      // Apps using the BLE API inherit the board policy (the amoled 2.06 uses
      // four links plus central/observer for HID-host and MIDI roles).
      set('CONFIG_BT_NIMBLE_MAX_CONNECTIONS', sdkconfig.defaultValue('CONFIG_BT_NIMBLE_MAX_CONNECTIONS') || '1')
      if (sdkconfig.defaultIsSet('CONFIG_BT_NIMBLE_ROLE_CENTRAL')) set('CONFIG_BT_NIMBLE_ROLE_CENTRAL', 'y')
      if (sdkconfig.defaultIsSet('CONFIG_BT_NIMBLE_ROLE_OBSERVER')) set('CONFIG_BT_NIMBLE_ROLE_OBSERVER', 'y')
    }
  } else if (sdkconfig.appDefaultIsSet('CONFIG_BT_ENABLED')) {
    // The app does not use the Gea BLE API but turns the controller on in its
    // own sdkconfig: it drives a Bluetooth stack from its own native sources.
    // Written positively, not left to the defaults file, because the generated
    // sdkconfig is sticky -- a build directory configured before the app asked
    // for Bluetooth still carries the "is not set" line, which outranks any
    // defaults file. The rest of the stack (host, roles, link count) comes from
    // the app's defaults, which Kconfig applies once the symbols exist.
    set('CONFIG_BT_ENABLED', 'y')
  } else if (sdkconfig.has(/^(CONFIG_BT_ENABLED=|# CONFIG_BT_ENABLED is not set)/m)) {
    // A minimal no-BLE build excludes the whole bt component, so its Kconfig
    // symbols do not exist; re-adding an "is not set" line there makes
    // Kconfig delete it and invalidates CMake on every invocation.
    unset('CONFIG_BT_ENABLED')
  }
  return sdkconfig
}

// Resolves every input of an ESP32 build without running it: build dir,
// sdkconfig, generated headers, cache arguments and the child environment.
export function prepareEsp32Build({ ctx, selection, app = null, env = ctx.env || process.env, log = () => {}, bleOta = false, dryRun = false }) {
  if (!selection.targetDir || !existsSync(path.join(selection.targetDir, 'CMakeLists.txt'))) {
    fail(`ESP32 target '${selection.target}' has no project directory (${selection.targetDir || 'unset'}). Is @geastack/targets installed?`, ExitCode.missingDependency)
  }
  const idfTarget = selection.idfTarget || 'esp32s3'
  const buildDir = esp32BuildDir(ctx, selection, app?.id, env)
  // gea.targets.esp32.sdkconfig: the app's own Kconfig defaults, layered over
  // the board's. IDF reads a ';'-separated SDKCONFIG_DEFAULTS list in order, so
  // the app's file is last and wins wherever the two disagree.
  const appEsp32Config = app ? appTargetConfig(app, 'esp32') : null
  const appSdkconfigFile = appEsp32Config?.sdkconfig ? path.join(app.root, appEsp32Config.sdkconfig) : ''
  const { file: sdkconfigFile, defaultsFile, regenerated } = prepareBuildLocalSdkconfig(selection.targetDir, buildDir, appSdkconfigFile)
  if (regenerated) log('sdkconfig defaults changed; the generated sdkconfig was rebuilt from them')
  log(`Using ESP32 target '${selection.target}' at ${selection.targetDir} (idf=${idfTarget} chip=${selection.esptoolChip || idfTarget} flash=${selection.flashSize})`)

  const childEnv = { ...env }
  const idfArgs = [`-DIDF_TARGET=${idfTarget}`, `-DGEA_APPS_ROOT=${ctx.projectRoot}`]
  if (selection.targetDefinition) {
    // The board header and target.cmake are generated here, once; CMake only
    // includes them.
    const outDir = path.join(buildDir, 'gea-custom-target')
    if (!ctx.chipsPackageDir) fail('@geastack/chips is not installed in this project; custom boards need its chip catalog.', ExitCode.missingDependency)
    const generated = writeCustomTarget({ definitionPath: selection.targetDefinition, outDir, catalog: loadChipCatalogFromDir(ctx.chipsPackageDir) })
    idfArgs.push(`-DGEA_BOARD_DEFINITION=${selection.targetDefinition}`, `-DGEA_CUSTOM_TARGET_DIR=${outDir}`)
    childEnv.GEA_BOARD_DEFINITION = selection.targetDefinition
    childEnv.GEA_CUSTOM_TARGET_DIR = outDir
    log(`Generated custom board files in ${outDir} (${path.basename(generated.headerPath)}, ${path.basename(generated.cmakePath)})`)
  }

function runAppPrebuild(app, config, { dryRun, log }) {
  if (!config.prebuild) return
  log(`App prebuild: ${config.prebuild}`)
  if (dryRun) return
  const result = spawnSync(config.prebuild, { cwd: app.root, shell: true, stdio: 'inherit' })
  if (result.error) throw new CliError(`App prebuild failed to start: ${result.error.message}`, ExitCode.buildFailed)
  if (result.status !== 0) {
    fail(`App prebuild exited ${result.status}: ${config.prebuild}`, ExitCode.buildFailed)
  }
}

// A string is an existing CSV the app maintains; an object is the table itself,
// which is generated into the build directory. The CSV path and the payload
// pairs stay in separate variables -- a single ';'-joined value could not say
// where the path ends and the payloads begin.
//
// The plan written alongside is for `gea flash`, which drives esptool itself
// instead of IDF's flash target: without it the flash would read the board's
// static table and skip every payload, leaving a board with an app and no
// factory data.
// `2` -> `2.0`, `1.5` -> `1.5`, not declared -> ''. Keeps the value a double
// literal for the C++ define while staying the plain decimal string CMake hands
// to geatsc.
function cssDevicePixelRatioLiteral(ratio) {
  if (!(ratio > 0)) return ''
  const text = String(ratio)
  return text.includes('.') ? text : `${text}.0`
}

function preparePartitions(app, config, buildDir) {
  const plan = ({ csv = '', payloads = [] }) => {
    writeFlashPlan(buildDir, { csv, payloads })
    return { csv, payloads: payloads.map((payload) => `${payload.name}=${payload.file}`).join(';') }
  }
  if (!config.partitions) return plan({})
  if (typeof config.partitions === 'string') return plan({ csv: path.join(app.root, config.partitions) })
  const { file, payloads } = writePartitionTable({
    table: config.partitions,
    appRoot: app.root,
    outDir: path.join(buildDir, 'gea-partitions')
  })
  return plan({ csv: file, payloads })
}

  let appPartitionCsv = ''
  let capabilities = { network: false, ble: false, bleApi: false, audio: false, bindings: [], features: [] }
  if (app) {
    capabilities = resolveAppCapabilities(ctx, app, { env })
    if (bleOta) capabilities.ble = true
    const meta = appCmakeMeta(ctx, app)
    // gea.cssDevicePixelRatio lands in two places that have to agree. The
    // layout ratio travels with the app's own defines, because those go on the
    // whole native build -- the framework's runtime.cpp is what reads it. The
    // font ratio is a cache variable each board declares with a plain
    // `set(... CACHE STRING ...)`, so a -D of the same name, which exists before
    // the board's CMakeLists runs, wins without the board knowing about apps.
    const cssDpr = cssDevicePixelRatioLiteral(app.cssDevicePixelRatio)
    const appDefines = [appCmakeDefines(app), cssDpr && `GEA_EMBEDDED_CSS_LAYOUT_DEVICE_PIXEL_RATIO=${cssDpr}`]
      .filter(Boolean)
      .join(';')
    const esp32Config = appEsp32Config
    // Runs before the partition table is read and before configure, because it
    // is what produces the files embedFiles and a partition's data refer to.
    runAppPrebuild(app, esp32Config, { dryRun, log })
    const partitions = preparePartitions(app, esp32Config, buildDir)
    appPartitionCsv = partitions.csv
    const partitionPayloads = partitions.payloads
    const appNative = {
      GEA_EMBEDDED_APP_DEFINES: appDefines,
      GEA_EMBEDDED_APP_LDFRAGMENTS: appCmakeLdFragments(app),
      GEA_EMBEDDED_APP_COMPONENT_DIRS: appTargetPaths(app, 'esp32', 'componentDirs').join(';'),
      // Component names the app's own native sources include headers from or
      // take PUBLIC compile definitions from. They land on the shared
      // gea_framework component's REQUIRES, which is transitive, so the app's
      // sources in `main` see them without every board declaring them.
      GEA_EMBEDDED_APP_COMPONENT_REQUIRES: esp32Config.componentRequires.join(';'),
      GEA_EMBEDDED_APP_LINK_OPTIONS: esp32Config.linkOptions.join(';'),
      // `symbol=file` pairs; CMake splits each on the first '='.
      GEA_EMBEDDED_APP_EMBED_FILES: Object.entries(esp32Config.embedFiles)
        .map(([symbol, file]) => `${symbol}=${path.join(app.root, file)}`)
        .join(';'),
      GEA_EMBEDDED_APP_PARTITION_DATA: partitionPayloads,
      // gea.compilerPlugins: the app's own geatsc plugins, e.g. one declaring
      // the native host functions its TSX calls.
      GEA_EMBEDDED_APP_GEATSC_PLUGINS: app.compilerPlugins.map((plugin) => path.join(app.root, plugin)).join(';')
    }
    idfArgs.push(`-DGEA_EMBEDDED_APP=${app.id}`, `-DGEA_EMBEDDED_APP_META=${meta}`)
    if (cssDpr) idfArgs.push(`-DGEA_EMBEDDED_CSS_DEVICE_PIXEL_RATIO=${cssDpr}`)
    for (const [name, value] of Object.entries(appNative)) if (value) idfArgs.push(`-D${name}=${value}`)
    idfArgs.push(
      `-DGEA_EMBEDDED_CAPABILITY_NETWORK=${capabilities.network ? 1 : 0}`,
      `-DGEA_EMBEDDED_CAPABILITY_BLE=${capabilities.ble ? 1 : 0}`,
      `-DGEA_EMBEDDED_CAPABILITY_AUDIO=${capabilities.audio ? 1 : 0}`
    )
    // IDF's MINIMAL_BUILD component-requirements pass runs before normal
    // CMake cache propagation; environment values stay visible there, so
    // conditional components such as bt enter the dependency graph.
    childEnv.GEA_EMBEDDED_APP = app.id
    childEnv.GEA_EMBEDDED_APP_META = meta
    for (const [name, value] of Object.entries(appNative)) if (value) childEnv[name] = value
    childEnv.GEA_EMBEDDED_CAPABILITY_NETWORK = capabilities.network ? '1' : '0'
    childEnv.GEA_EMBEDDED_CAPABILITY_BLE = capabilities.ble ? '1' : '0'
    childEnv.GEA_EMBEDDED_CAPABILITY_AUDIO = capabilities.audio ? '1' : '0'
    if (bleOta) childEnv.GEA_EMBEDDED_BLE_OTA = '1'
    log(`App capabilities: network=${capabilities.network ? 1 : 0} ble=${capabilities.ble ? 1 : 0} audio=${capabilities.audio ? 1 : 0}`)
    generateWifiConfig(app.root, path.join(buildDir, 'apps', app.id, 'wifi_config.h'))
  }

  applySdkconfigPolicy(new Sdkconfig(sdkconfigFile, defaultsFile, appSdkconfigFile), {
    selection,
    app,
    capabilities,
    bleOta,
    partitionCsv: appPartitionCsv
  }).save()

  const defaultsArg = [defaultsFile, appSdkconfigFile].filter(Boolean).join(';')
  const sourceSet = app ? listAppSources(app.root) : []
  return { buildDir, sdkconfigFile, defaultsFile, appSdkconfigFile, defaultsArg, idfArgs, childEnv, capabilities, sourceSet, images: buildImages(buildDir) }
}

// Windows executables carry an extension from PATHEXT, so probing for the bare
// name finds nothing even when the tool is installed and on PATH -- which is
// how an ESP-IDF install that ships ninja.exe still read as "no ninja".
function executableNames(name, env) {
  if (process.platform !== 'win32') return [name]
  const extensions = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return [name, ...extensions.map((extension) => name + extension)]
}

function commandExists(name, env) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean)
  const names = executableNames(name, env)
  return dirs.some((dir) => names.some((candidate) => existsSync(path.join(dir, candidate))))
}

export function configureArguments(prepared, env) {
  const args = []
  if ((env.GEA_IDF_CCACHE || '1') !== '0' && commandExists('ccache', env)) args.push('--ccache')
  // A CMake generator is immutable once a build directory has been
  // configured. Prefer Ninja for new builds (its no-op dependency traversal
  // is dramatically cheaper) while leaving existing Make builds untouched.
  if (!existsSync(path.join(prepared.buildDir, 'CMakeCache.txt'))) {
    // idf.py accepts only Ninja on Windows, so the probe must not decide there:
    // a false negative would pick a generator the build refuses outright.
    const windows = process.platform === 'win32'
    const generator = env.GEA_IDF_GENERATOR || (windows || commandExists('ninja', env) ? 'Ninja' : 'Unix Makefiles')
    if (generator !== 'Ninja' && generator !== 'Unix Makefiles') {
      fail(`GEA_IDF_GENERATOR must be 'Ninja' or 'Unix Makefiles' (got '${generator}').`, ExitCode.usage)
    }
    if (windows && generator !== 'Ninja') {
      fail(`ESP-IDF on Windows supports only the Ninja generator (got '${generator}').`, ExitCode.usage)
    }
    args.push('-G', generator)
  }
  args.push('-B', prepared.buildDir, `-DSDKCONFIG=${prepared.sdkconfigFile}`, `-DSDKCONFIG_DEFAULTS=${prepared.defaultsArg || prepared.defaultsFile}`)
  return args
}

function runInTarget(command, args, { cwd, env, dryRun, verbose, label, logFile, stdout, stderr, failureCode = ExitCode.buildFailed }) {
  return runQuiet(command, args, { cwd, env, dryRun, verbose, label, logFile, stdout, stderr, failureCode })
}

// App capability flags are CMake cache entries. Reconfigure only when those
// inputs change; ordinary source/CMake dependency changes remain the build
// system's responsibility. This retains Ninja's sub-second no-op.
export async function ensureConfigured({ idf, prepared, env, dryRun = false, verbose = false, stdout, stderr = console.error }) {
  const signatureFile = path.join(prepared.buildDir, '.gea-configure-args')
  const signature = [`-DSDKCONFIG=${prepared.sdkconfigFile}`, `-DSDKCONFIG_DEFAULTS=${prepared.defaultsArg || prepared.defaultsFile}`, ...prepared.idfArgs, ...(prepared.sourceSet || [])].join('\n') + '\n'
  if (existsSync(path.join(prepared.buildDir, 'CMakeCache.txt')) && existsSync(signatureFile) && readFileSync(signatureFile, 'utf8') === signature) {
    return false
  }
  const { command, args } = idfPyCommand(idf, [...configureArguments(prepared, env), ...prepared.idfArgs, 'reconfigure'])
  await runInTarget(command, args, {
    cwd: prepared.targetDir,
    env,
    dryRun,
    verbose,
    label: 'Configuring ESP-IDF',
    logFile: path.join(prepared.buildDir, 'gea-configure.log'),
    stdout,
    stderr
  })
  if (!dryRun) {
    mkdirSync(prepared.buildDir, { recursive: true })
    const tmp = `${signatureFile}.tmp.${process.pid}`
    writeFileSync(tmp, signature)
    renameSync(tmp, signatureFile)
  }
  return true
}

export function buildJobs(env) {
  const jobs = env.GEA_IDF_JOBS || '8'
  if (!/^[1-9]\d*$/.test(jobs)) fail(`GEA_IDF_JOBS must be a positive integer (got '${jobs}').`, ExitCode.usage)
  return jobs
}

// Opt-in workspace-wide serialization for benchmark-grade builds
// (GEA_SERIALIZE_HEAVY_BUILDS=1). Concurrent builds are the normal workflow;
// the lock only exists so a measurement is not taken beside another compile.
export function acquireHeavyBuildLock({ ctx, env, label, stderr }) {
  if (env.GEA_SERIALIZE_HEAVY_BUILDS !== '1') return () => {}
  const lockPath = env.GEA_HEAVY_BUILD_LOCK_PATH || path.join(ctx.buildRoot, '.heavy-build.lock')
  mkdirSync(path.dirname(lockPath), { recursive: true })
  const contents = `pid=${process.pid}\nkind=esp32\nlabel=${label}\nstarted_at=${new Date().toISOString()}\n`
  for (;;) {
    try {
      writeFileSync(lockPath, contents, { flag: 'wx', mode: 0o600 })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = readFileSync(lockPath, 'utf8')
      const pid = Number(owner.match(/^pid=(\d+)$/m)?.[1])
      let live = false
      try {
        process.kill(pid, 0)
        live = Number.isFinite(pid)
      } catch {
        live = false
      }
      if (live) {
        warn(stderr, `Another heavyweight build is already using this workspace:\n${owner.trim()}\n(lock: ${lockPath})`)
        fail('Heavy-build lock is held; retry when that build finishes or unset GEA_SERIALIZE_HEAVY_BUILDS.', ExitCode.buildFailed)
      }
      unlinkSync(lockPath)
    }
  }
  return () => {
    try {
      if (readFileSync(lockPath, 'utf8') === contents) unlinkSync(lockPath)
    } catch {
      // already gone
    }
  }
}

export async function buildEsp32Firmware({ ctx, selection, app = null, env = ctx.env || process.env, bleOta = false, dryRun = false, verbose = false, stdout = console.log, stderr = console.error, configureOnly = false }) {
  // On a terminal the toolchain, target and capability lines fold into one
  // dim line; the spinner labels name each phase.
  const quiet = quietSteps(env, verbose)
  const detail = quiet ? () => {} : stdout
  const idf = requireEspIdf(env, detail)
  const prepared = prepareEsp32Build({ ctx, selection, app, env: idf.env, log: detail, bleOta, dryRun })
  prepared.targetDir = selection.targetDir
  if (quiet) hint(stdout, buildSummaryLine(idf, selection, prepared.capabilities))

  const buildEnv = { ...prepared.childEnv }
  const release = acquireHeavyBuildLock({ ctx, env: buildEnv, label: app ? `${selection.target} app=${app.id}` : selection.target, stderr })
  try {
    if (configureOnly) {
      detail(`Configuring target ${selection.idfTarget || 'esp32s3'}...`)
      await ensureConfigured({ idf, prepared, env: buildEnv, dryRun, verbose, stdout, stderr })
      return prepared
    }

    detail(app ? `Building firmware for app '${app.id}' in ${prepared.buildDir}...` : 'Building firmware...')
    await ensureConfigured({ idf, prepared, env: buildEnv, dryRun, verbose, stdout, stderr })
    await runInTarget('cmake', ['--build', prepared.buildDir, '--parallel', buildJobs(buildEnv)], {
      cwd: selection.targetDir,
      env: buildEnv,
      dryRun,
      verbose,
      label: 'Building firmware',
      logFile: path.join(prepared.buildDir, 'gea-build.log'),
      stdout,
      stderr
    })
  } finally {
    release()
  }

  return prepared
}

function buildSummaryLine(idf, selection, capabilities) {
  const flags = ['network', 'ble', 'audio'].map((name) => `${name}=${capabilities[name] ? 1 : 0}`).join(' ')
  return `ESP-IDF ${idf.version?.full || 'unknown'} · ${selection.target} · ${flags}`
}

export function fullCleanEsp32({ ctx, selection, app = null, env = ctx.env || process.env, stdout = console.log }) {
  const dir = app ? esp32BuildDir(ctx, selection, app.id, env) : path.join(ctx.buildRoot, selection.target)
  stdout(`Removing build artifacts in ${dir}...`)
  spawnSync('rm', ['-rf', dir], { stdio: 'inherit' })
}
