/**
 * useSteamAppIds — Maps launcher game IDs to Steam App IDs.
 *
 * Source of truth: game-id-mapping.json in the steam-metadata GitHub repo.
 * CDN URL (no auth, no rate limit):
 *   https://raw.githubusercontent.com/isagi3097-cell/steam-metadata/main/game-id-mapping.json
 *
 * The file is a flat JSON object: { [gameId: string]: number }
 * Admin updates it by uploading a new version to the repo root — no code change needed.
 */

import { useState, useEffect } from 'react'

const MAPPING_URL =
  'https://raw.githubusercontent.com/isagi3097-cell/steam-metadata/main/game-id-mapping.json'

// ── Module-level singleton ──────────────────────────────────────────────────

let cachedMapping: Record<string, number> = {}
let fetchPromise: Promise<Record<string, number>> | null = null
const listeners: Array<(m: Record<string, number>) => void> = []

async function loadMapping(): Promise<Record<string, number>> {
  if (fetchPromise) return fetchPromise

  fetchPromise = (async () => {
    try {
      // Bust CDN cache every 10 min
      const url = `${MAPPING_URL}?_t=${Math.floor(Date.now() / 600_000)}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: Record<string, number> = await res.json()
      cachedMapping = data
      listeners.forEach((fn) => fn(data))
      return data
    } catch (e) {
      console.warn('[useSteamAppIds] Failed to load mapping from CDN:', e)
      return cachedMapping
    } finally {
      fetchPromise = null
    }
  })()

  return fetchPromise
}

// ── React hook ──────────────────────────────────────────────────────────────

export function useSteamAppIds() {
  const [mapping, setMapping] = useState<Record<string, number>>(cachedMapping)

  useEffect(() => {
    let mounted = true

    void loadMapping().then((m) => {
      if (mounted) setMapping(m)
    })

    const listener = (m: Record<string, number>) => {
      if (mounted) setMapping(m)
    }
    listeners.push(listener)

    return () => {
      mounted = false
      const idx = listeners.indexOf(listener)
      if (idx !== -1) listeners.splice(idx, 1)
    }
  }, [])

  return { mapping }
}

// ── Non-hook helper (usable outside React) ──────────────────────────────────

export function getAppIdForGame(gameId: string): number | undefined {
  if (/^\d+$/.test(gameId)) return Number(gameId)
  return cachedMapping[gameId]
}

// Start loading immediately on module import so data is ready by mount time
void loadMapping()
