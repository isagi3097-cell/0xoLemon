import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Download,
  FolderOpen,
  HardDrive,
  Languages,
  Layers,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  X,
  ExternalLink,
  MessageCircle,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { listen } from '@tauri-apps/api/event'
import { DownloadWaveCard } from './DownloadWaveCard'
import './BypassFixView.css'
import type { GameCatalog, GameInstallState, GameSummary, GameToolsCatalogItem } from '../types'
import { useLocale } from '../context/locale'
import type { VietnameseTranslationItem, TranslationSourceKey } from '../data/vietnameseTranslations'

import othersIcon from '../assets/translations/others.png'
import othersBg from '../assets/translations/black-myth-wukong_e8hc.1920.webp'

/** LuaTools Discord community. Users join here, then sign in with Discord to unlock fixes. */
const LUA_TOOLS_DISCORD_URL = 'https://discord.gg/luatools'

/** EmpireTools (DenuvoEmpire) Discord. Empress fixes come from generator.ryuu.lol, which
 *  requires a Discord sign-in — the same shape of flow as LuaTools, different account. */
const EMPRESS_DISCORD_URL = 'https://discord.gg/denuvoempire'

/** Mirrors the Rust `LuaToolsAuthStatus`. This is the lua.tools account (Supabase Discord
 *  OAuth on db.lua.tools) — NOT the launcher's own 0xoLemon Discord gate. */
interface LuaToolsAuthStatus {
  signedIn: boolean
  account?: string | null
}

/** Mirrors the Rust `EmpressAuthStatus`. The generator.ryuu.lol account, signed in with
 *  Discord — independent from both the 0xoLemon gate and the LuaTools account. */
interface EmpressAuthStatus {
  signedIn: boolean
  account?: string | null
}

type SortOption = 'az' | 'za' | 'popular' | 'downloaded' | 'newest'
type FilterOption = 'all' | 'installed' | 'popular' | 'new'

interface BypassFixViewProps {
  catalog?: GameCatalog
  selectedGameId?: string | null
  installStates?: Record<string, GameInstallState>
  onSelectGame?: (gameId: string | null) => void
  onVerify?: () => void
}

const SOURCE_VISUALS: Array<{
  key: TranslationSourceKey
  icon: string
  bg: string
  color: string
  /** Optional override for the generic Bypass/Fix title. Unset = use the localized title. */
  label?: string
}> = [
  {
    // `key` is only the internal TranslationSourceKey slot the bypass index is bucketed into.
    // No `label` here: the landing card keeps the generic "Bypass / Fix" copy, and the
    // LuaTools-specific naming lives in the catalog tags (see the `bypassItems` map).
    key: 'others',
    icon: othersIcon,
    bg: othersBg,
    color: '#38bdf8',
  },
]

type TranslationGridColumns = 4 | 6 | 8

interface BypassAppInfo {
  appid: string
  build_count: number
  latest_buildid: string
  all_tags: string[]
  provider?: 'probbi' | 'lua_tools' | 'empress'
  name?: string | null
  header_image?: string | null
}

interface BypassTag {
  tag: string
  filename: string
  /** Direct download URL — only present for empress fixes */
  href?: string | null
}

interface BypassBuild {
  buildid: string
  tags: BypassTag[]
}

interface SteamAppMetadata {
  appid: number
  name: string | null
  install_dir: string | null
  os_list: string[]
  tags: string[]
  developers: string[]
  publishers: string[]
  website: string | null
  branches: Array<{ name: string; build_id: string; time_updated: number | null; password_required: boolean }>
  dlc: number[]
  release_date: string | null
  launch_executables: string[]
  launch_options: string[]
  header_image?: string | null
  hero_image?: string | null
  logo_image?: string | null
  capsule_image?: string | null
}

interface ResolvedBypassMeta {
  name?: string
  headerImage?: string
  heroImage?: string
  logoImage?: string
}

const bypassMetaCache = new Map<string, ResolvedBypassMeta>()

function resolveSteamAssetUrl(appid: string, val: unknown, fallbackFilename: string): string {
  if (!val) {
    return `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/${fallbackFilename}`
  }
  if (typeof val === 'string') {
    const trimmed = val.trim()
    if (!trimmed) return `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/${fallbackFilename}`
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
    return `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/${trimmed}`
  }
  if (typeof val === 'object' && val !== null) {
    const obj = (val as { image?: Record<string, unknown> }).image && typeof (val as { image?: unknown }).image === 'object'
      ? (val as { image: Record<string, unknown> }).image
      : (val as Record<string, unknown>)
    const preferredLangs = ['english', 'vietnamese', 'default', 'schinese', 'tchinese', 'japanese', 'koreana']
    for (const lang of preferredLangs) {
      const p = obj[lang]
      if (typeof p === 'string' && p.trim()) {
        const trimmed = p.trim()
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
        return `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/${trimmed}`
      }
    }
    for (const k of Object.keys(obj)) {
      const p = obj[k]
      if (typeof p === 'string' && p.trim()) {
        const trimmed = p.trim()
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
        return `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/${trimmed}`
      }
    }
  }
  return `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/${fallbackFilename}`
}

type BypassItem = VietnameseTranslationItem & {
  appid: string
  provider: 'probbi' | 'lua_tools' | 'empress'
  latestBuildId: string
  bypassTags: string[]
  buildCount: number
  knownBuildIds: string[]
  executables: string[]
  launchArguments: string[]
  category: string
  dependencies: string[]
  sourceTags: string[]
}

function formatTranslationCopy(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  )
}

function translationIdentity(item: VietnameseTranslationItem): string {
  return `${item.source || 'others'}:${item.id}:${item.downloadUrl}`
}

const BYPASS_FIX_SEARCH_HISTORY_KEY = '0xo_bypass_fix_search_history_v2'
const CATALOG_PAGE_SIZE = 24

function readSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(BYPASS_FIX_SEARCH_HISTORY_KEY)
    if (!raw) return ['Wukong', 'Resident Evil', 'Persona', '007', 'The Witcher']
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, 10) : []
  } catch {
    return ['Wukong', 'Resident Evil', 'Persona', '007', 'The Witcher']
  }
}

function saveSearchHistory(history: string[]) {
  try {
    localStorage.setItem(BYPASS_FIX_SEARCH_HISTORY_KEY, JSON.stringify(history.slice(0, 10)))
  } catch {}
}

export function BypassFixView({
  catalog,
  selectedGameId,
  installStates = {},
  onSelectGame: _onSelectGame,
  onVerify,
}: BypassFixViewProps) {
  const { t } = useLocale()
  const copy = t.translationsView
  const fixCopy = copy.bypassFix
  const [bypassIndex, setBypassIndex] = useState<BypassAppInfo[]>([])
  const [steamMetadata, setSteamMetadata] = useState<Record<string, SteamAppMetadata>>({})
  const [resolvedAppMeta, setResolvedAppMeta] = useState<Record<string, ResolvedBypassMeta>>(() => {
    const initial: Record<string, ResolvedBypassMeta> = {}
    bypassMetaCache.forEach((v, k) => { initial[k] = v })
    return initial
  })
  const steamMetadataFailed = useRef<Set<string>>(new Set())
  const [lightningMetadata, setLightningMetadata] = useState<Record<string, GameToolsCatalogItem>>({})

  const catalogMap = useMemo(() => {
    const map = new Map<string, GameSummary>()
    catalog?.games?.forEach((game) => map.set(game.id, game))
    return map
  }, [catalog?.games])
  const [isSyncing, setIsSyncing] = useState(false)
  const [activeSource, setActiveSource] = useState<TranslationSourceKey>('others')
  const [hoveredSource, setHoveredSource] = useState<TranslationSourceKey | null>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [selectedTranslation, setSelectedTranslation] = useState<BypassItem | null>(null)
  const [selectedBuilds, setSelectedBuilds] = useState<BypassBuild[]>([])
  const [selectedArchive, setSelectedArchive] = useState<{ buildid: string; tag: string; filename: string } | null>(null)
  const [versionDropdownOpen, setVersionDropdownOpen] = useState(false)
  const versionDropdownRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false)
  const [activeFilter, setActiveFilter] = useState<FilterOption>('all')
  const [activeTag, setActiveTag] = useState('all')
  const [catalogPage, setCatalogPage] = useState(0)
  const [sortBy, setSortBy] = useState<SortOption>('az')
  const [sortOpen, setSortOpen] = useState(false)
  const [viewLayout, setViewLayout] = useState<'grid' | 'list'>(() => {
    const stored = localStorage.getItem('bypassFixViewLayout')
    return stored === 'list' ? 'list' : 'grid'
  })
  const [gridCols, setGridCols] = useState<TranslationGridColumns>(() => {
    const stored = Number(localStorage.getItem('bypassFixGridCols'))
    return stored === 4 || stored === 8 ? stored : 6
  })
  const [searchHistory, setSearchHistory] = useState<string[]>(readSearchHistory)
  const [installedBypass, setInstalledBypass] = useState<Record<string, boolean>>({})
  const [externalInstalledGames, setExternalInstalledGames] = useState<Record<string, boolean>>({})
  const [installing, setInstalling] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  // LuaTools (lua.tools) sign-in — separate from the launcher's 0xoLemon Discord gate.
  const [luaToolsAuth, setLuaToolsAuth] = useState<LuaToolsAuthStatus>({ signedIn: false })
  const [luaToolsSigningIn, setLuaToolsSigningIn] = useState(false)
  // True only right after a LuaTools fix failed with LUATOOLS_AUTH_REQUIRED. Drives the
  // "sign in / join Discord" affordance, so it stays hidden until there is something to fix.
  const [authRequired, setAuthRequired] = useState(false)
  // Empress (generator.ryuu.lol) sign-in — separate account from both the 0xoLemon gate
  // and LuaTools, but the same UX: Discord sign-in, then downloads fly on their own.
  const [empressAuth, setEmpressAuth] = useState<EmpressAuthStatus>({ signedIn: false })
  const [empressSigningIn, setEmpressSigningIn] = useState(false)
  // True only right after an Empress fix failed with EMPRESS_AUTH_REQUIRED. Drives the
  // "sign in / join Discord" affordance, so it stays hidden until there is something to fix.
  const [empressAuthRequired, setEmpressAuthRequired] = useState(false)
  // Set to the direct download href when Empress install still fails after sign-in.
  // Shows a manual download affordance pointing to the ryuu.lol file.
  const [empressManualHref, setEmpressManualHref] = useState<string | null>(null)

  const refreshLuaToolsAuth = async () => {
    try {
      const status = await invoke<LuaToolsAuthStatus>('get_luatools_auth_status')
      setLuaToolsAuth(status)
      if (status.signedIn) setAuthRequired(false)
    } catch {
      setLuaToolsAuth({ signedIn: false })
    }
  }

  const handleLuaToolsSignIn = async () => {
    if (luaToolsSigningIn) return
    setLuaToolsSigningIn(true)
    setActionError(null)
    try {
      const account = await invoke<string | null>('sign_in_luatools')
      setLuaToolsAuth({ signedIn: true, account })
      setAuthRequired(false)
      setActionSuccess(copy.luaToolsSignedIn)
    } catch (error) {
      const code = String(error)
      if (code.includes('LUATOOLS_AUTH_TIMEOUT')) {
        setActionError(copy.luaToolsAuthTimeout)
      } else if (code.includes('LUATOOLS_AUTH_DENIED')) {
        setActionError(copy.luaToolsAuthDenied)
      } else if (code.includes('LUATOOLS_AUTH_PORT_BUSY')) {
        setActionError(copy.luaToolsAuthPortBusy)
      } else {
        setActionError(formatTranslationCopy(copy.luaToolsAuthError, { error: code }))
      }
    } finally {
      setLuaToolsSigningIn(false)
    }
  }

  const handleLuaToolsSignOut = async () => {
    try {
      await invoke('sign_out_luatools')
    } catch {
      // Signing out locally is best-effort; a stale session would just fail on the next download.
    }
    setLuaToolsAuth({ signedIn: false })
    setActionSuccess(copy.luaToolsSignedOut)
  }

  const handleLuaToolsDiscordJoin = async () => {
    try {
      await openUrl(LUA_TOOLS_DISCORD_URL)
    } catch {
      // Opening the browser is best-effort; the URL is also shown as plain text next to it.
    }
  }

  const refreshEmpressAuth = async () => {
    try {
      const status = await invoke<EmpressAuthStatus>('get_empress_auth_status')
      setEmpressAuth(status)
      if (status.signedIn) setEmpressAuthRequired(false)
    } catch {
      setEmpressAuth({ signedIn: false })
    }
  }

  const handleEmpressSignIn = async () => {
    if (empressSigningIn) return
    setEmpressSigningIn(true)
    setActionError(null)
    try {
      const account = await invoke<string | null>('sign_in_empress')
      setEmpressAuth({ signedIn: true, account })
      setEmpressAuthRequired(false)
      setActionSuccess(copy.empressSignedIn)
    } catch (error) {
      const code = String(error)
      if (code.includes('EMPRESS_AUTH_TIMEOUT')) {
        setActionError(copy.empressAuthTimeout)
      } else if (code.includes('EMPRESS_AUTH_DENIED')) {
        setActionError(copy.empressAuthDenied)
      } else if (code.includes('EMPRESS_AUTH_PORT_BUSY')) {
        setActionError(copy.empressAuthPortBusy)
      } else {
        setActionError(formatTranslationCopy(copy.empressAuthError, { error: code }))
      }
    } finally {
      setEmpressSigningIn(false)
    }
  }

  const handleEmpressSignOut = async () => {
    try {
      await invoke('sign_out_empress')
    } catch {
      // Signing out locally is best-effort; a stale session would just fail on the next download.
    }
    setEmpressAuth({ signedIn: false })
    setActionSuccess(copy.empressSignedOut)
  }

  const handleEmpressDiscordJoin = async () => {
    try {
      await openUrl(EMPRESS_DISCORD_URL)
    } catch {
      // Opening the browser is best-effort; the URL is also shown as plain text next to it.
    }
  }

  interface DetectedPath {
    path: string
    source: 'launcher' | 'steam' | 'custom'
  }

  interface TranslationProgressState {
    gameId: string
    stage: 'downloading' | 'backing_up' | 'extracting' | 'finished' | 'error'
    downloadedBytes: number
    totalBytes: number
    percent: number
    speedBps: number
    message: string
  }

  const [gamePaths, setGamePaths] = useState<Record<string, DetectedPath>>(() => {
    const initial: Record<string, DetectedPath> = {}
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith('0xo_game_path_')) {
          const gid = k.replace('0xo_game_path_', '')
          const val = localStorage.getItem(k)
          if (val) initial[gid] = { path: val, source: 'custom' }
        }
      }
    } catch {}
    return initial
  })

  const [activeProgress, setActiveProgress] = useState<Record<string, TranslationProgressState>>({})

  const refresh = async () => {
    setIsSyncing(true)
    try {
      const index = await invoke<BypassAppInfo[]>('get_bypass_index')
      setBypassIndex(index)
      const lightningCatalog = await invoke<{ items: GameToolsCatalogItem[] }>('get_lightning_catalog', { kind: 'bypass' }).catch(() => ({ items: [] }))
      setLightningMetadata(Object.fromEntries(lightningCatalog.items.map((item) => [String(item.appId), item])))
    } catch (error) {
      setActionError(`Không thể tải danh sách bypass/fix: ${String(error)}`)
    } finally {
      setIsSyncing(false)
    }
  }

  useEffect(() => {
    void refresh()
    void refreshLuaToolsAuth()
    void refreshEmpressAuth()
  }, [])

  useEffect(() => {
    if (!bypassIndex.length) return
    let active = true

    const fetchMeta = async () => {
      const needed = bypassIndex.filter((entry) => entry.appid && !bypassMetaCache.has(entry.appid))
      if (!needed.length) return

      const updates: Record<string, ResolvedBypassMeta> = {}
      await Promise.all(
        needed.map(async (entry) => {
          const id = entry.appid
          const numId = parseInt(id, 10)
          if (isNaN(numId)) return
          const shard = (numId % 1000).toString().padStart(3, '0')
          try {
            const res = await fetch(`https://raw.githubusercontent.com/isagi3097-cell/steam-metadata/main/data/${shard}/${id}.json`)
            if (!res.ok) return
            const json = await res.json()
            const common = json?.common || {}
            const name = common.name || json?.name || json?.extended?.gamename
            const headerImage = resolveSteamAssetUrl(id, common.library_assets_full?.header_image || common.header_image || json.header_image, 'header.jpg')
            const heroImage = resolveSteamAssetUrl(id, common.library_assets_full?.library_hero || common.library_hero, 'library_hero.jpg')
            const logoImage = resolveSteamAssetUrl(id, common.library_assets_full?.library_logo || common.library_logo, 'logo.png')
            const record: ResolvedBypassMeta = { name, headerImage, heroImage, logoImage }
            bypassMetaCache.set(id, record)
            updates[id] = record
          } catch {}
        })
      )

      if (active && Object.keys(updates).length > 0) {
        setResolvedAppMeta((prev) => ({ ...prev, ...updates }))
      }
    }

    void fetchMeta()
    return () => { active = false }
  }, [bypassIndex])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void listen<{
      game_id: string
      stage: 'downloading' | 'backing_up' | 'extracting' | 'finished' | 'error'
      downloaded_bytes: number
      total_bytes: number
      percent: number
      speed_bps: number
      message: string
    }>('bypass-progress', (event) => {
      const p = event.payload
      setActiveProgress((prev) => ({
        ...prev,
        [p.game_id]: {
          gameId: p.game_id,
          stage: p.stage,
          downloadedBytes: p.downloaded_bytes,
          totalBytes: p.total_bytes,
          percent: p.percent,
          speedBps: p.speed_bps,
          message: p.message,
        },
      }))
    }).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!selectedTranslation?.appid) {
      setSelectedBuilds([])
      setSelectedArchive(null)
      return
    }
    const appid = selectedTranslation.appid
    const provider = selectedTranslation.provider
    const latestBuildId = selectedTranslation.latestBuildId
    void invoke<BypassBuild[]>('get_bypass_builds', {
      appid,
      provider,
    })
      .then((builds) => {
        setSelectedBuilds(builds)
        const preferredBuild = builds.find((build) => build.buildid === latestBuildId) || builds[0]
        const preferredArchive = preferredBuild?.tags[0]
        setSelectedArchive(preferredBuild && preferredArchive ? { buildid: preferredBuild.buildid, tag: preferredArchive.tag, filename: preferredArchive.filename } : null)
      })
      .catch((error) => setActionError(`Không thể tải build bypass: ${String(error)}`))
  }, [selectedTranslation?.appid, selectedTranslation?.provider, selectedTranslation?.latestBuildId])

  useEffect(() => {
    if (selectedTranslation?.gameId) {
      const gid = selectedTranslation.gameId
      if (!gamePaths[gid]) {
        void invoke<{ path: string; source: string } | null>('detect_game_path', { gameId: gid })
          .then((res) => {
            if (res && res.path) {
              setGamePaths((prev) => ({
                ...prev,
                [gid]: { path: res.path, source: (res.source as 'launcher' | 'steam') || 'steam' },
              }))
            }
          })
          .catch(() => {})
      }
      if (!installStates[gid]?.installed && !externalInstalledGames[gid]) {
        void invoke<string | null>('check_game_installed', { gameId: gid, customPath: gamePaths[gid]?.path || null })
          .then((path) => {
            if (path) {
              setExternalInstalledGames((prev) => ({ ...prev, [gid]: true }))
            }
          })
          .catch(() => {})
      }
    }
  }, [selectedTranslation?.gameId, installStates])

  const searchInputRef = useRef<HTMLInputElement>(null)

  const sourcesConfig = useMemo(() => SOURCE_VISUALS.map((source) => ({
    ...source,
    title: source.label || fixCopy.title,
    subtitle: fixCopy.subtitle,
  })), [fixCopy.title, fixCopy.subtitle])

  const bypassItems = useMemo<BypassItem[]>(() => {
    return bypassIndex.flatMap((entry) => {
      const catalogGame = catalogMap.get(entry.appid)
      const lightning = lightningMetadata[entry.appid]
      const meta = resolvedAppMeta[entry.appid] || bypassMetaCache.get(entry.appid)
      const defaultHeader = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${entry.appid}/header.jpg`
      const gameTitle = entry.name || meta?.name || catalogGame?.title || lightning?.name || `AppID ${entry.appid}`
      const knownBuildIds = entry.latest_buildid ? [entry.latest_buildid] : []

      const coverUrl = entry.header_image || meta?.headerImage || lightning?.imageUrl || defaultHeader
      const bannerUrl = meta?.heroImage || lightning?.backgroundUrl || lightning?.imageUrl || coverUrl

      return [{
        id: `${entry.provider || 'probbi'}:${entry.appid}`,
        gameTitle,
        translationTitle: entry.provider === 'lua_tools' ? 'LuaTools Fix catalog'
          : entry.provider === 'empress' ? 'Empress Fix'
          : `Bypass / Fix · ${entry.latest_buildid || 'Latest'}`,
        fileName: entry.provider === 'lua_tools' ? `${entry.appid}.zip`
          : entry.provider === 'empress' ? `${entry.appid}_empress_fix.zip`
          : `${entry.latest_buildid || 'default'}/${entry.all_tags[0] || 'default'}.7z`,
        author: entry.provider === 'lua_tools' ? 'lua.tools'
          : entry.provider === 'empress' ? 'Empress / generator.ryuu.lol'
          : lightning?.sourceRepository || 'PROBBI / Community',
        version: entry.latest_buildid || '1.0',
        size: `${entry.build_count} Fix${entry.build_count === 1 ? '' : 'es'}`,
        downloadUrl: '',
        coverUrl,
        bannerUrl,
        description: lightning?.note || `${gameTitle} · Steam AppID ${entry.appid}`,
        installGuide: lightning?.instructions?.join(' ') || undefined,
        tags: entry.provider === 'lua_tools' ? ['LuaTools Fix']
          : entry.provider === 'empress' ? ['Empress Fix']
          : entry.all_tags,
        repo: entry.provider === 'lua_tools' ? 'lua.tools'
          : entry.provider === 'empress' ? 'generator.ryuu.lol'
          : 'PROBBI/PROBBINE',
        gameId: entry.appid,
        source: 'others' as const,
        downloads: entry.build_count,
        likes: 0,
        updatedAt: entry.latest_buildid,
        isRecommended: true,
        appid: entry.appid,
        latestBuildId: entry.latest_buildid,
        bypassTags: entry.provider === 'lua_tools' ? ['LuaTools Fix']
          : entry.provider === 'empress' ? ['Empress Fix']
          : entry.all_tags,
        buildCount: entry.build_count,
        knownBuildIds,
        executables: [],
        launchArguments: [],
        category: lightning?.category || '',
        dependencies: lightning?.dependencies || [],
        sourceTags: entry.provider === 'lua_tools' ? ['LuaTools Fix']
          : entry.provider === 'empress' ? ['Empress Fix']
          : entry.all_tags,
        provider: entry.provider === 'lua_tools' ? 'lua_tools'
          : entry.provider === 'empress' ? 'empress'
          : 'probbi',
      }]
    })
  }, [bypassIndex, catalogMap, lightningMetadata, resolvedAppMeta])

  // Count items per source
  const sourceCounts = useMemo(() => {
    const counts: Record<TranslationSourceKey, number> = {
      theredteam: 0,
      canhcutteam: 0,
      gamethuanviet: 0,
      others: 0,
    }
    bypassItems.forEach((item) => {
      const src = item.source || 'others'
      counts[src] = (counts[src] || 0) + 1
    })
    return counts
  }, [bypassItems])

  const catalogTags = useMemo(() => {
    const set = new Set<string>()
    bypassItems.forEach((item) => {
      item.sourceTags?.forEach((t) => { if (t) set.add(t) })
      item.bypassTags?.forEach((t) => { if (t) set.add(t) })
      item.tags?.forEach((t) => { if (t) set.add(t) })
    })
    set.add('online-fix')
    return Array.from(set).sort((a, b) => {
      if (a === 'online-fix') return -1
      if (b === 'online-fix') return 1
      return a.localeCompare(b)
    })
  }, [bypassItems])

  // Global Ctrl + K listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOverlayOpen(true)
      }
      if (e.key === 'Escape' && searchOverlayOpen) {
        setSearchOverlayOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [searchOverlayOpen])

  // Focus search input when overlay opens
  useEffect(() => {
    if (searchOverlayOpen) {
      document.body.classList.add('store-search-overlay-open')
      const timer = window.setTimeout(() => searchInputRef.current?.focus(), 40)
      return () => {
        window.clearTimeout(timer)
        document.body.classList.remove('store-search-overlay-open')
      }
    }
  }, [searchOverlayOpen])

  // If selectedGameId is passed from parent, pick the matching translation and open catalog view
  useEffect(() => {
    if (selectedGameId) {
      const match = bypassItems.find((item) => item.gameId === selectedGameId)
      if (match) {
        setSelectedTranslation(match)
        if (match.source) setActiveSource(match.source)
        setIsExpanded(true)
      }
    }
  }, [selectedGameId, bypassItems])

  const handleSetGridCols = (cols: TranslationGridColumns) => {
    setGridCols(cols)
    localStorage.setItem('bypassFixGridCols', String(cols))
  }

  const handleSetViewLayout = (layout: 'grid' | 'list') => {
    setViewLayout(layout)
    localStorage.setItem('bypassFixViewLayout', layout)
  }

  const handleSearchSubmit = (term: string) => {
    const clean = term.trim()
    if (clean && !searchHistory.includes(clean)) {
      const updated = [clean, ...searchHistory].slice(0, 10)
      setSearchHistory(updated)
      saveSearchHistory(updated)
    }
  }

  const handleClearHistory = () => {
    setSearchHistory([])
    saveSearchHistory([])
  }

  const activeBuild = useMemo(() => {
    if (!selectedBuilds.length) return null
    if (selectedArchive) {
      const match = selectedBuilds.find((b) => b.buildid === selectedArchive.buildid)
      if (match) return match
    }
    return selectedBuilds[0]
  }, [selectedBuilds, selectedArchive])

  const handleVersionChange = (buildid: string) => {
    const targetBuild = selectedBuilds.find((b) => b.buildid === buildid)
    if (!targetBuild || !targetBuild.tags.length) return
    const matchingTag = targetBuild.tags.find((t) => t.tag === selectedArchive?.tag) || targetBuild.tags[0]
    setSelectedArchive({
      buildid: targetBuild.buildid,
      tag: matchingTag.tag,
      filename: matchingTag.filename,
    })
  }

  const handleBrowseGameFolder = async (gid: string) => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: 'Chọn thư mục cài đặt game',
      })
      if (selected && typeof selected === 'string') {
        localStorage.setItem(`0xo_game_path_${gid}`, selected)
        setGamePaths((prev) => ({
          ...prev,
          [gid]: { path: selected, source: 'custom' },
        }))
        const item = bypassItems.find((t) => t.gameId === gid)
        if (item) {
          void invoke<boolean>('get_bypass_status', {
            gameId: gid,
            customPath: selected,
          }).then((installed) => {
            setInstalledBypass((prev) => ({ ...prev, [translationIdentity(item)]: installed }))
          }).catch(() => {})
        }
      }
    } catch (err) {
      console.error('Failed to open directory picker:', err)
    }
  }

  const handleInstallPatch = async (item: BypassItem) => {
    if (!item.gameId || !item.appid) return
    const gid = item.gameId
    const identity = translationIdentity(item)
    let targetPath = gamePaths[gid]?.path

    if (!targetPath) {
      try {
        const selected = await openDialog({
          directory: true,
          multiple: false,
          title: `Chọn thư mục cài đặt cho ${item.gameTitle}`,
        })
        if (!selected || typeof selected !== 'string') {
          return
        }
        targetPath = selected
        localStorage.setItem(`0xo_game_path_${gid}`, selected)
        setGamePaths((prev) => ({
          ...prev,
          [gid]: { path: selected, source: 'custom' },
        }))
      } catch (err) {
        setActionError(`Không thể mở hộp thoại chọn thư mục: ${String(err)}`)
        return
      }
    }

    try {
      setInstalling(identity)
      setActionError(null)
      setActionSuccess(null)
      setAuthRequired(false)
      setEmpressAuthRequired(false)
      setEmpressManualHref(null)
      const selectedBuild = selectedArchive && selectedBuilds.find((candidate) => candidate.buildid === selectedArchive.buildid)
      const build = selectedBuild || selectedBuilds.find((candidate) => candidate.buildid === item.latestBuildId) || selectedBuilds[0]
      const tag = selectedBuild ? selectedArchive?.tag : build?.tags[0]?.tag || item.bypassTags[0]
      if (!build || !tag) {
        throw new Error('Không có build/tag bypass khả dụng')
      }
      if (item.provider === 'lua_tools') {
        await invoke('install_lua_tools_fix', {
          gameId: item.gameId,
          appid: item.appid,
          fixId: build.buildid,
          customPath: targetPath,
        })
      } else if (item.provider === 'empress') {
        const selectedTag = selectedArchive
          ? build.tags.find((t) => t.tag === selectedArchive.tag) ?? build.tags[0]
          : build.tags[0]
        if (!selectedTag?.href) {
          throw new Error('Không tìm thấy URL tải Empress fix')
        }
        await invoke('install_empress_fix', {
          gameId: item.gameId,
          href: selectedTag.href,
          filename: selectedTag.filename,
          customPath: targetPath,
        })
      } else {
        await invoke('install_bypass_fix', {
          gameId: item.gameId,
          appid: item.appid,
          buildid: build.buildid,
          tag,
          filename: selectedArchive?.filename || null,
          customPath: targetPath,
        })
      }
      setInstalledBypass((prev) => ({ ...prev, [identity]: true }))
      setActionSuccess('Cài đặt bypass/fix thành công!')
    } catch (error) {
      const code = String(error)
      if (code.includes('LUATOOLS_AUTH_REQUIRED')) {
        // LuaTools fixes need the lua.tools account; guide the user instead of dumping a raw
        // backend error, and flag the modal to reveal the join/sign-in affordance.
        setLuaToolsAuth({ signedIn: false })
        setAuthRequired(true)
        setActionError(copy.luaToolsAuthRequired)
      } else if (code.includes('EMPRESS_AUTH_REQUIRED')) {
        // generator.ryuu.lol needs the Empire Discord account — same UX as LuaTools: flag the
        // modal to reveal the join/sign-in affordance. The manual link stays as a last resort
        // for the case where the session is refused even after a fresh sign-in.
        setEmpressAuth({ signedIn: false })
        setEmpressAuthRequired(true)
        const build = activeBuild || selectedBuilds[0]
        setEmpressManualHref(build?.tags[0]?.href ?? null)
        setActionError(copy.empressAuthRequired)
      } else {
        setActionError(formatTranslationCopy(copy.installError, { error: code }))
      }
    } finally {
      setInstalling(null)
      setActiveProgress((prev) => {
        const next = { ...prev }
        delete next[gid]
        return next
      })
    }
  }

  const handleUninstallPatch = async (item: BypassItem) => {
    if (!item.gameId) return
    const gid = item.gameId
    const identity = translationIdentity(item)
    const targetPath = gamePaths[gid]?.path || null
    try {
      setUninstalling(true)
      setActionError(null)
      setActionSuccess(null)
      await invoke('uninstall_bypass_fix', { gameId: item.gameId, customPath: targetPath })
      setInstalledBypass((prev) => ({ ...prev, [identity]: false }))
      setActionSuccess('Đã gỡ bypass/fix và khôi phục file gốc!')
      onVerify?.()
    } catch (error) {
      setActionError(formatTranslationCopy(copy.uninstallError, { error: String(error) }))
    } finally {
      setUninstalling(false)
    }
  }

  // Filtered & Sorted items for the current active source
  const processedItems = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = bypassItems.filter((item) => {
      const src = item.source || 'others'
      if (src !== activeSource) return false
      if (activeTag !== 'all') {
        const needleTag = activeTag.toLowerCase()
        const hasTag = (item.sourceTags || []).some((t) => t.toLowerCase() === needleTag)
          || (item.bypassTags || []).some((t) => t.toLowerCase() === needleTag)
          || (item.tags || []).some((t) => t.toLowerCase() === needleTag)
          || (needleTag === 'online-fix' && (
            item.fileName?.toLowerCase().includes('online-fix') ||
            item.translationTitle?.toLowerCase().includes('online-fix')
          ))
        if (!hasTag) return false
      }

      const isGameInstalled = Boolean(
        item.gameId &&
          (installStates[item.gameId]?.installed ||
            externalInstalledGames[item.gameId] ||
            installedBypass[translationIdentity(item)])
      )
      if (activeFilter === 'installed' && !isGameInstalled) return false
      if (activeFilter === 'popular' && !(item.isRecommended || (item.likes || 0) > 0 || (item.downloads || 0) > 1000)) return false
      if (activeFilter === 'new' && !item.tags.some((t) => t.toLowerCase().includes('new') || t.toLowerCase().includes('patch') || t.toLowerCase().includes('full'))) return false

      if (!needle) return true
      const fields = [
        item.gameTitle,
        item.translationTitle,
        item.fileName,
        item.author,
        item.version,
        item.description,
        ...item.tags,
      ].filter(Boolean)
      return fields.some((f) => String(f).toLowerCase().includes(needle))
    })

    list.sort((a, b) => {
      switch (sortBy) {
        case 'az':
          return a.gameTitle.localeCompare(b.gameTitle)
        case 'za':
          return b.gameTitle.localeCompare(a.gameTitle)
        case 'popular':
          return (b.likes || 0) - (a.likes || 0)
        case 'downloaded':
          return (b.downloads || 0) - (a.downloads || 0)
        case 'newest':
          return (b.updatedAt || '').localeCompare(a.updatedAt || '')
        default:
          return 0
      }
    })

    return list
  }, [activeFilter, activeSource, activeTag, bypassItems, externalInstalledGames, installStates, installedBypass, query, sortBy])

  const visibleItems = useMemo(
    () => processedItems.slice(catalogPage * CATALOG_PAGE_SIZE, (catalogPage + 1) * CATALOG_PAGE_SIZE),
    [catalogPage, processedItems],
  )
  const pageCount = Math.max(1, Math.ceil(processedItems.length / CATALOG_PAGE_SIZE))

  const visibleIdsKey = useMemo(() => visibleItems.map((item) => item.id).join(','), [visibleItems])

  useEffect(() => {
    let canceled = false
    const checkStatuses = async () => {
      if (visibleItems.length === 0) return
      const entries = await Promise.all(visibleItems.map(async (item) => {
        if (!item.gameId) return [translationIdentity(item), false] as const
        const customPath = gamePaths[item.gameId]?.path || null
        const installed = await invoke<boolean>('get_bypass_status', {
          gameId: item.gameId,
          customPath,
        }).catch(() => false)
        return [translationIdentity(item), installed] as const
      }))
      if (canceled) return
      setInstalledBypass((current) => {
        let changed = false
        for (const [k, v] of entries) {
          if (current[k] !== v) {
            changed = true
            break
          }
        }
        if (!changed) return current
        return { ...current, ...Object.fromEntries(entries) }
      })
    }
    void checkStatuses()
    return () => {
      canceled = true
    }
  }, [visibleIdsKey, gamePaths])

  // Lazy-load Steam metadata ONLY when a specific game is opened in the detail modal
  useEffect(() => {
    const appid = selectedTranslation?.appid
    if (!appid || selectedTranslation.provider === 'lua_tools') return
    if (steamMetadata[appid] || steamMetadataFailed.current.has(appid)) return

    let canceled = false
    invoke<SteamAppMetadata>('get_steam_app_metadata', { appid })
      .then((metadata) => {
        if (!canceled && metadata) {
          setSteamMetadata((current) => ({ ...current, [appid]: metadata }))
        }
      })
      .catch(() => {
        steamMetadataFailed.current.add(appid)
      })

    return () => {
      canceled = true
    }
  }, [selectedTranslation?.appid, selectedTranslation?.provider])

  useEffect(() => {
    setCatalogPage(0)
  }, [activeFilter, activeSource, activeTag, query, sortBy, processedItems.length])

  // Helper to render image
  const renderCover = (item: BypassItem, isLarge = false) => {
    const imageUrl = isLarge
      ? (item.bannerUrl || item.coverUrl)
      : item.coverUrl

    return (
      <div className="translation-cover-wrapper" style={{ position: 'relative', width: '100%', height: '100%' }}>
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={item.gameTitle}
            loading="lazy"
            decoding="async"
            className="translation-cover-img"
            onError={(e) => {
              const target = e.currentTarget
              const fastlyFallback = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${item.appid}/header.jpg`
              const capsuleFallback = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${item.appid}/capsule_231x87.jpg`
              if (target.src !== fastlyFallback && target.src !== capsuleFallback) {
                target.src = fastlyFallback
              } else if (target.src === fastlyFallback) {
                target.src = capsuleFallback
              } else {
                target.style.display = 'none'
                const ph = target.parentElement?.querySelector('.translation-cover-placeholder-fallback') as HTMLElement
                if (ph) ph.style.display = 'flex'
              }
            }}
          />
        ) : null}
        <div
          className="translation-cover-placeholder translation-cover-placeholder-fallback"
          style={{ display: imageUrl ? 'none' : 'flex' }}
        >
          <Languages size={isLarge ? 48 : 28} />
          <span>{item.gameTitle}</span>
        </div>
      </div>
    )
  }

  const selectedMeta = selectedTranslation?.appid ? steamMetadata[selectedTranslation.appid] : undefined
  const modalKnownBuildIds = useMemo(() => {
    if (!selectedTranslation) return []
    const steamBuildIds = (selectedMeta?.branches || []).map((b) => b.build_id).filter((b) => b && b !== '0')
    return Array.from(new Set([selectedTranslation.latestBuildId, ...steamBuildIds])).filter(Boolean)
  }, [selectedTranslation, selectedMeta])

  const modalExecutables = selectedMeta?.launch_executables?.length ? selectedMeta.launch_executables : selectedTranslation?.executables || []
  const modalLaunchArgs = selectedMeta?.launch_options?.length ? selectedMeta.launch_options : selectedTranslation?.launchArguments || []

  // Active or currently hovered source metadata for instant background switching
  const displaySourceKey = hoveredSource || activeSource
  const currentSourceMeta = sourcesConfig.find((s) => s.key === displaySourceKey) || sourcesConfig[0]
  const activeSourceMeta = sourcesConfig.find((s) => s.key === activeSource) || sourcesConfig[0]

  return (
    <section className={`translations-shell translation-catalog-view ${isExpanded ? 'is-expanded-mode' : 'is-landing-mode'}`}>
      <div className="translation-backdrop" aria-hidden="true">
        {sourcesConfig.map((source) => (
          <img
            key={source.key}
            src={source.bg}
            alt=""
            className={`translation-backdrop-image ${displaySourceKey === source.key ? 'is-visible' : ''}`}
          />
        ))}
      </div>
      {/* BACKGROUND VEIL FOR CONTRAST */}
      <div className={`translation-bg-veil ${isExpanded ? 'is-catalog-veil' : 'is-landing-veil'}`} />

      {/* TOP-LEFT LARGE LOGO WATERMARK (Matching Lightning UI) */}
      <div className="translation-watermark-hero">
        <div key={displaySourceKey} className="translation-watermark-content">
          <img src={currentSourceMeta.icon} alt="" className="translation-watermark-logo" />
          <div className="translation-watermark-text">
            <span className="translation-watermark-tag">{fixCopy.catalogTitle}</span>
            <h1 className="translation-watermark-title">{currentSourceMeta.title}</h1>
          </div>
        </div>
      </div>

      {/* =========================================================================
          MODE 1: LANDING VIEW (Centered Dock - Image 2)
         ========================================================================= */}
      {!isExpanded ? (
        <div className="translation-landing-container">
          <div className="translation-landing-center">
            {/* DOCK ICONS (Row of 4 Glassmorphic Squircle Cards) */}
            <div className="translation-lightning-dock" role="tablist">
              {sourcesConfig.map((source) => {
                const isActive = activeSource === source.key
                const isHovered = hoveredSource === source.key
                const count = isSyncing && bypassItems.length === 0 ? '...' : sourceCounts[source.key] || 0

                return (
                  <button
                    key={source.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-label={source.title}
                    className={`translation-lightning-card ${isActive ? 'is-active' : ''} ${isHovered ? 'is-hovered' : ''}`}
                    style={{ '--source-accent': source.color } as React.CSSProperties}
                    onMouseEnter={() => setHoveredSource(source.key)}
                    onMouseLeave={() => setHoveredSource(null)}
                    onFocus={() => setHoveredSource(source.key)}
                    onBlur={() => setHoveredSource(null)}
                    onClick={() => {
                      setActiveSource(source.key)
                      setIsExpanded(true)
                      setQuery('')
                    }}
                  >
                    <div className="lightning-card-glow" />
                    <div className="lightning-card-surface">
                      <div className="lightning-card-icon-box">
                        <img src={source.icon} alt="" aria-hidden="true" />
                      </div>
                      <div className="lightning-card-meta">
                        <strong>{source.title}</strong>
                        <small>{count} fixes</small>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
            <p className="translation-landing-hint">{fixCopy.landingHint}</p>
          </div>
        </div>
      ) : (
        /* =========================================================================
            MODE 2: EXPANDED CATALOG VIEW (Dock on Top + Game Grid - Image 3)
           ========================================================================= */
        <div className="translation-catalog-container">
          {/* HEADER ROW WITH COMPACT DOCK & CONTROLS */}
          <header className="translation-expanded-header">
            {/* BACK BUTTON TO RETURN TO CENTER DOCK */}
            <button
              type="button"
              className="translation-back-dock-btn"
              onClick={() => setIsExpanded(false)}
              title={fixCopy.backTitle}
            >
              <ArrowLeft size={16} />
              <span>{fixCopy.sourcesButton}</span>
            </button>

            {/* TOP-CENTER COMPACT DOCK ICONS */}
            <div className="translation-lightning-dock compact" role="tablist">
              {sourcesConfig.map((source) => {
                const isActive = activeSource === source.key
                const isHovered = hoveredSource === source.key

                return (
                  <button
                    key={source.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-label={source.title}
                    className={`translation-lightning-card compact ${isActive ? 'is-active' : ''} ${isHovered ? 'is-hovered' : ''}`}
                    style={{ '--source-accent': source.color } as React.CSSProperties}
                    onMouseEnter={() => setHoveredSource(source.key)}
                    onMouseLeave={() => setHoveredSource(null)}
                    onFocus={() => setHoveredSource(source.key)}
                    onBlur={() => setHoveredSource(null)}
                    onClick={() => {
                      setActiveSource(source.key)
                      setQuery('')
                    }}
                  >
                    <div className="lightning-card-glow" />
                    <div className="lightning-card-surface">
                      <div className="lightning-card-icon-box">
                        <img src={source.icon} alt="" aria-hidden="true" />
                      </div>
                      <span className="lightning-compact-title">{source.title}</span>
                    </div>
                  </button>
                )
              })}
            </div>

            {/* TOP-RIGHT CONTROLS: SEARCH & SYNC */}
            <div className="translation-header-controls">
              <label
                className="store-search"
                onClick={() => setSearchOverlayOpen(true)}
                style={{ cursor: 'pointer', maxWidth: '280px' }}
              >
                <Search size={15} />
                <input
                  readOnly
                  value={query}
                  placeholder={formatTranslationCopy(fixCopy.searchPlaceholder, { source: activeSourceMeta.title })}
                  style={{ cursor: 'pointer' }}
                />
                <kbd>Ctrl K</kbd>
              </label>

              <button
                type="button"
                className="translation-sync-btn"
                onClick={() => void refresh()}
                disabled={isSyncing}
                title={fixCopy.syncTitle}
              >
                <RotateCcw size={14} className={isSyncing ? 'is-spinning' : ''} />
                <span>{isSyncing ? copy.syncing : copy.sync}</span>
              </button>

              <button
                type="button"
                className="translation-sync-btn lua-tools-discord-btn"
                onClick={() => void openUrl(LUA_TOOLS_DISCORD_URL)}
                title={copy.luaToolsDiscordTitle}
              >
                <MessageCircle size={14} />
                <span>{copy.luaToolsDiscordJoin}</span>
                <ExternalLink size={13} />
              </button>

              {luaToolsAuth.signedIn ? (
                <button
                  type="button"
                  className="translation-sync-btn lua-tools-signed-in"
                  onClick={() => void handleLuaToolsSignOut()}
                  title={copy.luaToolsSignOutTitle}
                >
                  <CheckCircle2 size={14} />
                  <span>{luaToolsAuth.account || copy.luaToolsSignedInShort}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="translation-sync-btn"
                  onClick={() => void handleLuaToolsSignIn()}
                  disabled={luaToolsSigningIn}
                  title={copy.luaToolsSignInTitle}
                >
                  {luaToolsSigningIn ? <Loader2 size={14} className="is-spinning" /> : <MessageCircle size={14} />}
                  <span>{luaToolsSigningIn ? copy.luaToolsSigningIn : copy.luaToolsSignIn}</span>
                </button>
              )}

              {/* EMPIRE (Empress fix) ACCOUNT — identical UX to the LuaTools controls above. */}
              <button
                type="button"
                className="translation-sync-btn lua-tools-discord-btn"
                onClick={() => void handleEmpressDiscordJoin()}
                title={copy.empressDiscordTitle}
              >
                <MessageCircle size={14} />
                <span>{copy.empressDiscordJoin}</span>
                <ExternalLink size={13} />
              </button>

              {empressAuth.signedIn ? (
                <button
                  type="button"
                  className="translation-sync-btn lua-tools-signed-in"
                  onClick={() => void handleEmpressSignOut()}
                  title={copy.empressSignOutTitle}
                >
                  <CheckCircle2 size={14} />
                  <span>{empressAuth.account || copy.empressSignedInShort}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="translation-sync-btn"
                  onClick={() => void handleEmpressSignIn()}
                  disabled={empressSigningIn}
                  title={copy.empressSignInTitle}
                >
                  {empressSigningIn ? <Loader2 size={14} className="is-spinning" /> : <MessageCircle size={14} />}
                  <span>{empressSigningIn ? copy.empressSigningIn : copy.empressSignIn}</span>
                </button>
              )}
            </div>
          </header>

          {/* SECONDARY TOOLBAR: SORT, DENSITY, FILTERS */}
          <div className="translation-sub-toolbar">
              <div className="translation-filter-tabs" role="tablist" aria-label={fixCopy.fixTags}>
                <button type="button" className={activeTag === 'all' ? 'is-active' : ''} onClick={() => setActiveTag('all')}>
                  {formatTranslationCopy(fixCopy.allTags, { count: bypassItems.length })}
                </button>
                {catalogTags.map((tag) => (
                  <button key={tag} type="button" className={activeTag === tag ? 'is-active' : ''} onClick={() => setActiveTag(tag)}>
                    {tag}
                  </button>
                ))}
              </div>
              <div className="translation-filter-tabs" role="tablist" aria-label={fixCopy.statusFilters}>
              <button type="button" className={activeFilter === 'all' ? 'is-active' : ''} onClick={() => setActiveFilter('all')}>
                {formatTranslationCopy(fixCopy.fixes, { count: processedItems.length })}
              </button>
              <button type="button" className={activeFilter === 'installed' ? 'is-active' : ''} onClick={() => setActiveFilter('installed')}>
                {fixCopy.installedGames}
              </button>
              <button type="button" className={activeFilter === 'popular' ? 'is-active' : ''} onClick={() => setActiveFilter('popular')}>
                {fixCopy.popular}
              </button>
              <button type="button" className={activeFilter === 'new' ? 'is-active' : ''} onClick={() => setActiveFilter('new')}>
                {fixCopy.recentlyUpdated}
              </button>
            </div>

            <div className="translation-toolbar-right" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {/* SORT DROPDOWN */}
              <div className="store-sort-dropdown" style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="sort-toggle-btn"
                  onClick={() => setSortOpen(!sortOpen)}
                  onBlur={() => setTimeout(() => setSortOpen(false), 200)}
                >
                  <SlidersHorizontal size={14} />
                  <span>
                    {sortBy === 'az' ? 'A → Z' :
                     sortBy === 'za' ? 'Z → A' :
                     sortBy === 'popular' ? copy.sort.popular :
                     sortBy === 'downloaded' ? copy.sort.downloaded : copy.sort.newest}
                  </span>
                </button>
                {sortOpen && (
                  <div className="sort-dropdown-menu">
                    <button type="button" onClick={() => setSortBy('az')} className={sortBy === 'az' ? 'active' : ''}>A → Z</button>
                    <button type="button" onClick={() => setSortBy('za')} className={sortBy === 'za' ? 'active' : ''}>Z → A</button>
                    <button type="button" onClick={() => setSortBy('popular')} className={sortBy === 'popular' ? 'active' : ''}>{copy.sort.popular}</button>
                    <button type="button" onClick={() => setSortBy('downloaded')} className={sortBy === 'downloaded' ? 'active' : ''}>{copy.sort.downloaded}</button>
                    <button type="button" onClick={() => setSortBy('newest')} className={sortBy === 'newest' ? 'active' : ''}>{copy.sort.newest}</button>
                  </div>
                )}
              </div>

              {/* VIEW DENSITY / LAYOUT */}
              <div className="view-layout-toggle" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {viewLayout === 'grid' && (
                  <div style={{ display: 'flex', gap: '2px', marginRight: '6px' }}>
                    <button type="button" className={gridCols === 4 ? 'active' : ''} onClick={() => handleSetGridCols(4)} title={formatTranslationCopy(copy.columnsTitle, { count: 4 })}>4x</button>
                    <button type="button" className={gridCols === 6 ? 'active' : ''} onClick={() => handleSetGridCols(6)} title={formatTranslationCopy(copy.columnsTitle, { count: 6 })}>6x</button>
                    <button type="button" className={gridCols === 8 ? 'active' : ''} onClick={() => handleSetGridCols(8)} title={formatTranslationCopy(copy.columnsTitle, { count: 8 })}>8x</button>
                  </div>
                )}
                <button
                  type="button"
                  className={viewLayout === 'grid' ? 'active' : ''}
                  onClick={() => handleSetViewLayout('grid')}
                  title={copy.gridView}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></svg>
                </button>
                <button
                  type="button"
                  className={viewLayout === 'list' ? 'active' : ''}
                  onClick={() => handleSetViewLayout('list')}
                  title={copy.listView}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><path d="M14 6h7" /><path d="M14 10h7" /><path d="M14 14h7" /><path d="M14 18h7" /></svg>
                </button>
              </div>
            </div>
          </div>

          {/* MAIN GAME GRID / LIST */}
          {processedItems.length === 0 ? (
            <div className="translation-empty catalog-empty">
              <Search size={32} />
              <strong>{formatTranslationCopy(fixCopy.noFixes, { source: activeSourceMeta.title })}</strong>
              <span>{fixCopy.noFixesHint}</span>
              <span className="lua-tools-discord-hint">{copy.luaToolsDiscordHint}</span>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
                <button
                  type="button"
                  className="translation-sync-btn lua-tools-discord-btn"
                  onClick={() => void openUrl(LUA_TOOLS_DISCORD_URL)}
                >
                  <MessageCircle size={14} />
                  <span>{copy.luaToolsDiscordJoin}</span>
                  <ExternalLink size={13} />
                </button>
                <button
                  type="button"
                  className="translation-sync-btn"
                  onClick={() => (luaToolsAuth.signedIn ? void handleLuaToolsSignOut() : void handleLuaToolsSignIn())}
                  disabled={luaToolsSigningIn}
                >
                  {luaToolsSigningIn ? <Loader2 size={14} className="is-spinning" /> : <CheckCircle2 size={14} />}
                  <span>{luaToolsAuth.signedIn ? copy.luaToolsSignOut : copy.luaToolsSignIn}</span>
                </button>
              </div>
            </div>
          ) : viewLayout === 'grid' ? (
            <div className={`translation-lightning-grid grid-cols-${gridCols}`}>
              {visibleItems.map((item) => {
                const identity = translationIdentity(item)
                const isPatchInstalled = Boolean(installedBypass[identity])
                const isGameInstalled = Boolean(
                  item.gameId &&
                    (installStates[item.gameId]?.installed ||
                      externalInstalledGames[item.gameId] ||
                      isPatchInstalled)
                )

                return (
                  <div
                    key={identity}
                    className={`translation-catalog-card lightning-game-card ${isPatchInstalled ? 'is-installed' : 'is-available'}`}
                    onClick={() => setSelectedTranslation(item)}
                  >
                    <div className="lightning-card-cover-box">
                      {renderCover(item)}
                      <div className="lightning-card-cover-overlay" />
                      {isPatchInstalled ? (
                        <span className="lightning-card-installed-badge">
                          <CheckCircle2 size={12} /> Fix installed
                        </span>
                      ) : isGameInstalled ? (
                        <span className="lightning-card-installed-badge game-ready">
                          <CheckCircle2 size={12} /> {copy.badges.gameInstalled}
                        </span>
                      ) : null}
                      <span className="lightning-card-size-tag">
                        <HardDrive size={11} /> {item.size}
                      </span>
                    </div>
                    <div className="lightning-card-title-bar">
                      <strong title={item.gameTitle}>{item.gameTitle}</strong>
                      <small title={item.translationTitle || item.fileName}>
                        {item.translationTitle || item.fileName}
                      </small>
                      {item.bypassTags && item.bypassTags.length > 0 && (
                        <div className="translation-card-tags" style={{ marginTop: '4px', gap: '3px', display: 'flex', flexWrap: 'wrap' }}>
                          {item.bypassTags.map((t) => (
                            <span key={t} className={`translation-tag ${t.toLowerCase().includes('online-fix') ? 'online-fix-tag' : ''}`}>
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            /* LIST LAYOUT */
            <div className="translation-list-container">
              {visibleItems.map((item) => {
                const identity = translationIdentity(item)
                const isPatchInstalled = Boolean(installedBypass[identity])
                const isGameInstalled = Boolean(
                  item.gameId &&
                    (installStates[item.gameId]?.installed ||
                      externalInstalledGames[item.gameId] ||
                      isPatchInstalled)
                )

                return (
                  <article
                    key={identity}
                    className="translation-list-row"
                    onClick={() => setSelectedTranslation(item)}
                  >
                    <div className="translation-list-media">
                      {renderCover(item)}
                    </div>
                    <div className="translation-list-info">
                      <div className="translation-list-title-row">
                        <strong>{item.gameTitle}</strong>
                        {item.version ? <span className="translation-tag">Build {item.version}</span> : null}
                        {item.bypassTags?.map((t) => (
                          <span key={t} className={`translation-tag ${t.toLowerCase().includes('online-fix') ? 'online-fix-tag' : ''}`}>
                            {t}
                          </span>
                        ))}
                      </div>
                      <p className="translation-list-sub">{item.translationTitle || item.fileName}</p>
                      <div className="translation-list-meta">
                        <span><HardDrive size={13} /> {item.size}</span>
                        <span style={{ color: isPatchInstalled ? '#4ade80' : undefined }}>
                          {isPatchInstalled ? '✓ Fix đã cài' : isGameInstalled ? '✓ Game đã cài' : '○ Có thể tải'}
                        </span>
                      </div>
                    </div>
                    <div className="translation-list-action">
                      <button type="button" className="translation-btn-view">
                        {copy.viewDetails}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
          {pageCount > 1 && (
            <nav className="translation-pagination" aria-label={fixCopy.pagination}>
              <button type="button" disabled={catalogPage === 0} onClick={() => setCatalogPage((page) => Math.max(0, page - 1))}>{fixCopy.previous}</button>
              <span>{catalogPage + 1} / {pageCount}</span>
              <button type="button" disabled={catalogPage + 1 >= pageCount} onClick={() => setCatalogPage((page) => Math.min(pageCount - 1, page + 1))}>{fixCopy.next}</button>
            </nav>
          )}
        </div>
      )}

      {/* DETAIL MODAL / DRAWER */}
      {selectedTranslation && (
        <div className="translation-modal-overlay" onClick={() => setSelectedTranslation(null)}>
          <div className="translation-modal-content" onClick={(e) => e.stopPropagation()}>
            <header className="translation-modal-header">
              <div className="translation-modal-hero">
                {renderCover(selectedTranslation, true)}
                <div className="translation-modal-hero-overlay" />
                <button
                  type="button"
                  className="translation-modal-close"
                  onClick={() => setSelectedTranslation(null)}
                  aria-label={fixCopy.close}
                  title={fixCopy.close}
                >
                  <X size={20} strokeWidth={2.5} />
                </button>
                <div className="translation-modal-hero-title">
                  <span><Languages size={16} /> {fixCopy.title}</span>
                  <h2>{selectedTranslation.gameTitle}</h2>
                  <p>{selectedTranslation.translationTitle || selectedTranslation.fileName}</p>
                </div>
              </div>
            </header>

            <div className="translation-modal-body">
              <div className="translation-modal-meta-grid">
                <div>
                  <label>{fixCopy.fixArchive}</label>
                  <strong style={{ wordBreak: 'break-all', fontSize: '11px' }}>{selectedTranslation.fileName || 'Bypass archive'}</strong>
                </div>
                <div>
                  <label>{fixCopy.builds}</label>
                  <strong>{selectedTranslation.size}</strong>
                </div>
                <div>
                  <label>{fixCopy.fixSource}</label>
                  <strong>{selectedTranslation.author || activeSourceMeta.title}</strong>
                </div>
                <div>
                  <label>{fixCopy.repository}</label>
                  <strong>{selectedTranslation.repo?.split('/')[0] || '0xoLemon'}</strong>
                </div>
              </div>

              <div className="translation-modal-section">
                  <h3>{fixCopy.steamBuild}</h3>
                <div className="translation-modal-meta-grid">
                  <div>
                    <label>{fixCopy.branches}</label>
                    <strong>{modalKnownBuildIds.join(', ') || 'Không có BuildID'}</strong>
                  </div>
                  <div>
                    <label>{fixCopy.executable}</label>
                    <strong>{modalExecutables.join(', ') || 'Không có dữ liệu executable'}</strong>
                  </div>
                  <div>
                    <label>{fixCopy.launchConfig}</label>
                    <strong>{modalLaunchArgs.join(' | ') || 'Không có launch config'}</strong>
                  </div>
                </div>
              </div>

              {selectedTranslation.description ? (
                <div className="translation-modal-section">
                  <h3>{fixCopy.description}</h3>
                  <p>{selectedTranslation.description}</p>
                </div>
              ) : null}

              {selectedTranslation.installGuide && (
                <div className="translation-modal-section">
                  <h3>{fixCopy.installationGuide}</h3>
                  <p>{selectedTranslation.installGuide}</p>
                </div>
              )}

              {/* ACTION MESSAGES */}
              {actionError && (
                <div className="translation-alert error">
                  <AlertCircle size={16} />
                  <span>{actionError}</span>
                </div>
              )}

              {/* LUA TOOLS ACCOUNT GATE — revealed only after a LUATOOLS_AUTH_REQUIRED failure. */}
              {authRequired && (
                <div className="lua-tools-auth-gate">
                  <span>{copy.luaToolsDiscordHint}</span>
                  <div className="lua-tools-auth-gate-actions">
                    <button
                      type="button"
                      className="translation-sync-btn lua-tools-discord-btn"
                      onClick={() => void handleLuaToolsDiscordJoin()}
                      title={copy.luaToolsDiscordTitle}
                    >
                      <MessageCircle size={14} />
                      <span>{copy.luaToolsDiscordJoin}</span>
                      <ExternalLink size={13} />
                    </button>
                    <button
                      type="button"
                      className="translation-sync-btn"
                      onClick={() => void handleLuaToolsSignIn()}
                      disabled={luaToolsSigningIn}
                      title={copy.luaToolsSignInTitle}
                    >
                      {luaToolsSigningIn ? <Loader2 size={14} className="is-spinning" /> : <CheckCircle2 size={14} />}
                      <span>{luaToolsSigningIn ? copy.luaToolsSigningIn : copy.luaToolsSignIn}</span>
                    </button>
                  </div>
                  <small className="lua-tools-auth-gate-url">{LUA_TOOLS_DISCORD_URL}</small>
                </div>
              )}

              {/* EMPIRE ACCOUNT GATE — revealed only after an EMPRESS_AUTH_REQUIRED failure.
                  Same affordance as the LuaTools gate above: join the Discord, then sign in. */}
              {empressAuthRequired && (
                <div className="lua-tools-auth-gate">
                  <span>{copy.empressDiscordHint}</span>
                  <div className="lua-tools-auth-gate-actions">
                    <button
                      type="button"
                      className="translation-sync-btn lua-tools-discord-btn"
                      onClick={() => void handleEmpressDiscordJoin()}
                      title={copy.empressDiscordTitle}
                    >
                      <MessageCircle size={14} />
                      <span>{copy.empressDiscordJoin}</span>
                      <ExternalLink size={13} />
                    </button>
                    <button
                      type="button"
                      className="translation-sync-btn"
                      onClick={() => void handleEmpressSignIn()}
                      disabled={empressSigningIn}
                      title={copy.empressSignInTitle}
                    >
                      {empressSigningIn ? <Loader2 size={14} className="is-spinning" /> : <CheckCircle2 size={14} />}
                      <span>{empressSigningIn ? copy.empressSigningIn : copy.empressSignIn}</span>
                    </button>
                  </div>
                  <small className="lua-tools-auth-gate-url">{EMPRESS_DISCORD_URL}</small>
                </div>
              )}

              {/* EMPRESS MANUAL DOWNLOAD — last resort when the file is still refused */}
              {empressManualHref && (
                <div className="lua-tools-auth-gate">
                  <span>Tải tự động thất bại. Tải Empress fix thủ công và đặt vào thư mục game:</span>
                  <div className="lua-tools-auth-gate-actions">
                    <a
                      href={empressManualHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="translation-sync-btn lua-tools-discord-btn"
                      title="Tải Empress fix thủ công"
                    >
                      <ExternalLink size={14} />
                      <span>Tải thủ công (ryuu.lol)</span>
                    </a>
                  </div>
                  <small className="lua-tools-auth-gate-url">{empressManualHref}</small>
                </div>
              )}

              {actionSuccess && (
                <div className="translation-alert success">
                  <CheckCircle2 size={16} />
                  <span>{actionSuccess}</span>
                </div>
              )}

              {/* GAME DIRECTORY DETECTOR & SELECTOR */}
              {selectedTranslation.gameId && (
                <div className="translation-modal-section translation-folder-section">
                  <div className="translation-game-path-header">
                    <h3>{fixCopy.folder}</h3>
                    <button
                      type="button"
                      className="translation-btn-browse-folder"
                      onClick={() => handleBrowseGameFolder(selectedTranslation.gameId!)}
                      title={fixCopy.chooseFolder}
                    >
                      <FolderOpen size={14} />
                      {gamePaths[selectedTranslation.gameId]?.path ? fixCopy.changeFolder : fixCopy.chooseFolder}
                    </button>
                  </div>
                  <div className={`translation-game-path-badge ${gamePaths[selectedTranslation.gameId]?.path ? 'is-detected' : 'is-missing'}`}>
                    {gamePaths[selectedTranslation.gameId]?.path ? (
                      <>
                        <span className="path-source-tag">
                          {gamePaths[selectedTranslation.gameId].source === 'steam' ? 'Steam' : gamePaths[selectedTranslation.gameId].source === 'launcher' ? '007Launcher' : 'Tùy chọn'}
                        </span>
                        <span className="path-text" title={gamePaths[selectedTranslation.gameId].path}>
                          {gamePaths[selectedTranslation.gameId].path}
                        </span>
                      </>
                    ) : (
                      <span className="path-missing-text">
                        ⚠️ Chưa nhận diện được thư mục game. Bấm &quot;Chọn thư mục game&quot; để launcher tự động cài đặt.
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* REAL-TIME DOWNLOAD WAVE PROGRESS */}
              {selectedTranslation.gameId && activeProgress[selectedTranslation.gameId] && (
                <div className="translation-modal-section translation-wave-wrapper">
                  <DownloadWaveCard
                    telemetry={{
                      transferId: `bypass_${selectedTranslation.gameId}`,
                      owner: 'depot',
                      state: activeProgress[selectedTranslation.gameId].stage === 'error' ? 'failed' : activeProgress[selectedTranslation.gameId].stage === 'finished' ? 'complete' : 'downloading',
                      phaseLabel: activeProgress[selectedTranslation.gameId].stage === 'downloading' ? (activeProgress[selectedTranslation.gameId].message || 'Đang tải bypass/fix...') : activeProgress[selectedTranslation.gameId].stage === 'backing_up' ? 'Đang sao lưu file gốc...' : activeProgress[selectedTranslation.gameId].stage === 'extracting' ? 'Đang giải nén bypass/fix...' : activeProgress[selectedTranslation.gameId].message,
                      downloadedBytes: activeProgress[selectedTranslation.gameId].downloadedBytes,
                      totalBytes: activeProgress[selectedTranslation.gameId].totalBytes,
                      bytesPerSecond: activeProgress[selectedTranslation.gameId].speedBps,
                      progress: activeProgress[selectedTranslation.gameId].percent,
                      updatedAt: Date.now(),
                    }}
                  />
                </div>
              )}

              {/* ARCHIVES / IN-APP ACTIONS (RevoltVH Parity) */}
              <div className="translation-modal-section">
                <div className="translation-section-header-row">
                  <h3>{fixCopy.availableFixes}</h3>
                  {selectedBuilds.length > 1 ? (
                    <div className="translation-version-selector" ref={versionDropdownRef}>
                      <span className="translation-version-label">
                        <Layers size={13} />
                        <span>{fixCopy.versionLabel || 'Phiên bản / Build'}:</span>
                      </span>
                      <div className="translation-version-custom-wrap">
                        <button
                          type="button"
                          className={`translation-version-trigger${versionDropdownOpen ? ' is-open' : ''}`}
                          onClick={() => setVersionDropdownOpen((v) => !v)}
                          onBlur={() => window.setTimeout(() => setVersionDropdownOpen(false), 160)}
                        >
                          <span className="translation-version-trigger-text">
                            {(() => {
                              const b = activeBuild
                              if (!b) return '—'
                              const isLatest = b.buildid === selectedTranslation.latestBuildId || b.buildid === selectedBuilds[0]?.buildid
                              const txt = b.buildid.toLowerCase() === 'latest'
                                ? 'Mới nhất'
                                : b.buildid.toLowerCase().startsWith('build')
                                  ? b.buildid
                                  : `Build ${b.buildid}`
                              return isLatest && b.buildid.toLowerCase() !== 'latest' ? `${txt} (Mới nhất)` : txt
                            })()}
                          </span>
                          <ChevronDown size={13} className={`translation-version-arrow${versionDropdownOpen ? ' is-open' : ''}`} />
                        </button>
                        {versionDropdownOpen && (
                          <div className="translation-version-menu">
                            {selectedBuilds.map((build, idx) => {
                              const isLatest = build.buildid === selectedTranslation.latestBuildId || idx === 0
                              const isActive = activeBuild?.buildid === build.buildid
                              const txt = build.buildid.toLowerCase() === 'latest'
                                ? 'Mới nhất'
                                : build.buildid.toLowerCase().startsWith('build')
                                  ? build.buildid
                                  : `Build ${build.buildid}`
                              const label = isLatest && build.buildid.toLowerCase() !== 'latest' ? `${txt} (Mới nhất)` : txt
                              const tagCountText = build.tags.length > 1 ? `${build.tags.length} fixes` : `${build.tags.length} fix`
                              return (
                                <button
                                  key={build.buildid}
                                  type="button"
                                  className={`translation-version-option${isActive ? ' is-active' : ''}`}
                                  onMouseDown={(e) => {
                                    e.preventDefault()
                                    handleVersionChange(build.buildid)
                                    setVersionDropdownOpen(false)
                                  }}
                                >
                                  <span className="translation-version-option-label">{label}</span>
                                  <span className="translation-version-option-count">{tagCountText}</span>
                                  {isActive && <Check size={12} className="translation-version-option-check" />}
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : activeBuild && activeBuild.buildid.toLowerCase() !== 'latest' ? (
                    <span className="translation-single-build-badge">
                      <Layers size={12} />
                      <span>{activeBuild.buildid.toLowerCase().startsWith('build') ? activeBuild.buildid : `Build ${activeBuild.buildid}`}</span>
                    </span>
                  ) : null}
                </div>
                <div className="translation-card-tags" aria-label={fixCopy.availableTags}>
                  {activeBuild?.tags.map((archive) => (
                    <button
                      key={`${activeBuild.buildid}:${archive.tag}`}
                      type="button"
                      className={`translation-tag translation-tag-button ${selectedArchive?.buildid === activeBuild.buildid && selectedArchive.tag === archive.tag ? 'is-selected' : ''}`}
                      onClick={() => setSelectedArchive({ buildid: activeBuild.buildid, tag: archive.tag, filename: archive.filename })}
                    >
                      {archive.tag}
                    </button>
                  ))}
                </div>
                <div className="translation-archive-card">
                  <div className="translation-archive-info">
                    <strong>{selectedTranslation.provider === 'lua_tools'
                      ? `${selectedArchive?.tag || 'LuaTools fix'} · ${selectedTranslation.fileName || 'ZIP archive'}`
                      : selectedArchive ? `${selectedArchive.buildid} · ${selectedArchive.filename || `${selectedArchive.tag}.7z`}` : selectedTranslation.fileName || 'Bypass archive'}</strong>
                    <span><HardDrive size={13} /> {selectedTranslation.size} · Bypass/Fix archive</span>
                  </div>
                  <div className="translation-archive-btns">
                    {installedBypass[translationIdentity(selectedTranslation)] ? (
                      <>
                        <button
                          type="button"
                          className="translation-btn-uninstall"
                          onClick={() => handleUninstallPatch(selectedTranslation)}
                          disabled={uninstalling}
                        >
                          {uninstalling ? <Loader2 size={15} className="is-spinning" /> : <RotateCcw size={15} />}
                          {uninstalling ? copy.modal.uninstalling : 'Gỡ Bypass/Fix'}
                        </button>

                        <button
                          type="button"
                          className="translation-btn-reinstall"
                          onClick={() => handleInstallPatch(selectedTranslation)}
                          disabled={installing === translationIdentity(selectedTranslation)}
                          title={fixCopy.reinstall}
                        >
                          {installing === translationIdentity(selectedTranslation) ? <Loader2 size={14} className="is-spinning" /> : <RefreshCw size={14} />}
                          Cài lại
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="translation-btn-auto-install"
                          onClick={() => handleInstallPatch(selectedTranslation)}
                          disabled={installing === translationIdentity(selectedTranslation)}
                        >
                          {installing === translationIdentity(selectedTranslation) ? (
                            <Loader2 size={15} className="is-spinning" />
                          ) : (
                            <Download size={15} />
                          )}
                          {installing === translationIdentity(selectedTranslation) ? copy.modal.installing : 'Cài Đặt Bypass/Fix'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* FULLSCREEN SEARCH OVERLAY (Identical UX to StoreSearchOverlay) */}
      {searchOverlayOpen && typeof document !== 'undefined' && createPortal(
        <div className="store-search-overlay" role="dialog" aria-modal="true" aria-label={copy.search.dialogLabel}>
          <div className="store-search-backdrop" onClick={() => setSearchOverlayOpen(false)} />
          <section className="store-search-surface">
            <header className="store-search-hero">
              <form
                className="store-search-command"
                onSubmit={(e) => {
                  e.preventDefault()
                  handleSearchSubmit(query)
                  setSearchOverlayOpen(false)
                }}
              >
                <Search size={22} />
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={copy.search.placeholder || 'Search games or bypass fixes'}
                  autoComplete="off"
                  spellCheck="false"
                />
                {query ? (
                  <button type="button" className="store-search-clear" onClick={() => setQuery('')} title={copy.search.clear}>
                    <X size={18} />
                  </button>
                ) : (
                  <kbd>Ctrl K</kbd>
                )}
              </form>
              <button
                type="button"
                className="store-search-close"
                onClick={() => setSearchOverlayOpen(false)}
                title={copy.search.close}
              >
                <X size={20} />
              </button>
            </header>

            <div className="store-search-filters" role="tablist">
              {sourcesConfig.map((source) => (
                <button
                  key={source.key}
                  type="button"
                  className={activeSource === source.key ? 'active' : ''}
                  onClick={() => {
                    setActiveSource(source.key)
                    setIsExpanded(true)
                  }}
                >
                  {source.title} ({sourceCounts[source.key] || 0})
                </button>
              ))}
            </div>

            {!query.trim() ? (
              <div className="store-search-discovery">
                <div className="store-search-discovery-columns">
                  <section>
                    <div className="store-search-section-title">
                      <span><Clock3 size={15} /> {copy.search.recent}</span>
                      {searchHistory.length ? (
                        <button type="button" onClick={handleClearHistory}>{copy.search.clearHistory}</button>
                      ) : null}
                    </div>
                    <div className="store-search-chips">
                      {searchHistory.length ? (
                        searchHistory.map((term) => (
                          <button
                            key={term}
                            type="button"
                            onClick={() => {
                              setQuery(term)
                              searchInputRef.current?.focus()
                            }}
                          >
                            {term}
                          </button>
                        ))
                      ) : (
                        <p>{copy.search.emptyHistory}</p>
                      )}
                    </div>
                  </section>
                  <section>
                    <div className="store-search-section-title">
                      <span><TrendingUp size={15} /> {copy.search.trending}</span>
                    </div>
                    <div className="store-search-chips trending">
                      {['Wukong', 'Resident Evil', 'Persona', '007', 'The Witcher'].map((term) => (
                        <button
                          key={term}
                          type="button"
                          onClick={() => {
                            setQuery(term)
                            searchInputRef.current?.focus()
                          }}
                        >
                          <span>{term}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
                <div className="store-search-results-heading">
                  <span><Sparkles size={16} /> {copy.search.recommended}</span>
                  <small>{copy.search.recommendedHint}</small>
                </div>
              </div>
            ) : (
              <div className="store-search-results-heading">
                <span>{formatTranslationCopy(copy.search.results, { count: processedItems.length, query: query.trim() })}</span>
                <small>{formatTranslationCopy(copy.search.source, { source: activeSourceMeta.title })}</small>
              </div>
            )}

            <div className="store-search-results" aria-live="polite">
              {processedItems.slice(0, query.trim() ? 24 : 12).map((item) => (
                <button
                  key={translationIdentity(item)}
                  type="button"
                  className="store-search-result"
                  onClick={() => {
                    setSelectedTranslation(item)
                    setSearchOverlayOpen(false)
                    handleSearchSubmit(query)
                  }}
                >
                  <div className="store-search-result-media">
                    {renderCover(item)}
                  </div>
                  <div className="store-search-result-copy">
                    <strong>{item.gameTitle}</strong>
                    <span>{item.translationTitle || item.fileName}</span>
                    <small>{item.size}</small>
                  </div>
                  <span className="store-search-result-match">
                    <HardDrive size={13} /> {item.size}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>,
        document.body
      )}
    </section>
  )
}
