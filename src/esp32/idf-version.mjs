// ESP-IDF target-version resolution.
//
// One pinned default in code, an env var / CLI option that overrides it
// outright (pin an older release or try a release candidate), and a
// best-effort GitHub "latest release" lookup used only when nothing
// overrides the pin. The network call is injected (`fetchImpl`/`fetchLatest`)
// so real usage hits GitHub while tests supply a fake and never touch the
// network.

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/
const VERSION_IN_TEXT = /v?(\d+)\.(\d+)\.(\d+)/i

// The version GeaStack targets when nothing overrides it and the latest
// release cannot be determined (offline, GitHub unreachable, rate limited).
// Bump this alongside board-script updates.
export const DEFAULT_ESP_IDF_VERSION = 'v6.0.2'

const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/espressif/esp-idf/releases/latest'

// Parses a strict `vX.Y.Z` release tag. Returns null for anything else,
// including release candidates and betas (`v6.1.0-rc1`), so callers can
// filter those out of the "latest" lookup.
export function parseStableIdfTag(value) {
  const match = STABLE_TAG.exec(String(value || '').trim())
  if (!match) return null
  return { tag: match[0], major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

// Pulls a `major.minor(.patch)` out of free-form text such as
// `idf.py --version`'s `ESP-IDF v6.0.2-dirty` output.
export function extractIdfVersionFromText(text) {
  const match = VERSION_IN_TEXT.exec(String(text || ''))
  if (!match) return null
  return { majorMinor: `${match[1]}.${match[2]}`, full: `${match[1]}.${match[2]}.${match[3]}` }
}

// Best-effort lookup of the latest stable ESP-IDF release tag from GitHub.
// Never throws: returns '' when the request fails, times out (~4s default),
// the machine is offline, or the latest release is not a stable vX.Y.Z tag.
// `fetchImpl` defaults to the global fetch; tests inject a fake instead of
// touching the network.
export async function fetchLatestEspIdfVersion({ fetchImpl = globalThis.fetch, timeoutMs = 4000, log = () => {} } = {}) {
  if (typeof fetchImpl !== 'function') return ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(GITHUB_LATEST_RELEASE_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (!response?.ok) return ''
    const body = await response.json()
    return parseStableIdfTag(body?.tag_name)?.tag || ''
  } catch (error) {
    log(`Could not determine the latest ESP-IDF release (${error.message}); using ${DEFAULT_ESP_IDF_VERSION}.`)
    return ''
  } finally {
    clearTimeout(timer)
  }
}

// Resolves the ESP-IDF version tag to install/verify against, in order:
//   1. `override` (--idf-version) or GEA_ESP_IDF_VERSION -- explicit pin or
//      a release candidate to test; used as-is (not required to be stable).
//   2. the latest stable GitHub release, when `fetchLatest` can determine one.
//   3. DEFAULT_ESP_IDF_VERSION.
export async function resolveEspIdfVersion({ override, env = process.env, fetchLatest = fetchLatestEspIdfVersion, log = () => {} } = {}) {
  const requested = override || env.GEA_ESP_IDF_VERSION
  if (requested) return requested.startsWith('v') ? requested : `v${requested}`
  const latest = await fetchLatest({ log })
  return latest || DEFAULT_ESP_IDF_VERSION
}

// True when an installed ESP-IDF's version.cmake-derived version satisfies
// the resolved target: same-or-newer major.minor. This is a floor, not an
// exact-match: an installed 6.0.2 must not be rejected just because the
// resolved target moved on to, say, 6.1.0 -- reinstalling isn't required
// unless the installed major.minor genuinely trails the target's.
// An unparsable target is treated as "anything installed is acceptable".
export function idfVersionMeetsTarget(installedVersion, targetTag) {
  const target = extractIdfVersionFromText(targetTag)
  if (!target) return true
  const [targetMajor, targetMinor] = target.majorMinor.split('.').map(Number)
  const parts = String(installedVersion?.majorMinor || '').split('.').map(Number)
  if (parts.length < 2 || parts.some((part) => Number.isNaN(part))) return false
  const [installedMajor, installedMinor] = parts
  if (installedMajor !== targetMajor) return installedMajor > targetMajor
  return installedMinor >= targetMinor
}
