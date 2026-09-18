/**
 * GameDownloadPanel
 *
 * Panel gộp chức năng Depot Downloader trực tiếp vào trang Store/Library.
 * UI trông như "tải bản backup" nhưng thực chất tải qua depot key.
 *
 * Mặc định: Windows | nhánh public (mới nhất) | tích full depot Windows.
 * "Tùy chọn tải nâng cao" cho phép chọn nhánh, từng depot, concurrency.
 */

import { useState, useEffect, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  AlertCircle,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Download,
  Folder,
  HardDrive,
  Loader2,
  Pause,
  Play,
  Square,
  X,
} from 'lucide-react'
import { formatBytes } from '../../lib/format'
import { loadLauncherPreferences } from '../../lib/preferences'
import { defaultDepotSelection } from '../../lib/depotSelection'
import type {
  DiskSpaceInfo,
  DepotDownloadProgressEvent,
  SelectiveDepotSelection,
  SteamAppDepotInfo,
} from '../../types'
import './GameDownloadPanel.css'

// -- Types -------------------------------------------------------------------

interface Props {
  /** Steam App ID -- panel khong render neu undefined hoac <= 0 */
  appid?: number
  /** Ten game de hien thi */
  gameName: string
  /** installDir tu steam-metadata config.installdir (neu co) */
  installDir?: string
}

const CONCURRENCY_OPTIONS = [16, 32, 64, 128]

// -- Component ----------------------------------------------------------------

export function GameDownloadPanel({ appid, gameName, installDir }: Props) {
  // -- App info / depots -------------------------------------------------------
  const [appInfo, setAppInfo] = useState<SteamAppDepotInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // -- Dir / disk --------------------------------------------------------------
  const [targetDir, setTargetDir] = useState('')
  const [diskSpace, setDiskSpace] = useState<DiskSpaceInfo | null>(null)

  // -- Depot selection ---------------------------------------------------------
  const [selectedDepotIds, setSelectedDepotIds] = useState<Set<number>>(new Set())
  const [selectedBranch, setSelectedBranch] = useState('public')

  // -- Advanced panel ----------------------------------------------------------
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [maxConcurrency, setMaxConcurrency] = useState(32)
  const [verifyAll, setVerifyAll] = useState(false)

  // -- Download state ----------------------------------------------------------
  const [isDownloading, setIsDownloading] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [currentProgress, setCurrentProgress] = useState<DepotDownloadProgressEvent | null>(null)
  const [downloadSuccess, setDownloadSuccess] = useState<boolean | null>(null)
  const [statusMessage, setStatusMessage] = useState('')

  // -- Load depot info khi appid thay doi --------------------------------------
  useEffect(() => {
    if (!appid || appid <= 0) {
      setAppInfo(null)
      setLoadError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setAppInfo(null)
    setSelectedDepotIds(new Set())

    invoke<SteamAppDepotInfo>('depot_downloader_get_steam_depots', { appid })
      .then((info) => {
        if (cancelled) return
        setAppInfo(info)

        // Auto-fill targetDir
        const prefs = loadLauncherPreferences()
        const base = prefs.defaultLibraryRoot.replace(/[/\\]+$/, '')
        const folderName =
          installDir ||
          info.installDir ||
          info.name.replace(/[/:*?"<>|]/g, '_').trim() ||
          String(appid)
        const dest = `${base}\\${folderName}`
        setTargetDir(dest)

        invoke<DiskSpaceInfo>('depot_downloader_check_disk_space', { targetPath: dest })
          .then((s) => { if (!cancelled) setDiskSpace(s) })
          .catch(() => {})

        // Auto-chon full depot Windows
        const sel = defaultDepotSelection(info.depots, 'vi', 'windows')
        setSelectedDepotIds(sel.selected)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [appid, installDir])

  // -- Progress events ---------------------------------------------------------
  useEffect(() => {
    const promise = listen<DepotDownloadProgressEvent>('depot-download-progress', (event) => {
      const p = event.payload
      if (!p) return
      setCurrentProgress(p)

      if (p.eventType === 'start' || p.eventType === 'resumed') {
        setIsDownloading(true); setIsPaused(false); setDownloadSuccess(null)
        setStatusMessage(p.message || 'Dang khoi dong tai xuong...')
      } else if (p.eventType === 'depot-start') {
        setIsDownloading(true)
        if (p.message) setStatusMessage(p.message)
      } else if (p.eventType === 'paused') {
        setIsDownloading(false); setIsPaused(true)
        setStatusMessage(p.message || 'Da tam dung')
      } else if (p.eventType === 'complete') {
        setIsDownloading(false); setIsPaused(false); setDownloadSuccess(true)
        setStatusMessage(p.message || 'Tai xuong hoan tat!')
      } else if (p.eventType === 'error') {
        setIsDownloading(false); setIsPaused(false); setDownloadSuccess(false)
        setStatusMessage(p.message || 'Loi tai xuong')
      } else if (p.eventType === 'cancelled') {
        setIsDownloading(false); setIsPaused(false); setDownloadSuccess(null)
        setStatusMessage('')
      }
    })
    return () => { promise.then((fn) => fn()).catch(() => {}) }
  }, [])

  // -- Trang thai downloader hien tai ------------------------------------------
  useEffect(() => {
    invoke<{ isDownloading: boolean; isPaused: boolean; destinationDir?: string }>(
      'depot_downloader_get_status'
    )
      .then((s) => {
        if (s.isDownloading || s.isPaused) {
          setIsDownloading(s.isDownloading)
          setIsPaused(s.isPaused)
          if (s.destinationDir) setTargetDir(s.destinationDir)
        }
      })
      .catch(() => {})
  }, [])

  // -- Disk space khi targetDir thay doi ---------------------------------------
  const checkSpace = (path: string) => {
    if (!path.trim()) { setDiskSpace(null); return }
    invoke<DiskSpaceInfo>('depot_downloader_check_disk_space', { targetPath: path })
      .then((s) => setDiskSpace(s))
      .catch(() => setDiskSpace(null))
  }

  useEffect(() => { if (targetDir) checkSpace(targetDir) }, [targetDir])

  // -- Computed ----------------------------------------------------------------
  const windowsDepots = useMemo(() => {
    if (!appInfo) return []
    const winOnly = appInfo.depots.filter(
      (d) => !d.os || d.os.toLowerCase().includes('windows')
    )
    return winOnly.length > 0 ? winOnly : appInfo.depots
  }, [appInfo])

  const requiredBytes = useMemo(() => {
    if (!appInfo) return 0
    return appInfo.depots
      .filter((d) => selectedDepotIds.has(d.depotId))
      .reduce((sum, d) => sum + (d.size || 0), 0)
  }, [appInfo, selectedDepotIds])

  // -- Handlers ----------------------------------------------------------------
  const handleBrowse = async () => {
    try {
      const sel = await openDialog({
        directory: true,
        multiple: false,
        title: 'Chon thu muc cai dat game',
        defaultPath: targetDir || undefined,
      })
      if (sel && typeof sel === 'string') setTargetDir(sel)
    } catch {}
  }

  const handleBranchChange = (branch: string) => {
    if (!appInfo) return
    setSelectedBranch(branch)
    const updatedDepots = appInfo.depots.map((d) => {
      const bm = d.manifests?.[branch]
      return {
        ...d,
        publicManifestId: bm
          ? bm.gid
          : branch === 'public'
          ? d.publicManifestId
          : undefined,
        size: bm && bm.size > 0 ? bm.size : d.size,
      }
    })
    setAppInfo({ ...appInfo, depots: updatedDepots })
    setSelectedDepotIds(
      new Set(updatedDepots.filter((d) => d.publicManifestId).map((d) => d.depotId))
    )
  }

  const toggleDepot = (depotId: number) => {
    setSelectedDepotIds((prev) => {
      const next = new Set(prev)
      if (next.has(depotId)) next.delete(depotId)
      else next.add(depotId)
      return next
    })
  }

  const handleDownload = async () => {
    if (!appInfo || selectedDepotIds.size === 0 || !targetDir.trim()) return

    const selections: SelectiveDepotSelection[] = appInfo.depots
      .filter((d) => selectedDepotIds.has(d.depotId))
      .map((d) => ({
        depotId: d.depotId,
        manifestId: d.publicManifestId,
        size: d.size,
      }))

    setIsDownloading(true)
    setIsPaused(false)
    setDownloadSuccess(null)
    setCurrentProgress(null)
    setStatusMessage('Dang khoi dong tai xuong...')

    try {
      await invoke('depot_downloader_start_selective_download', {
        appid: appInfo.appid,
        gameTitle: appInfo.name || gameName,
        selections,
        destinationDir: targetDir,
        maxDownloads: maxConcurrency,
        verifyAll,
      })
    } catch (err: any) {
      setIsDownloading(false)
      setDownloadSuccess(false)
      setStatusMessage(String(err) || 'Khong the bat dau tai')
    }
  }

  const handlePause = async () => {
    try { await invoke('depot_downloader_pause_download') } catch {}
  }

  const handleResume = async () => {
    try {
      await invoke('depot_downloader_resume_download')
      setIsPaused(false)
      setIsDownloading(true)
    } catch {}
  }

  const handleCancel = async () => {
    try {
      if (isDownloading || isPaused) await invoke('depot_downloader_cancel_download')
    } catch {} finally {
      setIsDownloading(false)
      setIsPaused(false)
      setDownloadSuccess(null)
      setCurrentProgress(null)
      setStatusMessage('')
    }
  }

  const handleOpenDir = async () => {
    if (targetDir) await invoke('open_folder', { path: targetDir }).catch(() => {})
  }

  // Khong render neu khong co appid hop le
  if (!appid || appid <= 0) return null

  const pct = currentProgress?.progressPercent ?? 0
  const speed = currentProgress?.speedMbps ?? 0
  const isActive = isDownloading || isPaused

  return (
    <section className="gdp-panel">
      {/* -- Dong thu muc -- */}
      <div className="gdp-dir-row">
        <div className="gdp-dir-label">
          <Folder size={13} aria-hidden />
          <span>Thu muc</span>
        </div>
        <div className="gdp-dir-input-wrap">
          <input
            type="text"
            className="gdp-dir-input"
            value={targetDir}
            onChange={(e) => setTargetDir(e.target.value)}
            placeholder="Chon thu muc cai dat..."
            disabled={isActive}
            aria-label="Thu muc cai dat"
          />
          <button
            type="button"
            className="gdp-dir-browse"
            onClick={handleBrowse}
            disabled={isActive}
            title="Chon thu muc"
          >
            <Folder size={13} />
          </button>
        </div>
        {diskSpace && (
          <span className="gdp-disk-info">
            <HardDrive size={12} />
            {formatBytes(diskSpace.freeBytes)} trong / {formatBytes(diskSpace.totalBytes)}
          </span>
        )}
      </div>

      {/* -- Dong tom tat + nut hanh dong -- */}
      <div className="gdp-action-row">
        <div className="gdp-summary">
          {loading && (
            <>
              <Loader2 size={13} className="gdp-spin" />
              <span>Dang tai thong tin depot...</span>
            </>
          )}
          {!loading && appInfo && !isActive && (
            <>
              <span className="gdp-summary-chip">Windows</span>
              <span className="gdp-summary-chip">
                {appInfo.publicBuildId ? `Build ${appInfo.publicBuildId}` : 'Moi nhat'}
              </span>
              <span className="gdp-summary-chip">
                {selectedDepotIds.size} depot &middot; {formatBytes(requiredBytes)}
              </span>
            </>
          )}
          {!loading && loadError && (
            <span className="gdp-load-error">
              <AlertCircle size={13} /> {loadError}
            </span>
          )}
          {isActive && statusMessage && (
            <span className="gdp-status-msg">{statusMessage}</span>
          )}
        </div>

        <div className="gdp-action-btns">
          {!isActive && (
            <button
              type="button"
              className="gdp-btn-download"
              onClick={handleDownload}
              disabled={loading || !appInfo || selectedDepotIds.size === 0 || !targetDir.trim()}
            >
              <Download size={14} />
              <span>Tai ve</span>
            </button>
          )}

          {isDownloading && !isPaused && (
            <>
              <button type="button" className="gdp-btn-pause" onClick={handlePause}>
                <Pause size={13} /> Dung
              </button>
              <button type="button" className="gdp-btn-cancel" onClick={handleCancel} title="Huy">
                <X size={13} />
              </button>
            </>
          )}

          {isPaused && (
            <>
              <button type="button" className="gdp-btn-resume" onClick={handleResume}>
                <Play size={13} /> Tiep tuc
              </button>
              <button type="button" className="gdp-btn-cancel" onClick={handleCancel} title="Huy">
                <X size={13} />
              </button>
            </>
          )}

          {downloadSuccess === true && !isActive && (
            <button type="button" className="gdp-btn-open" onClick={handleOpenDir}>
              <CheckCircle2 size={13} /> Mo thu muc
            </button>
          )}
        </div>
      </div>

      {/* -- Progress bar -- */}
      {isActive && (
        <div className="gdp-progress-wrap">
          <div className="gdp-progress-bar">
            <div className="gdp-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="gdp-progress-meta">
            <span>{pct.toFixed(1)}%</span>
            {speed > 0 && <span>{speed.toFixed(2)} MB/s</span>}
            {currentProgress?.transferredBytes != null && currentProgress?.totalBytes != null && (
              <span>
                {formatBytes(currentProgress.transferredBytes!)} / {formatBytes(currentProgress.totalBytes!)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Status bar */}
      {!isActive && statusMessage && (
        <div
          className={`gdp-status-bar${
            downloadSuccess === false ? ' is-error' : downloadSuccess === true ? ' is-success' : ''
          }`}
        >
          {downloadSuccess === true && <CheckCircle2 size={12} />}
          {downloadSuccess === false && <AlertCircle size={12} />}
          <span>{statusMessage}</span>
        </div>
      )}

      {/* -- Toggle nang cao -- */}
      {appInfo && !isActive && (
        <button
          type="button"
          className="gdp-advanced-toggle"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          Tuy chon tai nang cao
        </button>
      )}

      {/* -- Panel nang cao -- */}
      {showAdvanced && appInfo && !isActive && (
        <div className="gdp-advanced-panel">
          {appInfo.branches && appInfo.branches.length > 0 && (
            <div className="gdp-adv-row">
              <span className="gdp-adv-label">Nhanh</span>
              <select
                value={selectedBranch}
                onChange={(e) => handleBranchChange(e.target.value)}
                className="gdp-adv-select"
              >
                {appInfo.branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}{b.buildId ? ` (Build ${b.buildId})` : ''}{b.pwdRequired ? ' (khoa)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="gdp-adv-row gdp-adv-depots-row">
            <span className="gdp-adv-label">
              Depots <small>({windowsDepots.length})</small>
            </span>
            <div className="gdp-depot-list">
              {windowsDepots.map((d) => {
                const checked = selectedDepotIds.has(d.depotId)
                return (
                  <label
                    key={d.depotId}
                    className={`gdp-depot-row${checked ? ' is-checked' : ''}`}
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggleDepot(d.depotId)} />
                    {checked
                      ? <CheckSquare size={14} className="gdp-depot-chk" />
                      : <Square size={14} className="gdp-depot-chk" />}
                    <span className="gdp-depot-id">{d.depotId}</span>
                    <span className="gdp-depot-name" title={d.name}>{d.name || 'Depot'}</span>
                    {d.dlcAppid && <span className="gdp-depot-tag">DLC</span>}
                    {!d.hasKey && <span className="gdp-depot-tag is-locked">No key</span>}
                    <span className="gdp-depot-size">{formatBytes(d.size || 0)}</span>
                  </label>
                )
              })}
            </div>
          </div>

          <div className="gdp-adv-row">
            <span className="gdp-adv-label">Luong tai</span>
            <select
              value={maxConcurrency}
              onChange={(e) => setMaxConcurrency(Number(e.target.value))}
              className="gdp-adv-select"
            >
              {CONCURRENCY_OPTIONS.map((v) => (
                <option key={v} value={v}>{v} luong</option>
              ))}
            </select>
            <label className="gdp-adv-verify-label">
              <input type="checkbox" checked={verifyAll} onChange={(e) => setVerifyAll(e.target.checked)} />
              Kiem tra toan bo
            </label>
          </div>

          <button
            type="button"
            className="gdp-btn-download gdp-adv-download-btn"
            onClick={handleDownload}
            disabled={!appInfo || selectedDepotIds.size === 0 || !targetDir.trim()}
          >
            <Download size={13} />
            Tai voi lua chon nang cao ({selectedDepotIds.size} depot &middot; {formatBytes(requiredBytes)})
          </button>
        </div>
      )}
    </section>
  )
}