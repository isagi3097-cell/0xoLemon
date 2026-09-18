import { useState, useMemo, useRef, useEffect } from 'react'
import {
  X,
  Download,
  Folder,
  HardDrive,
  CheckCircle2,
  AlertTriangle,
  Languages,
  CheckSquare,
  Square,
  Zap,
  Loader2,
  ChevronDown,
  Check,
  ShieldAlert,
} from 'lucide-react'
import { formatBytes } from '../lib/format'
import type { SteamAppDepotInfo, DiskSpaceInfo, SteamVersionHistoryItem } from '../types'
import './DepotInstallModal.css'

export interface DepotInstallModalProps {
  isOpen: boolean
  onClose: () => void
  appInfo: SteamAppDepotInfo
  gameName: string
  capsuleImage?: string
  heroImage?: string
  targetDir: string
  setTargetDir: (dir: string) => void
  onBrowseDir: () => void
  diskSpace: DiskSpaceInfo | null
  selectedDepotIds: Set<number>
  toggleDepot: (depotId: number) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  onSelectKeyed?: () => void
  selectedBranch: string
  onSelectBranch: (branch: string) => void
  selectedHistoryVersion: string
  onSelectHistoryVersion: (buildId: string) => void
  versionHistory: SteamVersionHistoryItem[]
  maxConcurrency: number
  setMaxConcurrency: (val: number) => void
  verifyAll: boolean
  setVerifyAll: (val: boolean) => void
  isSyncingHubcap: boolean
  onSyncHubcap: () => void
  isDownloading: boolean
  onStartDownload: () => void
  isVi: boolean
}

const CONCURRENCY_OPTIONS = [
  { value: 4 },
  { value: 8 },
  { value: 16 },
  { value: 32 },
  { value: 64 },
]

export const ALL_STEAM_LANGUAGES = [
  { code: 'english', label: 'English', viLabel: 'Tiếng Anh' },
  { code: 'vietnamese', label: 'Tiếng Việt', viLabel: 'Tiếng Việt' },
  { code: 'schinese', label: '简体中文', viLabel: 'Trung (Giản thể)' },
  { code: 'tchinese', label: '繁體中文', viLabel: 'Trung (Phồn thể)' },
  { code: 'japanese', label: '日本語', viLabel: 'Tiếng Nhật' },
  { code: 'koreana', label: '한국어', viLabel: 'Tiếng Hàn' },
  { code: 'french', label: 'Français', viLabel: 'Tiếng Pháp' },
  { code: 'german', label: 'Deutsch', viLabel: 'Tiếng Đức' },
  { code: 'spanish', label: 'Español', viLabel: 'Tây Ban Nha' },
  { code: 'russian', label: 'Русский', viLabel: 'Tiếng Nga' },
  { code: 'portuguese', label: 'Português', viLabel: 'Bồ Đào Nha' },
  { code: 'brazilian', label: 'Português-BR', viLabel: 'Bồ Đào Nha (BR)' },
  { code: 'polish', label: 'Polski', viLabel: 'Tiếng Ba Lan' },
  { code: 'italian', label: 'Italiano', viLabel: 'Tiếng Ý' },
  { code: 'thai', label: 'ไทย', viLabel: 'Tiếng Thái' },
]

export function DepotInstallModal({
  isOpen,
  onClose,
  appInfo,
  gameName,
  capsuleImage,
  heroImage,
  targetDir,
  setTargetDir,
  onBrowseDir,
  diskSpace,
  selectedDepotIds,
  toggleDepot,
  onSelectAll,
  onDeselectAll,
  onSelectKeyed,
  selectedBranch,
  onSelectBranch,
  selectedHistoryVersion,
  onSelectHistoryVersion,
  versionHistory,
  maxConcurrency,
  setMaxConcurrency,
  verifyAll,
  setVerifyAll,
  isSyncingHubcap,
  onSyncHubcap,
  isDownloading,
  onStartDownload,
  isVi,
}: DepotInstallModalProps) {
  const [showHistoryMenu, setShowHistoryMenu] = useState(false)
  const [showConcurrencyMenu, setShowConcurrencyMenu] = useState(false)
  const [depotFilter, setDepotFilter] = useState<'all' | 'base' | 'dlc'>('all')
  const [selectedLanguage, setSelectedLanguage] = useState<string>('all')
  const [isAllocating, setIsAllocating] = useState(false)
  const [allocatingProgress, setAllocatingProgress] = useState(0)

  useEffect(() => {
    if (!isAllocating) return
    const timer1 = window.setTimeout(() => setAllocatingProgress(55), 350)
    const timer2 = window.setTimeout(() => setAllocatingProgress(88), 850)
    const timer3 = window.setTimeout(() => setAllocatingProgress(100), 1250)
    const timer4 = window.setTimeout(() => {
      setIsAllocating(false)
      onStartDownload()
      onClose()
    }, 1500)
    return () => {
      window.clearTimeout(timer1)
      window.clearTimeout(timer2)
      window.clearTimeout(timer3)
      window.clearTimeout(timer4)
    }
  }, [isAllocating, onStartDownload, onClose])

  const concurrencyRef = useRef<HTMLDivElement>(null)

  const availableLanguageCodes = useMemo(() => {
    const set = new Set<string>()
    for (const d of appInfo.depots) {
      if (d.language) {
        set.add(d.language.toLowerCase().trim())
      }
    }
    return set
  }, [appInfo.depots])

  const availableBranchNames = useMemo(() => {
    const set = new Set<string>(['public'])
    for (const d of appInfo.depots) {
      if (d.manifests) {
        for (const k of Object.keys(d.manifests)) {
          set.add(k)
        }
      }
    }
    return set
  }, [appInfo.depots])

  const filteredDepots = useMemo(() => {
    return appInfo.depots.filter((d) => {
      if (depotFilter === 'base' && d.dlcAppid) return false
      if (depotFilter === 'dlc' && !d.dlcAppid) return false
      if (selectedLanguage !== 'all') {
        if (d.language && d.language.toLowerCase().trim() !== selectedLanguage) {
          return false
        }
      }
      return true
    })
  }, [appInfo.depots, depotFilter, selectedLanguage])

  const requiredBytes = useMemo(() => {
    return appInfo.depots
      .filter((d) => selectedDepotIds.has(d.depotId))
      .reduce((sum, d) => sum + (d.size || 0), 0)
  }, [appInfo.depots, selectedDepotIds])

  const downloadBytes = useMemo(() => {
    return appInfo.depots
      .filter((d) => selectedDepotIds.has(d.depotId))
      .reduce((sum, d) => sum + (d.downloadSize ?? d.size ?? 0), 0)
  }, [appInfo.depots, selectedDepotIds])

  const hasEnoughSpace = useMemo(() => {
    if (!diskSpace || requiredBytes === 0) return true
    return diskSpace.freeBytes >= requiredBytes
  }, [diskSpace, requiredBytes])

  const missingKeysCount = useMemo(() => {
    return appInfo.depots
      .filter((d) => selectedDepotIds.has(d.depotId) && !d.hasKey)
      .length
  }, [appInfo.depots, selectedDepotIds])

  if (!isOpen) return null

  if (isAllocating) {
    return (
      <div className="depot-modal-backdrop" role="presentation">
        <div className="depot-modal-dialog" style={{ maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
          <div className="depot-modal-header" style={{ padding: '16px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <HardDrive size={20} color="#38bdf8" />
              <h3 style={{ margin: 0, fontSize: 16, color: '#f1f5f9' }}>
                {isVi ? 'Đang chuẩn bị tải xuống - ' : 'Preparing Download - '}{gameName}
              </h3>
            </div>
          </div>
          <div className="depot-modal-body" style={{ padding: 20 }}>
            <div className="steam-allocating-container" style={{ margin: 0, padding: 20 }}>
              <div className="steam-allocating-header">
                <div className="steam-allocating-icon">
                  <HardDrive size={20} />
                </div>
                <div>
                  <div className="steam-allocating-title">
                    {isVi ? `Đang phân bổ dung lượng cho ${gameName}...` : `Allocating disk space for ${gameName}...`}
                  </div>
                  <div className="steam-allocating-subtitle">
                    {isVi ? 'Steam Direct đang chuẩn bị không gian lưu trữ và kiểm tra thư mục...' : 'Steam Direct is reserving storage and verifying directory structure...'}
                  </div>
                </div>
              </div>
              <div className="steam-allocating-bar-track">
                <div className="steam-allocating-fill" style={{ width: `${allocatingProgress}%` }} />
              </div>
              <div className="steam-allocating-meta-grid">
                <div className="steam-allocating-meta-item">
                  <small>{isVi ? 'Dung lượng cần' : 'Disk space required'}</small>
                  <strong>{formatBytes(requiredBytes)}</strong>
                </div>
                <div className="steam-allocating-meta-item">
                  <small>{isVi ? 'Dung lượng còn trống' : 'Disk space available'}</small>
                  <strong>{formatBytes(diskSpace?.freeBytes || 0)}</strong>
                </div>
                <div className="steam-allocating-meta-item" style={{ gridColumn: '1 / -1' }}>
                  <small>{isVi ? 'Thư mục cài đặt' : 'Install directory'}</small>
                  <strong style={{ wordBreak: 'break-all', fontSize: 12 }}>{targetDir}</strong>
                </div>
              </div>
            </div>
          </div>
          <div className="depot-modal-footer" style={{ padding: '12px 20px' }}>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="depot-modal-btn-cancel"
              onClick={() => setIsAllocating(false)}
            >
              {isVi ? 'Hủy bỏ' : 'Cancel'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="depot-modal-backdrop" onClick={onClose}>
      <div className="depot-modal-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="depot-modal-header">
          <div className="depot-modal-game-info">
            <img
              src={
                capsuleImage ||
                heroImage ||
                `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appInfo.appid}/header.jpg`
              }
              alt=""
              className="depot-modal-thumb"
            />
            <div>
              <div className="depot-modal-tagline">{isVi ? 'Tùy chọn tải & Cài đặt' : 'Install Options'}</div>
              <h2 className="depot-modal-title">{gameName}</h2>
              <div className="depot-modal-submeta">
                <span>AppID: <strong>{appInfo.appid}</strong></span>
                <span>•</span>
                <span>Build: <strong>{selectedHistoryVersion || appInfo.publicBuildId || 'Current'}</strong></span>
                <span>•</span>
                <span>{appInfo.depots.length} Depots</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="depot-modal-close-btn"
            onClick={onClose}
            aria-label={isVi ? 'Đóng' : 'Close'}
          >
            <X size={20} />
          </button>
        </div>

        {/* Modal Body: Scrollable Content */}
        <div className="depot-modal-body">
          {/* Branch and Version History Selection */}
          <section className="depot-modal-section">
            <div className="depot-modal-section-title">
              {isVi ? '1. Nhánh phát hành & Phiên bản (Branch & Version)' : '1. Release Branch & Version'}
            </div>

            <div className="depot-modal-version-row">
              {/* Branch Pills */}
              {appInfo.branches && appInfo.branches.length > 0 && (
                <div className="depot-modal-branches">
                  <span className="depot-modal-label">Branch:</span>
                  <div className="depot-modal-pill-group">
                    {appInfo.branches.map((b) => {
                      const isAvailable = availableBranchNames.has(b.name)
                      return (
                        <button
                          key={b.name}
                          type="button"
                          disabled={!isAvailable}
                          className={`depot-modal-pill ${selectedBranch === b.name ? 'is-active' : ''} ${!isAvailable ? 'is-disabled' : ''}`}
                          onClick={() => onSelectBranch(b.name)}
                          title={!isAvailable ? (isVi ? 'Nhánh này chưa có manifest depot' : 'No depots available for this branch') : undefined}
                        >
                          {b.name} (Build {b.buildId}){b.pwdRequired ? ' 🔒' : ''}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Version History Menu */}
              {versionHistory.length > 0 && (
                <div className="depot-modal-history-select">
                  <span className="depot-modal-label">{isVi ? 'Lịch sử Build:' : 'Build History:'}</span>
                  <div className="depot-modal-dropdown-wrap">
                    <button
                      type="button"
                      className="depot-modal-dropdown-trigger"
                      onClick={() => setShowHistoryMenu((prev) => !prev)}
                    >
                      <span>
                        {selectedHistoryVersion
                          ? `Build ${selectedHistoryVersion}`
                          : `-- ${isVi ? 'Bản mới nhất' : 'Latest'} (${appInfo.publicBuildId || 'Current'}) --`}
                      </span>
                      <ChevronDown size={14} className={`depot-modal-dropdown-arrow ${showHistoryMenu ? 'is-rotated' : ''}`} />
                    </button>

                    {showHistoryMenu && (
                      <div className="depot-modal-dropdown-menu">
                        <button
                          type="button"
                          className={`depot-modal-dropdown-item ${!selectedHistoryVersion ? 'is-selected' : ''}`}
                          onClick={() => {
                            onSelectHistoryVersion('')
                            setShowHistoryMenu(false)
                          }}
                        >
                          <span>-- {isVi ? 'Bản mới nhất' : 'Latest'} ({appInfo.publicBuildId || 'Current'}) --</span>
                          {!selectedHistoryVersion && <Check size={14} />}
                        </button>
                        {versionHistory.map((h) => {
                          const isSelected = selectedHistoryVersion === h.buildId
                          const dStr = h.timeUpdated
                            ? new Date(h.timeUpdated * 1000).toLocaleDateString()
                            : h.firstSeen
                              ? new Date(h.firstSeen * 1000).toLocaleDateString()
                              : ''
                          return (
                            <button
                              key={`${h.branch}-${h.buildId}`}
                              type="button"
                              className={`depot-modal-dropdown-item ${isSelected ? 'is-selected' : ''}`}
                              onClick={() => {
                                onSelectHistoryVersion(h.buildId)
                                setShowHistoryMenu(false)
                              }}
                            >
                              <span>
                                Build {h.buildId} ({h.branch}) {dStr ? `• ${dStr}` : ''}
                              </span>
                              {isSelected && <Check size={14} />}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {/* Supported Languages Selector */}
              <div className="depot-modal-languages-row">
                <span className="depot-modal-label">
                  <Languages size={13} />
                  <span>{isVi ? 'Gói ngôn ngữ:' : 'Language:'}</span>
                </span>
                <div className="depot-modal-lang-group">
                  <button
                    type="button"
                    className={`depot-modal-pill ${selectedLanguage === 'all' ? 'is-active' : ''}`}
                    onClick={() => setSelectedLanguage('all')}
                  >
                    {isVi ? 'Tất cả' : 'All'}
                  </button>
                  {ALL_STEAM_LANGUAGES.map((lang) => {
                    const isAvailable = availableLanguageCodes.has(lang.code)
                    const isActive = selectedLanguage === lang.code
                    return (
                      <button
                        key={lang.code}
                        type="button"
                        disabled={!isAvailable}
                        className={`depot-modal-pill ${isActive ? 'is-active' : ''} ${!isAvailable ? 'is-disabled' : ''}`}
                        onClick={() => setSelectedLanguage(isActive ? 'all' : lang.code)}
                        title={
                          isAvailable
                            ? (isVi ? `Gói ngôn ngữ: ${lang.viLabel}` : `Language pack: ${lang.label}`)
                            : (isVi ? `Game không có gói depot riêng cho ${lang.viLabel}` : `No separate depot pack for ${lang.label}`)
                        }
                      >
                        {lang.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </section>

          {/* Depots Checklist */}
          <section className="depot-modal-section">
            <div className="depot-modal-section-header">
              <div className="depot-modal-section-title">
                {isVi ? '2. Chọn gói dữ liệu cài đặt (Depots & DLCs)' : '2. Select Depots & DLCs'}
              </div>

              <div className="depot-modal-depot-controls">
                {/* Filter toggle */}
                <div className="depot-modal-sub-filters">
                  <button
                    type="button"
                    className={`depot-filter-btn ${depotFilter === 'all' ? 'is-active' : ''}`}
                    onClick={() => setDepotFilter('all')}
                  >
                    {isVi ? 'Tất cả' : 'All'}
                  </button>
                  <button
                    type="button"
                    className={`depot-filter-btn ${depotFilter === 'base' ? 'is-active' : ''}`}
                    onClick={() => setDepotFilter('base')}
                  >
                    {isVi ? 'Game gốc' : 'Base Game'}
                  </button>
                  <button
                    type="button"
                    className={`depot-filter-btn ${depotFilter === 'dlc' ? 'is-active' : ''}`}
                    onClick={() => setDepotFilter('dlc')}
                  >
                    DLCs
                  </button>
                </div>

                <div className="depot-modal-action-btns">
                  <button
                    type="button"
                    className="depot-action-btn is-check-keys"
                    onClick={onSyncHubcap}
                    disabled={isSyncingHubcap}
                    title={
                      isVi
                        ? 'Kiểm tra và lấy key từ Hubcap Free, Ryuu, LUIE, Hubcap Manifest'
                        : 'Check and fetch decryption keys from Hubcap Free, Ryuu, LUIE, Hubcap Manifest'
                    }
                  >
                    {isSyncingHubcap ? (
                      <Loader2 size={13} className="is-spinning" />
                    ) : (
                      <Zap size={13} />
                    )}
                    <span>{isVi ? 'Check Depot Keys' : 'Check Depot Keys'}</span>
                  </button>
                  {onSelectKeyed && (
                    <button
                      type="button"
                      className="depot-action-btn is-keyed"
                      onClick={onSelectKeyed}
                      title={isVi ? 'Chỉ tích chọn các depot đã có sẵn key giải mã' : 'Select only depots with decryption keys'}
                    >
                      <Check size={13} /> {isVi ? 'Tích ô có key' : 'Only Keyed'}
                    </button>
                  )}
                  <button type="button" className="depot-action-btn" onClick={onSelectAll}>
                    <CheckSquare size={13} /> {isVi ? 'Chọn hết' : 'Select All'}
                  </button>
                  <button type="button" className="depot-action-btn is-quiet" onClick={onDeselectAll}>
                    <Square size={13} /> {isVi ? 'Bỏ chọn' : 'Deselect All'}
                  </button>
                </div>
              </div>
            </div>

            {/* Depots List Table */}
            <div className="depot-modal-depots-list">
              {filteredDepots.map((depot) => {
                const isSelected = selectedDepotIds.has(depot.depotId)
                const isOtherOs = depot.os && !depot.os.toLowerCase().includes('windows')

                return (
                  <label
                    key={depot.depotId}
                    className={`depot-modal-row ${isSelected ? 'is-selected' : ''} ${
                      !depot.hasKey ? 'has-key-warning' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleDepot(depot.depotId)}
                    />

                    <div className="depot-modal-row-info">
                      <div className="depot-modal-row-title">
                        <strong>Depot {depot.depotId}{depot.name ? ` — ${depot.name}` : ''}</strong>
                        {depot.dlcAppid && (
                          <span className="depot-tag is-dlc">DLC {depot.dlcAppid}</span>
                        )}
                        {depot.language && (
                          <span className="depot-tag is-lang">
                            <Languages size={11} /> {depot.language}
                          </span>
                        )}
                        {depot.os && (
                          <span className={`depot-tag ${isOtherOs ? 'is-other-os' : 'is-os'}`}>
                            {depot.os}
                          </span>
                        )}
                        {depot.isShared && (
                          <span className="depot-tag is-shared">Shared</span>
                        )}
                      </div>

                      <div className="depot-modal-row-meta">
                        <span>Manifest: {depot.publicManifestId || 'Default'}</span>
                        {depot.downloadSize && depot.downloadSize > 0 ? (
                          <span>(Tải nén: {formatBytes(depot.downloadSize)})</span>
                        ) : null}
                        {depot.hasKey ? (
                          <span className="depot-key-status is-ok">
                            <CheckCircle2 size={12} /> Key OK
                          </span>
                        ) : (
                          <span className="depot-key-status is-warn">
                            <AlertTriangle size={12} /> {isVi ? 'Thiếu khóa' : 'Missing Key'}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="depot-modal-row-size">
                      {depot.size > 0 ? formatBytes(depot.size) : '—'}
                    </div>
                  </label>
                )
              })}
            </div>
          </section>

          {/* Directory & Disk Space */}
          <section className="depot-modal-section">
            <div className="depot-modal-section-title">
              {isVi ? '3. Thư mục cài đặt & Bộ nhớ (Storage & Location)' : '3. Install Location & Storage'}
            </div>

            <div className="depot-modal-dir-row">
              <input
                type="text"
                value={targetDir}
                onChange={(e) => setTargetDir(e.target.value)}
                className="depot-modal-dir-input"
                placeholder="E:\0xoLemon store\..."
              />
              <button
                type="button"
                className="depot-modal-browse-btn"
                onClick={onBrowseDir}
                title={isVi ? 'Chọn thư mục' : 'Browse folder'}
              >
                <Folder size={14} />
                <span>{isVi ? 'Duyệt...' : 'Browse...'}</span>
              </button>
            </div>

            {/* Disk Space Bar */}
            <div className="depot-modal-disk-box">
              <div className="depot-modal-disk-labels">
                <span>
                  <HardDrive size={13} />
                  {isVi ? 'Dung lượng cần:' : 'Needed:'} <strong>{formatBytes(requiredBytes)}</strong>
                </span>
                {diskSpace && (
                  <span className={!hasEnoughSpace ? 'is-space-error' : 'is-space-good'}>
                    {isVi ? 'Ổ đĩa còn trống:' : 'Available:'} <strong>{formatBytes(diskSpace.freeBytes)}</strong>
                  </span>
                )}
              </div>
              <div className="depot-modal-disk-track">
                <div
                  className={`depot-modal-disk-fill ${!hasEnoughSpace ? 'is-danger' : 'is-good'}`}
                  style={{
                    width:
                      diskSpace && diskSpace.freeBytes > 0
                        ? `${Math.min(100, (requiredBytes / (requiredBytes + diskSpace.freeBytes)) * 100)}%`
                        : '30%',
                  }}
                />
              </div>
              {!hasEnoughSpace && (
                <div className="depot-modal-space-alert">
                  <ShieldAlert size={14} />
                  <span>
                    {isVi
                      ? 'Cảnh báo: Ổ đĩa của bạn không đủ dung lượng để cài đặt các depot đã chọn.'
                      : 'Warning: Not enough disk space on selected drive.'}
                  </span>
                </div>
              )}
            </div>
          </section>

          {/* Missing Keys & Settings Row */}
          <section className="depot-modal-section depot-modal-advanced-row">
            {/* Missing Keys Notification */}
            {missingKeysCount > 0 ? (
              <div className="depot-modal-keys-alert">
                <div className="depot-modal-keys-text">
                  <AlertTriangle size={15} />
                  <span>
                    {isVi
                      ? `${missingKeysCount} depot đã chọn chưa có key giải mã cục bộ.`
                      : `${missingKeysCount} depots are missing local decryption keys.`}
                  </span>
                </div>
                <button
                  type="button"
                  className="depot-modal-sync-keys-btn"
                  onClick={onSyncHubcap}
                  disabled={isSyncingHubcap}
                >
                  {isSyncingHubcap ? <Loader2 size={13} className="is-spinning" /> : <Zap size={13} />}
                  <span>{isVi ? 'Lấy key từ Hubcap' : 'Sync Keys from Hubcap'}</span>
                </button>
              </div>
            ) : (
              <div className="depot-modal-keys-good">
                <CheckCircle2 size={15} />
                <span>{isVi ? 'Tất cả depot đã chọn đều có sẵn key giải mã!' : 'All selected depots have valid decryption keys!'}</span>
              </div>
            )}

            {/* Concurrency & Verify Controls */}
            <div className="depot-modal-options-group">
              <div className="depot-modal-concurrency-wrap" ref={concurrencyRef}>
                <span>{isVi ? 'Luồng tải:' : 'Concurrency:'}</span>
                <div className="depot-modal-dropdown-wrap">
                  <button
                    type="button"
                    className="depot-modal-dropdown-trigger"
                    onClick={() => setShowConcurrencyMenu((prev) => !prev)}
                  >
                    <span>{maxConcurrency} luồng</span>
                    <ChevronDown size={14} className={`depot-modal-dropdown-arrow ${showConcurrencyMenu ? 'is-rotated' : ''}`} />
                  </button>

                  {showConcurrencyMenu && (
                    <div className="depot-modal-dropdown-menu is-concurrency">
                      {CONCURRENCY_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          className={`depot-modal-dropdown-item ${maxConcurrency === opt.value ? 'is-selected' : ''}`}
                          onClick={() => {
                            setMaxConcurrency(opt.value)
                            setShowConcurrencyMenu(false)
                          }}
                        >
                          <span>{opt.value} {opt.value === 32 ? (isVi ? '(khuyên dùng)' : '(recommended)') : ''}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <label className="depot-modal-verify-toggle">
                <input
                  type="checkbox"
                  checked={verifyAll}
                  onChange={(e) => setVerifyAll(e.target.checked)}
                />
                <span>{isVi ? 'Kiểm tra tệp (Verify)' : 'Verify files'}</span>
              </label>
            </div>
          </section>
        </div>

        {/* Modal Footer: Action Bar */}
        <div className="depot-modal-footer">
          <div className="depot-modal-footer-summary">
            <span>{isVi ? 'Đã chọn:' : 'Selected:'} <strong>{selectedDepotIds.size}/{appInfo.depots.length}</strong></span>
            <span>•</span>
            <span>{isVi ? 'Dung lượng tải:' : 'Download:'} <strong>{formatBytes(downloadBytes > 0 ? downloadBytes : requiredBytes)}</strong></span>
            <span>•</span>
            <span>{isVi ? 'Cần ổ đĩa:' : 'Disk space:'} <strong>{formatBytes(requiredBytes)}</strong></span>
          </div>

          <div className="depot-modal-footer-btns">
            <button
              type="button"
              className="depot-modal-btn-cancel"
              onClick={onClose}
              disabled={isDownloading}
            >
              {isVi ? 'Hủy bỏ' : 'Cancel'}
            </button>

            <button
              type="button"
              className="depot-modal-btn-download"
              onClick={() => {
                setIsAllocating(true)
                setAllocatingProgress(15)
              }}
              disabled={isDownloading || selectedDepotIds.size === 0 || !hasEnoughSpace}
            >
              {isDownloading ? (
                <>
                  <Loader2 size={16} className="is-spinning" />
                  <span>{isVi ? 'Đang khởi động tải...' : 'Starting download...'}</span>
                </>
              ) : (
                <>
                  <Download size={16} />
                  <span>{isVi ? 'Bắt đầu tải xuống' : 'Start Download'}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
