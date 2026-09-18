/**
 * Depot OS tag helpers.
 *
 * Steam's `config.oslist` is a free-form, comma separated, lowercase string
 * taken verbatim from the appinfo payload (e.g. `windows`, `macos`,
 * `linux`, `windows,macos`). The launcher previously rendered that raw value
 * in the depot list, so macOS/Linux depots showed up untranslated and were
 * impossible to scan visually.
 *
 * These helpers normalise the raw value into stable labels plus a platform
 * kind so the UI can colour each tag consistently wherever depots are listed.
 */

export type DepotOsKind = 'windows' | 'macos' | 'linux' | 'other'

export interface DepotOsTag {
  /** Normalised platform identifier used for styling. */
  kind: DepotOsKind
  /** Capitalised, platform-correct display label (e.g. `macOS`, `Linux`). */
  label: string
  /** Original token from Steam, preserved for tooltips/debugging. */
  raw: string
}

const LABELS: Record<DepotOsKind, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  other: '',
}

function classify(token: string): DepotOsKind {
  const value = token.trim().toLowerCase()
  if (!value) return 'other'
  // Steam uses both `macos` and the legacy `osx` spelling.
  if (value === 'macos' || value === 'osx' || value === 'mac' || value === 'darwin') return 'macos'
  if (value === 'linux' || value === 'steamlinux' || value === 'ubuntu') return 'linux'
  if (value === 'windows' || value === 'win' || value === 'win32') return 'windows'
  return 'other'
}

/**
 * Parse Steam's comma separated oslist into ordered, de-duplicated tags.
 * Unknown tokens are kept with `kind: 'other'` so nothing is silently hidden.
 */
export function parseDepotOsList(os?: string | null): DepotOsTag[] {
  if (!os) return []
  const seen = new Set<string>()
  const tags: DepotOsTag[] = []
  for (const token of os.split(',')) {
    const trimmed = token.trim()
    if (!trimmed) continue
    const kind = classify(trimmed)
    const key = kind === 'other' ? trimmed.toLowerCase() : kind
    if (seen.has(key)) continue
    seen.add(key)
    tags.push({ kind, label: LABELS[kind] || trimmed, raw: trimmed })
  }
  return tags
}

/** True when the depot targets a platform other than Windows. */
export function isNonWindowsDepot(os?: string | null): boolean {
  const tags = parseDepotOsList(os)
  if (tags.length === 0) return false
  return tags.every((tag) => tag.kind !== 'windows')
}

/**
 * Whether a depot matches a platform filter value.
 * A depot with no oslist is treated as cross-platform (matches every filter),
 * matching the previous `if (d.os && ...)` behaviour.
 */
export function depotMatchesOsFilter(
  os: string | null | undefined,
  filter: 'all' | 'windows' | 'linux' | 'macos',
): boolean {
  if (filter === 'all') return true
  const tags = parseDepotOsList(os)
  if (tags.length === 0) return true
  return tags.some((tag) => tag.kind === filter)
}
