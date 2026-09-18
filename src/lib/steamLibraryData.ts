/**
 * Hook to get per-game play stats (playtime, last played, achievements).
 *
 * Data sources (in priority order):
 *  1. Local launcher runtime tracking via `get_game_runtime_states` (always available)
 *  2. Global achievement % from Steam API via `get_steam_global_achievements` (no key needed)
 *
 * The old Render backend (zeroxolemon-launcher.onrender.com) is no longer used.
 */

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { GameRuntimeState } from '../types'
import { isTauriRuntime } from './gameMeta'

export type SteamLibraryAchievement = {
  id: string
  name: string
  description: string
  iconUrl: string
  unlocked: boolean
  unlockTime: number | null
}

export type SteamLibraryData = {
  playtimeMinutes: number | null
  lastPlayedAt: string | null
  achievements: SteamLibraryAchievement[]
  unlockedAchievements: number
  source: 'steam' | 'launcher'
}

export type SteamLibraryDataState = {
  data: SteamLibraryData | null
  loading: boolean
  error: string | null
  reload: () => void
}

function launcherFallback(runtime: GameRuntimeState | null): SteamLibraryData | null {
  if (!runtime) return null
  return {
    playtimeMinutes: Math.max(0, Math.round(runtime.totalPlaytimeSeconds / 60)),
    lastPlayedAt: runtime.lastPlayedAt,
    achievements: [],
    unlockedAchievements: 0,
    source: 'launcher',
  }
}

function validAppId(value: string | number | undefined): string | null {
  const appId = String(value ?? '').trim()
  return /^\d{1,10}$/.test(appId) ? appId : null
}

export function useSteamLibraryData(
  gameId: string,
  appid: string | number | undefined,
): SteamLibraryDataState {
  const [data, setData] = useState<SteamLibraryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const appId = validAppId(appid)
    let active = true

    const load = async () => {
      setLoading(true)
      setError(null)

      // 1. Always try to load local launcher runtime data first
      let local: SteamLibraryData | null = null
      if (isTauriRuntime()) {
        try {
          const states = await invoke<GameRuntimeState[]>('get_game_runtime_states')
          local = launcherFallback(states.find((s) => s.gameId === gameId) ?? null)
          if (active && local) setData(local)
        } catch {
          // Local runtime unavailable — continue
        }
      }

      if (!appId) {
        if (active) {
          setData(local)
          setError(local ? null : 'Steam App ID is not available for this game.')
          setLoading(false)
        }
        return
      }

      // 2. No user-specific Steam API call needed here (no SteamID).
      //    Just resolve with launcher data — news + achievements are
      //    loaded separately by useSteamNews / get_steam_global_achievements.
      if (active) {
        setData(local)
        setError(null)
        setLoading(false)
      }
    }

    void load()
    return () => { active = false }
  }, [appid, gameId, revision])

  return { data, loading, error, reload: () => setRevision((v) => v + 1) }
}
