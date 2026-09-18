/**
 * DefaultLibraryDetail
 *
 * Layout y hệt Steam library detail:
 *  - Hero full width
 *  - Action bar: Play + stats (lần cuối / thời gian / thành tựu) + tools
 *  - Tab bar: Trang cửa hàng | DLC | Trung tâm cộng đồng | Thảo luận | Hướng dẫn | Hỗ trợ
 *  - Main view (default, khi không có tab nào):
 *      LEFT  — Tin tức & cập nhật (Steam news)
 *      RIGHT — THÀNH TỰU panel + GHI CHÚ panel + DLC panel + OST Player
 *  - Tab views: mỗi tab hiển thị nội dung riêng
 */

import { useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  AlertCircle,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  FolderOpen,
  Heart,
  Library,
  Lock,
  MessageSquare,
  Package,
  Play,
  RefreshCcw,
  Settings2,
  ShieldCheck,
  Square,
  Store,
  Trash2,
  Trophy,
  Users,
  Wrench,
} from 'lucide-react'
import { useLocale } from '../../context/locale'
import type { GameDetail, GameInstallState, GameSummary, VerifyUiStatus } from '../../types'
import { assetUrlForId } from '../../lib/gameMeta'
import { useSteamLibraryData } from '../../lib/steamLibraryData'
import { useSteamNews, useSteamStoreDetail } from '../../lib/useSteamApi'
import { OSTPlayer } from '../../components/panels'
import { GameDownloadPanel } from './GameDownloadPanel'
import './DefaultLibraryDetail.css'

// ── Types ──────────────────────────────────────────────────────────────────

type Props = {
  game: GameSummary
  detail: GameDetail
  assets: Record<string, string>
  /** Steam App ID from mapping[game.id] — takes priority over game.appid */
  steamAppId?: number
  installState?: GameInstallState
  displayedVersion: string
  heroUrl?: string
  logoUrl?: string
  coverUrl?: string
  downloadSize: number
  installed: boolean
  updateReady: boolean
  installing: boolean
  playing: boolean
  verifying: boolean
  installBlocked: boolean
  favorite: boolean
  showVersionAction: boolean
  verifyStatus: VerifyUiStatus | null
  onInstall: () => void
  onPlay: () => void
  onStop: () => void
  onUpdate: () => void
  onVersions: () => void
  onVerify: () => void
  onBrowse: () => void
  onUninstall: () => void
  onToggleFavorite: () => void
  onOpenStore: () => void
  onOpenExternal: (url: string) => void
}

type TabId = 'store' | 'dlc' | 'community' | 'discussions' | 'guides' | 'support'

const TABS: { id: TabId; label: string; icon: typeof Trophy }[] = [
  { id: 'store',       label: 'Trang cửa hàng',    icon: Store         },
  { id: 'dlc',         label: 'DLC',                icon: Package       },
  { id: 'community',   label: 'Trung tâm cộng đồng', icon: Users        },
  { id: 'discussions', label: 'Thảo luận',           icon: MessageSquare },
  { id: 'guides',      label: 'Hướng dẫn',           icon: BookOpen      },
  { id: 'support',     label: 'Hỗ trợ',             icon: Wrench        },
]

// ── Helpers ─────────────────────────────────────────────────────────────────

function steamUrl(appid: number | string | undefined, page: TabId | 'achievements'): string | null {
  const id = String(appid ?? '').trim()
  if (!/^\d+$/.test(id)) return null
  const map: Record<TabId | 'achievements', string> = {
    store:        `https://store.steampowered.com/app/${id}/`,
    dlc:          `https://store.steampowered.com/app/${id}/#dlc`,
    community:    `https://steamcommunity.com/app/${id}/`,
    discussions:  `https://steamcommunity.com/app/${id}/discussions/`,
    guides:       `https://steamcommunity.com/app/${id}/guides/`,
    support:      `https://help.steampowered.com/en/wizard/HelpWithGame/?appid=${id}`,
    achievements: `https://steamcommunity.com/stats/${id}/achievements/`,
  }
  return map[page]
}

function fmtPlaytime(mins: number | null | undefined): string {
  if (!mins || mins <= 0) return 'Chưa chơi'
  if (mins < 60) return `${mins} phút`
  const h = mins / 60
  return `${h >= 100 ? Math.round(h) : h.toFixed(1)} giờ`
}

function fmtLastPlayed(iso: string | null | undefined): string {
  if (!iso) return 'Chưa từng chơi'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Không rõ'
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (diff === 0) return 'Hôm nay'
  if (diff === 1) return 'Hôm qua'
  if (diff < 30) return `${diff} ngày trước`
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium' }).format(d)
}

function fmtDate(iso: string): string {
  try { return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium' }).format(new Date(iso)) }
  catch { return iso }
}

// ── Main Component ─────────────────────────────────────────────────────────

export function DefaultLibraryDetail({
  game,
  detail,
  assets,
  steamAppId,
  installState: _installState,
  displayedVersion: _displayedVersion,
  heroUrl,
  logoUrl,
  coverUrl: _coverUrl,
  downloadSize: _downloadSize,
  installed,
  updateReady,
  installing,
  playing,
  verifying,
  installBlocked,
  favorite,
  showVersionAction,
  verifyStatus,
  onInstall,
  onPlay,
  onStop,
  onUpdate,
  onVersions,
  onVerify,
  onBrowse,
  onUninstall,
  onToggleFavorite,
  onOpenStore,
  onOpenExternal,
}: Props) {
  const { t } = useLocale()
  const reduced = Boolean(useReducedMotion())
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [activeTab, setActiveTab] = useState<TabId | null>(null)
  const [notes, setNotes] = useState('')
  const [expandedNews, setExpandedNews] = useState<Set<string>>(new Set())

  const appid = steamAppId ?? game.appid ?? detail.appid
  const steamData  = useSteamLibraryData(game.id, appid)
  const news       = useSteamNews(appid)
  const storeDetail = useSteamStoreDetail(appid)

  // Prefer high-res CDN images from steam-metadata over prop fallbacks
  const effectiveHero    = storeDetail.detail?.hero_image    ?? heroUrl   ?? null
  const effectiveLogo    = storeDetail.detail?.logo_image    ?? logoUrl   ?? null

  // ── Play stats ────────────────────────────────────────────────────────────
  const playtimeMins  = steamData.data?.playtimeMinutes
  const lastPlayedAt  = steamData.data?.lastPlayedAt
  const unlocked      = steamData.data?.unlockedAchievements ?? 0
  const achList       = detail.achievements           // launcher achievements with icon assets
  const achTotal      = achList.length

  // ── Primary action button ─────────────────────────────────────────────────
  // `installing` also covers the window where the click already started a job
  // but `installed` has not flipped yet. During that window the button must be
  // inert: otherwise every extra click replays the whole install preflight
  // (Backup Game catalog + manifest fetch) and floods the backend.
  const primary = playing
    ? { label: 'Dừng',                   icon: <Square size={18} fill="currentColor" />, action: onStop,    cls: 'dld-btn-stop',    busy: false }
    : installing
      ? { label: 'Đang tải...',           icon: <Download size={18} />,                  action: () => {},  cls: 'dld-btn-busy',    busy: true }
      : installed && updateReady
        ? { label: t.library.update,       icon: <RefreshCcw size={18} />,               action: onUpdate,  cls: 'dld-btn-update',  busy: false }
        : installed
          ? { label: t.library.play,       icon: <Play size={20} fill="currentColor" />, action: onPlay,    cls: 'dld-btn-play',    busy: false }
          : { label: t.library.chooseInstall, icon: <Download size={18} />,              action: onInstall, cls: 'dld-btn-install', busy: false }

  // ── Tab keyboard nav ──────────────────────────────────────────────────────
  const handleTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next: number
    if      (e.key === 'ArrowRight') next = (i + 1) % TABS.length
    else if (e.key === 'ArrowLeft')  next = (i - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home')       next = 0
    else if (e.key === 'End')        next = TABS.length - 1
    else return
    e.preventDefault()
    setActiveTab(TABS[next].id)
    tabRefs.current[next]?.focus()
  }

  const open = (page: TabId | 'achievements') => {
    const url = steamUrl(appid, page)
    if (url) onOpenExternal(url)
  }

  // ── RIGHT SIDEBAR (shown in main view) ────────────────────────────────────
  const renderSidebar = () => (
    <aside className="dld-sidebar">

      {/* THÀNH TỰU */}
      <section className="dld-side-card">
        <div className="dld-side-card-header">
          <Trophy size={14} />
          <strong>Thành tựu</strong>
          <span className="dld-side-badge">
            {steamData.loading && !steamData.data ? '…' : `${unlocked} / ${achTotal || '?'}`}
          </span>
        </div>

        {achTotal > 0 && (
          <>
            <div className="dld-ach-bar-wrap">
              <div className="dld-ach-bar">
                <div
                  className="dld-ach-bar-fill"
                  style={{ width: `${achTotal > 0 ? Math.round((unlocked / achTotal) * 100) : 0}%` }}
                />
              </div>
              <span className="dld-ach-pct">
                {achTotal > 0 ? Math.round((unlocked / achTotal) * 100) : 0}%
              </span>
            </div>

            <p className="dld-ach-label">Thành tựu chưa mở</p>
            <div className="dld-ach-strip">
              {achList.slice(0, 8).map((a) => {
                const iconUrl = assetUrlForId(a.iconAssetId, assets)
                return iconUrl ? (
                  <img key={a.id} src={iconUrl} alt={a.name} title={a.name}
                    loading="lazy" decoding="async" className="dld-ach-icon" />
                ) : (
                  <div key={a.id} className="dld-ach-icon dld-ach-icon-locked" title={a.name}>
                    <Lock size={13} />
                  </div>
                )
              })}
              {achList.length > 8 && (
                <div className="dld-ach-icon dld-ach-more">+{achList.length - 8}</div>
              )}
            </div>
          </>
        )}

        {steamUrl(appid, 'achievements') && (
          <button type="button" className="dld-side-link" onClick={() => open('achievements')}>
            Xem thống kê toàn cầu <ExternalLink size={11} />
          </button>
        )}
      </section>

      {/* GHI CHÚ */}
      <section className="dld-side-card">
        <div className="dld-side-card-header">
          <span>📝</span>
          <strong>Ghi chú</strong>
        </div>
        <textarea
          className="dld-notes-area"
          placeholder="Ghi chú gì đó về game này…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
        />
      </section>

      {/* DLC từ steam-metadata */}
      {(storeDetail.detail?.dlc?.length ?? 0) > 0 && (
        <section className="dld-side-card">
          <div className="dld-side-card-header">
            <Package size={14} />
            <strong>DLC</strong>
            <span className="dld-side-badge">{storeDetail.detail!.dlc.length}</span>
          </div>
          <div className="dld-dlc-grid-mini">
            {(storeDetail.detail!.dlc_details.length > 0
              ? storeDetail.detail!.dlc_details.slice(0, 6)
              : storeDetail.detail!.dlc.slice(0, 6).map((id) => ({ appid: id, name: `DLC ${id}`, header_image: null }))
            ).map((dlc) => (
              <div key={dlc.appid} className="dld-dlc-mini-item" title={dlc.name}>
                <img
                  src={dlc.header_image ?? `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${dlc.appid}/header.jpg`}
                  alt={dlc.name}
                  loading="lazy" decoding="async"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                />
              </div>
            ))}
          </div>
          {steamUrl(appid, 'dlc') && (
            <button type="button" className="dld-side-link" onClick={() => setActiveTab('dlc')}>
              Xem tất cả DLC
            </button>
          )}
        </section>
      )}

      {/* Game meta info */}
      {storeDetail.detail && (storeDetail.detail.developers.length > 0 || storeDetail.detail.genres.length > 0) && (
        <section className="dld-side-card dld-meta-card">
          {storeDetail.detail.developers.length > 0 && (
            <div className="dld-meta-row">
              <span>Nhà phát triển</span>
              <span>{storeDetail.detail.developers.join(', ')}</span>
            </div>
          )}
          {storeDetail.detail.publishers.length > 0 && (
            <div className="dld-meta-row">
              <span>Nhà phát hành</span>
              <span>{storeDetail.detail.publishers.join(', ')}</span>
            </div>
          )}
          {storeDetail.detail.release_date && (
            <div className="dld-meta-row">
              <span>Ngày ra mắt</span>
              <span>{storeDetail.detail.release_date}</span>
            </div>
          )}
          {storeDetail.detail.genres.length > 0 && (
            <div className="dld-tags">
              {storeDetail.detail.genres.slice(0, 6).map((genre) => (
                <span key={genre} className="dld-tag">{genre}</span>
              ))}
            </div>
          )}
        </section>
      )}

      {/* OST Player */}
      <OSTPlayer bgImage={heroUrl || logoUrl} gameId={game.id} gameTitle={game.title} />
    </aside>
  )

  // ── MAIN VIEW — activity + sidebar ───────────────────────────────────────
  const renderMainView = () => (
    <div className="dld-main-layout">

      {/* LEFT — news feed */}
      <div className="dld-main-left">
        {/* Nếu có steam appid, hiển thị hoạt động */}
        <section className="dld-activity-section">
          <h2 className="dld-section-title">Hoạt động</h2>
          <div className="dld-activity-input">
            <div className="dld-activity-avatar">
              <Users size={18} />
            </div>
            <input type="text" placeholder="Phát biểu gì đó về trò chơi này với bạn bè…" disabled />
          </div>
        </section>

        <section className="dld-news-section">
          <h2 className="dld-section-title">Tin tức &amp; Cập nhật</h2>

          {news.loading && news.items.length === 0 && (
            <div className="dld-news-skeleton">
              {[0, 1, 2].map((i) => <div key={i} className="dld-news-skeleton-item" />)}
            </div>
          )}

          {!news.loading && news.error && (
            <div className="dld-news-empty">
              <AlertCircle size={20} />
              <p>
                {appid
                  ? `Không tải được tin tức (${news.error})`
                  : 'Game này chưa có Steam App ID trong mapping.'}
              </p>
              {appid && (
                <button type="button" onClick={news.reload}>Thử lại</button>
              )}
            </div>
          )}

          {!news.loading && !news.error && news.items.length === 0 && (
            <div className="dld-news-empty">
              <p>Chưa có tin tức cho game này.</p>
              {steamUrl(appid, 'store') && (
                <button type="button" onClick={() => open('store')}>
                  Xem trên Steam <ExternalLink size={13} />
                </button>
              )}
            </div>
          )}

          {news.items.map((item) => {
            const isExpanded = expandedNews.has(item.gid)
            const toggle = () => setExpandedNews((prev) => {
              const next = new Set(prev)
              if (next.has(item.gid)) next.delete(item.gid)
              else next.add(item.gid)
              return next
            })
            // Strip basic BBCode tags for readable plain text display
            const plainContent = item.contents
              ?.replace(/\[url=[^\]]*\]([^\[]*)\[\/url\]/gi, '$1')
              ?.replace(/\[[^\]]+\]/g, '')
              ?.trim() ?? ''

            return (
              <article key={item.gid} className={`dld-news-item${isExpanded ? ' is-expanded' : ''}`}>
                <div className="dld-news-date">{fmtDate(item.date)}</div>
                <div className="dld-news-body">
                  {item.thumbnail && !isExpanded && (
                    <img src={item.thumbnail} alt="" className="dld-news-thumb"
                      loading="lazy" decoding="async" />
                  )}
                  <div className="dld-news-text">
                    <h3>{item.title}</h3>
                    {!isExpanded && (
                      <p>{item.excerpt}{item.excerpt.length >= 279 ? '…' : ''}</p>
                    )}
                    {isExpanded && plainContent && (
                      <div className="dld-news-full-content">{plainContent}</div>
                    )}
                    <div className="dld-news-actions">
                      <button type="button" className="dld-news-more" onClick={toggle}>
                        {isExpanded ? (
                          <><ChevronUp size={12} /> Thu gọn</>
                        ) : (
                          <><ChevronDown size={12} /> Đọc thêm</>
                        )}
                      </button>
                      {item.url && (
                        <button type="button" className="dld-news-external"
                          onClick={() => onOpenExternal(item.url)}>
                          <ExternalLink size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </article>
            )
          })}
        </section>

        {/* Community content */}
        <section className="dld-community-section">
          <h2 className="dld-section-title">
            Nội dung cộng đồng
            {steamUrl(appid, 'community') && (
              <button type="button" onClick={() => open('community')}>
                <ExternalLink size={13} />
              </button>
            )}
          </h2>
          <p className="dld-community-empty">Không có nội dung bổ sung.</p>
        </section>
      </div>

      {/* RIGHT — sidebar */}
      {renderSidebar()}
    </div>
  )

  // ── DLC TAB ───────────────────────────────────────────────────────────────
  const renderDlcTab = () => {
    const dlcIds    = storeDetail.detail?.dlc ?? []
    const dlcRich   = storeDetail.detail?.dlc_details ?? []
    // Build unified list: rich entries first, then fill remaining with raw id stubs
    const richSet   = new Set(dlcRich.map((d) => d.appid))
    const stubItems = dlcIds.filter((id) => !richSet.has(id)).map((id) => ({ appid: id, name: `App ${id}`, header_image: null }))
    const allDlc    = [...dlcRich, ...stubItems]

    return (
      <div className="dld-tab-content">
        {storeDetail.loading ? (
          <p className="dld-tab-empty">Đang tải DLC…</p>
        ) : dlcIds.length === 0 ? (
          <div className="dld-tab-empty-center">
            <Package size={36} />
            <p>Không có DLC cho game này.</p>
            {steamUrl(appid, 'dlc') && (
              <button type="button" onClick={() => open('dlc')}>
                Kiểm tra trên Steam <ExternalLink size={13} />
              </button>
            )}
          </div>
        ) : (
          <div className="dld-dlc-full-grid">
            {allDlc.map((dlc) => (
              <div key={dlc.appid} className="dld-dlc-card">
                <img
                  src={dlc.header_image ?? `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${dlc.appid}/header.jpg`}
                  alt={dlc.name} loading="lazy" decoding="async"
                  onError={(e) => {
                    const el = e.currentTarget as HTMLImageElement
                    el.src = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${dlc.appid}/capsule_231x87.jpg`
                  }}
                />
                <div className="dld-dlc-info">
                  <span className="dld-dlc-name" title={dlc.name}>{dlc.name}</span>
                  <button type="button"
                    onClick={() => onOpenExternal(`https://store.steampowered.com/app/${dlc.appid}/`)}>
                    <ExternalLink size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── STORE / COMMUNITY / DISCUSSIONS / GUIDES / SUPPORT TABS ───────────────
  const renderHubTab = (tab: TabId) => {
    const url = steamUrl(appid, tab)
    const meta = TABS.find((t) => t.id === tab)!
    const Icon = meta.icon

    const descriptions: Record<TabId, string> = {
      store: 'Khám phá trang thông tin chính thức, đánh giá từ người dùng, gói nội dung và chi tiết mua sắm trên Steam Store.',
      dlc: 'Danh sách các gói mở rộng, nội dung bổ sung và vật phẩm tải về cho trò chơi.',
      community: 'Xem trung tâm cộng đồng chính thức gồm tác phẩm nghệ thuật, ảnh chụp màn hình, video và hoạt động của người chơi trên toàn cầu.',
      discussions: 'Tham gia các chuyên mục thảo luận cộng đồng, trao đổi mẹo chơi, tìm bạn cùng chơi và báo cáo sự cố kỹ thuật.',
      guides: 'Xem các cẩm nang, bí kíp, hướng dẫn chiến thuật và tài liệu do cộng đồng game thủ Steam biên soạn.',
      support: 'Truy cập trang hỗ trợ chính thức của Steam để kiểm tra thông tin tài khoản, khắc phục lỗi game và yêu cầu trợ giúp.',
    }

    return (
      <div className="dld-hub-tab">
        <div className="dld-hub-card">
          <div className="dld-hub-header">
            <div className="dld-hub-icon-wrap">
              <Icon size={28} />
            </div>
            <div className="dld-hub-meta">
              <span className="dld-hub-badge">Steam Community Hub</span>
              <h2>{meta.label} · {game.title}</h2>
              <p className="dld-hub-desc">{descriptions[tab]}</p>
              {url && <span className="dld-hub-url">{url}</span>}
            </div>
          </div>

          <div className="dld-hub-actions">
            {tab === 'store' && (
              <button type="button" className="dld-hub-btn-primary" onClick={onOpenStore}>
                <Store size={16} />
                <span>Mở trong Cửa hàng Launcher</span>
              </button>
            )}
            {url ? (
              <button type="button" className="dld-hub-btn-steam" onClick={() => onOpenExternal(url)}>
                <span>Mở trên Steam</span>
                <ExternalLink size={14} />
              </button>
            ) : (
              <span className="dld-hub-missing">Chưa có Steam App ID cho trò chơi này.</span>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── RENDER ────────────────────────────────────────────────────────────────
  return (
    <main className="dld-surface">

      {/* Hero */}
      <div className="dld-hero">
        {effectiveHero
          ? <img className="dld-hero-img" src={effectiveHero} alt="" loading="eager" decoding="async" />
          : <div className="dld-hero-placeholder"><Library size={48} /></div>}
        <div className="dld-hero-vignette" />
        <div className="dld-hero-logo">
          {effectiveLogo
            ? <img src={effectiveLogo} alt={game.title} loading="eager" decoding="async" />
            : <h1 className="dld-hero-title">{game.title}</h1>}
        </div>
      </div>

      {/* Action bar — giống Steam */}
      <div className="dld-actionbar">
        <button
          type="button"
          className={`dld-primary-btn ${primary.cls}`}
          disabled={installing || installBlocked || primary.busy}
          onClick={primary.action}
        >
          {primary.icon}
          <span>{primary.label}</span>
        </button>

        {/* Stats: lần cuối | thời gian | thành tựu */}
        <div className="dld-stats">
          <div className="dld-stat">
            <label>Lần cuối chơi</label>
            <strong>{steamData.loading && !steamData.data ? '…' : fmtLastPlayed(lastPlayedAt)}</strong>
          </div>
          <div className="dld-stat-sep" />
          <div className="dld-stat">
            <label>Thời gian chơi</label>
            <strong>{steamData.loading && !steamData.data ? '…' : fmtPlaytime(playtimeMins)}</strong>
          </div>
          <div className="dld-stat-sep" />
          <div className="dld-stat">
            <Trophy size={14} />
            <label>Thành tựu</label>
            <strong>
              {achTotal > 0
                ? `${unlocked} / ${achTotal}`
                : steamData.loading ? '…' : 'N/A'}
            </strong>
          </div>
        </div>

        {/* Tool buttons — right */}
        <div className="dld-tools">
          <button type="button" onClick={onOpenStore} title="Trang cửa hàng">
            <Store size={15} />
          </button>
          {showVersionAction && installed && (
            <button type="button" onClick={onVersions} disabled={installBlocked || installing} title="Phiên bản">
              <Settings2 size={15} />
            </button>
          )}
          <button type="button" onClick={onVerify} disabled={!installed || verifying || installBlocked}
            title={verifying ? `${Math.round((verifyStatus?.percent ?? 0) * 100)}%` : t.library.verifyIntegrity}>
            <ShieldCheck size={15} />
          </button>
          <button type="button" onClick={onBrowse} disabled={!installed} title="Duyệt tệp">
            <FolderOpen size={15} />
          </button>
          <button type="button"
            className={favorite ? 'is-fav' : ''}
            onClick={onToggleFavorite}
            aria-pressed={favorite}
            title={favorite ? 'Bỏ yêu thích' : 'Yêu thích'}>
            <Heart size={15} fill={favorite ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>

      {/* Download panel — gộp Depot Downloader trực tiếp vào đây */}
      <GameDownloadPanel
        appid={typeof appid === 'number' ? appid : undefined}
        gameName={game.title}
      />

      {/* Tab bar */}
      <div className="dld-tabbar" role="tablist">
        {/* Hoạt động = main view, không phải tab riêng */}
        <button
          type="button" role="tab"
          className={activeTab === null ? 'is-active' : ''}
          aria-selected={activeTab === null}
          onClick={() => setActiveTab(null)}
        >
          Hoạt động
        </button>
        {TABS.map((tab, i) => {
          const Icon = tab.icon
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              ref={(el) => { tabRefs.current[i] = el }}
              type="button" role="tab"
              className={active ? 'is-active' : ''}
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => handleTabKey(e, i)}
            >
              <Icon size={13} aria-hidden />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={activeTab ?? '__main__'}
          className="dld-tabcontent"
          initial={reduced ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? undefined : { opacity: 0, y: -4 }}
          transition={{ duration: reduced ? 0 : 0.13 }}
        >
          {activeTab === null              && renderMainView()}
          {activeTab === 'dlc'            && renderDlcTab()}
          {activeTab !== null && activeTab !== 'dlc' && renderHubTab(activeTab)}
        </motion.div>
      </AnimatePresence>

      {/* Footer */}
      <div className="dld-footer">
        {installed && (
          <button type="button" className="dld-uninstall-btn"
            disabled={installing || playing || installBlocked} onClick={onUninstall}>
            <Trash2 size={13} /> {t.library.uninstall}
          </button>
        )}
      </div>
    </main>
  )
}
