// ESP-IDF target-version resolution.
//
// One pinned default in code, and an env var / CLI option that overrides it
// outright (pin another release or try a release candidate).

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/
const VERSION_IN_TEXT = /v?(\d+)\.(\d+)\.(\d+)/i

// The version GeaStack targets when nothing overrides it.
// Bump this alongside board-script updates.
export const DEFAULT_ESP_IDF_VERSION = 'v6.0.2'

// Automatic build selection is target-specific; IDF_PATH can override it.
export function espIdfVersionForTarget(target) {
  return target === 'esp32-s31-espressif-mosaico' ? '6.2-dev' : DEFAULT_ESP_IDF_VERSION.slice(1)
}

// Parses a strict `vX.Y.Z` release tag. Returns null for anything else,
// including release candidates and betas (`v6.1.0-rc1`).
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

// Resolves the ESP-IDF version tag to install/verify against, in order:
//   1. `override` (--idf-version) or GEA_ESP_IDF_VERSION -- explicit pin or
//      a release candidate to test; used as-is (not required to be stable).
//   2. DEFAULT_ESP_IDF_VERSION.
// Builds accept exactly the release espIdfVersionForTarget names, so setup
// installs that one: a newer stable release would install cleanly and then be
// refused by every build.
export async function resolveEspIdfVersion({ override, env = process.env } = {}) {
  const requested = override || env.GEA_ESP_IDF_VERSION
  // Only a bare version gains the tag's `v`; a branch (`master`) is cloned as named.
  if (requested) return /^\d/.test(requested) ? `v${requested}` : requested
  return DEFAULT_ESP_IDF_VERSION
}

// True when an installed ESP-IDF satisfies the setup target. For the pinned
// default that means being that exact release, because builds look for exactly
// it: reporting a newer release as "found" leaves a machine no build accepts.
// A version the user asked for by name keeps the major.minor floor.
export function idfVersionSatisfiesTarget(installedVersion, targetTag) {
  if (targetTag !== DEFAULT_ESP_IDF_VERSION) return idfVersionMeetsTarget(installedVersion, targetTag)
  return installedVersion?.full === DEFAULT_ESP_IDF_VERSION.slice(1)
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
