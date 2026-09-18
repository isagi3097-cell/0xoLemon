import { useEffect, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './gameMeta'

export type SteamNewsItem = {
  gid: string
  title: string
  url: string
  author: string
  excerpt: string
  /** Full BBCode/HTML content from Steam News API */
  contents: string
  /** ISO 8601 date string e.g. "2025-03-14" */
  date: string
  feed_type: number
  thumbnail: string | null
  tags: string[]
}

export type SteamAppMeta = {
  appid: number
  name: string | null
  install_dir: string | null
  os_list: string[]
  tags: string[]
  developers: string[]
  publishers: string[]
  website: string | null
  branches: SteamBranchInfo[]
  dlc: number[]
  release_date: string | null
}

export type SteamBranchInfo = {
  name: string
  build_id: string
  time_updated: number | null
  password_required: boolean
}

export type SteamGlobalAchievement = {
  name: string
  percent: number
  display_name?: string
  description?: string
  icon?: string
  icon_gray?: string
  hidden?: boolean
}

// ── Caches ─────────────────────────────────────────────────────────────────

const NEWS_TTL_MS = 5 * 60_000
const META_TTL_MS = 10 * 60_000

type CacheEntry<T> = { data: T; expiresAt: number }
const newsCache = new Map<string, CacheEntry<SteamNewsItem[]>>()
const metaCache = new Map<string, CacheEntry<SteamAppMeta>>()
const storeDetailCache = new Map<string, CacheEntry<SteamStoreDetail>>()
const achievementsCache = new Map<string, CacheEntry<SteamGlobalAchievement[]>>()
const STORE_TTL_MS = 15 * 60_000
const ACHIEVEMENTS_TTL_MS = 15 * 60_000

export function setStoreDetailCache(appid: string | number, data: SteamStoreDetail) {
  const id = String(appid).trim()
  if (id) storeDetailCache.set(id, { data, expiresAt: Date.now() + STORE_TTL_MS })
}

export function setNewsCache(appid: string | number, data: SteamNewsItem[]) {
  const id = String(appid).trim()
  if (id) newsCache.set(id, { data, expiresAt: Date.now() + NEWS_TTL_MS })
}

export function setAchievementsCache(appid: string | number, data: SteamGlobalAchievement[]) {
  const id = String(appid).trim()
  if (id) achievementsCache.set(id, { data, expiresAt: Date.now() + ACHIEVEMENTS_TTL_MS })
}

// ── useSteamNews ────────────────────────────────────────────────────────────

export type SteamNewsState = {
  items: SteamNewsItem[]
  loading: boolean
  error: string | null
  reload: () => void
}

export function useSteamNews(appid: string | number | undefined): SteamNewsState {
  const [items, setItems] = useState<SteamNewsItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const id = String(appid ?? '').trim()
    if (!id || !/^\d+$/.test(id)) {
      setItems([])
      setError(null)   // không hiện lỗi khi chưa có appid — chỉ lỗi khi fetch thất bại
      return
    }

    // Return cached data immediately if valid
    const cached = newsCache.get(id)
    if (cached && cached.expiresAt > Date.now()) {
      setItems(cached.data)
      setLoading(false)
      setError(null)
      return
    }

    let active = true
    setLoading(true)
    setError(null)

    const load = async () => {
      try {
        let result: SteamNewsItem[]

        if (isTauriRuntime()) {
          result = await invoke<SteamNewsItem[]>('get_steam_news', { appid: id, count: 8 })
        } else {
          // Dev browser fallback — use Steam News API directly (may hit CORS in browser)
          const res = await fetch(
            `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${id}&count=8&maxlength=600&format=json`,
          )
          const json = await res.json()
          const raw: Array<{ gid: string; title: string; url: string; author: string; contents: string; date: number; feedtype?: number; tags?: Array<{ tag: string }> }> =
            json?.appnews?.newsitems ?? []
          result = raw.map((item) => ({
            gid: item.gid,
            title: item.title,
            url: item.url,
            author: item.author,
            excerpt: item.contents.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280),
            contents: item.contents,
            date: new Date(item.date * 1000).toISOString().slice(0, 10),
            feed_type: item.feedtype ?? 0,
            thumbnail: null,
            tags: (item.tags ?? []).map((t) => t.tag),
          }))
        }

        newsCache.set(id, { data: result, expiresAt: Date.now() + NEWS_TTL_MS })
        if (active) { setItems(result); setError(null) }
      } catch (err) {
        const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Failed to load news'
        if (active) setError(msg)
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => { active = false }
  }, [appid, revision])

  return { items, loading, error, reload: () => setRevision((r) => r + 1) }
}

// ── useSteamAppMeta ─────────────────────────────────────────────────────────

export type SteamAppMetaState = {
  meta: SteamAppMeta | null
  loading: boolean
  error: string | null
}

export function useSteamAppMeta(appid: string | number | undefined): SteamAppMetaState {
  const [meta, setMeta] = useState<SteamAppMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const id = String(appid ?? '').trim()
    if (!id || !/^\d+$/.test(id)) { setMeta(null); return }

    const cached = metaCache.get(id)
    if (cached && cached.expiresAt > Date.now()) {
      setMeta(cached.data)
      setLoading(false)
      return
    }

    let active = true
    setLoading(true)
    setError(null)

    const load = async () => {
      try {
        let result: SteamAppMeta
        if (isTauriRuntime()) {
          result = await invoke<SteamAppMeta>('get_steam_app_metadata', { appid: id })
        } else {
          // Browser dev fallback: read from GitHub CDN directly
          const shard = (parseInt(id, 10) % 1000).toString().padStart(3, '0')
          const res = await fetch(
            `https://raw.githubusercontent.com/isagi3097-cell/steam-metadata/main/data/${shard}/${id}.json`,
          )
          if (!res.ok) throw new Error(`Metadata not found (HTTP ${res.status})`)
          const json = await res.json()
          result = {
            appid: parseInt(id, 10),
            name: json.name ?? null,
            install_dir: json.installdir ?? null,
            os_list: (json.oslist ?? '').split(',').filter(Boolean),
            tags: (json.tags ?? []).map((t: { name?: string }) => t.name).filter(Boolean),
            developers: json.developers ?? [],
            publishers: json.publishers ?? [],
            website: json.website ?? null,
            branches: [],
            dlc: json.dlc ?? [],
            release_date: json.release_date ?? null,
          }
        }
        metaCache.set(id, { data: result, expiresAt: Date.now() + META_TTL_MS })
        if (active) { setMeta(result); setError(null) }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load metadata')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => { active = false }
  }, [appid])

  return { meta, loading, error }
}

// ── useSteamStoreDetail ──────────────────────────────────────────────────────
// Uses Steam Store appdetails API (via Rust backend) for DLC, devs, genres, etc.
// This is much more reliable than parsing the nested steam-metadata JSON.

export type SteamDlcItem = {
  appid: number
  name: string
  header_image: string | null
}

export type SteamScreenshotItem = {
  id: number
  path_thumbnail: string
  path_full: string
}

export type SteamMovieItem = {
  id: number
  name: string
  thumbnail: string
  mp4_480: string | null
  mp4_max: string | null
  webm_max: string | null
  hls_h264?: string | null
}

export type SteamRequirements = {
  minimum: string | null
  recommended: string | null
}

export type SystemSpecs = {
  os: string
  cpu: string
  ram_gb: number
  gpu: string
  directx: string
}

export type SteamStoreDetail = {
  appid: number
  name: string
  short_description: string | null
  detailed_description?: string | null
  about_the_game?: string | null
  dlc: number[]
  dlc_details: SteamDlcItem[]
  developers: string[]
  publishers: string[]
  genres: string[]
  categories?: string[]
  drm_notice?: string | null
  ext_user_account_notice?: string | null
  supported_languages?: string | null
  release_date: string | null
  website: string | null
  header_image: string | null
  /** 2x hero banner from steam-metadata library_assets_full */
  hero_image: string | null
  /** 2x logo from steam-metadata library_assets_full */
  logo_image: string | null
  /** 2x capsule (600x900) from steam-metadata library_assets_full */
  capsule_image: string | null
  /** Icon .ico URL from steam-metadata clienticon */
  icon_image: string | null
  screenshots?: SteamScreenshotItem[]
  movies?: SteamMovieItem[]
  pc_requirements?: SteamRequirements | null
  review_score?: number | null
  review_score_desc?: string | null
  review_percentage?: number | null
  metacritic_score?: number | null
  metacritic_url?: string | null
  total_reviews?: number | null
}

export type SteamStoreDetailState = {
  detail: SteamStoreDetail | null
  loading: boolean
  error: string | null
}

export function useSteamStoreDetail(appid: string | number | undefined): SteamStoreDetailState {
  const [detail, setDetail] = useState<SteamStoreDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const id = String(appid ?? '').trim()
    if (!id || !/^\d+$/.test(id)) {
      setDetail(null)
      setError(null)
      return
    }

    const cached = storeDetailCache.get(id)
    if (cached && cached.expiresAt > Date.now()) {
      setDetail(cached.data)
      setLoading(false)
      return
    }

    let active = true
    setLoading(true)
    setError(null)

    const load = async () => {
      try {
        let result: SteamStoreDetail

        if (isTauriRuntime()) {
          result = await invoke<SteamStoreDetail>('get_steam_store_detail', { appid: id })
        } else {
          // Browser dev fallback — call Steam Store API directly (CORS may block)
          const res = await fetch(
            `https://store.steampowered.com/api/appdetails?appids=${id}&cc=vn&l=english`,
          )
          const json = await res.json()
          const entry = json?.[id]
          if (!entry?.success) throw new Error('Steam Store API: success=false')
          const d = entry.data
          result = {
            appid: parseInt(id, 10),
            name: d.name ?? '',
            short_description: d.short_description ?? null,
            dlc: (d.dlc ?? []) as number[],
            dlc_details: [],
            developers: d.developers ?? [],
            publishers: d.publishers ?? [],
            genres: (d.genres ?? []).map((g: { description: string }) => g.description),
            release_date: d.release_date?.date ?? null,
            website: d.website ?? null,
            header_image: d.header_image ?? null,
            hero_image: null,
            logo_image: null,
            capsule_image: null,
            icon_image: null,
          }
        }

        storeDetailCache.set(id, { data: result, expiresAt: Date.now() + STORE_TTL_MS })
        if (active) { setDetail(result); setError(null) }
      } catch (err) {
        const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Failed to load store detail'
        if (active) setError(msg)
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => { active = false }
  }, [appid])

  return { detail, loading, error }
}

// ── useSystemSpecs ──────────────────────────────────────────────────────────
export function useSystemSpecs() {
  const [specs, setSpecs] = useState<SystemSpecs | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const check = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (isTauriRuntime()) {
        const res = await invoke<SystemSpecs>('get_system_specs')
        setSpecs(res)
      } else {
        // Dev fallback
        setSpecs({
          os: 'Windows 11 (64-bit)',
          cpu: '13th Gen Intel(R) Core(TM) i7-13700H',
          ram_gb: 32.0,
          gpu: 'NVIDIA GeForce RTX 4060 Laptop GPU',
          directx: 'DirectX 12',
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể quét cấu hình máy')
    } finally {
      setLoading(false)
    }
  }, [])

  return { specs, loading, error, check }
}

// ── useSteamGlobalAchievements ──────────────────────────────────────────────
export function useSteamGlobalAchievements(appid: string | number | undefined) {
  const [achievements, setAchievements] = useState<SteamGlobalAchievement[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const id = String(appid ?? '').trim()
    if (!id || !/^\d+$/.test(id)) {
      setAchievements([])
      return
    }

    const cached = achievementsCache.get(id)
    if (cached && cached.expiresAt > Date.now()) {
      setAchievements(cached.data)
      setLoading(false)
      setError(null)
      return
    }

    let active = true
    setLoading(true)
    setError(null)

    const load = async () => {
      try {
        let list: SteamGlobalAchievement[] = []
        if (isTauriRuntime()) {
          list = await invoke<SteamGlobalAchievement[]>('get_steam_global_achievements', { appid: id })
        } else {
          const res = await fetch(
            `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${id}&format=json`
          )
          const json = await res.json()
          list = (json?.achievementpercentages?.achievements ?? []).map((a: { name: string; percent: string | number }) => ({
            name: a.name,
            percent: typeof a.percent === 'string' ? parseFloat(a.percent) : a.percent,
          }))
        }
        achievementsCache.set(id, { data: list, expiresAt: Date.now() + ACHIEVEMENTS_TTL_MS })
        if (active) {
          setAchievements(list)
          setError(null)
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Không thể tải danh sách thành tựu')
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [appid])

  return { achievements, loading, error }
}
