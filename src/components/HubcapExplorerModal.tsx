import { useState, useEffect, useCallback, useTransition } from 'react'
import {
  X,
  Compass,
  Search,
  Database,
  RefreshCw,
  FileCode,
  Layers,
  Upload,
  Download,
  AlertCircle,
  CheckCircle2,
  Copy,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Package,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { formatBytes } from '../lib/format'
import type {
  HubcapLibraryPage,
  HubcapSearchPage,
  HubcapStatusDetails,
  HubcapAppContents,
  HubcapUploadManifestResult,
  HubcapDepotKeysSummary,
} from '../types'
import './HubcapExplorerModal.css'

interface HubcapExplorerModalProps {
  isOpen: boolean
  onClose: () => void
  initialAppId?: number | null
}

export function HubcapExplorerModal({ isOpen, onClose, initialAppId }: HubcapExplorerModalProps) {
  const [activeTab, setActiveTab] = useState<'library' | 'inspector' | 'tools'>('library')
  const [, startTransition] = useTransition()

  // --- Tab 1: Library & Search State ---
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState('updated')
  const [page, setPage] = useState(1)
  const [libraryData, setLibraryData] = useState<HubcapLibraryPage | null>(null)
  const [searchData, setSearchData] = useState<HubcapSearchPage | null>(null)
  const [loadingLibrary, setLoadingLibrary] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)

  // --- Tab 2: App Inspector State ---
  const [targetAppId, setTargetAppId] = useState<string>(initialAppId ? String(initialAppId) : '')
  const [loadingInspector, setLoadingInspector] = useState(false)
  const [inspectorError, setInspectorError] = useState<string | null>(null)
  const [statusData, setStatusData] = useState<HubcapStatusDetails | null>(null)
  const [contentsData, setContentsData] = useState<HubcapAppContents | null>(null)
  const [luaSection, setLuaSection] = useState<'all' | 'basegame' | 'dlc'>('all')
  const [luaCode, setLuaCode] = useState<string | null>(null)
  const [loadingLua, setLoadingLua] = useState(false)
  const [copiedText, setCopiedText] = useState<string | null>(null)

  // --- Tab 3: Tools State ---
  const [workshopId, setWorkshopId] = useState('')
  const [workshopLoading, setWorkshopLoading] = useState(false)
  const [workshopMsg, setWorkshopMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [uploadFilePath, setUploadFilePath] = useState('')
  const [uploadDepotId, setUploadDepotId] = useState('')
  const [uploadManifestId, setUploadManifestId] = useState('')
  const [uploadOverwrite, setUploadOverwrite] = useState(false)
  const [uploadLoading, setUploadLoading] = useState(false)
  const [uploadResult, setUploadResult] = useState<HubcapUploadManifestResult | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const [depotKeysSummary, setDepotKeysSummary] = useState<HubcapDepotKeysSummary | null>(null)
  const [loadingDepotKeys, setLoadingDepotKeys] = useState(false)

  // ----------------------------------------------------
  // Tab 1: Library Load
  // ----------------------------------------------------
  const fetchLibrary = useCallback(async (targetPage: number, sort: string) => {
    setLoadingLibrary(true)
    setLibraryError(null)
    setSearchData(null)
    try {
      const offset = (targetPage - 1) * 30
      const data = await invoke<HubcapLibraryPage>('get_hubcap_library', {
        limit: 30,
        offset,
        search: null,
        sortBy: sort,
      })
      setLibraryData(data)
    } catch (err) {
      setLibraryError(String(err))
    } finally {
      setLoadingLibrary(false)
    }
  }, [])

  const executeSearch = useCallback(async () => {
    const q = searchQuery.trim()
    if (!q) {
      void fetchLibrary(1, sortBy)
      return
    }
    setLoadingLibrary(true)
    setLibraryError(null)
    try {
      const data = await invoke<HubcapSearchPage>('search_hubcap_games', {
        query: q,
        limit: 40,
        appid: /^[0-9]+$/.test(q),
      })
      setSearchData(data)
      setLibraryData(null)
    } catch (err) {
      setLibraryError(String(err))
    } finally {
      setLoadingLibrary(false)
    }
  }, [searchQuery, sortBy, fetchLibrary])

  useEffect(() => {
    if (isOpen && activeTab === 'library' && !libraryData && !searchData) {
      void fetchLibrary(1, sortBy)
    }
  }, [isOpen, activeTab, libraryData, searchData, fetchLibrary, sortBy])

  // ----------------------------------------------------
  // Tab 2: App Inspector Load
  // ----------------------------------------------------
  const inspectApp = useCallback(async (appIdNum: number) => {
    setLoadingInspector(true)
    setInspectorError(null)
    setStatusData(null)
    setContentsData(null)
    setLuaCode(null)
    try {
      const [statusRes, contentsRes] = await Promise.allSettled([
        invoke<HubcapStatusDetails>('get_hubcap_status_details', { appid: appIdNum }),
        invoke<HubcapAppContents | null>('get_hubcap_app_contents', { appid: appIdNum }),
      ])

      if (statusRes.status === 'fulfilled') {
        setStatusData(statusRes.value)
      }
      if (contentsRes.status === 'fulfilled') {
        setContentsData(contentsRes.value)
      }

      if (statusRes.status === 'rejected' && contentsRes.status === 'rejected') {
        setInspectorError('Không tìm thấy dữ liệu manifest cho App ID này.')
      }

      // Fetch Lua section
      setLoadingLua(true)
      try {
        const lua = await invoke<string>('get_hubcap_lua_section', {
          appid: appIdNum,
          section: luaSection,
        })
        setLuaCode(lua)
      } catch {
        setLuaCode(null)
      } finally {
        setLoadingLua(false)
      }
    } catch (err) {
      setInspectorError(String(err))
    } finally {
      setLoadingInspector(false)
    }
  }, [luaSection])

  const switchLuaSection = async (section: 'all' | 'basegame' | 'dlc') => {
    setLuaSection(section)
    const appIdNum = Number(targetAppId)
    if (!appIdNum || isNaN(appIdNum)) return
    setLoadingLua(true)
    try {
      const lua = await invoke<string>('get_hubcap_lua_section', {
        appid: appIdNum,
        section,
      })
      setLuaCode(lua)
    } catch (err) {
      setLuaCode(`-- Lỗi tải Lua (${section}): ${String(err)}`)
    } finally {
      setLoadingLua(false)
    }
  }

  const navigateToAppInspector = (appId: string | number) => {
    setTargetAppId(String(appId))
    setActiveTab('inspector')
    startTransition(() => {
      void inspectApp(Number(appId))
    })
  }

  // ----------------------------------------------------
  // Tab 3: Tools
  // ----------------------------------------------------
  const handleDownloadWorkshop = async () => {
    const wid = Number(workshopId.trim())
    if (!wid || isNaN(wid)) {
      setWorkshopMsg({ type: 'error', text: 'Workshop Item ID không hợp lệ' })
      return
    }
    setWorkshopLoading(true)
    setWorkshopMsg(null)
    try {
      const bytes = await invoke<number[]>('fetch_hubcap_workshop_manifest', { workshopId: wid })
      if (!bytes || bytes.length === 0) {
        throw new Error('Hubcap trả về file trống')
      }
      const u8 = new Uint8Array(bytes)
      const blob = new Blob([u8], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `workshop_${wid}.manifest`
      a.click()
      URL.revokeObjectURL(url)
      setWorkshopMsg({
        type: 'success',
        text: `Đã tạo và tải xuống thành công workshop_${wid}.manifest (${formatBytes(u8.length)})!`,
      })
    } catch (err) {
      setWorkshopMsg({ type: 'error', text: String(err) })
    } finally {
      setWorkshopLoading(false)
    }
  }

  const handleSelectUploadFile = async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        filters: [{ name: 'Steam Manifest', extensions: ['manifest'] }],
      })
      if (selected && typeof selected === 'string') {
        setUploadFilePath(selected)
        const baseName = selected.split(/[/\\]/).pop() || ''
        const match = baseName.match(/([0-9]+)_([0-9]+)/)
        if (match) {
          if (!uploadDepotId) setUploadDepotId(match[1])
          if (!uploadManifestId) setUploadManifestId(match[2])
        }
      }
    } catch (err) {
      setUploadError(String(err))
    }
  }

  const handleUploadManifest = async () => {
    if (!uploadFilePath.trim()) {
      setUploadError('Vui lòng chọn file manifest hợp lệ')
      return
    }
    setUploadLoading(true)
    setUploadError(null)
    setUploadResult(null)
    try {
      const res = await invoke<HubcapUploadManifestResult>('upload_hubcap_manifest', {
        filePath: uploadFilePath.trim(),
        depotId: uploadDepotId ? Number(uploadDepotId) : null,
        manifestId: uploadManifestId ? uploadManifestId.trim() : null,
        overwrite: uploadOverwrite,
      })
      setUploadResult(res)
    } catch (err) {
      setUploadError(String(err))
    } finally {
      setUploadLoading(false)
    }
  }

  const handleFetchDepotKeys = async () => {
    setLoadingDepotKeys(true)
    try {
      const summary = await invoke<HubcapDepotKeysSummary>('get_hubcap_depot_keys_summary')
      setDepotKeysSummary(summary)
    } catch (err) {
      console.error(err)
    } finally {
      setLoadingDepotKeys(false)
    }
  }

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedText(label)
      setTimeout(() => setCopiedText(null), 2000)
    } catch {
      // fallback
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="dialog-backdrop hubcap-modal-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="hubcap-modal-container" role="dialog" aria-modal="true">
        {/* Header */}
        <div className="hubcap-modal-header">
          <div className="hubcap-header-left">
            <div className="hubcap-icon-wrap">
              <Compass size={22} />
            </div>
            <div>
              <h2 className="hubcap-header-title">
                Hubcap Manifest Explorer & Tools
              </h2>
              <p className="hubcap-header-subtitle">
                Tra cứu 158.000+ Games, Depots, Manifests, Lua Scripts & Công cụ tải/upload
              </p>
            </div>
          </div>
          <button type="button" className="hubcap-close-btn" onClick={onClose} aria-label="Đóng">
            <X size={20} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="hubcap-tabs-nav">
          <button
            type="button"
            className={`hubcap-tab-btn ${activeTab === 'library' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('library')}
          >
            <Database size={16} />
            Thư Viện & Tìm Kiếm
          </button>
          <button
            type="button"
            className={`hubcap-tab-btn ${activeTab === 'inspector' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('inspector')}
          >
            <Layers size={16} />
            Chi Tiết App & Depots
          </button>
          <button
            type="button"
            className={`hubcap-tab-btn ${activeTab === 'tools' ? 'is-active' : ''}`}
            onClick={() => {
              setActiveTab('tools')
              if (!depotKeysSummary) void handleFetchDepotKeys()
            }}
          >
            <Package size={16} />
            Công Cụ Workshop & Upload
          </button>

          <span className="hubcap-free-badge">
            <ShieldCheck size={13} />
            Free Endpoints (0 Quota)
          </span>
        </div>

        {/* Modal Body */}
        <div className="hubcap-modal-body">
          {/* TAB 1: LIBRARY & SEARCH */}
          {activeTab === 'library' && (
            <>
              <div className="hubcap-search-bar">
                <div className="hubcap-input-wrap">
                  <Search size={16} className="hubcap-input-icon" />
                  <input
                    type="text"
                    className="hubcap-search-input"
                    placeholder="Tìm game theo tên hoặc Steam App ID..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void executeSearch()
                    }}
                  />
                </div>
                <select
                  className="hubcap-select"
                  value={sortBy}
                  onChange={(e) => {
                    setSortBy(e.target.value)
                    setPage(1)
                    void fetchLibrary(1, e.target.value)
                  }}
                >
                  <option value="updated">Mới cập nhật</option>
                  <option value="name">Tên (A-Z)</option>
                  <option value="appid">App ID</option>
                </select>
                <button
                  type="button"
                  className="hubcap-primary-btn"
                  onClick={() => void executeSearch()}
                  disabled={loadingLibrary}
                >
                  <Search size={14} />
                  Tìm Kiếm
                </button>
                <button
                  type="button"
                  className="hubcap-secondary-btn"
                  onClick={() => {
                    setSearchQuery('')
                    setPage(1)
                    void fetchLibrary(1, sortBy)
                  }}
                  disabled={loadingLibrary}
                  title="Xem toàn bộ thư viện"
                >
                  <RefreshCw size={14} className={loadingLibrary ? 'spin' : ''} />
                  Toàn bộ
                </button>
              </div>

              {libraryError && (
                <div className="hubcap-alert-box danger">
                  <AlertCircle size={16} />
                  <span>{libraryError}</span>
                </div>
              )}

              {loadingLibrary ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
                  Đang tải danh sách game từ Hubcap...
                </div>
              ) : searchData ? (
                <div>
                  <div style={{ fontSize: '13px', color: 'var(--muted)', marginBottom: '10px' }}>
                    Tìm thấy <strong>{searchData.totalMatches.toLocaleString()}</strong> kết quả cho &quot;{searchData.query}&quot;
                  </div>
                  <div className="hubcap-games-grid">
                    {searchData.results.map((item) => (
                      <div key={item.gameId} className="hubcap-game-card">
                        <div className="hubcap-game-header">
                          {item.headerImage ? (
                            <img src={item.headerImage} alt="" className="hubcap-game-img" loading="lazy" />
                          ) : (
                            <div className="hubcap-game-img" />
                          )}
                          <div className="hubcap-game-info">
                            <div className="hubcap-game-name" title={item.gameName}>{item.gameName}</div>
                            <div className="hubcap-game-appid">App ID: {item.gameId}</div>
                          </div>
                        </div>
                        <div className="hubcap-game-footer">
                          <span className={`hubcap-avail-pill ${item.manifestAvailable ? 'available' : 'missing'}`}>
                            {item.manifestAvailable ? 'Có Manifest' : 'Chưa có'}
                          </span>
                          <button
                            type="button"
                            className="hubcap-card-btn"
                            onClick={() => navigateToAppInspector(item.gameId)}
                          >
                            Chi tiết & Depots &rarr;
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : libraryData ? (
                <div>
                  <div style={{ fontSize: '13px', color: 'var(--muted)', marginBottom: '10px' }}>
                    Thư viện hệ thống: <strong>{libraryData.totalCount.toLocaleString()}</strong> games
                  </div>
                  <div className="hubcap-games-grid">
                    {libraryData.games.map((item) => (
                      <div key={item.gameId} className="hubcap-game-card">
                        <div className="hubcap-game-header">
                          {item.headerImage ? (
                            <img src={item.headerImage} alt="" className="hubcap-game-img" loading="lazy" />
                          ) : (
                            <div className="hubcap-game-img" />
                          )}
                          <div className="hubcap-game-info">
                            <div className="hubcap-game-name" title={item.gameName}>{item.gameName}</div>
                            <div className="hubcap-game-appid">App ID: {item.gameId}</div>
                          </div>
                        </div>
                        <div className="hubcap-game-footer">
                          <span className={`hubcap-avail-pill ${item.manifestAvailable ? 'available' : 'missing'}`}>
                            {item.manifestAvailable ? 'Có Manifest' : 'Chưa có'}
                          </span>
                          <button
                            type="button"
                            className="hubcap-card-btn"
                            onClick={() => navigateToAppInspector(item.gameId)}
                          >
                            Chi tiết & Depots &rarr;
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Pagination */}
                  <div className="hubcap-pagination">
                    <button
                      type="button"
                      className="hubcap-page-btn"
                      disabled={page <= 1}
                      onClick={() => {
                        const prev = page - 1
                        setPage(prev)
                        void fetchLibrary(prev, sortBy)
                      }}
                    >
                      <ChevronLeft size={14} style={{ display: 'inline', verticalAlign: 'middle' }} /> Trang trước
                    </button>
                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                      Trang {page} / {Math.ceil((libraryData.totalCount || 1) / 30)}
                    </span>
                    <button
                      type="button"
                      className="hubcap-page-btn"
                      disabled={page * 30 >= libraryData.totalCount}
                      onClick={() => {
                        const next = page + 1
                        setPage(next)
                        void fetchLibrary(next, sortBy)
                      }}
                    >
                      Trang sau <ChevronRight size={14} style={{ display: 'inline', verticalAlign: 'middle' }} />
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}

          {/* TAB 2: APP INSPECTOR */}
          {activeTab === 'inspector' && (
            <>
              <div className="hubcap-search-bar">
                <div className="hubcap-input-wrap" style={{ maxWidth: '300px' }}>
                  <input
                    type="number"
                    className="hubcap-search-input"
                    placeholder="Nhập Steam App ID..."
                    value={targetAppId}
                    onChange={(e) => setTargetAppId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void inspectApp(Number(targetAppId))
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="hubcap-primary-btn"
                  onClick={() => void inspectApp(Number(targetAppId))}
                  disabled={loadingInspector || !targetAppId}
                >
                  <Search size={14} />
                  Tra Cứu App
                </button>
              </div>

              {inspectorError && (
                <div className="hubcap-alert-box danger">
                  <AlertCircle size={16} />
                  <span>{inspectorError}</span>
                </div>
              )}

              {loadingInspector ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
                  Đang lấy dữ liệu chi tiết cho App {targetAppId}...
                </div>
              ) : (
                <>
                  {/* Status Panel */}
                  {statusData && (
                    <div className="hubcap-panel">
                      <h4 className="hubcap-panel-title">
                        <Layers size={16} />
                        Trạng Thái Manifest ({statusData.gameName || `App ${statusData.appId}`})
                      </h4>
                      <div className="hubcap-meta-grid">
                        <div className="hubcap-meta-item">
                          <span className="hubcap-meta-label">Trạng thái</span>
                          <span className="hubcap-meta-val">{statusData.status}</span>
                        </div>
                        <div className="hubcap-meta-item">
                          <span className="hubcap-meta-label">File Manifest Tồn Tại</span>
                          <span className="hubcap-meta-val">{statusData.manifestFileExists ? '✓ Có sẵn' : '✗ Chưa có'}</span>
                        </div>
                        <div className="hubcap-meta-item">
                          <span className="hubcap-meta-label">Kích thước file</span>
                          <span className="hubcap-meta-val">{formatBytes(statusData.fileSize || 0)}</span>
                        </div>
                        <div className="hubcap-meta-item">
                          <span className="hubcap-meta-label">Thời gian tồn tại (Tuổi file)</span>
                          <span className="hubcap-meta-val">{statusData.fileAgeDays ? `${statusData.fileAgeDays.toFixed(1)} ngày` : '-'}</span>
                        </div>
                        <div className="hubcap-meta-item">
                          <span className="hubcap-meta-label">Cần cập nhật?</span>
                          <span className="hubcap-meta-val">{statusData.needsUpdate ? 'Có' : 'Không'}</span>
                        </div>
                        {statusData.updateReason && (
                          <div className="hubcap-meta-item" style={{ gridColumn: 'span 2' }}>
                            <span className="hubcap-meta-label">Lý do cập nhật</span>
                            <span className="hubcap-meta-val">{statusData.updateReason}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Contents Panel */}
                  {contentsData && (
                    <div className="hubcap-panel">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h4 className="hubcap-panel-title">
                          <Database size={16} />
                          Nội Dung Depots ({contentsData.manifestCount} depots)
                        </h4>
                        <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                          Branch: <strong>{contentsData.branch || 'public'}</strong> | ZIP Archive: {contentsData.zipExists ? '✓ Có' : '✗ Không'}
                        </span>
                      </div>
                      <div className="hubcap-depot-table-wrap">
                        <table className="hubcap-depot-table">
                          <thead>
                            <tr>
                              <th>Depot ID</th>
                              <th>Manifest ID</th>
                              <th>Filename</th>
                            </tr>
                          </thead>
                          <tbody>
                            {contentsData.manifests.map((depot) => (
                              <tr key={depot.depotId}>
                                <td>
                                  <strong>{depot.depotId}</strong>
                                  <button
                                    type="button"
                                    className="hubcap-copy-btn-sm"
                                    onClick={() => void copyToClipboard(depot.depotId, `depot-${depot.depotId}`)}
                                  >
                                    {copiedText === `depot-${depot.depotId}` ? 'Copied' : 'Copy'}
                                  </button>
                                </td>
                                <td>
                                  <code>{depot.manifestId}</code>
                                  <button
                                    type="button"
                                    className="hubcap-copy-btn-sm"
                                    onClick={() => void copyToClipboard(depot.manifestId, `manifest-${depot.manifestId}`)}
                                  >
                                    {copiedText === `manifest-${depot.manifestId}` ? 'Copied' : 'Copy'}
                                  </button>
                                </td>
                                <td>{depot.filename || '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Lua Script Panel */}
                  {targetAppId && (
                    <div className="hubcap-panel">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h4 className="hubcap-panel-title">
                          <FileCode size={16} />
                          Lua Script Source
                        </h4>
                        <div className="hubcap-subtabs">
                          <button
                            type="button"
                            className={`hubcap-subtab-btn ${luaSection === 'all' ? 'is-active' : ''}`}
                            onClick={() => void switchLuaSection('all')}
                          >
                            Toàn bộ
                          </button>
                          <button
                            type="button"
                            className={`hubcap-subtab-btn ${luaSection === 'basegame' ? 'is-active' : ''}`}
                            onClick={() => void switchLuaSection('basegame')}
                          >
                            Chỉ Base Game
                          </button>
                          <button
                            type="button"
                            className={`hubcap-subtab-btn ${luaSection === 'dlc' ? 'is-active' : ''}`}
                            onClick={() => void switchLuaSection('dlc')}
                          >
                            Chỉ DLCs
                          </button>
                        </div>
                      </div>

                      {loadingLua ? (
                        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--muted)' }}>
                          Đang nạp mã Lua...
                        </div>
                      ) : luaCode ? (
                        <div className="hubcap-code-box">
                          <button
                            type="button"
                            className="hubcap-code-copy-btn"
                            onClick={() => void copyToClipboard(luaCode, 'lua-code')}
                          >
                            <Copy size={13} />
                            {copiedText === 'lua-code' ? 'Đã copy!' : 'Copy Script'}
                          </button>
                          <code>{luaCode}</code>
                        </div>
                      ) : (
                        <div style={{ padding: '16px', color: 'var(--muted)', fontSize: '12px' }}>
                          Không có mã Lua script cho tùy chọn này.
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* TAB 3: TOOLS */}
          {activeTab === 'tools' && (
            <div className="hubcap-tools-section">
              {/* Workshop Generator */}
              <div className="hubcap-panel">
                <h4 className="hubcap-panel-title">
                  <Download size={16} />
                  Tải Workshop Manifest Trực Tiếp
                </h4>
                <div className="hubcap-alert-box warning">
                  <AlertCircle size={16} />
                  <span>
                    <strong>Lưu ý:</strong> Endpoint này tải manifest vật phẩm Workshop Steam và{' '}
                    <strong>sẽ trừ vào hạn mức Workshop hàng ngày</strong> của tài khoản Hubcap.
                  </span>
                </div>
                <div className="hubcap-form-row">
                  <div className="hubcap-input-wrap" style={{ maxWidth: '320px' }}>
                    <input
                      type="number"
                      className="hubcap-search-input"
                      placeholder="Nhập Workshop PublishedFileId (ví dụ: 123456789)..."
                      value={workshopId}
                      onChange={(e) => setWorkshopId(e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="hubcap-primary-btn"
                    onClick={() => void handleDownloadWorkshop()}
                    disabled={workshopLoading || !workshopId.trim()}
                  >
                    <Download size={14} />
                    {workshopLoading ? 'Đang tạo...' : 'Tải Workshop Manifest'}
                  </button>
                </div>
                {workshopMsg && (
                  <div className={`hubcap-alert-box ${workshopMsg.type === 'success' ? 'success' : 'danger'}`}>
                    {workshopMsg.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                    <span>{workshopMsg.text}</span>
                  </div>
                )}
              </div>

              {/* Upload Manifest */}
              <div className="hubcap-panel">
                <h4 className="hubcap-panel-title">
                  <Upload size={16} />
                  Đóng Góp Manifest Lên Hệ Thống Hubcap (Upload Cache)
                </h4>
                <div className="hubcap-alert-box info">
                  <AlertCircle size={16} />
                  <span>
                    Chức năng này dành cho tài khoản đã được cấp quyền đóng góp (Allowlisted). Tải file .manifest cục bộ
                    từ máy tính lên Hubcap để chia sẻ cache cho cộng đồng.
                  </span>
                </div>
                <div className="hubcap-form-row">
                  <button type="button" className="hubcap-secondary-btn" onClick={() => void handleSelectUploadFile()}>
                    Chọn file .manifest...
                  </button>
                  <span style={{ fontSize: '12px', color: uploadFilePath ? 'var(--text-strong)' : 'var(--muted)' }}>
                    {uploadFilePath || 'Chưa chọn file'}
                  </span>
                </div>
                <div className="hubcap-form-row">
                  <input
                    type="number"
                    className="hubcap-select"
                    placeholder="Depot ID (Tùy chọn)"
                    value={uploadDepotId}
                    onChange={(e) => setUploadDepotId(e.target.value)}
                  />
                  <input
                    type="text"
                    className="hubcap-select"
                    placeholder="Manifest ID (Tùy chọn)"
                    value={uploadManifestId}
                    onChange={(e) => setUploadManifestId(e.target.value)}
                  />
                  <label className="hubcap-checkbox-label">
                    <input
                      type="checkbox"
                      checked={uploadOverwrite}
                      onChange={(e) => setUploadOverwrite(e.target.checked)}
                    />
                    Ghi đè nếu đã có
                  </label>
                  <button
                    type="button"
                    className="hubcap-primary-btn"
                    onClick={() => void handleUploadManifest()}
                    disabled={uploadLoading || !uploadFilePath}
                  >
                    <Upload size={14} />
                    {uploadLoading ? 'Đang tải lên...' : 'Tải Lên Hubcap'}
                  </button>
                </div>
                {uploadError && (
                  <div className="hubcap-alert-box danger">
                    <AlertCircle size={16} />
                    <span>{uploadError}</span>
                  </div>
                )}
                {uploadResult && (
                  <div className={`hubcap-alert-box ${uploadResult.success ? 'success' : 'danger'}`}>
                    {uploadResult.success ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                    <span>
                      {uploadResult.success
                        ? `Tải lên thành công! Depot: ${uploadResult.depotId ?? '-'}, Manifest: ${uploadResult.manifestId ?? '-'}, Kích thước: ${formatBytes(uploadResult.size || 0)}`
                        : `Thất bại (${uploadResult.status}): ${uploadResult.error || 'Lỗi không xác định'}`}
                    </span>
                  </div>
                )}
              </div>

              {/* Depot Keys Summary */}
              <div className="hubcap-panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 className="hubcap-panel-title">
                    <Database size={16} />
                    Thống Kê Depot Keys Toàn Hệ Thống
                  </h4>
                  <button
                    type="button"
                    className="hubcap-secondary-btn"
                    onClick={() => void handleFetchDepotKeys()}
                    disabled={loadingDepotKeys}
                  >
                    <RefreshCw size={13} className={loadingDepotKeys ? 'spin' : ''} />
                    Làm Mới
                  </button>
                </div>
                {loadingDepotKeys ? (
                  <div style={{ padding: '16px', color: 'var(--muted)', textAlign: 'center' }}>
                    Đang nạp dữ liệu thống kê Depot Keys...
                  </div>
                ) : depotKeysSummary ? (
                  <div className="hubcap-meta-grid">
                    <div className="hubcap-meta-item">
                      <span className="hubcap-meta-label">Tổng số Depot IDs</span>
                      <span className="hubcap-meta-val">{depotKeysSummary.totalDepotIds.toLocaleString()}</span>
                    </div>
                    <div className="hubcap-meta-item">
                      <span className="hubcap-meta-label">Depots Đã Có Manifest</span>
                      <span className="hubcap-meta-val">{depotKeysSummary.existingCount.toLocaleString()}</span>
                    </div>
                    <div className="hubcap-meta-item">
                      <span className="hubcap-meta-label">Depots Đang Chờ (Pending)</span>
                      <span className="hubcap-meta-val">{depotKeysSummary.pendingCount.toLocaleString()}</span>
                    </div>
                    <div className="hubcap-meta-item">
                      <span className="hubcap-meta-label">Trạng thái API</span>
                      <span className="hubcap-meta-val">{depotKeysSummary.status}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
