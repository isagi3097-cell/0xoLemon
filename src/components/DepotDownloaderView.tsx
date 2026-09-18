import { useState, useEffect, useRef, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  Download,
  Search,
  RefreshCw,
  Folder,
  KeyRound,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Terminal,
  ExternalLink,
  Loader2,
  HardDrive,
  Pause,
  Play,
  ArrowRightLeft,
} from 'lucide-react'
import { useLocale } from '../context/locale'
import type {
  DepotGameItem,
  DepotGameDetail,
  DepotDownloadProgressEvent,
  DepotDownloaderStatus,
  DepotInstallState,
} from '../types'
import './DepotDownloaderView.css'
import { UnifiedSearchOverlay, UnifiedSearchResult } from './UnifiedSearchOverlay'
import { SteamDirectDepotView } from './SteamDirectDepotView'
import { DepotArchiveContributions } from './DepotArchiveContributions'

export function DepotDownloaderView({
  defaultLibraryRoot,
  selectedAppId,
}: {
  defaultLibraryRoot: string
  selectedAppId?: number | null
}) {
  const { locale } = useLocale()
  const isVi = locale.startsWith('vi')


  // Sub-tab state: 'steam_direct' (default) vs 'curated_hf' (hidden, logic preserved)
  const [activeSubTab, setActiveSubTab] = useState<'steam_direct' | 'curated_hf'>('steam_direct')

  // Catalog state
  const [catalog, setCatalog] = useState<DepotGameItem[]>([])
  const [loadingCatalog, setLoadingCatalog] = useState(true)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [depotSearchOverlayOpen, setDepotSearchOverlayOpen] = useState(false)

  // Selected game & builds
  const [selectedGame, setSelectedGame] = useState<DepotGameItem | null>(null)
  const [gameDetail, setGameDetail] = useState<DepotGameDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  // Configuration for download
  const [selectedBuildId, setSelectedBuildId] = useState<string>('')
  const [targetDir, setTargetDir] = useState<string>('')
  const [maxConcurrency, setMaxConcurrency] = useState<number>(64)
  const [verifyAll, setVerifyAll] = useState<boolean>(true)

  // Download runtime state
  const [isDownloading, setIsDownloading] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [installState, setInstallState] = useState<DepotInstallState | null>(null)
  const [installStateRefreshSeq, setInstallStateRefreshSeq] = useState(0)
  const [cachedManifestCount, setCachedManifestCount] = useState<number>(0)
  const [downloadProgress, setDownloadProgress] = useState<number>(0)
  const [currentDepotText, setCurrentDepotText] = useState<string>('')
  const [statusMessage, setStatusMessage] = useState<string>('')
  const [downloadLogs, setDownloadLogs] = useState<string[]>([])
  const [downloadSuccess, setDownloadSuccess] = useState<boolean | null>(null)
  const [showLogs, setShowLogs] = useState<boolean>(true)

  const terminalBodyRef = useRef<HTMLDivElement>(null)
  const detailRequestSeqRef = useRef(0)

  // Load catalog on mount
  const fetchCatalog = async () => {
    setLoadingCatalog(true)
    setCatalogError(null)
    try {
      const items = await invoke<DepotGameItem[]>('depot_downloader_get_catalog')
      setCatalog(items)
    } catch (err: any) {
      setCatalogError(err?.toString() || 'Lá»—i táº£i danh má»¥c kho Depot.')
    } finally {
      setLoadingCatalog(false)
    }
  }

  useEffect(() => {
    if (activeSubTab === 'curated_hf') {
      fetchCatalog()
    }
  }, [activeSubTab])

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setDepotSearchOverlayOpen(true)
      }
    }
    window.addEventListener('keydown', handleSearchShortcut)
    return () => window.removeEventListener('keydown', handleSearchShortcut)
  }, [])

  // Check ongoing status
  useEffect(() => {
    invoke<DepotDownloaderStatus>('depot_downloader_get_status')
      .then((status) => {
        if (status.isDownloading || status.isPaused) {
          setIsDownloading(status.isDownloading)
          setIsPaused(status.isPaused)
          if (status.destinationDir) setTargetDir(status.destinationDir)
          if (status.activeBuildId) setSelectedBuildId(status.activeBuildId)
        }
      })
      .catch(() => {})
  }, [])

  // Listen for progress events
  useEffect(() => {
    const unlisten = listen<DepotDownloadProgressEvent>('depot-download-progress', (event) => {
      const payload = event.payload
      if (!payload) return

      if (payload.eventType === 'start' || payload.eventType === 'resumed') {
        setIsDownloading(true)
        setIsPaused(false)
        setDownloadSuccess(null)
        setDownloadProgress(0)
        setStatusMessage(payload.message || 'Báº¯t Ä‘áº§u táº£i...')
      } else if (payload.eventType === 'depot-start') {
        setCurrentDepotText(payload.message || `Äang táº£i depot ${payload.depotId}...`)
        if (payload.progressPercent != null) {
          setDownloadProgress(payload.progressPercent)
        }
      } else if (payload.eventType === 'log') {
        if (payload.message) {
          setDownloadLogs((prev) => [...prev.slice(-300), payload.message!])
        }
        if (payload.progressPercent != null) {
          setDownloadProgress(payload.progressPercent)
        }
      } else if (payload.eventType === 'depot-done') {
        if (payload.progressPercent != null) {
          setDownloadProgress(payload.progressPercent)
        }
      } else if (payload.eventType === 'paused') {
        setIsDownloading(false)
        setIsPaused(true)
        setDownloadSuccess(null)
        setStatusMessage(payload.message || (isVi ? 'ÄĂ£ táº¡m dá»«ng. Dá»¯ liá»‡u hiá»‡n cĂ³ Ä‘Æ°á»£c giá»¯ nguyĂªn.' : 'Paused. Existing data is preserved.'))
      } else if (payload.eventType === 'complete') {
        setIsDownloading(false)
        setIsPaused(false)
        setDownloadProgress(100)
        setDownloadSuccess(true)
        setStatusMessage(payload.message || 'Táº£i hoĂ n táº¥t thĂ nh cĂ´ng!')
        setInstallStateRefreshSeq((value) => value + 1)
      } else if (payload.eventType === 'error') {
        setIsDownloading(false)
        setIsPaused(false)
        setDownloadSuccess(false)
        setStatusMessage(payload.message || 'Lá»—i táº£i depot.')
      } else if (payload.eventType === 'cancelled') {
        setIsDownloading(false)
        setIsPaused(false)
        setDownloadSuccess(false)
        setStatusMessage(payload.message || 'ÄĂ£ há»§y táº£i.')
      }
    })

    return () => {
      unlisten.then((fn) => fn()).catch(() => {})
    }
  }, [isVi])

  // Read launcher-owned committed BuildID metadata for this working copy.
  // DepotDownloader's own .DepotDownloader/depot.config remains untouched and
  // authoritative for its chunk/manifest resume logic.
  useEffect(() => {
    if (!gameDetail || !targetDir.trim()) {
      setInstallState(null)
      return
    }

    let disposed = false
    invoke<DepotInstallState>('depot_downloader_get_install_state', {
      appid: gameDetail.appid,
      destinationDir: targetDir,
    })
      .then((state) => {
        if (!disposed) setInstallState(state)
      })
      .catch(() => {
        if (!disposed) setInstallState(null)
      })

    return () => {
      disposed = true
    }
  }, [gameDetail, targetDir, installStateRefreshSeq])

  // Query how many manifests are cached locally for the selected build (offline-ready check)
  useEffect(() => {
    if (!selectedBuildId || !targetDir.trim()) {
      setCachedManifestCount(0)
      return
    }
    let disposed = false
    invoke<{ depotId: number; manifestGid: string; manifestFile: string }[]>(
      'depot_downloader_get_cached_manifests',
      { buildId: selectedBuildId, destinationDir: targetDir },
    )
      .then((list) => {
        if (!disposed) setCachedManifestCount(list.length)
      })
      .catch(() => {
        if (!disposed) setCachedManifestCount(0)
      })
    return () => {
      disposed = true
    }
  }, [selectedBuildId, targetDir, installStateRefreshSeq])

  // Keep live log scrolling inside the terminal only so ancestor containers never move.
  useEffect(() => {
    if (!showLogs || !terminalBodyRef.current) return
    terminalBodyRef.current.scrollTop = terminalBodyRef.current.scrollHeight
  }, [downloadLogs, showLogs])

  // Select a game from catalog. The request sequence prevents a slower
  // response from a previous click from overwriting the current selection.
  const handleSelectGame = async (game: DepotGameItem) => {
    if (isDownloading || isPaused) return
    const requestId = ++detailRequestSeqRef.current

    setSelectedGame(game)
    setGameDetail(null)
    setSelectedBuildId('')
    setInstallState(null)
    setLoadingDetail(true)
    setDetailError(null)
    setDownloadSuccess(null)
    setStatusMessage('')
    setCurrentDepotText('')
    setDownloadLogs([])

    // Default target path â€” use the launcher's configured library root
    const safeTitle = game.title.replace(/[\/:*?"<>|]/g, '_').trim()
    const libraryBase = defaultLibraryRoot.replace(/[\\/]+$/, '')
    setTargetDir(`${libraryBase}\\${safeTitle}`)

    try {
      const detail = await invoke<DepotGameDetail>('depot_downloader_get_game_detail', {
        appid: game.appid,
        folderName: game.folderName,
      })
      if (detailRequestSeqRef.current !== requestId) return

      setGameDetail(detail)
      if (detail.builds.length > 0) {
        setSelectedBuildId(detail.builds[0].buildId)
      }
    } catch (err: any) {
      if (detailRequestSeqRef.current !== requestId) return
      setDetailError(err?.toString() || 'KhĂ´ng thá»ƒ láº¥y thĂ´ng tin phiĂªn báº£n game.')
    } finally {
      if (detailRequestSeqRef.current === requestId) {
        setLoadingDetail(false)
      }
    }
  }

  // Browse destination folder
  const handleBrowseDir = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: isVi ? 'Chá»n thÆ° má»¥c lÆ°u game' : 'Select Game Destination Directory',
      })
      if (selected && typeof selected === 'string') {
        setTargetDir(selected)
      }
    } catch (e) {
      console.error('Directory browse failed:', e)
    }
  }

  // Start from one canonical detail snapshot. This prevents a game card from
  // being combined with a BuildID resolved for a different game.
  const handleStartDownload = async () => {
    if (!gameDetail || !selectedBuildId || !targetDir) return
    const build = gameDetail.builds.find((item) => item.buildId === selectedBuildId)
    if (!build) {
      setDownloadSuccess(false)
      setStatusMessage(
        isVi
          ? 'Build Ä‘Ă£ chá»n khĂ´ng cĂ²n thuá»™c game hiá»‡n táº¡i. HĂ£y chá»n láº¡i phiĂªn báº£n.'
          : 'The selected build no longer belongs to this game. Please select the build again.',
      )
      return
    }

    setIsDownloading(true)
    setIsPaused(false)
    setDownloadSuccess(null)
    setDownloadLogs([])
    setDownloadProgress(0)
    setStatusMessage(isVi ? 'Äang khá»Ÿi cháº¡y tiáº¿n trĂ¬nh táº£i...' : 'Starting download pipeline...')

    try {
      await invoke('depot_downloader_start_download', {
        appid: gameDetail.appid,
        folderName: gameDetail.folderName,
        buildId: build.buildId,
        destinationDir: targetDir,
        maxDownloads: maxConcurrency,
        verifyAll,
      })
    } catch (err: any) {
      setIsDownloading(false)
      setIsPaused(false)
      setDownloadSuccess(false)
      setStatusMessage(err?.toString() || (isVi ? 'KhĂ´ng thá»ƒ báº¯t Ä‘áº§u táº£i.' : 'Failed to start download.'))
    }
  }

  // Pause keeps game files, .DepotDownloader, staging and cached manifests.
  // Resume launches the exact same immutable job; DepotDownloader then verifies
  // the interrupted working copy and reuses chunks that are already valid.
  const handlePauseDownload = async () => {
    try {
      await invoke('depot_downloader_pause_download')
      setStatusMessage(isVi ? 'Äang táº¡m dá»«ng an toĂ n...' : 'Pausing safely...')
    } catch (err: any) {
      setStatusMessage(err?.toString() || (isVi ? 'KhĂ´ng thá»ƒ táº¡m dá»«ng.' : 'Could not pause download.'))
    }
  }

  const handleResumeDownload = async () => {
    try {
      await invoke('depot_downloader_resume_download')
      setIsPaused(false)
      setIsDownloading(true)
      setDownloadSuccess(null)
      setStatusMessage(isVi ? 'Äang kiá»ƒm tra dá»¯ liá»‡u Ä‘Ă£ cĂ³ vĂ  tiáº¿p tá»¥c táº£i...' : 'Verifying existing data and resuming...')
    } catch (err: any) {
      setStatusMessage(err?.toString() || (isVi ? 'KhĂ´ng thá»ƒ tiáº¿p tá»¥c táº£i.' : 'Could not resume download.'))
    }
  }

  // Cancel download
  const handleCancelDownload = async () => {
    try {
      await invoke('depot_downloader_cancel_download')
      setIsPaused(false)
      setIsDownloading(false)
      setStatusMessage(isVi ? 'Äang gá»­i yĂªu cáº§u há»§y táº£i...' : 'Sending cancel request...')
    } catch (err) {
      console.error('Cancel error:', err)
    }
  }

  // Open destination folder
  const handleOpenFolder = async () => {
    if (!targetDir) return
    try {
      await invoke('open_folder', { path: targetDir })
    } catch (e) {
      console.error('Failed to open directory:', e)
    }
  }

  // Filtered games
  const filteredCatalog = useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    if (!q) return catalog
    return catalog.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.appid.toString().includes(q) ||
        item.folderName.toLowerCase().includes(q)
    )
  }, [catalog, searchQuery])

  const selectedBuild = useMemo(() => {
    return gameDetail?.builds.find((b) => b.buildId === selectedBuildId) ?? null
  }, [gameDetail, selectedBuildId])

  const isActiveDownload = isDownloading || isPaused
  const installedBuildId = installState?.installedBuildId ?? ''
  const isVersionSwitch = Boolean(installedBuildId && selectedBuildId && installedBuildId !== selectedBuildId)
  const isCurrentBuild = Boolean(installedBuildId && selectedBuildId && installedBuildId === selectedBuildId)

  return (
    <div className="depot-downloader-container">
      {/* â”€â”€ Hidden preserved sub-nav (logic intact) â”€â”€ */}
      <div style={{ display: 'none' }}>
        <button type="button" onClick={() => setActiveSubTab('steam_direct')} />
        <button type="button" onClick={() => setActiveSubTab('curated_hf')} />
        <DepotArchiveContributions />
      </div>

      {activeSubTab === 'steam_direct' ? (
        <SteamDirectDepotView defaultLibraryRoot={defaultLibraryRoot} initialAppId={selectedAppId} />
      ) : selectedGame ? (
        /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
           GAME DETAIL PAGE â€” Epic-style 2-column layout
           â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
        <div className="store-detail-root">
          {/* Top Bar */}
          <div className="store-detail-topbar">
            <button
              type="button"
              className="store-back-btn"
              onClick={() => {
                setSelectedGame(null)
                setGameDetail(null)
                setDetailError(null)
                setDownloadSuccess(null)
                setDownloadLogs([])
              }}
              disabled={isActiveDownload}
            >
              â† {isVi ? 'Quay láº¡i' : 'Back'}
            </button>
            <span className="store-detail-breadcrumb">
              {isVi ? 'Cá»­a hĂ ng' : 'Store'} / {selectedGame.title}
            </span>
            <div className="store-detail-search-area">
              <div className="store-topbar-search" onClick={() => setDepotSearchOverlayOpen(true)}>
                <Search size={13} />
                <span>{isVi ? 'TĂ¬m kiáº¿m...' : 'Search store...'}</span>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="store-detail-tabs">
            <button type="button" className="store-tab is-active">Overview</button>
            <button type="button" className="store-tab">Depots</button>
          </div>

          {loadingDetail ? (
            <div className="store-detail-loading">
              <Loader2 size={32} className="spin" />
              <span>{isVi ? `Äang táº£i ${selectedGame.title}...` : `Loading ${selectedGame.title}...`}</span>
            </div>
          ) : detailError ? (
            <div className="store-detail-error">
              <AlertCircle size={24} />
              <span>{detailError}</span>
            </div>
          ) : gameDetail ? (
            <div className="store-detail-layout">
              {/* â”€â”€ LEFT: Main content â”€â”€ */}
              <div className="store-detail-content">
                {/* Hero image */}
                <div className="store-detail-hero">
                  {selectedGame.bannerUrl ? (
                    <img
                      src={selectedGame.bannerUrl}
                      alt={gameDetail.title}
                      className="store-detail-hero-img"
                      onError={(e) => ((e.currentTarget as HTMLElement).style.display = 'none')}
                    />
                  ) : (
                    <div className="store-detail-hero-placeholder">
                      <HardDrive size={48} />
                    </div>
                  )}
                </div>

                {/* Genre / feature tags */}
                <div className="store-detail-tags-row">
                  <div className="store-tag-group">
                    <span className="store-tag-label">{isVi ? 'Thá»ƒ loáº¡i' : 'Genres'}</span>
                    <div className="store-tag-list">
                      <span className="store-genre-tag">Steam</span>
                      <span className="store-genre-tag">AppID {gameDetail.appid}</span>
                    </div>
                  </div>
                  <div className="store-tag-group">
                    <span className="store-tag-label">{isVi ? 'TĂ­nh nÄƒng' : 'Features'}</span>
                    <div className="store-tag-list">
                      {gameDetail.hasKey ? (
                        <span className="store-feature-tag is-blue">
                          <ShieldCheck size={11} /> Depot Key Ready
                        </span>
                      ) : (
                        <span className="store-feature-tag is-grey">
                          <KeyRound size={11} /> No Key
                        </span>
                      )}
                      {cachedManifestCount > 0 && (
                        <span className="store-feature-tag is-green">
                          <span className="store-offline-pulse" />
                          {cachedManifestCount} {isVi ? 'manifest offline' : `offline manifest${cachedManifestCount > 1 ? 's' : ''}`}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Version info */}
                {selectedBuild && (
                  <div className="store-detail-section">
                    <h3 className="store-section-heading">
                      {isVi ? `BuildID ${selectedBuild.buildId} â€” Danh sĂ¡ch Depot` : `BuildID ${selectedBuild.buildId} â€” Depot Manifests`}
                    </h3>
                    <div className="store-manifests-table">
                      <div className="store-manifest-row is-header">
                        <span>Depot ID</span>
                        <span>Manifest GID</span>
                        <span>File</span>
                      </div>
                      {selectedBuild.manifests.map((m) => (
                        <div key={m.depotId} className="store-manifest-row">
                          <span className="mono">{m.depotId}</span>
                          <span className="mono">{m.manifestGid}</span>
                          <span className="mono dim">{m.manifestFile}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Download / progress area */}
                <div className="store-detail-section">
                  {isActiveDownload ? (
                    <div className="store-progress-panel">
                      <div className="store-progress-header">
                        {isPaused
                          ? <Pause size={16} />
                          : <Loader2 size={16} className="spin" />}
                        <strong>{statusMessage || (isPaused
                          ? (isVi ? 'ÄĂ£ táº¡m dá»«ng' : 'Paused')
                          : (isVi ? 'Äang táº£i...' : 'Downloading...'))}</strong>
                        <span className="store-progress-pct">{downloadProgress.toFixed(1)}%</span>
                      </div>
                      {currentDepotText && (
                        <div className="store-progress-sub">{currentDepotText}</div>
                      )}
                      <div className="store-progress-bar-track">
                        <div
                          className={`store-progress-bar-fill ${isPaused ? '' : 'is-animated'}`}
                          style={{ width: `${Math.max(1, Math.min(100, downloadProgress))}%` }}
                        />
                      </div>
                      <div className="store-progress-controls">
                        {isPaused ? (
                          <button type="button" className="store-btn-resume" onClick={handleResumeDownload}>
                            <Play size={14} /> {isVi ? 'Tiáº¿p tá»¥c' : 'Resume'}
                          </button>
                        ) : (
                          <button type="button" className="store-btn-pause" onClick={handlePauseDownload}>
                            <Pause size={14} /> {isVi ? 'Táº¡m dá»«ng' : 'Pause'}
                          </button>
                        )}
                        <button type="button" className="store-btn-cancel" onClick={handleCancelDownload}>
                          <XCircle size={14} /> {isVi ? 'Há»§y' : 'Cancel'}
                        </button>
                        <button type="button" className="store-btn-ghost" onClick={() => setShowLogs(!showLogs)}>
                          <Terminal size={13} /> {showLogs ? (isVi ? 'áº¨n log' : 'Hide logs') : (isVi ? 'Hiá»‡n log' : 'Show logs')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {downloadSuccess === true && (
                        <div className="store-success-banner">
                          <CheckCircle2 size={18} />
                          <div>
                            <strong>{isVi ? 'Táº£i hoĂ n táº¥t!' : 'Download complete!'}</strong>
                            <span>{isVi ? 'Táº¥t cáº£ depot Ä‘Ă£ ghi xong vĂ o thÆ° má»¥c Ä‘Ă­ch.' : 'All depots written to destination.'}</span>
                          </div>
                          <button type="button" className="store-btn-ghost" onClick={handleOpenFolder}>
                            <ExternalLink size={13} /> {isVi ? 'Má»Ÿ thÆ° má»¥c' : 'Open folder'}
                          </button>
                        </div>
                      )}
                      {downloadSuccess === false && (
                        <div className="store-error-banner">
                          <XCircle size={18} />
                          <div>
                            <strong>{isVi ? 'Táº£i tháº¥t báº¡i.' : 'Download failed.'}</strong>
                            <span>{statusMessage}</span>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* Console terminal */}
                  {showLogs && downloadLogs.length > 0 && (
                    <div className="store-terminal">
                      <div className="store-terminal-bar">
                        <div className="term-dot red" /><div className="term-dot yellow" /><div className="term-dot green" />
                        <span>DepotDownloaderMod</span>
                        <button type="button" className="store-btn-ghost ml-auto" onClick={() => setShowLogs(false)}>
                          <XCircle size={12} />
                        </button>
                      </div>
                      <div className="store-terminal-body" ref={terminalBodyRef}>
                        {downloadLogs.map((line, idx) => (
                          <div key={idx} className="store-log-line">{line}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* â”€â”€ RIGHT: Sidebar â”€â”€ */}
              <aside className="store-detail-sidebar">
                {/* Game thumbnail */}
                {selectedGame.bannerUrl && (
                  <div className="store-sidebar-thumb">
                    <img
                      src={selectedGame.bannerUrl}
                      alt={gameDetail.title}
                      onError={(e) => ((e.currentTarget as HTMLElement).style.display = 'none')}
                    />
                  </div>
                )}

                {/* Version switcher */}
                {installedBuildId && (
                  <div className={`store-version-chip ${isVersionSwitch ? 'is-switch' : 'is-current'}`}>
                    <ArrowRightLeft size={13} />
                    {isVersionSwitch
                      ? (isVi ? `Äá»•i ${installedBuildId} â†’ ${selectedBuildId}` : `Switch ${installedBuildId} â†’ ${selectedBuildId}`)
                      : (isVi ? `ÄĂ£ cĂ i BuildID ${installedBuildId}` : `Installed: BuildID ${installedBuildId}`)}
                  </div>
                )}

                {/* Build selector */}
                {gameDetail.builds.length > 0 ? (
                  <div className="store-sidebar-field">
                    <label className="store-sidebar-label">{isVi ? 'PhiĂªn báº£n' : 'Version'}</label>
                    <select
                      value={selectedBuildId}
                      onChange={(e) => setSelectedBuildId(e.target.value)}
                      disabled={isActiveDownload}
                      className="store-sidebar-select"
                    >
                      {gameDetail.builds.map((build, idx) => (
                        <option key={build.buildId} value={build.buildId}>
                          {idx === 0 ? 'â˜… ' : ''}BuildID {build.buildId}
                          {build.version ? ` (${build.version})` : ''}
                          {build.buildDate ? ` Â· ${build.buildDate}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="store-sidebar-warn">
                    <AlertCircle size={14} />
                    <span>{isVi ? 'KhĂ´ng cĂ³ BuildID' : 'No BuildIDs found'}</span>
                  </div>
                )}

                {/* Destination dir */}
                <div className="store-sidebar-field">
                  <label className="store-sidebar-label">{isVi ? 'ThÆ° má»¥c cĂ i Ä‘áº·t' : 'Install directory'}</label>
                  <div className="store-dir-row">
                    <input
                      type="text"
                      value={targetDir}
                      onChange={(e) => setTargetDir(e.target.value)}
                      disabled={isActiveDownload}
                      placeholder="D:\Games\GameName"
                      className="store-dir-input"
                    />
                    <button
                      type="button"
                      onClick={handleBrowseDir}
                      disabled={isActiveDownload}
                      className="store-dir-browse"
                      title={isVi ? 'Chá»n thÆ° má»¥c' : 'Browse'}
                    >
                      <Folder size={14} />
                    </button>
                  </div>
                </div>

                {/* Concurrency */}
                <div className="store-sidebar-field">
                  <label className="store-sidebar-label">Threads</label>
                  <select
                    value={maxConcurrency}
                    onChange={(e) => setMaxConcurrency(Number(e.target.value))}
                    disabled={isActiveDownload}
                    className="store-sidebar-select"
                  >
                    <option value={16}>16 â€” {isVi ? 'TiĂªu chuáº©n' : 'Standard'}</option>
                    <option value={32}>32 â€” {isVi ? 'Nhanh' : 'Fast'}</option>
                    <option value={64}>64 â€” {isVi ? 'KhuyĂªn dĂ¹ng' : 'Recommended'}</option>
                    <option value={128}>128 â€” {isVi ? 'Cá»±c nhanh' : 'High Performance'}</option>
                    <option value={256}>256 â€” {isVi ? 'Tá»‘i Ä‘a' : 'Maximum'}</option>
                  </select>
                </div>

                {/* Verify checkbox */}
                <label className="store-sidebar-check">
                  <input
                    type="checkbox"
                    checked={verifyAll || isVersionSwitch}
                    onChange={(e) => setVerifyAll(e.target.checked)}
                    disabled={isActiveDownload || isVersionSwitch}
                  />
                  <span>--verify-all</span>
                </label>

                {/* Primary CTA */}
                <button
                  type="button"
                  onClick={handleStartDownload}
                  disabled={isActiveDownload || !selectedBuildId || !targetDir || !gameDetail.hasKey}
                  className="store-cta-btn"
                >
                  {isActiveDownload
                    ? <Loader2 size={16} className="spin" />
                    : isVersionSwitch
                      ? <ArrowRightLeft size={16} />
                      : <Download size={16} />}
                  <span>
                    {isActiveDownload
                      ? (isVi ? 'Äang táº£i...' : 'Downloading...')
                      : isVersionSwitch
                        ? (isVi ? `Äá»•i sang BuildID ${selectedBuildId}` : `Switch to BuildID ${selectedBuildId}`)
                        : isCurrentBuild
                          ? (isVi ? 'XĂ¡c minh / Sá»­a' : 'Verify / Repair')
                          : (isVi ? 'Táº£i game' : 'Download')}
                  </span>
                </button>

                {!gameDetail.hasKey && (
                  <div className="store-sidebar-nokey">
                    <KeyRound size={13} />
                    <span>{isVi ? 'KhĂ´ng cĂ³ depot key â€” khĂ´ng thá»ƒ táº£i' : 'No depot key â€” cannot download'}</span>
                  </div>
                )}

                {targetDir && (
                  <button type="button" className="store-open-folder-btn" onClick={handleOpenFolder}>
                    <Folder size={14} />
                    <span>{isVi ? 'Má»Ÿ thÆ° má»¥c' : 'Open folder'}</span>
                  </button>
                )}

                <div className="store-sidebar-divider" />

                {/* Metadata */}
                <div className="store-meta-table">
                  <div className="store-meta-row">
                    <span className="store-meta-key">AppID</span>
                    <span className="store-meta-val mono">{gameDetail.appid}</span>
                  </div>
                  <div className="store-meta-row">
                    <span className="store-meta-key">{isVi ? 'Depot' : 'Depots'}</span>
                    <span className="store-meta-val">{selectedBuild ? selectedBuild.manifests.length : gameDetail.builds[0]?.manifests.length ?? 'â€”'}</span>
                  </div>
                  <div className="store-meta-row">
                    <span className="store-meta-key">{isVi ? 'Key' : 'Depot Key'}</span>
                    <span className={`store-meta-val ${gameDetail.hasKey ? 'is-green' : 'is-red'}`}>
                      {gameDetail.hasKey ? (isVi ? 'âœ“ Sáºµn sĂ ng' : 'âœ“ Ready') : (isVi ? 'âœ— Thiáº¿u' : 'âœ— Missing')}
                    </span>
                  </div>
                  {installedBuildId && (
                    <div className="store-meta-row">
                      <span className="store-meta-key">{isVi ? 'ÄĂ£ cĂ i' : 'Installed'}</span>
                      <span className="store-meta-val mono">BuildID {installedBuildId}</span>
                    </div>
                  )}
                  {cachedManifestCount > 0 && (
                    <div className="store-meta-row">
                      <span className="store-meta-key">Offline</span>
                      <span className="store-meta-val is-green">{cachedManifestCount} manifest{cachedManifestCount > 1 ? 's' : ''}</span>
                    </div>
                  )}
                  <div className="store-meta-row">
                    <span className="store-meta-key">{isVi ? 'ThÆ° má»¥c' : 'Folder'}</span>
                    <span className="store-meta-val dim">{gameDetail.folderName}</span>
                  </div>
                </div>
              </aside>
            </div>
          ) : null}
        </div>
      ) : (
        /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
           STORE BROWSE PAGE â€” Epic-style hero + grid
           â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
        <div className="store-browse-root">
          {/* Top bar */}
          <div className="store-browse-topbar">
            <div className="store-topbar-search" onClick={() => setDepotSearchOverlayOpen(true)}>
              <Search size={13} />
              <span>{isVi ? 'TĂ¬m kiáº¿m game...' : 'Search store...'}</span>
            </div>
            <nav className="store-topbar-nav">
              <button type="button" className="store-topnav-btn is-active">{isVi ? 'KhĂ¡m phĂ¡' : 'Discover'}</button>
              <button type="button" className="store-topnav-btn">{isVi ? 'Duyá»‡t' : 'Browse'}</button>
            </nav>
            <button
              type="button"
              className="store-topbar-refresh"
              onClick={fetchCatalog}
              disabled={loadingCatalog}
              title={isVi ? 'LĂ m má»›i' : 'Refresh'}
            >
              <RefreshCw size={14} className={loadingCatalog ? 'spin' : ''} />
            </button>
          </div>

          {/* Search overlay */}
          <UnifiedSearchOverlay
            open={depotSearchOverlayOpen}
            query={searchQuery}
            onQueryChange={setSearchQuery}
            onClose={() => setDepotSearchOverlayOpen(false)}
            onSubmit={() => setDepotSearchOverlayOpen(false)}
            placeholder={isVi ? 'TĂ¬m kiáº¿m game hoáº·c AppID...' : 'Search game or AppID...'}
            ariaLabel={isVi ? 'TĂ¬m kiáº¿m Depot Downloader' : 'Search Depot Downloader'}
            resultCount={filteredCatalog.length}
            resultsHint={isVi ? 'Kho build vĂ  depot hiá»‡n cĂ³' : 'Available clean build and depot catalog'}
            discoveryTitle={isVi ? 'Game trong kho Depot' : 'Depot catalog discovery'}
            discoveryHint={isVi ? 'TĂ¬m theo tĂªn game, AppID hoáº·c tĂªn thÆ° má»¥c.' : 'Search by game title, Steam AppID, or repository folder name.'}
            historyKey="0xo.depotDownloaderSearchHistory"
          >
            {filteredCatalog.length ? filteredCatalog.slice(0, 36).map((item) => (
              <UnifiedSearchResult
                key={`depot-search-${item.appid}`}
                title={item.title}
                subtitle={`AppID ${item.appid}`}
                matchLabel={item.folderName}
                imageUrl={item.bannerUrl || null}
                onClick={() => {
                  handleSelectGame(item)
                  setDepotSearchOverlayOpen(false)
                }}
              />
            )) : (
              <div className="store-search-empty">
                <Search size={28} />
                <strong>{isVi ? 'KhĂ´ng cĂ³ game phĂ¹ há»£p' : 'No matching games'}</strong>
                <span>{isVi ? 'Thá»­ tĂªn khĂ¡c hoáº·c nháº­p AppID chĂ­nh xĂ¡c.' : 'Try another title or exact Steam AppID.'}</span>
              </div>
            )}
          </UnifiedSearchOverlay>

          {loadingCatalog ? (
            <div className="store-browse-loading">
              <Loader2 size={36} className="spin" />
              <span>{isVi ? 'Äang táº£i kho game...' : 'Loading catalog...'}</span>
            </div>
          ) : catalogError ? (
            <div className="store-browse-error">
              <AlertCircle size={28} />
              <span>{catalogError}</span>
              <button type="button" onClick={fetchCatalog} className="store-btn-retry">
                {isVi ? 'Thá»­ láº¡i' : 'Retry'}
              </button>
            </div>
          ) : (
            <>
              {/* Hero Banner â€” first game in catalog */}
              {filteredCatalog.length > 0 && (
                <div className="store-hero-banner">
                  <div className="store-hero-art">
                    {filteredCatalog[0].bannerUrl ? (
                      <img
                        src={filteredCatalog[0].bannerUrl}
                        alt={filteredCatalog[0].title}
                        onError={(e) => ((e.currentTarget as HTMLElement).style.display = 'none')}
                      />
                    ) : (
                      <div className="store-hero-placeholder"><HardDrive size={64} /></div>
                    )}
                  </div>
                  <div className="store-hero-info">
                    <div className="store-hero-eyebrow">{isVi ? 'CĂ“ Sáº´N NGAY' : 'AVAILABLE NOW'}</div>
                    <h2 className="store-hero-title">{filteredCatalog[0].title}</h2>
                    <p className="store-hero-sub">AppID {filteredCatalog[0].appid} Â· {filteredCatalog[0].folderName}</p>
                    <button
                      type="button"
                      className="store-hero-cta"
                      onClick={() => handleSelectGame(filteredCatalog[0])}
                    >
                      {isVi ? 'Táº£i ngay â†’' : 'Download â†’'}
                    </button>
                  </div>
                </div>
              )}

              {/* Games grid */}
              <div className="store-section">
                <div className="store-section-header">
                  <h3 className="store-section-title">{isVi ? 'Game cĂ³ sáºµn' : 'Available Games'}</h3>
                  <span className="store-section-count">{filteredCatalog.length} {isVi ? 'game' : 'games'}</span>
                </div>

                {filteredCatalog.length === 0 ? (
                  <div className="store-grid-empty">
                    <HardDrive size={40} />
                    <p>{isVi ? 'KhĂ´ng tĂ¬m tháº¥y game nĂ o.' : 'No games found.'}</p>
                  </div>
                ) : (
                  <div className="store-game-grid">
                    {filteredCatalog.map((item) => (
                      <button
                        key={item.appid}
                        type="button"
                        className="store-game-card"
                        onClick={() => handleSelectGame(item)}
                      >
                        <div className="store-card-art">
                          {item.bannerUrl ? (
                            <img
                              src={item.bannerUrl}
                              alt={item.title}
                              onError={(e) => ((e.currentTarget as HTMLElement).style.display = 'none')}
                            />
                          ) : (
                            <div className="store-card-art-placeholder">
                              <HardDrive size={28} />
                            </div>
                          )}
                          <div className="store-card-appid-badge">AppID {item.appid}</div>
                        </div>
                        <div className="store-card-info">
                          <strong className="store-card-title">{item.title}</strong>
                          <span className="store-card-sub">{item.folderName}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
