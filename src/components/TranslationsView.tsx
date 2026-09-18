import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Languages,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import { DownloadWaveCard } from './DownloadWaveCard'
import './TranslationsView.css'
import type { GameCatalog, GameInstallState, GameSummary } from '../types'
import { assetUrlForId } from '../lib/gameMeta'
import { useLocale } from '../context/locale'
import { useRealtimeTranslations } from '../hooks/useRealtimeTranslations'
import {
  type VietnameseTranslationItem,
  type TranslationSourceKey,
} from '../data/vietnameseTranslations'

import theRedTeamIcon from '../assets/translations/theredteam.png'
import canhCutTeamIcon from '../assets/translations/canhcutteam.ico'
import gameThuanVietIcon from '../assets/translations/gamethuanviet.ico'
import othersIcon from '../assets/translations/others.png'
import theRedTeamBg from '../assets/translations/707153930_1014277167800133_6234460701972894567_n.jpg'
import canhCutTeamBg from '../assets/translations/4-1.webp'
import gameThuanVietBg from '../assets/translations/jJXFr2KHruvTcgL24E8hMb.webp'
import othersBg from '../assets/translations/black-myth-wukong_e8hc.1920.webp'

type SortOption = 'az' | 'za' | 'popular' | 'downloaded' | 'newest'
type FilterOption = 'all' | 'installed' | 'popular' | 'new'

interface TranslationsViewProps {
  catalog: GameCatalog
  selectedGameId?: string | null
  assets: Record<string, string>
  installStates?: Record<string, GameInstallState>
  onSelectGame?: (gameId: string | null) => void
  onRequestAsset: (game: GameSummary, assetId: string | undefined, urgent?: boolean) => void
  onVerify?: () => void
}

const SOURCE_VISUALS: Array<{
  key: TranslationSourceKey
  icon: string
  bg: string
  color: string
}> = [
  {
    key: 'theredteam',
    icon: theRedTeamIcon,
    bg: theRedTeamBg,
    color: '#ef4444',
  },
  {
    key: 'canhcutteam',
    icon: canhCutTeamIcon,
    bg: canhCutTeamBg,
    color: '#06b6d4',
  },
  {
    key: 'gamethuanviet',
    icon: gameThuanVietIcon,
    bg: gameThuanVietBg,
    color: '#f59e0b',
  },
  {
    key: 'others',
    icon: othersIcon,
    bg: othersBg,
    color: '#a855f7',
  },
]

type TranslationGridColumns = 4 | 6 | 8

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

const TRANSLATION_SEARCH_HISTORY_KEY = '0xo_translation_search_history_v2'
const TRANSLATION_PAGE_SIZE = 48

function readSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(TRANSLATION_SEARCH_HISTORY_KEY)
    if (!raw) return ['Wukong', 'Resident Evil', 'Persona', '007', 'The Witcher']
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, 10) : []
  } catch {
    return ['Wukong', 'Resident Evil', 'Persona', '007', 'The Witcher']
  }
}

function saveSearchHistory(history: string[]) {
  try {
    localStorage.setItem(TRANSLATION_SEARCH_HISTORY_KEY, JSON.stringify(history.slice(0, 10)))
  } catch {}
}

export function TranslationsView({
  catalog,
  selectedGameId,
  assets,
  installStates = {},
  onRequestAsset,
  onVerify,
}: TranslationsViewProps) {
  const { t, locale } = useLocale()
  const copy = t.translationsView
  const { translations, isSyncing, refresh } = useRealtimeTranslations()
  const [activeSource, setActiveSource] = useState<TranslationSourceKey>('theredteam')
  const [hoveredSource, setHoveredSource] = useState<TranslationSourceKey | null>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [selectedTranslation, setSelectedTranslation] = useState<VietnameseTranslationItem | null>(null)
  const [query, setQuery] = useState('')
  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false)
  const [activeFilter, setActiveFilter] = useState<FilterOption>('all')
  const [catalogPage, setCatalogPage] = useState(0)
  const [sortBy, setSortBy] = useState<SortOption>('az')
  const [sortOpen, setSortOpen] = useState(false)
  const [viewLayout, setViewLayout] = useState<'grid' | 'list'>(() => {
    const stored = localStorage.getItem('translationsViewLayout')
    return stored === 'list' ? 'list' : 'grid'
  })
  const [gridCols, setGridCols] = useState<TranslationGridColumns>(() => {
    const stored = Number(localStorage.getItem('translationsGridCols'))
    return stored === 4 || stored === 8 ? stored : 6
  })
  const [searchHistory, setSearchHistory] = useState<string[]>(readSearchHistory)
  const [installedTranslations, setInstalledTranslations] = useState<Record<string, boolean>>({})
  const [externalInstalledGames, setExternalInstalledGames] = useState<Record<string, boolean>>({})
  const [installing, setInstalling] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

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
    }>('translation-progress', (event) => {
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
  }, [selectedTranslation, installStates, externalInstalledGames, gamePaths])

  const searchInputRef = useRef<HTMLInputElement>(null)

  const sourcesConfig = useMemo(() => SOURCE_VISUALS.map((source) => ({
    ...source,
    ...copy.sources[source.key],
  })), [copy.sources])

  // Map catalog games for quick lookup and assets
  const catalogMap = useMemo(() => {
    const map = new Map<string, GameSummary>()
    catalog.games.forEach((game) => map.set(game.id, game))
    return map
  }, [catalog.games])

  // Count items per source
  const sourceCounts = useMemo(() => {
    const counts: Record<TranslationSourceKey, number> = {
      theredteam: 0,
      canhcutteam: 0,
      gamethuanviet: 0,
      others: 0,
    }
    translations.forEach((item) => {
      const src = item.source || 'others'
      counts[src] = (counts[src] || 0) + 1
    })
    return counts
  }, [translations])

  // Check installed status for each translation
  useEffect(() => {
    let canceled = false
    const checkStatuses = async () => {
      const results: Record<string, boolean> = {}
      for (const item of translations) {
        if (canceled) break
        if (item.gameId) {
          try {
            const customPath = gamePaths[item.gameId]?.path || null
            const installed = await invoke<boolean>('get_translation_status', {
              gameId: item.gameId,
              customPath,
            }).catch(() => false)
            results[translationIdentity(item)] = installed
          } catch {
            results[translationIdentity(item)] = false
          }
        } else {
          results[translationIdentity(item)] = false
        }
      }
      if (!canceled) setInstalledTranslations(results)
    }
    void checkStatuses()
    return () => {
      canceled = true
    }
  }, [translations, gamePaths])

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
      const match = translations.find((item) => item.gameId === selectedGameId)
      if (match) {
        setSelectedTranslation(match)
        if (match.source) setActiveSource(match.source)
        setIsExpanded(true)
      }
    }
  }, [selectedGameId, translations])

  // Request assets for visible games
  useEffect(() => {
    translations.forEach((item) => {
      if (item.gameId) {
        const game = catalogMap.get(item.gameId)
        if (game?.gridAssetId && !assets[game.gridAssetId]) {
          onRequestAsset(game, game.gridAssetId)
        }
      }
    })
  }, [assets, catalogMap, onRequestAsset, translations])

  const handleSetGridCols = (cols: TranslationGridColumns) => {
    setGridCols(cols)
    localStorage.setItem('translationsGridCols', String(cols))
  }

  const handleSetViewLayout = (layout: 'grid' | 'list') => {
    setViewLayout(layout)
    localStorage.setItem('translationsViewLayout', layout)
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
        const item = translations.find((t) => t.gameId === gid)
        if (item) {
          void invoke<boolean>('get_translation_status', {
            gameId: gid,
            customPath: selected,
          }).then((installed) => {
            setInstalledTranslations((prev) => ({ ...prev, [translationIdentity(item)]: installed }))
          }).catch(() => {})
        }
      }
    } catch (err) {
      console.error('Failed to open directory picker:', err)
    }
  }

  const handleOpenDownloadLink = async (url: string) => {
    try {
      await invoke('open_url', { url })
    } catch {
      window.open(url, '_blank')
    }
  }

  const handleInstallPatch = async (item: VietnameseTranslationItem) => {
    if (!item.gameId) return
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
      const relativePath = `${item.gameId}/Viethoagame/${item.downloadUrl.split('/').pop() || 'pack.zip'}`
      await invoke('install_translation', {
        gameId: item.gameId,
        translationPath: relativePath,
        downloadUrl: item.downloadUrl,
        customPath: targetPath,
      })
      setInstalledTranslations((prev) => ({ ...prev, [identity]: true }))
      setActionSuccess(copy.installSuccess || 'Cài đặt Việt Hóa thành công!')
    } catch (error) {
      setActionError(formatTranslationCopy(copy.installError, { error: String(error) }))
    } finally {
      setInstalling(null)
      setActiveProgress((prev) => {
        const next = { ...prev }
        delete next[gid]
        return next
      })
    }
  }

  const handleUninstallPatch = async (item: VietnameseTranslationItem) => {
    if (!item.gameId) return
    const gid = item.gameId
    const identity = translationIdentity(item)
    const targetPath = gamePaths[gid]?.path || null
    try {
      setUninstalling(true)
      setActionError(null)
      setActionSuccess(null)
      await invoke('uninstall_translation', { gameId: item.gameId, customPath: targetPath })
      setInstalledTranslations((prev) => ({ ...prev, [identity]: false }))
      setActionSuccess(copy.uninstallSuccess || 'Đã gỡ bản dịch và khôi phục file gốc!')
      onVerify?.()
    } catch (error) {
      setActionError(formatTranslationCopy(copy.uninstallError, { error: String(error) }))
    } finally {
      setUninstalling(false)
    }
  }

  const handleLaunchGame = async (item: VietnameseTranslationItem) => {
    if (!item.gameId) return
    const gid = item.gameId
    const targetPath = gamePaths[gid]?.path || null
    try {
      setActionError(null)
      await invoke('launch_translation_game', {
        gameId: gid,
        customPath: targetPath,
        executable: (item as any).executable || null,
        launchOptions: item.launchOptions || null,
      })
    } catch (error) {
      setActionError(`Không thể khởi chạy game: ${String(error)}`)
    }
  }

  // Filtered & Sorted items for the current active source
  const processedItems = useMemo(() => {
    const needle = query.trim().toLowerCase()
    let list = translations.filter((item) => {
      const src = item.source || 'others'
      // An active query is global: users can find a game without switching sources first.
      if (!needle && src !== activeSource) return false
      const isGameInstalled = Boolean(
        item.gameId &&
          (installStates[item.gameId]?.installed ||
            externalInstalledGames[item.gameId] ||
            installedTranslations[translationIdentity(item)])
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
  }, [activeFilter, activeSource, installStates, query, sortBy, translations])

  const visibleItems = processedItems.slice(catalogPage * TRANSLATION_PAGE_SIZE, (catalogPage + 1) * TRANSLATION_PAGE_SIZE)
  const pageCount = Math.max(1, Math.ceil(processedItems.length / TRANSLATION_PAGE_SIZE))

  useEffect(() => {
    setCatalogPage(0)
  }, [activeFilter, activeSource, query, sortBy, processedItems.length])

  // Helper to render image
  const renderCover = (item: VietnameseTranslationItem, isLarge = false) => {
    const game = item.gameId ? catalogMap.get(item.gameId) : undefined
    const imageUrl = isLarge
      ? (item.bannerUrl || item.coverUrl || (game?.heroAssetId ? assetUrlForId(game.heroAssetId, assets) : undefined))
      : (item.coverUrl || (game?.gridAssetId ? assetUrlForId(game.gridAssetId, assets) : undefined))

    if (imageUrl) {
      return (
        <img
          src={imageUrl}
          alt={item.gameTitle}
          loading="lazy"
          decoding="async"
          className="translation-cover-img"
        />
      )
    }
    return (
      <div className="translation-cover-placeholder">
        <Languages size={isLarge ? 48 : 28} />
        <span>{item.gameTitle}</span>
      </div>
    )
  }

  // Active or currently hovered source metadata for instant background switching
  const displaySourceKey = hoveredSource || activeSource
  const currentSourceMeta = sourcesConfig.find((s) => s.key === displaySourceKey) || sourcesConfig[0]
  const activeSourceMeta = sourcesConfig.find((s) => s.key === activeSource) || sourcesConfig[0]
  const searchScopeLabel = query.trim() ? (locale === 'vi-VN' ? 'Tất cả nguồn bản dịch' : 'All translation sources') : activeSourceMeta.title

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
            <span className="translation-watermark-tag">{copy.catalogTag || 'Translation catalog'}</span>
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
                const count = isSyncing && translations.length === 0 ? '...' : sourceCounts[source.key] || 0

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
                        <small>{formatTranslationCopy(copy.translationCount, { count })}</small>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
            <p className="translation-landing-hint">{copy.landingHint}</p>
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
              title={copy.backTitle}
            >
              <ArrowLeft size={16} />
              <span>{copy.sourcesButton}</span>
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
                style={{ cursor: 'pointer' }}
                title={query.trim() ? searchScopeLabel : undefined}
              >
                <Search size={15} />
                <input
                  readOnly
                  value={query}
                  placeholder={formatTranslationCopy(copy.searchSourcePlaceholder, { source: searchScopeLabel })}
                  style={{ cursor: 'pointer' }}
                />
                <kbd>Ctrl K</kbd>
              </label>

              <button
                type="button"
                className="translation-sync-btn"
                onClick={() => void refresh()}
                disabled={isSyncing}
                title={copy.syncTitle}
              >
                <RotateCcw size={14} className={isSyncing ? 'is-spinning' : ''} />
                <span>{isSyncing ? copy.syncing : copy.sync}</span>
              </button>
            </div>
          </header>

          {/* SECONDARY TOOLBAR: SORT, DENSITY, FILTERS */}
          <div className="translation-sub-toolbar">
            <div className="translation-filter-tabs" role="tablist" aria-label={copy.filterLabel}>
              <button type="button" className={activeFilter === 'all' ? 'is-active' : ''} onClick={() => setActiveFilter('all')}>
                {formatTranslationCopy(copy.filters.all, { count: processedItems.length })}
              </button>
              <button type="button" className={activeFilter === 'installed' ? 'is-active' : ''} onClick={() => setActiveFilter('installed')}>
                {copy.filters.installed}
              </button>
              <button type="button" className={activeFilter === 'popular' ? 'is-active' : ''} onClick={() => setActiveFilter('popular')}>
                {copy.filters.popular}
              </button>
              <button type="button" className={activeFilter === 'new' ? 'is-active' : ''} onClick={() => setActiveFilter('new')}>
                {copy.filters.new}
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
              <strong>{formatTranslationCopy(copy.emptyTitle, { source: activeSourceMeta.title })}</strong>
              <span>{copy.emptyBody}</span>
            </div>
          ) : viewLayout === 'grid' ? (
            <div className={`translation-lightning-grid grid-cols-${gridCols}`}>
              {visibleItems.map((item) => {
                const identity = translationIdentity(item)
                const isPatchInstalled = Boolean(installedTranslations[identity])
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
                          <CheckCircle2 size={12} /> {copy.badges.translationInstalled}
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
                const isPatchInstalled = Boolean(installedTranslations[identity])
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
                        {item.version ? <span className="translation-tag">{item.version}</span> : null}
                        <span className="translation-tag">{sourcesConfig.find((source) => source.key === (item.source || 'others'))?.title || activeSourceMeta.title}</span>
                      </div>
                      <p className="translation-list-sub">{item.translationTitle || item.fileName}</p>
                      <div className="translation-list-meta">
                        <span><HardDrive size={13} /> {item.size}</span>
                        <span style={{ color: isPatchInstalled ? '#4ade80' : undefined }}>
                          {isPatchInstalled ? `✓ ${copy.listStatus.translationInstalled}` : isGameInstalled ? `✓ ${copy.listStatus.gameInstalled}` : `○ ${copy.listStatus.freelyAvailable}`}
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
            <nav className="translation-pagination" aria-label={copy.pagination.label}>
              <button type="button" disabled={catalogPage === 0} onClick={() => setCatalogPage((page) => Math.max(0, page - 1))}>{copy.pagination.previous}</button>
              <span>{catalogPage + 1} / {pageCount}</span>
              <button type="button" disabled={catalogPage + 1 >= pageCount} onClick={() => setCatalogPage((page) => Math.min(pageCount - 1, page + 1))}>{copy.pagination.next}</button>
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
                  aria-label="Đóng"
                  title="Đóng"
                >
                  <X size={20} strokeWidth={2.5} />
                </button>
                <div className="translation-modal-hero-title">
                  <span><Languages size={16} /> {copy.modal.title}</span>
                  <h2>{selectedTranslation.gameTitle}</h2>
                  <p>{selectedTranslation.translationTitle || selectedTranslation.fileName}</p>
                </div>
              </div>
            </header>

            <div className="translation-modal-body">
              <div className="translation-modal-meta-grid">
                <div>
                  <label>{copy.modal.fileName}</label>
                  <strong style={{ wordBreak: 'break-all', fontSize: '11px' }}>{selectedTranslation.fileName || copy.modal.archiveFallback}</strong>
                </div>
                <div>
                  <label>{copy.modal.size}</label>
                  <strong>{selectedTranslation.size}</strong>
                </div>
                <div>
                  <label>{copy.modal.source}</label>
                  <strong>{selectedTranslation.author || activeSourceMeta.title}</strong>
                </div>
                <div>
                  <label>{copy.modal.repository}</label>
                  <strong>{selectedTranslation.repo?.split('/')[0] || '0xoLemon'}</strong>
                </div>
              </div>

              {selectedTranslation.description ? (
                <div className="translation-modal-section">
                  <h3>{copy.modal.description}</h3>
                  <p>{selectedTranslation.description}</p>
                </div>
              ) : null}

              {selectedTranslation.installGuide && (
                <div className="translation-modal-section">
                  <h3>{copy.modal.installGuide}</h3>
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
                    <h3>Thư mục cài đặt game</h3>
                    <button
                      type="button"
                      className="translation-btn-browse-folder"
                      onClick={() => handleBrowseGameFolder(selectedTranslation.gameId!)}
                      title="Chọn thư mục cài đặt game"
                    >
                      <FolderOpen size={14} />
                      {gamePaths[selectedTranslation.gameId]?.path ? 'Đổi thư mục' : 'Chọn thư mục game'}
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
                      transferId: `translation_${selectedTranslation.gameId}`,
                      owner: 'translation',
                      state: activeProgress[selectedTranslation.gameId].stage === 'error' ? 'failed' : activeProgress[selectedTranslation.gameId].stage === 'finished' ? 'complete' : 'downloading',
                      phaseLabel: activeProgress[selectedTranslation.gameId].stage === 'downloading' ? (activeProgress[selectedTranslation.gameId].message || 'Đang tải bản dịch...') : activeProgress[selectedTranslation.gameId].stage === 'backing_up' ? 'Đang sao lưu file gốc...' : activeProgress[selectedTranslation.gameId].stage === 'extracting' ? 'Đang giải nén bản dịch...' : activeProgress[selectedTranslation.gameId].message,
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
                <h3>{copy.modal.availableArchives}</h3>
                <div className="translation-archive-card">
                  <div className="translation-archive-info">
                    <strong>{selectedTranslation.translationTitle || selectedTranslation.fileName}</strong>
                    <span><HardDrive size={13} /> {selectedTranslation.size} · {copy.modal.packageLabel}</span>
                  </div>
                  <div className="translation-archive-btns">
                    {installedTranslations[translationIdentity(selectedTranslation)] ? (
                      <>
                        {/* BUTTON 1: LAUNCH GAME */}
                        <button
                          type="button"
                          className="translation-btn-play-game"
                          onClick={() => handleLaunchGame(selectedTranslation)}
                        >
                          <Play size={15} fill="currentColor" />
                          Vào Game
                        </button>

                        {/* BUTTON 2: UNINSTALL / RESTORE ORIGINAL */}
                        <button
                          type="button"
                          className="translation-btn-uninstall"
                          onClick={() => handleUninstallPatch(selectedTranslation)}
                          disabled={uninstalling}
                        >
                          {uninstalling ? <Loader2 size={15} className="is-spinning" /> : <RotateCcw size={15} />}
                          {uninstalling ? copy.modal.uninstalling : 'Gỡ Bản Dịch'}
                        </button>

                        {/* BUTTON 3: REINSTALL */}
                        <button
                          type="button"
                          className="translation-btn-reinstall"
                          onClick={() => handleInstallPatch(selectedTranslation)}
                          disabled={installing === translationIdentity(selectedTranslation)}
                          title="Cài đặt lại bản dịch"
                        >
                          {installing === translationIdentity(selectedTranslation) ? <Loader2 size={14} className="is-spinning" /> : <RefreshCw size={14} />}
                          Cài lại
                        </button>
                      </>
                    ) : (
                      <>
                        {/* BUTTON 1: IN-APP AUTO INSTALL (RevoltVH Parity) */}
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
                          {installing === translationIdentity(selectedTranslation) ? copy.modal.installing : 'Cài Đặt Việt Hóa'}
                        </button>

                        {/* BUTTON 2: MANUAL DOWNLOAD (Optional fallback) */}
                        <button
                          type="button"
                          className="translation-btn-manual-dl"
                          onClick={() => handleOpenDownloadLink(selectedTranslation.downloadUrl)}
                          title="Tải file zip thủ công về máy"
                        >
                          <ExternalLink size={14} />
                          Tải zip ngoài
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
                  placeholder={copy.search.placeholder || 'Search games or translations'}
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
                <small>{formatTranslationCopy(copy.search.source, { source: searchScopeLabel })}</small>
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
                    if (item.source) setActiveSource(item.source)
                    setIsExpanded(true)
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
