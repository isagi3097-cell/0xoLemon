import { useEffect, useState, useCallback } from 'react'
import {
  VIETNAMESE_TRANSLATIONS_DATA,
  type VietnameseTranslationItem,
  type TranslationSourceKey,
} from '../data/vietnameseTranslations'

const REVOLT_API_URL = 'https://cloud.revoltg.app/viethoa/games.json'
const FALLBACK_URLS = [
  '/translations.json',
  'https://huggingface.co/datasets/JOINCANE/0XoLemon/raw/main/translations.json',
]

const CACHE_KEY = '0xo_cached_translations_v6'

function translationMergeKey(item: VietnameseTranslationItem): string {
  const source = item.source || 'others'
  const url = String(item.downloadUrl || '').trim().toLowerCase()
  return `${source}::${item.id}::${url}`
}

export function mapRawGameToTranslation(g: {
  id?: string | number
  team?: string
  name?: string
  image?: string
  note?: string
  launch_options?: string
  url?: string
}): VietnameseTranslationItem {
  const gid = String(g.id || '').trim()
  const team = String(g.team || '').trim()
  const name = String(g.name || '').trim()
  const teamUpper = team.toUpperCase()

  let source: TranslationSourceKey = 'others'
  let displayAuthor = team || '0xoLemon'

  if (teamUpper === 'TRT') {
    source = 'theredteam'
    displayAuthor = 'The Red Team'
  } else if (teamUpper === 'CCT') {
    source = 'canhcutteam'
    displayAuthor = 'Cánh Cụt Team'
  } else if (teamUpper === 'GTHV' || teamUpper === 'GTV') {
    source = 'gamethuanviet'
    displayAuthor = 'Game Thuần Việt'
  } else {
    source = 'others'
    if (teamUpper === 'REVOLT' || teamUpper === 'REVOLTPRO') {
      displayAuthor = '0xoLemon'
    } else if (teamUpper === 'PUBLIC') {
      displayAuthor = 'Cộng đồng'
    }
  }

  const downloadUrl = g.url || `https://vh.revolt.vn/${team}/${gid}/pack.zip`
  const imageUrl = g.image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${gid}/header.jpg`
  const tagTeam = (teamUpper === 'REVOLT' || teamUpper === 'REVOLTPRO') ? '0xoLemon' : (team || '0xoLemon')
  const tags = [tagTeam, 'Việt Hóa']
  if (g.launch_options) {
    tags.push('Launch Param')
  }

  const guide = g.launch_options
    ? `Tham số khởi chạy khuyến nghị: ${g.launch_options}`
    : 'Cài đặt tự động hoặc giải nén thư mục bản dịch vào thư mục game.'

  return {
    id: gid,
    gameId: gid,
    gameTitle: name,
    translationTitle: `Bản dịch Tiếng Việt - ${name}`,
    fileName: `${gid}_pack.zip`,
    author: displayAuthor,
    version: '1.0',
    size: 'Pack',
    downloadUrl,
    coverUrl: imageUrl,
    bannerUrl: imageUrl,
    description: g.note || `Bản dịch Tiếng Việt cho ${name} cung cấp bởi ${displayAuthor}.`,
    installGuide: guide,
    tags,
    repo: '0xoLemon',
    source,
    originalTeam: team,
    launchOptions: g.launch_options || '',
  }
}

export function mergeTranslationLists(
  baseList: VietnameseTranslationItem[],
  customList: VietnameseTranslationItem[] = []
): VietnameseTranslationItem[] {
  const map = new Map<string, VietnameseTranslationItem>()

  // 1. Base games (from primary Revolt catalog or local fallback)
  for (const item of baseList) {
    if (item && item.id) {
      map.set(translationMergeKey(item), item)
    }
  }

  // 2. Custom games extend the authoritative live catalog, but never replace
  // a live entry with a different source or download URL.
  for (const custom of customList) {
    if (!custom || !custom.id) continue
    const key = translationMergeKey(custom)
    if (map.has(key)) {
      const existing = map.get(key)!
      map.set(key, {
        ...existing,
        ...custom,
        tags: Array.from(new Set([...(existing.tags || []), ...(custom.tags || [])])),
      })
    } else {
      map.set(key, custom)
    }
  }

  return Array.from(map.values())
}

function readCachedTranslations(): VietnameseTranslationItem[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
      }
    }
  } catch {}
  return VIETNAMESE_TRANSLATIONS_DATA
}

export function useRealtimeTranslations() {
  const [translations, setTranslations] = useState<VietnameseTranslationItem[]>(readCachedTranslations)
  const [isSyncing, setIsSyncing] = useState(true)
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null)

  const syncTranslations = useCallback(async () => {
    setIsSyncing(true)

    let baseGames: VietnameseTranslationItem[] = []

    // 1. Try Primary Online Source: vh.revolt.vn/games.json
    try {
      const url = `${REVOLT_API_URL}?t=${Date.now()}`
      const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } })
      if (res.ok) {
        const text = await res.text()
        const cleaned = text.replace(/^\uFEFF/, '').trim()
        const data = JSON.parse(cleaned)
        if (data && Array.isArray(data.games) && data.games.length > 0) {
          baseGames = data.games.map(mapRawGameToTranslation)
        }
      }
    } catch (err) {
      console.warn('Could not sync translations from primary API:', err)
    }

    // 2. Fallback to bundled local /translations.json if primary API was unreachable
    if (baseGames.length === 0) {
      for (const fallbackUrl of FALLBACK_URLS) {
        try {
          const res = await fetch(fallbackUrl, { headers: { 'Cache-Control': 'no-cache' } })
          if (res.ok) {
            const text = await res.text()
            const cleaned = text.replace(/^\uFEFF/, '').trim()
            const data = JSON.parse(cleaned)
            if (Array.isArray(data) && data.length > 0) {
              baseGames = data
              break
            }
          }
        } catch {}
      }
    }

    // 3. Fetch Custom / Exclusive 0xoLemon translations (from HuggingFace mirror)
    let customGames: VietnameseTranslationItem[] = []
    try {
      const customUrl = 'https://huggingface.co/datasets/JOINCANE/0XoLemon/raw/main/translations.json'
      const res = await fetch(`${customUrl}?t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } })
      if (res.ok) {
        const text = await res.text()
        const cleaned = text.replace(/^\uFEFF/, '').trim()
        const data = JSON.parse(cleaned)
        if (Array.isArray(data) && data.length > 0) {
          customGames = data
        }
      }
    } catch {}

    // 4. Hybrid Merge: Base catalog + Custom 0xoLemon + In-code static data
    const merged = mergeTranslationLists(baseGames, [...VIETNAMESE_TRANSLATIONS_DATA, ...customGames])

    if (merged.length > 0) {
      setTranslations(merged)
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(merged))
      } catch {}
      setLastSyncTime(Date.now())
    }

    setIsSyncing(false)
  }, [])

  useEffect(() => {
    void syncTranslations()

    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible') void syncTranslations()
    }
    const interval = window.setInterval(() => void syncTranslations(), 15 * 60 * 1000)
    document.addEventListener('visibilitychange', refreshOnReturn)
    window.addEventListener('focus', refreshOnReturn)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshOnReturn)
      window.removeEventListener('focus', refreshOnReturn)
    }
  }, [syncTranslations])

  return {
    translations,
    isSyncing,
    lastSyncTime,
    refresh: syncTranslations,
  }
}
