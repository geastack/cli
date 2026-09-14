import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadChipCatalogFromDir, writeCustomTarget } from '../boards/custom-target.mjs'
import { CliError, ExitCode, fail } from '../errors.mjs'
import { appCmakeMeta, appCmakeDefines, appCmakeLdFragments } from '../manifest.mjs'
import { formatCommand } from '../run.mjs'
import { resolveAppCapabilities } from './capabilities.mjs'
import { activateEspIdf, idfPyCommand } from './idf-env.mjs'
import { Sdkconfig, prepareBuildLocalSdkconfig } from './sdkconfig.mjs'
import { generateWifiConfig } from './wifi-config.mjs'

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
export function applySdkconfigPolicy(sdkconfig, { selection, app, capabilities, bleOta }) {
  const set = (key, value) => sdkconfig.set(key, value)
  const unset = (key) => sdkconfig.unset(key)

  set('CONFIG_ESP_MAIN_TASK_STACK_SIZE', String(selection.mainTaskStackSize || 32768))
  set('CONFIG_ESP_IPC_TASK_STACK_SIZE', String(selection.ipcTaskStackSize || 16384))
  set('CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY', 'y')
  set('CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL', '0')

  // The S3's default 16 KB instruction cache is too small for a frame's code
  // working set; 32 KB cut a whole frame ~35% for 16 KB of internal SRAM.
  // Cache config lives in the generated (sticky) sdkconfig, so defaults alone
  // would never reach an existing build directory.
  if ((selection.idfTarget || 'esp32s3') === 'esp32s3') {
    unset('CONFIG_ESP32S3_INSTRUCTION_CACHE_16KB')
    set('CONFIG_ESP32S3_INSTRUCTION_CACHE_32KB', 'y')
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

  // taurus-display OTAs into hardware provisioned with taurus-pedal's legacy
  // partition table; its image must stay byte-compatible with the field.
  if (app?.id === 'taurus-display') {
    set('CONFIG_PARTITION_TABLE_CUSTOM_FILENAME', '"partitions-taurus-display.csv"')
  }

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
export function prepareEsp32Build({ ctx, selection, app = null, env = ctx.env || process.env, log = () => {}, bleOta = false }) {
  if (!selection.targetDir || !existsSync(path.join(selection.targetDir, 'CMakeLists.txt'))) {
    fail(`ESP32 target '${selection.target}' has no project directory (${selection.targetDir || 'unset'}). Is @geastack/targets installed?`, ExitCode.missingDependency)
  }
  const idfTarget = selection.idfTarget || 'esp32s3'
  const buildDir = esp32BuildDir(ctx, selection, app?.id, env)
  const { file: sdkconfigFile, defaultsFile } = prepareBuildLocalSdkconfig(selection.targetDir, buildDir)
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

  let capabilities = { network: false, ble: false, bleApi: false, audio: false, bindings: [], features: [] }
  if (app) {
    capabilities = resolveAppCapabilities(ctx, app, { env })
    if (bleOta) capabilities.ble = true
    const meta = appCmakeMeta(ctx, app)
    const appDefines = appCmakeDefines(app)
    const appLdFragments = appCmakeLdFragments(app)
    idfArgs.push(`-DGEA_EMBEDDED_APP=${app.id}`, `-DGEA_EMBEDDED_APP_META=${meta}`)
    if (appDefines) idfArgs.push(`-DGEA_EMBEDDED_APP_DEFINES=${appDefines}`)
    if (appLdFragments) idfArgs.push(`-DGEA_EMBEDDED_APP_LDFRAGMENTS=${appLdFragments}`)
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
    if (appDefines) childEnv.GEA_EMBEDDED_APP_DEFINES = appDefines
    if (appLdFragments) childEnv.GEA_EMBEDDED_APP_LDFRAGMENTS = appLdFragments
    childEnv.GEA_EMBEDDED_CAPABILITY_NETWORK = capabilities.network ? '1' : '0'
    childEnv.GEA_EMBEDDED_CAPABILITY_BLE = capabilities.ble ? '1' : '0'
    childEnv.GEA_EMBEDDED_CAPABILITY_AUDIO = capabilities.audio ? '1' : '0'
    if (bleOta) childEnv.GEA_EMBEDDED_BLE_OTA = '1'
    log(`App capabilities: network=${capabilities.network ? 1 : 0} ble=${capabilities.ble ? 1 : 0} audio=${capabilities.audio ? 1 : 0}`)
    generateWifiConfig(app.root, path.join(buildDir, 'apps', app.id, 'wifi_config.h'))
  }

  applySdkconfigPolicy(new Sdkconfig(sdkconfigFile, defaultsFile), { selection, app, capabilities, bleOta }).save()

  return { buildDir, sdkconfigFile, defaultsFile, idfArgs, childEnv, capabilities, images: buildImages(buildDir) }
}

function commandExists(name, env) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean)
  return dirs.some((dir) => existsSync(path.join(dir, name)))
}

export function configureArguments(prepared, env) {
  const args = []
  if ((env.GEA_IDF_CCACHE || '1') !== '0' && commandExists('ccache', env)) args.push('--ccache')
  // A CMake generator is immutable once a build directory has been
  // configured. Prefer Ninja for new builds (its no-op dependency traversal
  // is dramatically cheaper) while leaving existing Make builds untouched.
  if (!existsSync(path.join(prepared.buildDir, 'CMakeCache.txt'))) {
    const generator = env.GEA_IDF_GENERATOR || (commandExists('ninja', env) ? 'Ninja' : 'Unix Makefiles')
    if (generator !== 'Ninja' && generator !== 'Unix Makefiles') {
      fail(`GEA_IDF_GENERATOR must be 'Ninja' or 'Unix Makefiles' (got '${generator}').`, ExitCode.usage)
    }
    args.push('-G', generator)
  }
  args.push('-B', prepared.buildDir, `-DSDKCONFIG=${prepared.sdkconfigFile}`, `-DSDKCONFIG_DEFAULTS=${prepared.defaultsFile}`)
  return args
}

function runInTarget(command, args, { cwd, env, dryRun, stdout, failureCode = ExitCode.buildFailed }) {
  if (dryRun) {
    stdout(formatCommand([command, ...args]))
    return
  }
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new CliError(`ERROR: Command failed (${result.status ?? 1}): ${formatCommand([command, ...args])}`, failureCode)
}

// App capability flags are CMake cache entries. Reconfigure only when those
// inputs change; ordinary source/CMake dependency changes remain the build
// system's responsibility. This retains Ninja's sub-second no-op.
export function ensureConfigured({ idf, prepared, env, dryRun = false, stdout }) {
  const signatureFile = path.join(prepared.buildDir, '.gea-configure-args')
  const signature = [`-DSDKCONFIG=${prepared.sdkconfigFile}`, `-DSDKCONFIG_DEFAULTS=${prepared.defaultsFile}`, ...prepared.idfArgs].join('\n') + '\n'
  if (existsSync(path.join(prepared.buildDir, 'CMakeCache.txt')) && existsSync(signatureFile) && readFileSync(signatureFile, 'utf8') === signature) {
    return false
  }
  const { command, args } = idfPyCommand(idf, [...configureArguments(prepared, env), ...prepared.idfArgs, 'reconfigure'])
  runInTarget(command, args, { cwd: prepared.targetDir, env, dryRun, stdout })
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
        stderr(`Another heavyweight build is already using this workspace:\n${owner.trim()}\n(lock: ${lockPath})`)
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

export function buildEsp32Firmware({ ctx, selection, app = null, env = ctx.env || process.env, bleOta = false, dryRun = false, stdout = console.log, stderr = console.error, configureOnly = false }) {
  const idf = requireEspIdf(env, stdout)
  const prepared = prepareEsp32Build({ ctx, selection, app, env: idf.env, log: stdout, bleOta })
  prepared.targetDir = selection.targetDir
  const buildEnv = { ...prepared.childEnv }
  const release = acquireHeavyBuildLock({ ctx, env: buildEnv, label: app ? `${selection.target} app=${app.id}` : selection.target, stderr })
  try {
    if (configureOnly) {
      stdout(`Configuring target ${selection.idfTarget || 'esp32s3'}...`)
      ensureConfigured({ idf, prepared, env: buildEnv, dryRun, stdout })
      return prepared
    }
    stdout(app ? `Building firmware for app '${app.id}' in ${prepared.buildDir}...` : 'Building firmware...')
    ensureConfigured({ idf, prepared, env: buildEnv, dryRun, stdout })
    runInTarget('cmake', ['--build', prepared.buildDir, '--parallel', buildJobs(buildEnv)], { cwd: selection.targetDir, env: buildEnv, dryRun, stdout })
  } finally {
    release()
  }
  return prepared
}

export function fullCleanEsp32({ ctx, selection, app = null, env = ctx.env || process.env, stdout = console.log }) {
  const dir = app ? esp32BuildDir(ctx, selection, app.id, env) : path.join(ctx.buildRoot, selection.target)
  stdout(`Removing build artifacts in ${dir}...`)
  spawnSync('rm', ['-rf', dir], { stdio: 'inherit' })
}
