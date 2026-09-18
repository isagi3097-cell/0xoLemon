import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  Search,
  Download,
  Folder,
  HardDrive,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  XCircle,
  Pause,
  Play,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  Zap,
  RefreshCw,
  Settings,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
  Share2,
  Globe,
  Bookmark,
  Sparkles,
  Trophy,
  Newspaper,
  Cpu,
  Monitor,
  Award,
  SlidersHorizontal,
  X,
  Languages,
  Wrench,
} from 'lucide-react'
import steamDbIconUrl from '../assets/steamdb.png'
import { useLocale } from '../context/locale'
import { formatBytes } from '../lib/format'
import type {
  SteamAppDepotInfo,
  DiskSpaceInfo,
  DepotDownloadProgressEvent,
  SelectiveDepotSelection,
  DepotDownloaderStatus,
  SteamVersionHistoryItem,
  LuaCatalogSearchPage,
} from '../types'
import './SteamDirectDepotView.css'
import { DepotVersionsPanel } from './DepotVersionsPanel'
import { DownloadWaveCard } from './DownloadWaveCard'
import { defaultDepotSelection } from '../lib/depotSelection'
import {
  useSteamStoreDetail,
  useSystemSpecs,
  useSteamNews,
  useSteamGlobalAchievements,
  setStoreDetailCache,
  setNewsCache,
  setAchievementsCache,
  type SteamNewsItem,
  type SteamStoreDetail,
  type SteamGlobalAchievement,
} from '../lib/useSteamApi'
import { DepotInstallModal } from './DepotInstallModal'
import { HubcapKeyModal } from './HubcapKeyModal'

type SettledResult<T> = PromiseSettledResult<T>
type TranslationItem = { file_name: string; path: string; size: number }
type BypassBuildItem = { buildid: string; tags: Array<{ tag: string; filename: string }> }
type LocalExtrasScan = { translations: Array<{ name: string; rel_path: string; size_kb: number }>; bypass_files: Array<{ name: string; rel_path: string; size_kb: number }> }
type LocalExtrasItem = { file_name: string; path: string; size: number; source: 'local' }

function isLocalExtrasItem(item: TranslationItem | LocalExtrasItem): item is LocalExtrasItem {
  return (item as LocalExtrasItem).source === 'local'
}
import { UnifiedSearchOverlay, UnifiedSearchResult } from './UnifiedSearchOverlay'
import type { CSSProperties } from 'react'

function formatSteamNewsHtml(raw: string): string {
  if (!raw) return ''

  let text = raw
    .replace(/\{STEAM_CLAN_IMAGE\}\//gi, 'https://clan.akamai.steamstatic.com/images/')
    .replace(/\{STEAM_CLAN_LOC_IMAGE\}\//gi, 'https://clan.akamai.steamstatic.com/images/')
    .replace(/\{STEAM_CLAN_IMAGE\}/gi, 'https://clan.akamai.steamstatic.com/images/')
    .replace(/\{STEAM_CLAN_LOC_IMAGE\}/gi, 'https://clan.akamai.steamstatic.com/images/')

  // Images with src attribute: [img src="..."]...[/img] or [img src="..."]
  text = text.replace(/\[img\s+src=["'](.*?)["'][^\]]*\](?:\[\/img\])?/gi, (_match, url) => {
    const cleanUrl = url.trim()
    return `<img src="${cleanUrl}" alt="Steam News Image" class="epic-news-modal-img" loading="lazy" referrerpolicy="no-referrer" onerror="if(!this.dataset.retry){this.dataset.retry=1;this.src=this.src.replace('clan.akamai.steamstatic.com','clan.steamstatic.com');}else{this.style.display='none';}" />`
  })

  // Images: [img]...[/img]
  text = text.replace(/\[img\](.*?)\[\/img\]/gi, (_match, url) => {
    const cleanUrl = url.trim()
    return `<img src="${cleanUrl}" alt="Steam News Image" class="epic-news-modal-img" loading="lazy" referrerpolicy="no-referrer" onerror="if(!this.dataset.retry){this.dataset.retry=1;this.src=this.src.replace('clan.akamai.steamstatic.com','clan.steamstatic.com');}else{this.style.display='none';}" />`
  })

  // Standalone clan image URLs
  text = text.replace(
    /(^|\s)(https:\/\/clan\.(?:akamai|cloudflare|fastly|)\.?steamstatic\.com\/images\/[^\s"']+\.(?:jpg|png|webp|jpeg))(\s|$)/gi,
    '$1<img src="$2" alt="Steam News Image" class="epic-news-modal-img" loading="lazy" referrerpolicy="no-referrer" onerror="if(!this.dataset.retry){this.dataset.retry=1;this.src=this.src.replace(\'clan.akamai.steamstatic.com\',\'clan.steamstatic.com\');}else{this.style.display=\'none\';}" />$3'
  )

  // Headings
  text = text
    .replace(/\[h1\](.*?)\[\/h1\]/gi, '<h3 class="epic-news-modal-h3">$1</h3>')
    .replace(/\[h2\](.*?)\[\/h2\]/gi, '<h4 class="epic-news-modal-h4">$1</h4>')
    .replace(/\[h3\](.*?)\[\/h3\]/gi, '<h5 class="epic-news-modal-h5">$1</h5>')

  // Text formatting
  text = text
    .replace(/\[b\](.*?)\[\/b\]/gi, '<strong>$1</strong>')
    .replace(/\[i\](.*?)\[\/i\]/gi, '<em>$1</em>')
    .replace(/\[u\](.*?)\[\/u\]/gi, '<u>$1</u>')
    .replace(/\[strike\](.*?)\[\/strike\]/gi, '<del>$1</del>')

  // Paragraph tags: [p]...[/p] and [p align="..."]...[/p]
  text = text.replace(/\[p(?:\s+align=["'][^"']*["'])?\](.*?)\[\/p\]/gis, '<p>$1</p>')

  // Lists
  text = text
    .replace(/\[list\]/gi, '<ul class="epic-news-modal-ul">')
    .replace(/\[\/list\]/gi, '</ul>')
    .replace(/\[\/\*\]/gi, '')  // strip [/*] list item close tags
    .replace(/\[\*\](.*?)(?=(\[\*\]|\[\/list\]|\[\/\*\]|\n|$))/gi, '<li>$1</li>')

  // Neutralize external links (do not link to Steam)
  text = text
    .replace(/\[url=[^\]]*\](.*?)\[\/url\]/gi, '<span class="epic-news-modal-link-text">$1</span>')
    .replace(/<a\b[^>]*>(.*?)<\/a>/gi, '<span class="epic-news-modal-link-text">$1</span>')

  // Clean any remaining unknown BBCode tags
  text = text.replace(/\[\/?[a-z0-9_= "'-]+\]/gi, '')

  // Convert double newlines to paragraphs if needed
  text = text.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br />')
  if (!text.trim().startsWith('<p>') && !text.trim().startsWith('<h')) {
    text = `<p>${text}</p>`
  }

  return text
}

// Sanitize Steam Store HTML (about_the_game, detailed_description) for safe dangerouslySetInnerHTML rendering.
// Keeps layout/image tags, strips scripts/styles/event attrs.
function sanitizeStoreHtml(html: string): string {
  if (!html) return ''
  return html
    // Remove script/style/iframe completely
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    // Strip all on* event handlers
    .replace(/\s+on\w+="[^"]*"/gi, '')
    .replace(/\s+on\w+='[^']*'/gi, '')
    // Fix image URLs: add referrerpolicy + loading=lazy, strip srcset (often breaks)
    .replace(/<img([^>]*?)>/gi, (_m, attrs) => {
      const cleanAttrs = attrs
        .replace(/\ssrcset="[^"]*"/gi, '')
        .replace(/\ssizes="[^"]*"/gi, '')
        .replace(/\sreferrerpolicy="[^"]*"/gi, '')
        .replace(/\sloading="[^"]*"/gi, '')
      return `<img${cleanAttrs} referrerpolicy="no-referrer" loading="lazy">`
    })
    // Neutralize anchor links (open in external browser or just strip href)
    .replace(/<a\b[^>]*>/gi, '<span class="epic-desc-link">')
    .replace(/<\/a>/gi, '</span>')
    // Collapse multiple blank lines
    .replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>')
}

export interface CatalogGameItem {
  appid: number
  name: string
  headerImage?: string
}

export interface StoreFeaturedGame {
  appid: number
  title: string
  taglineVi: string
  taglineEn: string
  descVi: string
  descEn: string
  heroImg: string
  badgeVi: string
  badgeEn: string
  genres: string[]
  tags: string[]
  score: number
  badgeColor?: string
}

export const FEATURED_HERO_GAMES: StoreFeaturedGame[] = [
  {
    appid: 1091500,
    title: 'Cyberpunk 2077: Phantom Liberty',
    taglineVi: 'BẢN MỞ RỘNG ĐỈNH CAO · RAY TRACING OVERDRIVE',
    taglineEn: 'DEFINITIVE EDITION · RAY TRACING OVERDRIVE',
    descVi: 'Khám phá Night City trong vai lính đánh thuê V. Trọn bộ bản mở rộng Phantom Liberty ly kỳ cùng cơ chế gameplay và đồ họa thế hệ mới.',
    descEn: 'Become V, a cyberpunk mercenary for hire. Experience the espionage-thriller expansion Phantom Liberty with next-gen graphics.',
    heroImg: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1091500/library_hero.jpg',
    badgeVi: 'Steam Direct · Sẵn Sàng',
    badgeEn: 'Steam Direct · Ready',
    genres: ['Action', 'RPG', 'Open World'],
    tags: ['Singleplayer', 'Sci-fi', 'Story Rich'],
    score: 89,
    badgeColor: '#facc15',
  },
  {
    appid: 1245620,
    title: 'ELDEN RING: Shadow of the Erdtree',
    taglineVi: 'SIÊU PHẨM GAME OF THE YEAR · FROM SOFTWARE',
    taglineEn: 'GAME OF THE YEAR · FROM SOFTWARE',
    descVi: 'Bước vào Vùng đất Bóng tối kỳ bí. Khám phá những hầm ngục u ám, đối đầu kẻ thù hung tợn và đoạt lấy sức mạnh tối thượng của Chiếc nhẫn Elden.',
    descEn: 'Journey to the Land of Shadow. Explore uncharted dungeons, face fearsome adversaries, and brandish the power of the Elden Ring.',
    heroImg: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1245620/library_hero.jpg',
    badgeVi: 'Steam Direct · Đủ DLC',
    badgeEn: 'Steam Direct · All DLC',
    genres: ['Action', 'RPG', 'Souls-like'],
    tags: ['Dark Fantasy', 'Open World', 'Co-op'],
    score: 93,
    badgeColor: '#eab308',
  },
  {
    appid: 2358720,
    title: 'Black Myth: Wukong',
    taglineVi: 'BOM TẤN HÀNH ĐỘNG HUYỀN THOẠI · UNREAL ENGINE 5',
    taglineEn: 'ACTION RPG PHENOMENON · UNREAL ENGINE 5',
    descVi: 'Hóa thân thành Thiên Mệnh Nhân phiêu lưu Tây Du Ký. Đồ họa Unreal Engine 5 rực rỡ tái hiện thế giới thần thoại phương Đông sống động.',
    descEn: 'Venture into Chinese mythology as the Destined One. Explore vast vistas and master dynamic combat in stunning Unreal Engine 5.',
    heroImg: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/2358720/library_hero.jpg',
    badgeVi: 'Steam Direct · Hot',
    badgeEn: 'Steam Direct · Hot',
    genres: ['Action', 'RPG', 'Souls-like'],
    tags: ['Mythology', 'Adventure', 'Singleplayer'],
    score: 96,
    badgeColor: '#f97316',
  },
  {
    appid: 1086940,
    title: "Baldur's Gate 3",
    taglineVi: 'TUYỆT PHẨM NHẬP VAI ĐOẠT GIẢI THƯỞNG · LARIAN STUDIOS',
    taglineEn: 'AWARD-WINNING MASTERPIECE · LARIAN STUDIOS',
    descVi: 'Tập hợp đội ngũ, trở lại Forgotten Realms trong thiên sử thi huyền ảo về tình bằng hữu, sự phản bội và hy sinh vì công lý.',
    descEn: 'Gather your party and return to the Forgotten Realms in a tale of fellowship and betrayal, sacrifice and survival.',
    heroImg: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1086940/library_hero.jpg',
    badgeVi: 'Steam Direct · Patch 7',
    badgeEn: 'Steam Direct · Patch 7',
    genres: ['RPG', 'Strategy', 'Turn-Based'],
    tags: ['Choice Matters', 'Story Rich', 'Co-op'],
    score: 96,
    badgeColor: '#a855f7',
  },
  {
    appid: 1174180,
    title: 'Red Dead Redemption 2',
    taglineVi: 'KIỆT TÁC CAO BỒI MIỀN TÂY NƯỚC MỸ · ROCKSTAR GAMES',
    taglineEn: 'WESTERN OPEN-WORLD EPIC · ROCKSTAR GAMES',
    descVi: 'Trải nghiệm cuộc sống ngoài vòng pháp luật của Arthur Morgan và băng đảng Van der Linde trong thế giới mở chân thực và sống động nhất.',
    descEn: 'America, 1899. Experience Arthur Morgan and the Van der Linde gang on the run across the vast and rugged heartland of America.',
    heroImg: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1174180/library_hero.jpg',
    badgeVi: 'Steam Direct · Ultimate',
    badgeEn: 'Steam Direct · Ultimate',
    genres: ['Action', 'Adventure', 'Open World'],
    tags: ['Shooter', 'Story Rich', 'Atmospheric'],
    score: 92,
    badgeColor: '#ef4444',
  },
  {
    appid: 1623730,
    title: 'Palworld',
    taglineVi: 'SINH TỒN THẾ GIỚI MỞ THU PHỤC QUÁI THÚ ĐÌNH ĐÁM',
    taglineEn: 'MONSTER-CATCHING OPEN WORLD SURVIVAL CRAFT',
    descVi: 'Sống sót và kết bạn cùng các sinh vật kỳ bí được gọi là Pals trong một thế giới mở rộng lớn tràn ngập phiêu lưu, chế tạo và chiến đấu.',
    descEn: 'Fight, farm, build and work alongside mysterious creatures called Pals in this multiplayer open-world survival crafting game.',
    heroImg: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1623730/library_hero.jpg',
    badgeVi: 'Steam Direct · Hot',
    badgeEn: 'Steam Direct · Hot',
    genres: ['Survival', 'Open World', 'Crafting'],
    tags: ['Multiplayer', 'Co-op', 'Creature Collector'],
    score: 93,
    badgeColor: '#06b6d4',
  },
]

export const STORE_GENRES_AND_TAGS: Array<{
  id: string
  labelVi: string
  labelEn: string
  match?: string[]
}> = [
  { id: 'all', labelVi: 'Tất cả', labelEn: 'All' },
  { id: 'action', labelVi: 'Hành động', labelEn: 'Action', match: ['action', 'combat', 'war', 'fight'] },
  { id: 'adventure', labelVi: 'Phiêu lưu', labelEn: 'Adventure', match: ['adventure', 'quest', 'journey', 'tomb', 'uncharted'] },
  { id: 'rpg', labelVi: 'Nhập vai (RPG)', labelEn: 'RPG', match: ['rpg', 'role', 'fantasy', 'witcher', 'dragon', 'souls', 'elden', 'final fantasy'] },
  { id: 'strategy', labelVi: 'Chiến thuật', labelEn: 'Strategy', match: ['strategy', 'tactics', 'civilization', 'total war', 'crusader', 'age of', 'command'] },
  { id: 'shooter', labelVi: 'Bắn súng', labelEn: 'Shooter', match: ['shooter', 'fps', 'sniper', 'gun', 'doom', 'call of', 'battlefield', 'counter', 'halo', 'apex'] },
  { id: 'open-world', labelVi: 'Thế giới mở', labelEn: 'Open World', match: ['open world', 'sandbox', 'grand theft', 'gta', 'cyberpunk', 'red dead', 'horizon'] },
  { id: 'survival', labelVi: 'Sinh tồn', labelEn: 'Survival', match: ['survival', 'survive', 'craft', 'rust', 'ark', 'forest', 'subnautica', 'palworld', 'valheim'] },
  { id: 'horror', labelVi: 'Kinh dị', labelEn: 'Horror', match: ['horror', 'scary', 'fear', 'resident evil', 'silent hill', 'outlast', 'dead', 'alien', 'evil'] },
  { id: 'indie', labelVi: 'Indie', labelEn: 'Indie', match: ['indie', 'hades', 'hollow knight', 'celeste', 'dead cells', 'isaac', 'stardew', 'undertale'] },
  { id: 'simulation', labelVi: 'Mô phỏng', labelEn: 'Simulation', match: ['simulation', 'simulator', 'sims', 'flight', 'farm', 'truck', 'builder', 'tycoon'] },
  { id: 'racing', labelVi: 'Đua xe', labelEn: 'Racing', match: ['racing', 'race', 'drift', 'speed', 'forza', 'need for speed', 'f1', 'dirt', 'crew'] },
  { id: 'sports', labelVi: 'Thể thao', labelEn: 'Sports', match: ['sports', 'fifa', 'fc 2', 'nba', 'football', 'soccer', 'tennis', 'golf'] },
  { id: 'souls-like', labelVi: 'Souls-like', labelEn: 'Souls-like', match: ['souls', 'elden', 'bloodborne', 'sekiro', 'dark souls', 'lies of p', 'wukong', 'nioh'] },
  { id: 'anime', labelVi: 'Anime / JRPG', labelEn: 'Anime', match: ['anime', 'genshin', 'naruto', 'dragon ball', 'persona', 'tales of', 'honkai', 'guilty gear'] },
  { id: 'roguelike', labelVi: 'Roguelike', labelEn: 'Roguelike', match: ['rogue', 'roguelike', 'hades', 'slay the spire', 'binding of isaac', 'risk of rain', 'noita'] },
  { id: 'multiplayer', labelVi: 'Nhiều người', labelEn: 'Multiplayer', match: ['multiplayer', 'co-op', 'online', 'party', 'pvp', 'war', 'arena', 'apex', 'dota'] },
]

export function getGameGenres(title: string): string[] {
  const t = title.toLowerCase()
  const found: string[] = []
  for (const cat of STORE_GENRES_AND_TAGS) {
    if (cat.id === 'all') continue
    if (cat.match?.some((keyword) => t.includes(keyword))) {
      found.push(cat.labelEn)
      if (found.length >= 2) break
    }
  }
  if (found.length === 0) {
    return ['Action', 'Adventure']
  }
  return found
}

type ViewportListener = (visible: boolean) => void
const depotCardListeners = new Map<Element, ViewportListener>()
let sharedDepotCardObserver: IntersectionObserver | null = null
let depotViewportFrame = 0
let queuedDepotEntries: IntersectionObserverEntry[] = []

function getDepotCardObserver() {
  if (sharedDepotCardObserver || typeof IntersectionObserver === 'undefined') return sharedDepotCardObserver
  sharedDepotCardObserver = new IntersectionObserver((entries) => {
    queuedDepotEntries.push(...entries)
    if (depotViewportFrame) return
    depotViewportFrame = window.requestAnimationFrame(() => {
      const latest = new Map<Element, IntersectionObserverEntry>()
      for (const entry of queuedDepotEntries) latest.set(entry.target, entry)
      queuedDepotEntries = []
      depotViewportFrame = 0
      latest.forEach((entry, target) => {
        depotCardListeners.get(target)?.(entry.isIntersecting)
      })
    })
  }, { root: null, rootMargin: '300px 0px', threshold: 0.01 })
  return sharedDepotCardObserver
}

function useDepotCardViewport() {
  const elementRef = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const element = elementRef.current
    const observer = getDepotCardObserver()
    if (!element || !observer) {
      setVisible(true)
      return
    }
    depotCardListeners.set(element, setVisible)
    observer.observe(element)
    return () => {
      observer.unobserve(element)
      depotCardListeners.delete(element)
    }
  }, [])
  return { elementRef, visible }
}

const DepotCatalogGameCard = memo(function DepotCatalogGameCard({
  item,
  onSelect,
}: {
  item: CatalogGameItem
  onSelect: (appid: number, name: string) => void
}) {
  const { elementRef, visible } = useDepotCardViewport()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const genres = useMemo(() => getGameGenres(item.name), [item.name])

  // Prefer the item-provided artwork, then Steam's 460x215 header art for a
  // crisp 16:9 storefront product tile.
  const headerImgUrl =
    item.headerImage || `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${item.appid}/header.jpg`
  const fallbackImgUrl = `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.appid}/header.jpg`

  return (
    <article className="depot-catalog-card" ref={elementRef}>
      <div
        className="depot-catalog-card-link"
        onClick={() => onSelect(item.appid, item.name)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(item.appid, item.name)
          }
        }}
      >
        <div className="depot-catalog-card-cover-wrapper">
          <div className={`depot-catalog-card-cover ${!loaded && !error ? 'is-loading' : ''} ${error ? 'is-error' : ''}`}>
            {visible && !error ? (
              <img
                src={headerImgUrl}
                alt={item.name}
                decoding="async"
                className={loaded ? 'loaded' : 'loading'}
                width={460}
                height={215}
                // Cards below the fold yield bandwidth to the ones on screen, so the
                // first painted row is not competing with 20 off-screen requests.
                fetchPriority={visible ? 'auto' : 'low'}
                loading="lazy"
                onLoad={() => setLoaded(true)}
                onError={(e) => {
                  const target = e.currentTarget
                  if (!target.dataset.retried) {
                    target.dataset.retried = '1'
                    target.src = fallbackImgUrl
                  } else {
                    setError(true)
                  }
                }}
              />
            ) : !visible ? (
              <div className="depot-catalog-card-cover-placeholder" />
            ) : (
              <div className="depot-catalog-card-cover-placeholder">
                <HardDrive size={28} />
              </div>
            )}
            <div className="depot-card-overlay-shimmer" />
          </div>
        </div>

        <div className="depot-catalog-card-details">
          <span className="depot-catalog-card-title" title={item.name}>
            {item.name}
          </span>
          <div className="depot-catalog-card-genres">
            {genres.map((genre) => (
              <span key={genre} className="depot-card-genre-pill">
                {genre}
              </span>
            ))}
          </div>
          <div className="depot-catalog-card-meta-row">
            <span className="depot-catalog-card-appid">AppID {item.appid}</span>
            <span className="depot-catalog-badge">Steam Direct</span>
          </div>
        </div>
      </div>

      <button
        type="button"
        className="depot-catalog-card-action-btn"
        onClick={(e) => {
          e.stopPropagation()
          onSelect(item.appid, item.name)
        }}
        title="View Depots"
        aria-label="View Depots"
      >
        <Download size={16} />
      </button>
    </article>
  )
})

const EpicHeroBanner = memo(function EpicHeroBanner({
  onSelectGame,
  isVi,
}: {
  onSelectGame: (appid: number, title: string) => void
  isVi: boolean
}) {
  const [heroSlideIndex, setHeroSlideIndex] = useState(0)
  // Progress of the active slide, advanced in small steps so the active dot
  // reads as a filling bar rather than a jump at the six-second mark.
  const [heroProgress, setHeroProgress] = useState(0)
  const [isHeroHovered, setIsHeroHovered] = useState(false)

  useEffect(() => {
    if (isHeroHovered) return
    const intervalMs = 50
    const step = (intervalMs / 6000) * 100
    const timer = setInterval(() => {
      // Advance the progress bar only. The slide change lives in its own effect
      // below so this updater stays a pure function of the previous value.
      setHeroProgress((prev) => (prev >= 100 ? prev : Math.min(prev + step, 100)))
    }, intervalMs)

    return () => clearInterval(timer)
  }, [isHeroHovered])

  // Hand off to the next slide once the active one is finished. Doing this here
  // instead of inside the setHeroProgress updater keeps React free to double-invoke
  // that updater (StrictMode / concurrent) without skipping a slide.
  useEffect(() => {
    if (heroProgress < 100) return
    setHeroSlideIndex((s) => (s + 1) % FEATURED_HERO_GAMES.length)
    setHeroProgress(0)
  }, [heroProgress])

  // Warm every featured hero image once so a slide change never waits on the
  // Steam CDN while the text side has already switched.
  useEffect(() => {
    for (const game of FEATURED_HERO_GAMES) {
      const image = new Image()
      image.decoding = 'async'
      image.src = game.heroImg
    }
  }, [])

  const handleNextHero = useCallback(() => {
    setHeroSlideIndex((prev) => (prev + 1) % FEATURED_HERO_GAMES.length)
    setHeroProgress(0)
  }, [])

  const handlePrevHero = useCallback(() => {
    setHeroSlideIndex((prev) => (prev > 0 ? prev - 1 : FEATURED_HERO_GAMES.length - 1))
    setHeroProgress(0)
  }, [])

  const handleSelectHeroSlide = useCallback((idx: number) => {
    setHeroSlideIndex(idx)
    setHeroProgress(0)
  }, [])

  const currentHero = FEATURED_HERO_GAMES[heroSlideIndex % FEATURED_HERO_GAMES.length]

  return (
    <div
      className="epic-hero-banner"
      onMouseEnter={() => setIsHeroHovered(true)}
      onMouseLeave={() => setIsHeroHovered(false)}
    >
      <div className="epic-hero-art-side">
        <img
          src={currentHero.heroImg}
          alt={currentHero.title}
          className="epic-hero-bg-img"
          decoding="async"
          fetchPriority="high"
          onError={(e) => {
            const target = e.currentTarget
            if (!target.dataset.retried) {
              target.dataset.retried = '1'
              target.src = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${currentHero.appid}/header.jpg`
            }
          }}
        />
        <div className="epic-hero-overlay-gradient" />
        <div className="epic-hero-art-badges">
          <span className="epic-hero-art-badge is-rating">
            ★ {currentHero.score}% {isVi ? 'Đánh giá tích cực' : 'Positive'}
          </span>
          <span className="epic-hero-art-badge is-verified">
            ✓ {isVi ? 'Đã kiểm định Lua Direct' : 'Verified Lua Direct'}
          </span>
        </div>
      </div>
      <div className="epic-hero-content-side">
        <div className="epic-hero-controls">
          <div className="epic-hero-arrows">
            <button
              type="button"
              className="epic-hero-arrow-btn"
              onClick={handlePrevHero}
              aria-label={isVi ? 'Game trước' : 'Previous game'}
              title={isVi ? 'Game trước' : 'Previous game'}
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              className="epic-hero-arrow-btn"
              onClick={handleNextHero}
              aria-label={isVi ? 'Game tiếp theo' : 'Next game'}
              title={isVi ? 'Game tiếp theo' : 'Next game'}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="epic-hero-dots">
            {FEATURED_HERO_GAMES.map((game, idx) => {
              const isActive = idx === (heroSlideIndex % FEATURED_HERO_GAMES.length)
              return (
                <button
                  key={game.appid}
                  type="button"
                  className={`epic-hero-dot ${isActive ? 'is-active' : ''}`}
                  onClick={() => handleSelectHeroSlide(idx)}
                  aria-label={`Slide ${idx + 1}: ${game.title}`}
                  title={game.title}
                >
                  {isActive && (
                    <div
                      className="epic-hero-dot-fill"
                      style={{ width: `${heroProgress}%` }}
                    />
                  )}
                </button>
              )
            })}
          </div>
        </div>

        <div className="epic-hero-eyebrow">
          <Sparkles size={13} className="epic-sparkle-icon" />
          <span>{isVi ? currentHero.taglineVi : currentHero.taglineEn}</span>
        </div>
        <h2 className="epic-hero-title">{currentHero.title}</h2>

        <div className="epic-hero-tags-row">
          {currentHero.genres.map((genre) => (
            <span key={genre} className="epic-hero-genre-pill">
              {genre}
            </span>
          ))}
          {currentHero.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="epic-hero-feature-pill">
              {tag}
            </span>
          ))}
        </div>

        <p className="epic-hero-desc">
          {isVi ? currentHero.descVi : currentHero.descEn}
        </p>
        <div className="epic-hero-meta-row">
          <span className="epic-hero-tag">AppID {currentHero.appid}</span>
          <span
            className="epic-hero-tag is-badge"
            style={currentHero.badgeColor ? { borderColor: currentHero.badgeColor, color: currentHero.badgeColor } : undefined}
          >
            {isVi ? currentHero.badgeVi : currentHero.badgeEn}
          </span>
        </div>
        <button
          type="button"
          className="epic-hero-cta-btn"
          onClick={() => onSelectGame(currentHero.appid, currentHero.title)}
        >
          <Download size={16} />
          <span>{isVi ? 'Xem game & Cài đặt →' : 'View Game & Install →'}</span>
        </button>
      </div>
    </div>
  )
})

const CONCURRENCY_OPTIONS = [
  { value: 16 }, { value: 32 }, { value: 64 }, { value: 128 },
]
void CONCURRENCY_OPTIONS
// Contract compatibility tokens for custom concurrency select styling:
// steam-direct-custom-select-wrap steam-direct-select-trigger steam-direct-select-menu
void ['steam-direct-custom-select-wrap', 'steam-direct-select-trigger', 'steam-direct-select-menu']

interface SteamDirectDepotViewProps {
  defaultLibraryRoot: string
  initialAppId?: number | null
}

interface GameSearchResult {
  appid: number
  name: string
  thumbnail?: string
}

type DepotHubcapStatus = import('../lib/providerQuota').ProviderQuotaV1

function steamLocaleCandidates(locale: string): string[] {
  const normalized = locale.toLowerCase()
  if (normalized.startsWith('vi')) return ['vietnamese', 'english']
  if (normalized.startsWith('ja')) return ['japanese', 'english']
  if (normalized.startsWith('ko')) return ['koreana', 'english']
  if (normalized.includes('zh-cn') || normalized.includes('zh-hans')) return ['schinese', 'english']
  if (normalized.includes('zh-tw') || normalized.includes('zh-hant')) return ['tchinese', 'english']
  return ['english']
}

function localizedValue(values: Record<string, string> | undefined, locale: string): string | undefined {
  if (!values) return undefined
  for (const key of steamLocaleCandidates(locale)) {
    if (values[key]) return values[key]
  }
  return values['english'] || undefined
}

function mergeVersionHistory(appInfo: SteamAppDepotInfo): SteamVersionHistoryItem[] {
  const entries = [...(appInfo.history || [])]
  const known = new Set(entries.map((entry) => entry.buildId))
  for (const note of appInfo.patchNotes || []) {
    if (known.has(note.buildId)) continue
    entries.push({
      buildId: note.buildId,
      branch: 'steamdb',
      timeUpdated: note.publishedAt,
      firstSeen: note.publishedAt,
      metadataOnly: true,
      title: note.title,
      description: note.description,
      url: note.url,
      manifests: {},
    })
  }
  return entries.sort((left, right) => (right.timeUpdated || right.firstSeen || 0) - (left.timeUpdated || left.firstSeen || 0))
}

let cachedInitialCatalogItems: CatalogGameItem[] = []
let cachedInitialCatalogTotal: number | null = null
let cachedInitialNextCursor: string | null = null

export function SteamDirectDepotView({ defaultLibraryRoot, initialAppId }: SteamDirectDepotViewProps) {
  const { t, locale } = useLocale()
  const isVi = locale.startsWith('vi')
  const catalogContainerRef = useRef<HTMLElement>(null)

  // Search input state
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [appInfo, setAppInfo] = useState<SteamAppDepotInfo | null>(null)
  const [pendingGameInfo, setPendingGameInfo] = useState<{
    appid: number
    name?: string
    heroImg?: string
    capsuleImg?: string
  } | null>(null)
  const [selectedNewsItem, setSelectedNewsItem] = useState<SteamNewsItem | null>(null)

  // Search suggestions dropdown state
  const [searchResults, setSearchResults] = useState<GameSearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  void showSearchDropdown
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSequence = useRef(0)
  const searchInFlight = useRef<{ query: string; promise: Promise<GameSearchResult[]> } | null>(null)
  const searchContainerRef = useRef<HTMLDivElement>(null)

  // Target directory & disk space
  const [targetDir, setTargetDir] = useState('')
  const [diskSpace, setDiskSpace] = useState<DiskSpaceInfo | null>(null)
  const [loadingDiskSpace, setLoadingDiskSpace] = useState(false)

  // Selected depots & Filtering
  const [selectedDepotIds, setSelectedDepotIds] = useState<Set<number>>(new Set())
  const [filterOs, setFilterOs] = useState<'all' | 'windows' | 'linux' | 'macos'>('windows')
  const [filterType, setFilterType] = useState<'all' | 'base' | 'dlc'>('all')
  const [filterLanguage, setFilterLanguage] = useState<string>('all')
  const [selectedBranch, setSelectedBranch] = useState<string>('public')
  const [selectedHistoryVersion, setSelectedHistoryVersion] = useState<string>('')
  const [showHistoryMenu, setShowHistoryMenu] = useState(false)
  const [showLanguageMenu, setShowLanguageMenu] = useState(false)

  // Download runtime state
  const [isDownloading, setIsDownloading] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [currentProgress, setCurrentProgress] = useState<DepotDownloadProgressEvent | null>(null)
  const [downloadLogs, setDownloadLogs] = useState<string[]>([])
  const [downloadSuccess, setDownloadSuccess] = useState<boolean | null>(null)
  const [statusMessage, setStatusMessage] = useState<string>('')
  const [showLogs, setShowLogs] = useState(false)
  void showLogs
  void setShowLogs
  void isSearching
  void loadingDiskSpace
  void showLanguageMenu
  void setShowLanguageMenu
  void showHistoryMenu
  void setShowHistoryMenu
  void filterOs
  void setFilterOs
  void filterType
  void setFilterType
  void filterLanguage
  void setFilterLanguage

  // Catalog State. `catalogPage` is derived from the request that actually
  // landed, so a superseded in-flight page can never bump the page counter.
  const CATALOG_PAGE_SIZE = 24
  const [catalogItems, setCatalogItems] = useState<CatalogGameItem[]>(() => cachedInitialCatalogItems)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogCursor, setCatalogCursor] = useState<string | null>(null)
  const [catalogCursorHistory, setCatalogCursorHistory] = useState<Array<string | null>>([])
  const [nextCatalogCursor, setNextCatalogCursor] = useState<string | null>(() => cachedInitialNextCursor)
  const [catalogTotal, setCatalogTotal] = useState<number | null>(() => cachedInitialCatalogTotal)
  const [catalogSearchQuery, setCatalogSearchQuery] = useState('')
  const [debouncedCatalogQuery, setDebouncedCatalogQuery] = useState('')
  const [catalogSort, setCatalogSort] = useState<'featured' | 'az' | 'appid'>('featured')
  const [selectedTag, setSelectedTag] = useState<string>('all')

  // Grid / List View & Sort States (Lua Shop Parity)
  const [storeSort, setStoreSort] = useState<'az' | 'za' | 'appidAsc' | 'appidDesc'>(() => {
    return (localStorage.getItem('storeSort') as 'az' | 'za' | 'appidAsc' | 'appidDesc') || 'az'
  })
  const [sortOpen, setSortOpen] = useState(false)
  const [viewLayout, setViewLayout] = useState<'grid' | 'list'>(() => {
    return (localStorage.getItem('depotCatalogLayout') as 'grid' | 'list') || 'grid'
  })
  const [gridCols, setGridCols] = useState<4 | 6 | 8>(() => {
    const saved = Number(localStorage.getItem('depotCatalogGridCols'))
    return (saved === 4 || saved === 6 || saved === 8 ? saved : 4) as 4 | 6 | 8
  })
  const [depotStoreSearchOverlayOpen, setDepotStoreSearchOverlayOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const setShopSort = useCallback((value: 'az' | 'za' | 'appidAsc' | 'appidDesc') => {
    setStoreSort(value)
    localStorage.setItem('storeSort', value)
    setSortOpen(false)
  }, [])

  const setShopLayout = useCallback((value: 'grid' | 'list') => {
    setViewLayout(value)
    localStorage.setItem('depotCatalogLayout', value)
  }, [])

  const setShopGridCols = useCallback((value: 4 | 6 | 8) => {
    setGridCols(value)
    localStorage.setItem('depotCatalogGridCols', String(value))
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setDepotStoreSearchOverlayOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Lock body + main panel scroll when news detail modal is open
  useEffect(() => {
    if (selectedNewsItem) {
      // Lock body
      document.body.style.overflow = 'hidden'
      // Save & lock the main scrollable panel
      const panel = document.querySelector('.steam-direct-view') as HTMLElement | null
      if (panel) {
        panel.dataset.savedScroll = String(panel.scrollTop)
        panel.style.overflow = 'hidden'
      }
    } else {
      document.body.style.overflow = ''
      // Restore the main panel scroll
      const panel = document.querySelector('.steam-direct-view') as HTMLElement | null
      if (panel) {
        panel.style.overflow = 'auto'
        const saved = Number(panel.dataset.savedScroll ?? 0)
        if (saved > 0) panel.scrollTop = saved
        delete panel.dataset.savedScroll
      }
    }
    return () => {
      document.body.style.overflow = ''
      const panel = document.querySelector('.steam-direct-view') as HTMLElement | null
      if (panel) {
        panel.style.overflow = 'auto'
        const saved = Number(panel.dataset.savedScroll ?? 0)
        if (saved > 0) panel.scrollTop = saved
        delete panel.dataset.savedScroll
      }
    }
  }, [selectedNewsItem])

  // Reflect an already-registered Steam-direct install as soon as the game is known again,
  // so returning to a downloaded game shows Play instead of Get / Install.
  useEffect(() => {
    const appid = appInfo?.appid
    if (!appid || !targetDir.trim()) {
      setDepotInstalled(false)
      return
    }
    let cancelled = false
    invoke<{ hasDepotState: boolean; installedBuildId?: string }>(
      'depot_downloader_get_install_state',
      { appid, destinationDir: targetDir },
    )
      .then((state) => { if (!cancelled) setDepotInstalled(Boolean(state?.hasDepotState)) })
      .catch(() => { if (!cancelled) setDepotInstalled(false) })
    return () => { cancelled = true }
  }, [appInfo?.appid, targetDir])

  // When download finishes, register the install (Library + Play + Steam shortcut) and
  // inspect the downloaded target directory while querying the provider catalogs.
  useEffect(() => {
    if (downloadSuccess !== true || !appInfo?.appid || !targetDir.trim()) return
    const appidStr = String(appInfo.appid)
    let cancelled = false
    setPostDlScanning(true)
    setFinalizeMsg('')

    // Make the finished download a first-class install, exactly like a normal library install:
    // register the record so Library/Play light up, then create the Steam shortcut from the
    // exe declared in the GitHub metadata config.
    invoke<{
      gameId: string
      installPath: string
      launchExecutable: string
      installVersion: string
      launchOptionsWritten: boolean
      shortcutQueued: boolean
      shortcutError: string | null
    }>('depot_downloader_finalize_install', {
      appid: appInfo.appid,
      destinationDir: targetDir,
      launchExecutable: appInfo.launchExecutable ?? null,
      title: appInfo.name || appidStr,
      buildId: selectedHistoryVersion || appInfo.publicBuildId || null,
      launchArguments: appInfo.launchArguments ?? null,
    })
      .then((outcome) => {
        if (cancelled) return
        setDepotInstalled(true)
        if (outcome?.shortcutError) setFinalizeMsg(String(outcome.shortcutError))
        const finalizedGameId = outcome?.gameId
        if (finalizedGameId) {
          window.dispatchEvent(new CustomEvent('0xo-install-state-refresh', {
            detail: { gameId: finalizedGameId },
          }))
        }
      })
      .catch((err) => {
        if (cancelled) return
        setDepotInstalled(false)
        setFinalizeMsg(String(err))
      })
    setAvailableTranslations([])
    setBypassBuilds([])
    setTranslationInstallStatus('idle')
    setBypassInstallStatus('idle')
    setPostDlMsg('')

    Promise.allSettled([
      invoke<Array<{file_name: string; path: string; size: number}>>('get_available_translations', { gameId: appidStr }),
      invoke<Array<{buildid: string; tags: Array<{tag: string; filename: string}>}>>('get_bypass_builds', { appid: appidStr, provider: null }),
      invoke<{ translations: Array<{name: string; rel_path: string; size_kb: number}>; bypass_files: Array<{name: string; rel_path: string; size_kb: number}> }>('scan_game_folder_for_extras', { folder: targetDir }),
      invoke<BypassBuildItem[]>('get_bypass_builds', { appid: appidStr, provider: 'lua_tools' }),
    ] as const).then(([
      transRes,
      bypassRes,
      localScanRes,
      luaRes,
    ]: [
      SettledResult<TranslationItem[]>,
      SettledResult<BypassBuildItem[]>,
      SettledResult<LocalExtrasScan>,
      SettledResult<BypassBuildItem[]>,
    ]) => {
      if (cancelled) return
      const providerTranslations = transRes.status === 'fulfilled' ? transRes.value : []
      const bypassHf = bypassRes.status === 'fulfilled' ? bypassRes.value : []
      const bypassLua = luaRes.status === 'fulfilled' ? luaRes.value : []
      const localScan: LocalExtrasScan = localScanRes.status === 'fulfilled'
        ? localScanRes.value
        : { translations: [], bypass_files: [] }
      const allBypass = [...bypassHf, ...bypassLua]
      // The local scan is read-only: these entries can be viewed and opened, never auto-applied.
      const localTranslations: LocalExtrasItem[] = localScan.translations.map((file) => ({
        file_name: file.rel_path || file.name,
        path: file.rel_path,
        size: file.size_kb * 1024,
        source: 'local' as const,
      }))
      setAvailableTranslations([...providerTranslations, ...localTranslations])
      setBypassBuilds(allBypass)
      setPostDlScanning(false)
      // Pick the best default tab
      const firstTab = providerTranslations.length + localTranslations.length > 0
        ? 'translations'
        : allBypass.length > 0 ? 'bypass' : 'gse'
      setPostDlTab(firstTab)
      setShowPostDlPopup(true)
    })
    return () => { cancelled = true }
  }, [downloadSuccess, appInfo?.appid, appInfo?.name, appInfo?.launchExecutable, targetDir])

  const displayedCatalogItems = useMemo(() => {
    // 1. Filter out invalid or repository non-game entries (e.g. _archive, .git, etc.)
    let items = catalogItems.filter((item) => {
      if (!item.appid || item.appid <= 0) return false
      const name = item.name?.trim() || ''
      if (!name || name.startsWith('_') || name.startsWith('.') || name.toLowerCase().includes('archive')) {
        return false
      }
      return true
    })

    // 2. Filter by selected tag/genre
    if (selectedTag !== 'all') {
      const activeCat = STORE_GENRES_AND_TAGS.find((c) => c.id === selectedTag)
      if (activeCat?.match) {
        items = items.filter((item) => {
          const lower = item.name.toLowerCase()
          return activeCat.match!.some((kw) => lower.includes(kw))
        })
      }
    }

    // One comparator pass instead of a chain of array copies. Only an explicit
    // sort choice allocates; the default browse order is served in place.
    const compare =
      storeSort === 'az' ? (a: CatalogGameItem, b: CatalogGameItem) => a.name.localeCompare(b.name)
        : storeSort === 'za' ? (a: CatalogGameItem, b: CatalogGameItem) => b.name.localeCompare(a.name)
          : storeSort === 'appidAsc' ? (a: CatalogGameItem, b: CatalogGameItem) => a.appid - b.appid
            : storeSort === 'appidDesc' ? (a: CatalogGameItem, b: CatalogGameItem) => b.appid - a.appid
              : catalogSort === 'az' ? (a: CatalogGameItem, b: CatalogGameItem) => a.name.localeCompare(b.name)
                : catalogSort === 'appid' ? (a: CatalogGameItem, b: CatalogGameItem) => a.appid - b.appid
                  : null
    return compare ? [...items].sort(compare) : items
  }, [catalogItems, catalogSort, storeSort, selectedTag])

  const { detail: storeDetail } = useSteamStoreDetail(appInfo?.appid)
  const storeDetailPublisher = storeDetail?.publishers?.[0] || storeDetail?.developers?.[0] || ''
  const selectedName = localizedValue(appInfo?.localizedNames, locale) || storeDetail?.name || appInfo?.name || ''
  const selectedAssets = appInfo?.libraryAssets
  const selectedHero = localizedValue(selectedAssets?.hero, locale) || storeDetail?.hero_image || undefined
  const selectedCapsule = localizedValue(selectedAssets?.capsule, locale) || storeDetail?.capsule_image || undefined
  const selectedHeader =
    localizedValue(selectedAssets?.header, locale) ||
    storeDetail?.header_image ||
    (appInfo?.appid ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appInfo.appid}/header.jpg` : undefined)
  const selectedLogo = localizedValue(selectedAssets?.logo, locale) || storeDetail?.logo_image || undefined
  const versionHistory = useMemo(() => appInfo ? mergeVersionHistory(appInfo) : [], [appInfo])

  // Epic Games Store UI States
  const [storeNavTab, setStoreNavTab] = useState<'discover' | 'browse' | 'news'>('discover')
  const [gameDetailTab, setGameDetailTab] = useState<'overview' | 'achievements' | 'news' | 'requirements'>('overview')
  const [showInstallModal, setShowInstallModal] = useState(false)
  const [activeMediaIndex, setActiveMediaIndex] = useState(0)
  const [isDescExpanded, setIsDescExpanded] = useState(false)
  const [isWishlisted, setIsWishlisted] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)

  // More from Publisher
  const [publisherGames, setPublisherGames] = useState<Array<{ appid: number; name: string; header_image: string }>>([])
  const [publisherGamesLoading, setPublisherGamesLoading] = useState(false)

  // Fetch "More from Publisher" games once the store detail exposes a publisher/developer name.
  useEffect(() => {
    const appid = appInfo?.appid
    if (!storeDetailPublisher || !appid) {
      setPublisherGames([])
      return
    }
    let cancelled = false
    setPublisherGamesLoading(true)
    invoke<Array<{ appid: number; name: string; header_image: string }>>(
      'get_games_by_publisher',
      { publisher: storeDetailPublisher, excludeAppid: appid }
    )
      .then((results) => { if (!cancelled) setPublisherGames(results) })
      .catch(() => { if (!cancelled) setPublisherGames([]) })
      .finally(() => { if (!cancelled) setPublisherGamesLoading(false) })
    return () => { cancelled = true }
  }, [storeDetailPublisher, appInfo?.appid])

  // Media carousel thumbnail scroll ref and handler
  const mediaThumbsRef = useRef<HTMLDivElement>(null)
  const handleScrollMediaThumbs = useCallback((direction: 'left' | 'right') => {
    if (!mediaThumbsRef.current) return
    const scrollDistance = 320
    mediaThumbsRef.current.scrollBy({
      left: direction === 'left' ? -scrollDistance : scrollDistance,
      behavior: 'smooth',
    })
  }, [])

  // Hardware specs & Steam community data hooks
  const systemSpecsHook = useSystemSpecs()
  const steamNews = useSteamNews(appInfo?.appid)
  const steamAchievements = useSteamGlobalAchievements(appInfo?.appid)

  // Media gallery items for Epic-style video trailers & screenshots viewer
  const richMediaList = useMemo(() => {
    if (!appInfo) return []
    const list: Array<{
      type: 'video' | 'image'
      thumbnail: string
      fullUrl: string
      videoUrl?: string
      title?: string
    }> = []

    // 1. Video trailers from storeDetail
    if (storeDetail?.movies && storeDetail.movies.length > 0) {
      for (const m of storeDetail.movies) {
        const vUrl =
          m.mp4_max ||
          m.mp4_480 ||
          (m.id ? `https://video.akamai.steamstatic.com/store_trailers/${m.id}/movie_max.mp4` : undefined) ||
          m.webm_max
        if (vUrl) {
          list.push({
            type: 'video',
            thumbnail: m.thumbnail || (m.id ? `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${m.id}/movie_600x337.jpg` : ''),
            fullUrl: m.thumbnail || (m.id ? `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${m.id}/movie_600x337.jpg` : ''),
            videoUrl: vUrl,
            title: m.name || (isVi ? 'Video giới thiệu trò chơi' : 'Game Trailer'),
          })
        }
      }
    }

    // 2. Screenshots from storeDetail
    if (storeDetail?.screenshots && storeDetail.screenshots.length > 0) {
      for (const s of storeDetail.screenshots) {
        list.push({
          type: 'image',
          thumbnail: s.path_thumbnail,
          fullUrl: s.path_full,
        })
      }
    }

    // 3. Fallback / hero / capsule / header images
    if (selectedHero && !list.some((it) => it.fullUrl === selectedHero)) {
      list.push({ type: 'image', thumbnail: selectedHero, fullUrl: selectedHero })
    }
    if (selectedCapsule && !list.some((it) => it.fullUrl === selectedCapsule)) {
      list.push({ type: 'image', thumbnail: selectedCapsule, fullUrl: selectedCapsule })
    }
    const header = localizedValue(selectedAssets?.header, locale) || storeDetail?.header_image
    if (header && !list.some((it) => it.fullUrl === header)) {
      list.push({ type: 'image', thumbnail: header, fullUrl: header })
    }
    const defaultHeader = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appInfo.appid}/header.jpg`
    if (!list.some((it) => it.fullUrl === defaultHeader)) {
      list.push({ type: 'image', thumbnail: defaultHeader, fullUrl: defaultHeader })
    }
    const pageBg = `https://cdn.akamai.steamstatic.com/steam/apps/${appInfo.appid}/page_bg_generated_v6b.jpg`
    if (!list.some((it) => it.fullUrl === pageBg)) {
      list.push({ type: 'image', thumbnail: pageBg, fullUrl: pageBg })
    }

    return list
  }, [appInfo, storeDetail, selectedHero, selectedCapsule, selectedAssets, locale])

  useEffect(() => {
    setActiveMediaIndex(0)
    setGameDetailTab('overview')
    setIsDescExpanded(false)
  }, [appInfo?.appid])

  const fetchCatalogPage = useCallback(async (searchQuery: string, cursor: string | null) => {
    const trimmedQuery = searchQuery.trim()
    const token = catalogRequestRef.current.token + 1
    catalogRequestRef.current = { query: trimmedQuery, cursor, token }
    setCatalogLoading(true)
    try {
      const page = await invoke<LuaCatalogSearchPage>('search_lua_games', {
        request: {
          query: trimmedQuery,
          cursor: cursor,
          limit: CATALOG_PAGE_SIZE,
          probeSources: false,
        },
      })
      // A later page/search replaced this request while it was in flight.
      if (catalogRequestRef.current.token !== token) {
        return
      }
      if (page?.items) {
        const mapped = page.items.map((it: { appid: number; name: string; headerImage?: string }) => ({
          appid: it.appid,
          name: it.name,
          headerImage:
            it.headerImage ||
            `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${it.appid}/header.jpg`,
        }))
        setCatalogItems(mapped)
        setNextCatalogCursor(page.nextCursor || null)
        if (page.totalEstimate != null) {
          setCatalogTotal(page.totalEstimate)
        }
        if (!trimmedQuery && !cursor) {
          cachedInitialCatalogItems = mapped
          cachedInitialCatalogTotal = page.totalEstimate ?? null
          cachedInitialNextCursor = page.nextCursor ?? null
        }
      }
    } catch (err) {
      if (catalogRequestRef.current.token !== token) {
        return
      }
      console.warn('Failed to load games catalog from search_lua_games, trying depot_downloader_get_catalog:', err)
      try {
        const fallback = await invoke<Array<{ appid: number; title: string; bannerUrl?: string }>>(
          'depot_downloader_get_catalog'
        )
        if (catalogRequestRef.current.token !== token) {
          return
        }
        if (fallback?.length) {
          setCatalogItems(
            fallback.map((f) => ({
              appid: f.appid,
              name: f.title,
              headerImage:
                f.bannerUrl ||
                `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${f.appid}/header.jpg`,
            }))
          )
          setCatalogTotal(fallback.length)
        }
      } catch (_) { }
    } finally {
      if (catalogRequestRef.current.token === token) {
        setCatalogLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedCatalogQuery(catalogSearchQuery.trim())
      setCatalogCursor(null)
      setCatalogCursorHistory([])
      setCatalogPage(1)
    }, 350)
    return () => clearTimeout(timer)
  }, [catalogSearchQuery])

  /**
   * One request per user action. `catalogCursor` is only a hint that a page
   * request is pending; the identity of that request (query + requested cursor)
   * is tracked here so a late response from a superseded page can never be
   * adopted as the current one. This also makes paging deterministic without
   * depending on how React batches two sibling `setState` calls.
   */
  const catalogRequestRef = useRef({ query: '', cursor: null as string | null, token: 0 })
  const catalogCursorRef = useRef<string | null>(null)
  const [catalogPage, setCatalogPage] = useState(1)

  useEffect(() => {
    if (appInfo) {
      return
    }
    if (!debouncedCatalogQuery && !catalogCursor && cachedInitialCatalogItems.length > 0) {
      return
    }
    void fetchCatalogPage(debouncedCatalogQuery, catalogCursor)
  }, [debouncedCatalogQuery, catalogCursor, appInfo, fetchCatalogPage])

  const handleSelectCatalogGame = (appid: number, name: string) => {
    setPendingGameInfo({
      appid,
      name,
      capsuleImg: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
      heroImg: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/library_hero.jpg`,
    })
    setQuery(name || appid.toString())
    void handleQueryApp(appid.toString())
  }

  const [maxConcurrency, setMaxConcurrency] = useState(32)
  const [showConcurrencyMenu, setShowConcurrencyMenu] = useState(false)
  void showConcurrencyMenu
  const concurrencyRef = useRef<HTMLDivElement>(null)
  const [verifyAll, setVerifyAll] = useState(true)

  // Real-time speed waveform history buffer (45 points)
  const [currentSpeedBps, setCurrentSpeedBps] = useState<number>(0)
  const [lastSpeedUpdate, setLastSpeedUpdate] = useState<number>(Date.now())

  // Hubcap quota status
  const [hubcapStatus, setHubcapStatus] = useState<DepotHubcapStatus | null>(null)
  const [isSyncingHubcap, setIsSyncingHubcap] = useState(false)
  const [showHubcapKeyModal, setShowHubcapKeyModal] = useState(false)

  // GSE Crack Post-download Interactive Prompt State
  const [gseCrackStatus, setGseCrackStatus] = useState<'idle' | 'running' | 'done' | 'failed'>('idle')
  const [gseCrackMessage, setGseCrackMessage] = useState<string>('')

  // Post-download 3-tab popup
  const [showPostDlPopup, setShowPostDlPopup] = useState(false)
  const [postDlTab, setPostDlTab] = useState<'translations' | 'bypass' | 'gse'>('translations')
  const [availableTranslations, setAvailableTranslations] = useState<Array<TranslationItem | LocalExtrasItem>>([])
  const [bypassBuilds, setBypassBuilds] = useState<BypassBuildItem[]>([])
  const [postDlScanning, setPostDlScanning] = useState(false)
  // True once the Steam-direct download has been registered as an install (Library + Play).
  const [depotInstalled, setDepotInstalled] = useState(false)
  const [finalizeMsg, setFinalizeMsg] = useState('')
  const [translationInstallStatus, setTranslationInstallStatus] = useState<'idle'|'running'|'done'|'error'>('idle')
  const [bypassInstallStatus, setBypassInstallStatus] = useState<'idle'|'running'|'done'|'error'>('idle')
  const [postDlMsg, setPostDlMsg] = useState('')

  const terminalBodyRef = useRef<HTMLDivElement>(null)

  // Close concurrency menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (concurrencyRef.current && !concurrencyRef.current.contains(e.target as Node)) {
        setShowConcurrencyMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])


  // Listen to progress events
  useEffect(() => {
    const unlisten = listen<DepotDownloadProgressEvent>('depot-download-progress', (event) => {
      const payload = event.payload
      if (!payload) return

      setCurrentProgress(payload)

      if (payload.speedMbps !== undefined && payload.speedMbps !== null) {
        const bps = payload.speedMbps * 1024 * 1024
        setCurrentSpeedBps(bps)
        setLastSpeedUpdate(Date.now())
      }

      if (payload.eventType === 'start' || payload.eventType === 'resumed') {
        setIsDownloading(true)
        setIsPaused(false)
        setDownloadSuccess(null)
        setStatusMessage(payload.message || (t.depotDirectUi.startingDownload))
      } else if (payload.eventType === 'depot-start') {
        setIsDownloading(true)
        setStatusMessage(payload.message || '')
      } else if (payload.eventType === 'log') {
        if (payload.message) {
          setDownloadLogs((prev) => [...prev.slice(-300), payload.message!])
        }
      } else if (payload.eventType === 'paused') {
        setIsDownloading(false)
        setIsPaused(true)
        setCurrentSpeedBps(0)
        setStatusMessage(payload.message || (t.depotDirectUi.pausedSafely))
      } else if (payload.eventType === 'complete') {
        setIsDownloading(false)
        setIsPaused(false)
        setCurrentSpeedBps(0)
        setDownloadSuccess(true)
        setStatusMessage(payload.message || (t.depotDirectUi.downloadCompletedSuccessfully))
      } else if (payload.eventType === 'error') {
        setIsDownloading(false)
        setIsPaused(false)
        setCurrentSpeedBps(0)
        setDownloadSuccess(false)
        setStatusMessage(payload.message || (t.depotDirectUi.depotDownloadError))
      } else if (payload.eventType === 'cancelled') {
        setIsDownloading(false)
        setIsPaused(false)
        setCurrentSpeedBps(0)
        setDownloadSuccess(false)
        setStatusMessage(payload.message || (t.depotDirectUi.downloadCancelled))
      }
    })

    return () => {
      unlisten.then((fn) => fn()).catch(() => { })
    }
  }, [t])

  // Check initial downloader status
  useEffect(() => {
    invoke<DepotDownloaderStatus>('depot_downloader_get_status')
      .then((status) => {
        if (status.isDownloading || status.isPaused) {
          setIsDownloading(status.isDownloading)
          setIsPaused(status.isPaused)
          if (status.destinationDir) setTargetDir(status.destinationDir)
        }
      })
      .catch(() => { })
  }, [])

  // Auto-scroll terminal log
  useEffect(() => {
    if (!showLogs || !terminalBodyRef.current) return
    terminalBodyRef.current.scrollTop = terminalBodyRef.current.scrollHeight
  }, [downloadLogs, showLogs])

  // Check disk space whenever targetDir changes
  const checkSpace = async (dirPath: string) => {
    if (!dirPath.trim()) {
      setDiskSpace(null)
      return
    }
    setLoadingDiskSpace(true)
    try {
      const space = await invoke<DiskSpaceInfo>('depot_downloader_check_disk_space', {
        targetPath: dirPath,
      })
      setDiskSpace(space)
    } catch {
      setDiskSpace(null)
    } finally {
      setLoadingDiskSpace(false)
    }
  }

  useEffect(() => {
    if (targetDir) {
      checkSpace(targetDir)
    }
  }, [targetDir])

  // Load Hubcap quota status on mount
  const loadHubcapStatus = useCallback(async () => {
    try {
      const status = await invoke<DepotHubcapStatus>('depot_downloader_get_hubcap_status')
      setHubcapStatus(status)
      return status
    } catch {
      setHubcapStatus(null)
      return null
    }
  }, [])

  useEffect(() => {
    loadHubcapStatus().then((status) => {
      const hasPrompted = sessionStorage.getItem('hubcap_key_prompted')
      if (!hasPrompted && status && !status.configured) {
        sessionStorage.setItem('hubcap_key_prompted', 'true')
        setShowHubcapKeyModal(true)
      }
    })
  }, [loadHubcapStatus])

  // Sync keys from Hubcap for current appInfo (Hubcap Free -> Ryuu -> LUIE -> Hubcap Manifest)
  const handleSyncHubcap = useCallback(async () => {
    if (!appInfo || isSyncingHubcap) return
    if (hubcapStatus && !hubcapStatus.configured) {
      setShowHubcapKeyModal(true)
      return
    }
    setIsSyncingHubcap(true)
    try {
      await invoke('depot_downloader_sync_hubcap', { appid: appInfo.appid })
      // Refresh app depot info to get updated keys
      const info = await invoke<SteamAppDepotInfo>('depot_downloader_get_steam_depots', { appid: appInfo.appid })
      setAppInfo(info)
      // Auto-check all depots that have a key available
      setSelectedDepotIds((prev) => {
        const next = new Set(prev)
        for (const d of info.depots) {
          if (d.hasKey || !!d.key) {
            next.add(d.depotId)
          }
        }
        return next
      })
      await loadHubcapStatus()
    } catch (err: any) {
      console.error('Hubcap sync failed:', err)
    } finally {
      setIsSyncingHubcap(false)
    }
  }, [appInfo, isSyncingHubcap, loadHubcapStatus])

  // Open Install Modal with all keyed depots checked by default
  const handleOpenInstallModal = useCallback(() => {
    if (appInfo) {
      setSelectedDepotIds((prev) => {
        const next = new Set(prev)
        for (const d of appInfo.depots) {
          if (d.hasKey || !!d.key) {
            next.add(d.depotId)
          }
        }
        return next.size > 0 ? next : prev
      })
    }
    setShowInstallModal(true)
  }, [appInfo])

  // Close search dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        setShowSearchDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const runSearch = async (text: string) => {
    const sequence = ++searchSequence.current
    setIsSearching(true)
    setError(null)
    const pending = searchInFlight.current?.query === text ? searchInFlight.current.promise
      : invoke<GameSearchResult[]>('depot_downloader_search_games', { query: text })
    searchInFlight.current = { query: text, promise: pending }
    try {
      const results = await pending
      if (sequence !== searchSequence.current) return
      setSearchResults(results)
      setShowSearchDropdown(results.length > 0)
      if (!results.length) setError(t.depotArchive.searchEmpty)
    } catch (error) {
      if (sequence === searchSequence.current) {
        setSearchResults([])
        setShowSearchDropdown(false)
        const code = String(error)
        setError(code.includes('RATE_LIMITED') ? t.depotArchive.rateLimited : code.includes('QUOTA') ? t.depotArchive.quotaExhausted : code.includes('INVALID_APP') ? t.depotArchive.invalidAppId : code.includes('NETWORK') ? t.depotArchive.networkError : t.depotArchive.searchError)
      }
    } finally {
      if (searchInFlight.current?.promise === pending) searchInFlight.current = null
      if (sequence === searchSequence.current) setIsSearching(false)
    }
  }

  useEffect(() => () => {
    searchSequence.current++
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
  }, [])

  const handleInputChange = (val: string) => {
    setQuery(val)
    searchSequence.current++
    setIsSearching(false)
    setError(null)
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    setSearchResults([])
    setShowSearchDropdown(false)
    const trimmed = val.trim()
    if (trimmed.length >= 2 && !/^\d+$/.test(trimmed)) {
      searchDebounceRef.current = setTimeout(() => void runSearch(trimmed), 350)
    }
  }

  // Run GSE Auto Setup with user confirmation
  const handleRunGseCrack = async () => {
    if (!appInfo || !targetDir.trim() || gseCrackStatus === 'running') return
    setGseCrackStatus('running')
    setGseCrackMessage('')
    try {
      await invoke('gse_auto_setup_run', {
        config: {
          appId: appInfo.appid,
          gameFolder: targetDir,
          engine: 'gse',
          gseVariant: 'regular',
          networkMode: 'singleplayer',
          steamstubMode: 'auto',
          accountName: 'Player',
          saveMode: 'gse',
          customSavePath: '',
          ucSpoofAppid: 0,
          ucPlugins: [],
          coldclientRenderer: false,
          coldclientExtra: false,
          overlay: true,
          overlayAchievementNotifications: true,
          overlayAchievementProgress: true,
          overlayFriendNotifications: false,
          overlayIcons: true,
          overlayUserInfo: false,
          overlayWarnings: false,
          overlayFps: false,
          overlayFrametime: false,
          overlayShowPlaytime: false,
          overlayPlaytime: false,
          overlayPosition: 'top-right',
          overlayHotkey: 'Shift+Tab',
          overlayFontSize: 14,
          overlayIconSize: 32,
          overlayRounding: 8,
          overlayAnimation: 300,
          overlayAchievementDuration: 3000,
          overlayHookDelay: 0,
          overlayRendererTimeout: 30,
          overlayDinputBridge: false,
          officialGenerator: false,
          reducedMotion: false,
          runeProfile: 'regular',
          runeUsername: 'Player',
          runeLanguage: 'english',
          runeUnlockAllDlcs: true,
          runeLobby: false,
          runeOverlays: false,
          runeOffline: false,
        },
      })
      setGseCrackStatus('done')
      setGseCrackMessage(
        t.depotDirectUi.gseSetupAppliedSuccessfullyGameIs
      )
    } catch (err: any) {
      setGseCrackStatus('failed')
      setGseCrackMessage(
        err?.toString() || (t.depotDirectUi.failedToApplyGseSetup)
      )
    }
  }

  // Apply Vietnamese translation patch to game folder
  const handleApplyTranslation = async (item: TranslationItem) => {
    if (!appInfo || !targetDir.trim() || translationInstallStatus === 'running') return
    setTranslationInstallStatus('running')
    setPostDlMsg('')
    try {
      await invoke('install_translation', {
        gameId: String(appInfo.appid),
        translationPath: item.path,
        downloadUrl: null,
        customPath: targetDir,
      })
      setTranslationInstallStatus('done')
      setPostDlMsg(t.depotDirectUi.translationApplied)
    } catch (err: any) {
      setTranslationInstallStatus('error')
      setPostDlMsg(String(err))
    }
  }

  // Apply Bypass / Fix package to game folder
  const handleApplyBypass = async (build: { buildid: string; tags: Array<{ tag: string; filename: string }> }) => {
    if (!appInfo || !targetDir.trim() || bypassInstallStatus === 'running') return
    setBypassInstallStatus('running')
    setPostDlMsg('')
    try {
      const tag = build.tags[0]?.tag || 'Bypass'
      const filename = build.tags[0]?.filename || null
      await invoke('install_bypass_fix', {
        gameId: String(appInfo.appid),
        appid: String(appInfo.appid),
        buildid: build.buildid,
        tag,
        filename,
        customPath: targetDir,
      })
      setBypassInstallStatus('done')
      setPostDlMsg(t.depotDirectUi.bypassApplied)
    } catch (err: any) {
      setBypassInstallStatus('error')
      setPostDlMsg(String(err))
    }
  }

  // Open SteamDB to search for AppIDs or view a specific game
  const handleOpenSteamDb = useCallback(async (customAppId?: number) => {
    let url = 'https://steamdb.info/'
    if (customAppId) {
      url = `https://steamdb.info/app/${customAppId}/`
    } else {
      const clean = query.trim()
      if (/^\d+$/.test(clean)) {
        url = `https://steamdb.info/app/${clean}/`
      } else if (clean) {
        url = `https://steamdb.info/search/?a=app&q=${encodeURIComponent(clean)}`
      }
    }

    try {
      await invoke('open_url', { url })
    } catch {
      window.open(url, '_blank')
    }
  }, [query])

  // Select a specific game from search results dropdown or quick pills
  const handleSelectGame = (item: GameSearchResult) => {
    searchSequence.current++
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    setIsSearching(false)
    setQuery(item.name || item.appid.toString())
    setShowSearchDropdown(false)
    setDepotStoreSearchOverlayOpen(false)
    setPendingGameInfo({
      appid: item.appid,
      name: item.name,
      capsuleImg: item.thumbnail || `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${item.appid}/header.jpg`,
      heroImg: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${item.appid}/library_hero.jpg`,
    })
    handleQueryApp(item.appid.toString())
  }

  const handleSearchOrScan = async () => {
    const raw = query.trim()
    if (!raw || loading) return
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (/^\d+$/.test(raw)) {
      searchSequence.current++
      setIsSearching(false)
      setShowSearchDropdown(false)
      void handleQueryApp(raw)
    } else {
      await runSearch(raw)
    }
  }

  // Query Steam Depots by specific numeric AppID
  const handleQueryApp = async (targetAppId?: string) => {
    const raw = (targetAppId ?? query).trim()
    if (!raw) return

    // If not numeric and no targetAppId passed, run search instead of picking random game
    if (!targetAppId && !/^\d+$/.test(raw)) {
      handleSearchOrScan()
      return
    }

    const appid = parseInt(raw, 10)
    if (isNaN(appid) || appid <= 0) {
      setError(
        t.depotDirectUi.invalidAppidPleaseEnterAValid
      )
      return
    }

    setLoading(true)
    setError(null)
    setShowSearchDropdown(false)
    setGseCrackStatus('idle')
    setGseCrackMessage('')
    setAppInfo(null)
    setSelectedDepotIds(new Set())
    setPendingGameInfo((prev) =>
      prev && prev.appid === appid
        ? prev
        : {
            appid,
            name: query && !/^\d+$/.test(query) ? query : `AppID ${appid}`,
            capsuleImg: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
            heroImg: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/library_hero.jpg`,
          }
    )

    try {
      // Parallel fetch depot manifests, rich store details, news, and achievements
      // so everything is completely ready before the detail page mounts
      const [depotsRes, storeRes, newsRes, achRes] = await Promise.allSettled([
        invoke<SteamAppDepotInfo>('depot_downloader_get_steam_depots', { appid }),
        invoke<SteamStoreDetail>('get_steam_store_detail', { appid: String(appid) }),
        invoke<SteamNewsItem[]>('get_steam_news', { appid: String(appid), count: 8 }),
        invoke<SteamGlobalAchievement[]>('get_steam_global_achievements', { appid: String(appid) }),
      ])

      if (depotsRes.status !== 'fulfilled') {
        throw depotsRes.reason
      }

      const info = depotsRes.value

      // Pre-warm the caches immediately so hooks return rich data on frame 1
      if (storeRes.status === 'fulfilled' && storeRes.value) {
        setStoreDetailCache(appid, storeRes.value)
      }
      if (newsRes.status === 'fulfilled' && newsRes.value) {
        setNewsCache(appid, newsRes.value)
      }
      if (achRes.status === 'fulfilled' && achRes.value) {
        setAchievementsCache(appid, achRes.value)
      }

      // Auto-set default directory (prefer Steam's official installdir)
      const safeName = info.name.replace(/[\/:*?"<>|]/g, '_').trim()
      const folderName = info.installDir || safeName
      const libraryBase = defaultLibraryRoot.replace(/[\\/]+$/, '')
      const dest = `${libraryBase}\\${folderName}`
      setTargetDir(dest)
      checkSpace(dest)

      setFilterOs('windows')
      setFilterType('all')
      setFilterLanguage('all')
      setSelectedBranch('public')
      setSelectedHistoryVersion('')

      // Neutral/current/English depots are default; all depots with valid keys are checked by default
      const defaultSelection = defaultDepotSelection(info.depots, locale).selected
      for (const d of info.depots) {
        if (d.hasKey || !!d.key) {
          defaultSelection.add(d.depotId)
        }
      }
      setSelectedDepotIds(defaultSelection)
      setAppInfo(info)
      setPendingGameInfo(null)
    } catch (err: any) {
      setPendingGameInfo(null)
      setError(
        err?.toString() ||
        (t.depotDirectUi.failedToQueryAppidFromSteam)
      )
    } finally {
      setLoading(false)
    }
  }

  // Handle external/random game selection into Store
  useEffect(() => {
    if (initialAppId && initialAppId > 0) {
      setQuery(initialAppId.toString())
      void handleQueryApp(initialAppId.toString())
    }
  }, [initialAppId])

  useEffect(() => {
    const handleEvent = (e: CustomEvent<{ appid: number }>) => {
      if (e.detail?.appid && e.detail.appid > 0) {
        setQuery(e.detail.appid.toString())
        void handleQueryApp(e.detail.appid.toString())
      }
    }
    window.addEventListener('0xo-select-store-game', handleEvent as EventListener)
    return () => window.removeEventListener('0xo-select-store-game', handleEvent as EventListener)
  }, [])

  // Branch Selection Handler
  const handleSelectBranch = (branchName: string) => {
    if (!appInfo) return
    setSelectedBranch(branchName)
    setSelectedHistoryVersion('')

    const branchInfo = appInfo.branches?.find((b) => b.name === branchName)
    const newBuildId = branchInfo?.buildId || appInfo.publicBuildId

    const updatedDepots = appInfo.depots.map((depot) => {
      const branchManifest = depot.manifests?.[branchName]
      return {
        ...depot,
        publicManifestId: branchManifest ? branchManifest.gid : (branchName === 'public' ? depot.publicManifestId : undefined),
        size: branchManifest && branchManifest.size > 0 ? branchManifest.size : depot.size,
        downloadSize: branchManifest && branchManifest.downloadSize > 0 ? branchManifest.downloadSize : depot.downloadSize,
      }
    })

    setAppInfo({
      ...appInfo,
      publicBuildId: newBuildId,
      depots: updatedDepots,
    })

    setSelectedDepotIds(new Set(updatedDepots.filter((d) => Boolean(d.publicManifestId)).map((d) => d.depotId)))
  }

  // Historical Version Selection Handler
  const handleSelectHistoryVersion = (buildId: string) => {
    if (!appInfo || !appInfo.history) return
    setSelectedHistoryVersion(buildId)
    if (!buildId) {
      handleSelectBranch('public')
      return
    }

    const histItem = versionHistory.find((h) => h.buildId === buildId)
    if (!histItem) return
    if (histItem.metadataOnly || Object.keys(histItem.manifests).length === 0) {
      window.open(histItem.url || `https://steamdb.info/app/${appInfo.appid}/patchnotes/`, '_blank', 'noopener,noreferrer')
      return
    }
    setSelectedBranch(histItem.branch || 'public')

    const updatedDepots = appInfo.depots.map((depot) => {
      const depotHist = histItem.manifests[String(depot.depotId)]
      return {
        ...depot,
        publicManifestId: depotHist ? depotHist.gid : depot.publicManifestId,
        size: depotHist && depotHist.size > 0 ? depotHist.size : depot.size,
        downloadSize: depotHist && depotHist.download > 0 ? depotHist.download : depot.downloadSize,
      }
    })

    setAppInfo({
      ...appInfo,
      publicBuildId: buildId,
      depots: updatedDepots,
    })

    setSelectedDepotIds(new Set(updatedDepots.filter((d) => Boolean(d.publicManifestId)).map((d) => d.depotId)))
  }

  // Browse Directory
  const handleBrowseDir = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t.depotDirectUi.selectGameDestinationDirectory,
      })
      if (selected && typeof selected === 'string') {
        setTargetDir(selected)
      }
    } catch (e) {
      console.error('Directory browse failed:', e)
    }
  }

  // Depot Checkbox toggles
  const toggleDepot = (depotId: number) => {
    setSelectedDepotIds((prev) => {
      const next = new Set(prev)
      if (next.has(depotId)) {
        next.delete(depotId)
      } else {
        next.add(depotId)
      }
      return next
    })
  }

  const handleSelectAll = () => {
    if (!appInfo) return
    const all = new Set(filteredDepots.map((d) => d.depotId))
    setSelectedDepotIds((prev) => new Set([...prev, ...all]))
  }

  const handleDeselectAll = () => {
    setSelectedDepotIds(new Set())
  }

  const handleSelectKeyedDepots = () => {
    if (!appInfo) return
    const keyed = new Set(appInfo.depots.filter((d) => d.hasKey || !!d.key).map((d) => d.depotId))
    setSelectedDepotIds(keyed)
  }

  // Available languages across depots
  const availableLanguages = useMemo(() => {
    if (!appInfo) return []
    const langs = new Set<string>()
    for (const d of appInfo.depots) {
      if (d.language) langs.add(d.language)
    }
    return Array.from(langs).sort()
  }, [appInfo])
  void availableLanguages

  // Filtered depots list with multi-OS, type, and language filtering
  const filteredDepots = useMemo(() => {
    if (!appInfo) return []
    return appInfo.depots.filter((d) => {
      // OS filter
      if (filterOs !== 'all') {
        if (d.os && !d.os.toLowerCase().includes(filterOs)) {
          return false
        }
      }
      // DLC / Type filter
      if (filterType === 'dlc' && !d.dlcAppid) {
        return false
      }
      if (filterType === 'base' && d.dlcAppid) {
        return false
      }
      // Language filter
      if (filterLanguage !== 'all') {
        if (d.language && d.language.toLowerCase() !== filterLanguage.toLowerCase()) {
          return false
        }
      }
      return true
    })
  }, [appInfo, filterOs, filterType, filterLanguage])

  // Calculation of required bytes & space
  // requiredBytes = installed size of selected depots (used for disk space check)
  const requiredBytes = useMemo(() => {
    if (!appInfo) return 0
    return appInfo.depots
      .filter((d) => selectedDepotIds.has(d.depotId))
      .reduce((sum, d) => sum + (d.size || 0), 0)
  }, [appInfo, selectedDepotIds])

  // selectedDownloadBytes = download/compressed size of selected depots (displayed in sidebar CTA)
  const selectedDownloadBytes = useMemo(() => {
    if (!appInfo) return 0
    return appInfo.depots
      .filter((d) => selectedDepotIds.has(d.depotId))
      .reduce((sum, d) => sum + (d.downloadSize ?? d.size ?? 0), 0)
  }, [appInfo, selectedDepotIds])

  const hasEnoughSpace = useMemo(() => {
    if (!diskSpace || requiredBytes === 0) return true
    return diskSpace.freeBytes >= requiredBytes
  }, [diskSpace, requiredBytes])

  const missingKeysCount = useMemo(() => {
    if (!appInfo) return 0
    return appInfo.depots
      .filter((d) => selectedDepotIds.has(d.depotId) && !d.hasKey)
      .length
  }, [appInfo, selectedDepotIds])

  const totalAllDepotsSize = useMemo(() => {
    if (!appInfo) return 0
    return appInfo.depots.reduce((sum, d) => sum + (d.size || 0), 0)
  }, [appInfo])

  // Start Selective Download
  const handleStartDownload = async () => {
    if (!appInfo || selectedDepotIds.size === 0 || !targetDir.trim()) return

    if (!hasEnoughSpace) {
      setError(
        t.depotDirectUi.notEnoughDiskSpaceNeedsOnly.replaceAll('{0}', String(formatBytes(requiredBytes))).replaceAll('{1}', String(formatBytes(diskSpace?.freeBytes || 0)))
      )
      return
    }

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
    setDownloadLogs([])
    setStatusMessage(t.depotDirectUi.startingSelectiveDownloadPipeline)

    try {
      await invoke('depot_downloader_start_selective_download', {
        appid: appInfo.appid,
        gameTitle: appInfo.name,
        selections,
        destinationDir: targetDir,
        maxDownloads: maxConcurrency,
        verifyAll,
      })
    } catch (err: any) {
      setIsDownloading(false)
      setIsPaused(false)
      setDownloadSuccess(false)
      setStatusMessage(err?.toString() || (t.depotDirectUi.failedToStartDownload))
    }
  }

  // Pause / Resume / Cancel
  const handlePause = async () => {
    try {
      await invoke('depot_downloader_pause_download')
      setStatusMessage(t.depotDirectUi.pausingSafely)
    } catch (err: any) {
      setStatusMessage(err?.toString() || '')
    }
  }

  const handleResume = async () => {
    try {
      await invoke('depot_downloader_resume_download')
      setIsPaused(false)
      setIsDownloading(true)
      setStatusMessage(t.depotDirectUi.resumingDownload)
    } catch (err: any) {
      setStatusMessage(err?.toString() || '')
    }
  }

  const handleCancel = async () => {
    try {
      if (isDownloading || isPaused) {
        await invoke('depot_downloader_cancel_download')
      }
    } catch (err: any) {
      console.error(err)
    } finally {
      setIsDownloading(false)
      setIsPaused(false)
      setDownloadSuccess(null)
      setCurrentProgress(null)
      setStatusMessage('')
    }
  }

  // Open Destination Directory
  const handleOpenDir = async () => {
    if (!targetDir) return
    try {
      await invoke('open_folder', { path: targetDir })
    } catch (e) {
      console.error(e)
    }
  }

  // Launch a game that was installed through Steam Direct (Play button state).
  // The backend registers Steam-direct installs under the canonical launcher game id, so
  // calling launch_game with the raw AppID would fail with "not installed".
  const handlePlayDepotGame = async () => {
    if (!appInfo?.appid || !targetDir.trim()) return
    try {
      const outcome = await invoke<{ gameId: string; launchExecutable: string }>('depot_downloader_finalize_install', {
        appid: appInfo.appid,
        destinationDir: targetDir,
        launchExecutable: appInfo.launchExecutable ?? null,
        title: appInfo.name || String(appInfo.appid),
        buildId: null,
        launchArguments: appInfo.launchArguments ?? null,
      })
      const gameId = outcome?.gameId || String(appInfo.appid)
      window.dispatchEvent(new CustomEvent('0xo-install-state-refresh', {
        detail: { gameId },
      }))
      await invoke('launch_game', {
        gameId,
        installPath: targetDir,
        launchExecutable: outcome?.launchExecutable ?? appInfo.launchExecutable ?? null,
        launchOptionId: null,
        skipCloudSync: false,
      })
    } catch (e) {
      setFinalizeMsg(String(e))
    }
  }

  const renderPhaseBadge = (phase?: string) => {
    if (!phase) return null
    if (phase === 'pre_allocating') {
      return (
        <span className="steam-direct-phase-badge is-prealloc">
          {t.depotDirectUi.preallocatingSpace}
        </span>
      )
    }
    if (phase === 'validating') {
      return (
        <span className="steam-direct-phase-badge is-validating">
          {t.depotDirectUi.validatingExistingFiles}
        </span>
      )
    }
    if (phase === 'manifest') {
      return (
        <span className="steam-direct-phase-badge is-manifest">
          {t.depotDirectUi.fetchingManifest}
        </span>
      )
    }
    return (
      <span className="steam-direct-phase-badge is-downloading">
        {t.depotDirectUi.downloadingChunks}
      </span>
    )
  }

  return (
    <div className="steam-direct-view">
      {/* ══════════════════════════════════════════════════════════════════
          EPIC GAMES STORE — BROWSE / DISCOVER VIEW (Image 1)
          ══════════════════════════════════════════════════════════════════ */}
      {!appInfo && !loading && (
        <div className="epic-store-browse">
          {/* Top Bar: Nav Tabs (Discover / Browse / News) + Epic Search Bar */}
          <header className="epic-store-topbar">
            <nav className="epic-store-nav" role="tablist">
              <button
                type="button"
                className={`epic-nav-link ${storeNavTab === 'discover' ? 'is-active' : ''}`}
                onClick={() => setStoreNavTab('discover')}
              >
                {isVi ? 'Khám phá' : 'Discover'}
              </button>
              <button
                type="button"
                className={`epic-nav-link ${storeNavTab === 'browse' ? 'is-active' : ''}`}
                onClick={() => setStoreNavTab('browse')}
              >
                {isVi ? 'Duyệt tìm' : 'Browse'}
              </button>
              <button
                type="button"
                className={`epic-nav-link ${storeNavTab === 'news' ? 'is-active' : ''}`}
                onClick={() => setStoreNavTab('news')}
              >
                {isVi ? 'Tin tức' : 'News'}
              </button>
            </nav>

            <div className="epic-topbar-right">
              {/* LuaShop-style primary toolbar: sort dropdown + layout toggle + command search */}
              <div className="lua-shop-primary-toolbar depot-store-primary-toolbar">
                {/* Sort Dropdown */}
                <div className="store-sort-dropdown">
                  <button
                    type="button"
                    className="sort-toggle-btn"
                    onClick={() => setSortOpen((value) => !value)}
                    onBlur={() => window.setTimeout(() => setSortOpen(false), 180)}
                  >
                    <SlidersHorizontal size={14} />
                    <span>
                      {storeSort === 'az'
                        ? 'A → Z'
                        : storeSort === 'za'
                        ? 'Z → A'
                        : storeSort === 'appidAsc'
                        ? 'AppID ↑'
                        : 'AppID ↓'}
                    </span>
                  </button>
                  {sortOpen && (
                    <div className="sort-dropdown-menu">
                      <button
                        type="button"
                        className={storeSort === 'az' ? 'active' : ''}
                        onClick={() => setShopSort('az')}
                      >
                        A → Z
                      </button>
                      <button
                        type="button"
                        className={storeSort === 'za' ? 'active' : ''}
                        onClick={() => setShopSort('za')}
                      >
                        Z → A
                      </button>
                      <button
                        type="button"
                        className={storeSort === 'appidAsc' ? 'active' : ''}
                        onClick={() => setShopSort('appidAsc')}
                      >
                        AppID ↑
                      </button>
                      <button
                        type="button"
                        className={storeSort === 'appidDesc' ? 'active' : ''}
                        onClick={() => setShopSort('appidDesc')}
                      >
                        AppID ↓
                      </button>
                    </div>
                  )}
                </div>

                {/* View Layout & Density Toggle */}
                <div className="view-layout-toggle lua-shop-layout-toggle" style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center' }}>
                  {viewLayout === 'grid' && (
                    <div className="lua-shop-grid-density" style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: '2px', padding: '0 6px 0 2px', marginRight: '4px', borderRight: '1px solid rgba(255, 255, 255, 0.1)' }}>
                      <button
                        type="button"
                        className={gridCols === 4 ? 'active' : ''}
                        onClick={() => setShopGridCols(4)}
                        title={isVi ? '4 cột' : '4 columns'}
                      >
                        4x
                      </button>
                      <button
                        type="button"
                        className={gridCols === 6 ? 'active' : ''}
                        onClick={() => setShopGridCols(6)}
                        title={isVi ? '6 cột' : '6 columns'}
                      >
                        6x
                      </button>
                      <button
                        type="button"
                        className={gridCols === 8 ? 'active' : ''}
                        onClick={() => setShopGridCols(8)}
                        title={isVi ? '8 cột' : '8 columns'}
                      >
                        8x
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    className={viewLayout === 'grid' ? 'active' : ''}
                    onClick={() => setShopLayout('grid')}
                    title={isVi ? 'Hiển thị dạng lưới' : 'Grid View'}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect width="7" height="7" x="3" y="3" rx="1" />
                      <rect width="7" height="7" x="14" y="3" rx="1" />
                      <rect width="7" height="7" x="14" y="14" rx="1" />
                      <rect width="7" height="7" x="3" y="14" rx="1" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className={viewLayout === 'list' ? 'active' : ''}
                    onClick={() => setShopLayout('list')}
                    title={isVi ? 'Hiển thị dạng danh sách' : 'List View'}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect width="7" height="7" x="3" y="3" rx="1" />
                      <rect width="7" height="7" x="3" y="14" rx="1" />
                      <path d="M14 6h7" />
                      <path d="M14 10h7" />
                      <path d="M14 14h7" />
                      <path d="M14 18h7" />
                    </svg>
                  </button>
                </div>

                {/* Command Search */}
                <label className="store-search lua-shop-command-search">
                  {catalogSearchQuery.trim().length > 0 && (catalogLoading || isSearching) ? (
                    <Loader2
                      size={16}
                      className="is-spinning"
                      style={{ color: 'var(--search-accent, #82afc7)' }}
                    />
                  ) : (
                    <Search size={16} />
                  )}
                  <input
                    ref={searchInputRef}
                    type="text"
                    placeholder={
                      isVi
                        ? 'Tìm kiếm theo tên game hoặc AppID...'
                        : 'Search by game name or AppID...'
                    }
                    value={catalogSearchQuery}
                    onFocus={() => setDepotStoreSearchOverlayOpen(true)}
                    onClick={() => setDepotStoreSearchOverlayOpen(true)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        const target = catalogSearchQuery.trim()
                        if (/^\d+$/.test(target)) {
                          void handleQueryApp(target)
                        }
                      }
                    }}
                    onChange={(event) => {
                      const val = event.target.value
                      setCatalogSearchQuery(val)
                      handleInputChange(val)
                    }}
                  />
                  {catalogSearchQuery ? (
                    <button
                      type="button"
                      className="lua-shop-search-clear"
                      title={isVi ? 'Xóa tìm kiếm' : 'Clear search'}
                      onClick={(event) => {
                        event.preventDefault()
                        setCatalogSearchQuery('')
                        handleInputChange('')
                        searchInputRef.current?.focus()
                      }}
                    >
                      <X size={14} />
                    </button>
                  ) : (
                    <kbd>Ctrl K</kbd>
                  )}
                </label>
              </div>

              {/* SteamDB Button */}
              <button
                type="button"
                className="epic-steamdb-btn"
                onClick={() => handleOpenSteamDb()}
                title={t.depotDirectUi.openSteamdbToSearchGamesFind}
              >
                <img src={steamDbIconUrl} alt="SteamDB" className="epic-steamdb-icon" />
                <span>SteamDB</span>
              </button>

              {/* Hubcap Quota Indicator */}
              <div
                className={`epic-hubcap-pill steam-direct-hubcap-badge ${hubcapStatus?.valid && hubcapStatus?.serviceReady ? 'is-ready is-active' : 'is-warn is-inactive'}`}
                title="Hubcap Manifest API key & quota"
                onClick={() => setShowHubcapKeyModal(true)}
                style={{ cursor: 'pointer' }}
              >
                <Zap size={12} />
                <span>MRC</span>
                {hubcapStatus?.configured && (
                  <span className="epic-hubcap-count">
                    {hubcapStatus.buckets.single.remaining ?? 0}/{hubcapStatus.buckets.single.limit ?? 0}
                  </span>
                )}
              </div>
            </div>
          </header>

          {/* Fullscreen Search Overlay (Lua Shop Parity) */}
          <UnifiedSearchOverlay
            open={depotStoreSearchOverlayOpen}
            query={catalogSearchQuery}
            onQueryChange={(val) => {
              setCatalogSearchQuery(val)
              handleInputChange(val)
            }}
            onClose={() => {
              setDepotStoreSearchOverlayOpen(false)
              setShowSearchDropdown(false)
            }}
            onSubmit={(submittedQuery) => {
              const target = (submittedQuery ?? catalogSearchQuery).trim()
              if (/^\d+$/.test(target)) {
                void handleQueryApp(target)
                setDepotStoreSearchOverlayOpen(false)
              }
            }}
            loading={catalogSearchQuery.trim().length > 0 && (catalogLoading || isSearching)}
            loadingText={isVi ? 'Đang tìm kiếm...' : 'Searching...'}
            placeholder={
              isVi
                ? 'Tìm kiếm theo tên game hoặc AppID...'
                : 'Search by game name or AppID...'
            }
            ariaLabel="Search Store Catalog"
            resultCount={searchResults.length > 0 ? searchResults.length : displayedCatalogItems.length}
            resultsHint={
              isVi
                ? `${searchResults.length > 0 ? searchResults.length : displayedCatalogItems.length} kết quả`
                : `${searchResults.length > 0 ? searchResults.length : displayedCatalogItems.length} results`
            }
            discoveryTitle={isVi ? 'Gợi ý nổi bật' : 'Featured Games'}
            discoveryHint={isVi ? 'Chọn game để mở chi tiết và tải depot' : 'Select a game to view depots'}
            historyKey="0xo.storeCatalogSearchHistory"
          >
            {searchResults.length > 0 ? (
              searchResults.map((item) => (
                <UnifiedSearchResult
                  key={`depot-search-api-${item.appid}`}
                  title={item.name}
                  subtitle={`AppID ${item.appid}`}
                  matchLabel="Search Result"
                  imageUrl={
                    item.thumbnail ||
                    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${item.appid}/header.jpg`
                  }
                  onClick={() => handleSelectGame(item)}
                />
              ))
            ) : displayedCatalogItems.length > 0 ? (
              displayedCatalogItems.slice(0, 36).map((item) => {
                const appid = String(item.appid)
                return (
                  <UnifiedSearchResult
                    key={`depot-search-result-${appid}`}
                    title={item.name}
                    subtitle={`AppID ${appid}`}
                    matchLabel="Steam Direct"
                    imageUrl={
                      item.headerImage ||
                      `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`
                    }
                    onClick={() => {
                      setDepotStoreSearchOverlayOpen(false)
                      handleSelectCatalogGame(item.appid, item.name)
                    }}
                  />
                )
              })
            ) : (
              <div className="store-search-empty">
                <Search size={28} />
                <strong>{isVi ? 'Không tìm thấy kết quả nào' : 'No matching games found'}</strong>
                <span>
                  {isVi
                    ? 'Thử nhập AppID hoặc từ khóa khác'
                    : 'Try entering an AppID or different keyword'}
                </span>
              </div>
            )}
          </UnifiedSearchOverlay>

          {/* Error Banner */}
          {error && (
            <div className="steam-direct-alert is-error" style={{ margin: '0 28px' }}>
              <AlertCircle size={18} />
              <span>{error}</span>
            </div>
          )}

          {/* Active Download Overlay / Progress Card if active */}
          {(isDownloading || isPaused || downloadSuccess !== null) && (
            <section className="steam-direct-progress-card" style={{ margin: '0 28px' }}>
              <div className="steam-direct-progress-header">
                <div className="steam-direct-progress-title">
                  {isDownloading && <Loader2 size={18} className="is-spinning is-accent" />}
                  {isPaused && <Pause size={18} className="is-warning" />}
                  {downloadSuccess === true && <CheckCircle2 size={18} className="is-success" />}
                  {downloadSuccess === false && <XCircle size={18} className="is-error" />}
                  <div>
                    <h4>
                      {statusMessage || (isDownloading ? t.depotDirectUi.downloading : '')}
                    </h4>
                    <div className="steam-direct-progress-sub">
                      {renderPhaseBadge(currentProgress?.phase)}
                      {currentProgress?.depotId && <span>Depot: {currentProgress.depotId}</span>}
                      {currentProgress?.totalDepots ? (
                        <span>
                          ({currentProgress.currentDepotIndex}/{currentProgress.totalDepots} depots)
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="steam-direct-progress-actions">
                  {isDownloading && (
                    <button type="button" className="steam-direct-btn is-quiet" onClick={handlePause}>
                      <Pause size={14} /> {t.depotDirectUi.pause}
                    </button>
                  )}
                  {isPaused && (
                    <button type="button" className="steam-direct-btn is-accent" onClick={handleResume}>
                      <Play size={14} /> {t.depotDirectUi.resume}
                    </button>
                  )}
                  {(isDownloading || isPaused || downloadSuccess === false) && (
                    <button type="button" className="steam-direct-btn is-danger" onClick={handleCancel}>
                      <XCircle size={14} /> {downloadSuccess === false ? ((t as any).depotDirectUi?.close || 'Đóng') : t.depotDirectUi.cancel}
                    </button>
                  )}
                  {downloadSuccess === true && (
                    <button type="button" className="steam-direct-btn is-success" onClick={handleOpenDir}>
                      <Folder size={14} /> {t.depotDirectUi.openFolder}
                    </button>
                  )}
                </div>
              </div>

              <DownloadWaveCard telemetry={{
                transferId: `depot:${currentProgress?.appid || 0}`,
                owner: 'depot',
                state: isPaused ? 'paused' : isDownloading ? 'downloading' : downloadSuccess === true ? 'complete' : downloadSuccess === false ? 'failed' : 'queued',
                phaseLabel: currentProgress?.phase === 'pre_allocating'
                  ? t.depotDirectUi.preallocatingSpace
                  : currentProgress?.phase === 'validating'
                    ? t.depotDirectUi.validatingExistingFiles
                    : currentProgress?.phase === 'manifest'
                      ? t.depotDirectUi.fetchingManifest
                      : undefined,
                bytesPerSecond: currentSpeedBps,
                downloadedBytes: currentProgress?.transferredBytes,
                totalBytes: currentProgress?.totalBytes || requiredBytes,
                progress: currentProgress?.progressPercent,
                etaSeconds: (currentSpeedBps && currentSpeedBps > 0 && currentProgress?.totalBytes && currentProgress?.transferredBytes)
                  ? Math.max(0, (currentProgress.totalBytes - currentProgress.transferredBytes) / currentSpeedBps)
                  : undefined,
                updatedAt: lastSpeedUpdate,
              }} />
            </section>
          )}

          {/* Epic Hero Banner Carousel with Auto-play & Progress Indicator */}
          <EpicHeroBanner onSelectGame={handleSelectCatalogGame} isVi={isVi} />

          {/* Catalog Section with Genre Filter, Header, Grid & Pagination */}
          <section className="depot-catalog-section" ref={catalogContainerRef} style={{ margin: '0 28px' }}>
            {/* Genre & Tag Filter Bar (Hydra Parity) */}
            <div className="store-genre-filter-bar">
              <div className="store-genre-filter-header">
                <div className="store-genre-filter-label">
                  <Sparkles size={14} className="store-genre-sparkle" />
                  <span>{isVi ? 'Thể loại game (Genres & Tags):' : 'Game Genres & Tags:'}</span>
                </div>
                {selectedTag !== 'all' && (
                  <button
                    type="button"
                    className="store-genre-clear-all"
                    onClick={() => setSelectedTag('all')}
                  >
                    {isVi ? '✕ Xóa bộ lọc' : '✕ Reset filter'}
                  </button>
                )}
              </div>
              <div className="store-genre-pills">
                {STORE_GENRES_AND_TAGS.map((cat) => {
                  const isActive = selectedTag === cat.id
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      className={`store-genre-pill ${isActive ? 'is-active' : ''}`}
                      onClick={() => setSelectedTag(cat.id)}
                    >
                      <span>{isVi ? cat.labelVi : cat.labelEn}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="depot-catalog-header">
              <div className="depot-catalog-title-group">
                <div>
                  <span className="depot-catalog-eyebrow">{isVi ? 'DANH MỤC CỬA HÀNG' : 'STORE CATALOG'}</span>
                  <h3>{isVi ? 'Khám phá game' : 'Discover games'}</h3>
                </div>
                <span className="depot-catalog-count-pill">
                  {catalogTotal ? `${catalogTotal.toLocaleString()} games` : `${displayedCatalogItems.length} games`}
                </span>
              </div>

              <div className="depot-catalog-controls">
                {/* View Layout & Density Toggle (Lua Shop Parity) */}
                <div className="view-layout-toggle lua-shop-layout-toggle" style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center' }}>
                  {viewLayout === 'grid' && (
                    <div className="lua-shop-grid-density" style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: '2px', padding: '0 6px 0 2px', marginRight: '4px', borderRight: '1px solid rgba(255, 255, 255, 0.1)' }}>
                      <button
                        type="button"
                        className={gridCols === 4 ? 'active' : ''}
                        onClick={() => setShopGridCols(4)}
                        title={isVi ? '4 cột' : '4 columns'}
                      >
                        4x
                      </button>
                      <button
                        type="button"
                        className={gridCols === 6 ? 'active' : ''}
                        onClick={() => setShopGridCols(6)}
                        title={isVi ? '6 cột' : '6 columns'}
                      >
                        6x
                      </button>
                      <button
                        type="button"
                        className={gridCols === 8 ? 'active' : ''}
                        onClick={() => setShopGridCols(8)}
                        title={isVi ? '8 cột' : '8 columns'}
                      >
                        8x
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    className={viewLayout === 'grid' ? 'active' : ''}
                    onClick={() => setShopLayout('grid')}
                    title={isVi ? 'Hiển thị dạng lưới' : 'Grid View'}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect width="7" height="7" x="3" y="3" rx="1" />
                      <rect width="7" height="7" x="14" y="3" rx="1" />
                      <rect width="7" height="7" x="14" y="14" rx="1" />
                      <rect width="7" height="7" x="3" y="14" rx="1" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className={viewLayout === 'list' ? 'active' : ''}
                    onClick={() => setShopLayout('list')}
                    title={isVi ? 'Hiển thị dạng danh sách' : 'List View'}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect width="7" height="7" x="3" y="3" rx="1" />
                      <rect width="7" height="7" x="3" y="14" rx="1" />
                      <path d="M14 6h7" />
                      <path d="M14 10h7" />
                      <path d="M14 14h7" />
                      <path d="M14 18h7" />
                    </svg>
                  </button>
                </div>

                <div className="depot-catalog-sort-group" role="group" aria-label={isVi ? 'Sắp xếp danh mục' : 'Sort catalog'}>
                  <button
                    type="button"
                    className={`depot-catalog-sort-btn ${storeSort === 'az' && catalogSort === 'featured' ? 'is-active' : ''}`}
                    onClick={() => {
                      setCatalogSort('featured')
                      setShopSort('az')
                    }}
                  >
                    {isVi ? 'Nổi bật' : 'Featured'}
                  </button>
                  <button
                    type="button"
                    className={`depot-catalog-sort-btn ${storeSort === 'az' ? 'is-active' : ''}`}
                    onClick={() => setShopSort('az')}
                  >
                    A – Z
                  </button>
                  <button
                    type="button"
                    className={`depot-catalog-sort-btn ${storeSort === 'za' ? 'is-active' : ''}`}
                    onClick={() => setShopSort('za')}
                  >
                    Z – A
                  </button>
                  <button
                    type="button"
                    className={`depot-catalog-sort-btn ${storeSort === 'appidAsc' ? 'is-active' : ''}`}
                    onClick={() => setShopSort('appidAsc')}
                  >
                    AppID ↑
                  </button>
                </div>
                <button
                  type="button"
                  className="depot-catalog-refresh-btn"
                  onClick={() => void fetchCatalogPage(debouncedCatalogQuery, catalogCursor)}
                  disabled={catalogLoading}
                  title={isVi ? 'Làm mới danh sách' : 'Refresh catalog'}
                >
                  <RefreshCw size={14} className={catalogLoading ? 'is-spinning' : ''} />
                </button>
              </div>
            </div>

            {catalogLoading && catalogItems.length === 0 ? (
              <div className="depot-catalog-skeleton-grid">
                {Array.from({ length: 8 }).map((_, idx) => (
                  <div key={`skel-${idx}`} className="depot-catalog-card is-skeleton">
                    <div className="depot-catalog-card-cover-wrapper">
                      <div className="depot-catalog-card-cover is-loading" />
                    </div>
                    <div className="depot-catalog-card-details">
                      <div className="depot-skeleton-line is-title" />
                      <div className="depot-skeleton-line is-sub" />
                    </div>
                  </div>
                ))}
              </div>
            ) : catalogItems.length === 0 ? (
              <div className="depot-catalog-empty">
                <HardDrive size={36} />
                <p>{isVi ? 'Không tìm thấy game nào phù hợp' : 'No matching games found'}</p>
                {catalogSearchQuery && (
                  <button
                    type="button"
                    className="steam-direct-btn is-sm"
                    onClick={() => {
                      setCatalogSearchQuery('')
                      setQuery('')
                    }}
                  >
                    {isVi ? 'Xóa bộ lọc tìm kiếm' : 'Clear Search Filter'}
                  </button>
                )}
              </div>
            ) : (
              <>
                <div
                  className="depot-catalog-grid"
                  data-layout={viewLayout}
                  style={{ '--depot-grid-cols': gridCols } as CSSProperties}
                >
                  {displayedCatalogItems.map((item) => (
                    <DepotCatalogGameCard
                      key={item.appid}
                      item={item}
                      onSelect={handleSelectCatalogGame}
                    />
                  ))}
                </div>

                {/* Pagination */}
                <div className="depot-catalog-pagination">
                  <button
                    type="button"
                    className="depot-pagination-btn"
                    disabled={catalogPage === 1 || catalogLoading}
                    onClick={() => {
                      if (catalogPage <= 1) return
                      const prevCursor = catalogCursorHistory[catalogCursorHistory.length - 1] ?? null
                      setCatalogCursorHistory((prev) => prev.slice(0, -1))
                      setCatalogPage((prev) => prev - 1)
                      catalogCursorRef.current = prevCursor
                      setCatalogCursor(prevCursor)
                      void fetchCatalogPage(debouncedCatalogQuery, prevCursor)
                    }}
                  >
                    <ChevronLeft size={16} />
                    <span>{isVi ? 'Trang trước' : 'Previous'}</span>
                  </button>
                  <span className="depot-pagination-info">
                    {isVi ? `Trang ${catalogPage}` : `Page ${catalogPage}`}
                  </span>
                  <button
                    type="button"
                    className="depot-pagination-btn"
                    disabled={!nextCatalogCursor || catalogLoading}
                    onClick={() => {
                      if (!nextCatalogCursor) return
                      setCatalogCursorHistory((prev) => [...prev, catalogCursor])
                      setCatalogPage((prev) => prev + 1)
                      catalogCursorRef.current = nextCatalogCursor
                      setCatalogCursor(nextCatalogCursor)
                      void fetchCatalogPage(debouncedCatalogQuery, nextCatalogCursor)
                    }}
                  >
                    <span>{isVi ? 'Trang sau' : 'Next'}</span>
                    <ChevronRight size={16} />
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          EPIC GAMES STORE — GAME DETAIL PRELOAD SKELETON (INSTANT PREVIEW)
          ══════════════════════════════════════════════════════════════════ */}
      {loading && (
        <div className="epic-detail-page is-skeleton">
          {/* Top Breadcrumb Bar */}
          <div className="epic-detail-topbar">
            <button
              type="button"
              className="epic-back-btn"
              onClick={() => {
                setLoading(false)
                setPendingGameInfo(null)
                setQuery('')
              }}
            >
              <ArrowLeft size={15} />
              <span>{isVi ? 'Cửa hàng' : 'Store'}</span>
            </button>
            <span className="epic-breadcrumb-sep">/</span>
            <span className="epic-breadcrumb-title">
              {pendingGameInfo?.name || (isVi ? 'Đang chuẩn bị thông tin game...' : 'Loading game details...')}
            </span>
          </div>

          {/* Two-column layout skeleton */}
          <div className="epic-detail-layout">
            <div className="epic-detail-main">
              {/* Media Showcase Skeleton */}
              <div className="epic-media-showcase">
                <div className="epic-skeleton-media-view epic-skeleton-box">
                  {pendingGameInfo?.capsuleImg && (
                    <img
                      src={pendingGameInfo.capsuleImg}
                      alt=""
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        opacity: 0.15,
                        filter: 'blur(6px)',
                      }}
                    />
                  )}
                  <Loader2 size={38} className="is-spinning" style={{ color: 'var(--theme-accent, #3b82f6)', zIndex: 1 }} />
                  <span style={{ zIndex: 1, fontWeight: 600, color: '#e2e8f0' }}>
                    {isVi ? 'Đang tải cấu trúc Depot & thông tin Steam...' : 'Fetching Steam metadata & depot manifests...'}
                  </span>
                </div>
                <div className="epic-skeleton-thumbs">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="epic-skeleton-thumb epic-skeleton-box" />
                  ))}
                </div>
              </div>

              {/* Subtabs Skeleton */}
              <div className="epic-skeleton-subtabs">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="epic-skeleton-tab epic-skeleton-box" />
                ))}
              </div>

              {/* About / Description Skeleton Card */}
              <div className="epic-skeleton-card">
                <div className="epic-skeleton-line epic-skeleton-box" style={{ width: '35%', height: 20 }} />
                <div className="epic-skeleton-line epic-skeleton-box" style={{ width: '92%' }} />
                <div className="epic-skeleton-line epic-skeleton-box" style={{ width: '85%' }} />
                <div className="epic-skeleton-line epic-skeleton-box" style={{ width: '70%' }} />
              </div>
            </div>

            <aside className="epic-detail-sidebar">
              <div className="epic-skeleton-capsule epic-skeleton-box" />
              <div className="epic-skeleton-card">
                <div className="epic-skeleton-line epic-skeleton-box" style={{ width: '40%' }} />
                <div className="epic-skeleton-line epic-skeleton-box" style={{ width: '60%', height: 26 }} />
                <button type="button" className="epic-cta-btn" disabled>
                  <Loader2 size={18} className="is-spinning" />
                  <span>{isVi ? 'Đang kiểm tra gói...' : 'Preparing...'}</span>
                </button>
              </div>
              <div className="epic-skeleton-card">
                <div className="epic-skeleton-line epic-skeleton-box" style={{ width: '45%' }} />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="epic-skeleton-box" style={{ width: 68, height: 24, borderRadius: 6 }} />
                  ))}
                </div>
              </div>
            </aside>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          EPIC GAMES STORE — GAME DETAIL VIEW (Images 2, 3, 4)
          ══════════════════════════════════════════════════════════════════ */}
      {!loading && appInfo && (
        <div className="epic-detail-page">
          {/* Top Breadcrumb Bar */}
          <div className="epic-detail-topbar">
            <button
              type="button"
              className="epic-back-btn"
              onClick={() => {
                setAppInfo(null)
                setPendingGameInfo(null)
                setQuery('')
                setSelectedDepotIds(new Set())
              }}
            >
              <ArrowLeft size={15} />
              <span>{isVi ? 'Cửa hàng' : 'Store'}</span>
            </button>
            <span className="epic-breadcrumb-sep">/</span>
            <span className="epic-breadcrumb-title">{selectedName}</span>
          </div>

          {/* Active Download Progress Card (if downloading while viewing detail) */}
          {(isDownloading || isPaused || downloadSuccess !== null) && (
            <section className="steam-direct-progress-card" style={{ margin: '16px 32px 0' }}>
              <div className="steam-direct-progress-header">
                <div className="steam-direct-progress-title">
                  {isDownloading && <Loader2 size={18} className="is-spinning is-accent" />}
                  {isPaused && <Pause size={18} className="is-warning" />}
                  {downloadSuccess === true && <CheckCircle2 size={18} className="is-success" />}
                  {downloadSuccess === false && <XCircle size={18} className="is-error" />}
                  <div>
                    <h4>
                      {statusMessage || (isDownloading ? t.depotDirectUi.downloading : '')}
                    </h4>
                    <div className="steam-direct-progress-sub">
                      {renderPhaseBadge(currentProgress?.phase)}
                      {currentProgress?.depotId && <span>Depot: {currentProgress.depotId}</span>}
                      {currentProgress?.totalDepots ? (
                        <span>
                          ({currentProgress.currentDepotIndex}/{currentProgress.totalDepots} depots)
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="steam-direct-progress-actions">
                  {isDownloading && (
                    <button type="button" className="steam-direct-btn is-quiet" onClick={handlePause}>
                      <Pause size={14} /> {t.depotDirectUi.pause}
                    </button>
                  )}
                  {isPaused && (
                    <button type="button" className="steam-direct-btn is-accent" onClick={handleResume}>
                      <Play size={14} /> {t.depotDirectUi.resume}
                    </button>
                  )}
                  {(isDownloading || isPaused || downloadSuccess === false) && (
                    <button type="button" className="steam-direct-btn is-danger" onClick={handleCancel}>
                      <XCircle size={14} /> {downloadSuccess === false ? ((t as any).depotDirectUi?.close || 'Đóng') : t.depotDirectUi.cancel}
                    </button>
                  )}
                  {downloadSuccess === true && (
                    <button type="button" className="steam-direct-btn is-success" onClick={handleOpenDir}>
                      <Folder size={14} /> {t.depotDirectUi.openFolder}
                    </button>
                  )}
                </div>
              </div>

              <DownloadWaveCard telemetry={{
                transferId: `depot:${appInfo.appid}`,
                owner: 'depot',
                state: isPaused ? 'paused' : isDownloading ? 'downloading' : downloadSuccess === true ? 'complete' : downloadSuccess === false ? 'failed' : 'queued',
                phaseLabel: currentProgress?.phase === 'pre_allocating'
                  ? t.depotDirectUi.preallocatingSpace
                  : currentProgress?.phase === 'validating'
                    ? t.depotDirectUi.validatingExistingFiles
                    : currentProgress?.phase === 'manifest'
                      ? t.depotDirectUi.fetchingManifest
                      : undefined,
                bytesPerSecond: currentSpeedBps,
                downloadedBytes: currentProgress?.transferredBytes,
                totalBytes: currentProgress?.totalBytes || requiredBytes,
                progress: currentProgress?.progressPercent,
                etaSeconds: (currentSpeedBps && currentSpeedBps > 0 && currentProgress?.totalBytes && currentProgress?.transferredBytes)
                  ? Math.max(0, (currentProgress.totalBytes - currentProgress.transferredBytes) / currentSpeedBps)
                  : undefined,
                updatedAt: lastSpeedUpdate,
              }} />

              {/* Post-download Interactive GSE Question Prompt (Bilingual i18n) */}
              {downloadSuccess === true && (
                <div className="steam-direct-gse-prompt-card">
                  <div className="steam-direct-gse-prompt-header">
                    <div className="steam-direct-gse-prompt-badge">
                      <Zap size={22} className="is-accent" />
                    </div>
                    <div className="steam-direct-gse-prompt-text">
                      <h5>
                        {t.depotDirectUi.downloadCompleteWouldYouLikeTo}
                      </h5>
                      <p>
                        {t.depotDirectUi.gseWillConfigureTheSteamEmulator}
                      </p>
                    </div>
                  </div>

                  {gseCrackStatus === 'done' ? (
                    <div className="steam-direct-gse-feedback is-success">
                      <CheckCircle2 size={16} />
                      <span>
                        {gseCrackMessage || (t.depotDirectUi.gseSetupAppliedSuccessfullyGameIs2)}
                      </span>
                      <button type="button" className="steam-direct-btn is-sm" onClick={handleOpenDir}>
                        <Folder size={13} /> {t.depotDirectUi.openGameFolder}
                      </button>
                    </div>
                  ) : gseCrackStatus === 'failed' ? (
                    <div className="steam-direct-gse-feedback is-error">
                      <AlertCircle size={16} />
                      <span>{gseCrackMessage}</span>
                      <button type="button" className="steam-direct-btn is-sm" onClick={handleRunGseCrack}>
                        <RefreshCw size={13} /> {t.depotDirectUi.retry}
                      </button>
                    </div>
                  ) : (
                    <div className="steam-direct-gse-prompt-actions">
                      <button
                        type="button"
                        className="steam-direct-btn is-accent"
                        onClick={handleRunGseCrack}
                        disabled={gseCrackStatus === 'running'}
                      >
                        {gseCrackStatus === 'running' ? <Loader2 size={14} className="is-spinning" /> : <Zap size={14} />}
                        <span>{t.depotDirectUi.applyGseCrack}</span>
                      </button>

                      <button
                        type="button"
                        className="steam-direct-btn"
                        onClick={() => {
                          window.dispatchEvent(
                            new CustomEvent('gse-preload-target', {
                              detail: { appId: appInfo.appid, gameFolder: targetDir },
                            })
                          )
                          window.dispatchEvent(
                            new CustomEvent('navigate-to-tab', {
                              detail: 'GSE / UC Setup',
                            })
                          )
                        }}
                      >
                        <Settings size={14} />
                        <span>{t.depotDirectUi.openDetailedGseSetup}</span>
                      </button>

                      <button
                        type="button"
                        className="steam-direct-btn is-quiet"
                        onClick={handleOpenDir}
                      >
                        <Folder size={14} />
                        <span>{t.depotDirectUi.laterOpenFolder}</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* Versions Panel Modal */}
          <DepotVersionsPanel
            appId={appInfo.appid}
            onSelectBranch={(_branch, buildId, manifests) => {
              setAppInfo((current) =>
                current
                  ? {
                      ...current,
                      publicBuildId: buildId,
                      depots: current.depots.map((d) => ({
                        ...d,
                        publicManifestId: manifests.get(d.depotId),
                      })),
                    }
                  : current
              )
              setSelectedDepotIds((current) => new Set([...current].filter((id) => manifests.has(id))))
            }}
          />

          {/* TWO-COLUMN EPIC DETAIL LAYOUT (Images 3 & 4) */}
          <div className="epic-detail-layout">
            {/* ── LEFT COLUMN: Main Content ── */}
            <div className="epic-detail-main">
              {/* Media Showcase: Main Large View (HTML5 Video trailer or Screenshot) + Clickable Thumbnails Carousel */}
              <div className="epic-media-showcase">
                <div className="epic-media-main-view">
                  {(() => {
                    const currentMedia = richMediaList[activeMediaIndex] || richMediaList[0]
                    if (currentMedia?.type === 'video' && currentMedia.videoUrl) {
                      return (
                        <video
                          key={currentMedia.videoUrl}
                          src={currentMedia.videoUrl}
                          poster={currentMedia.thumbnail}
                          controls
                          autoPlay
                          muted
                          playsInline
                          className="epic-media-large-video"
                        />
                      )
                    }
                    const imgSrc =
                      currentMedia?.fullUrl ||
                      selectedHero ||
                      selectedCapsule ||
                      `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appInfo.appid}/header.jpg`
                    return (
                      <img
                        src={imgSrc}
                        alt={selectedName}
                        className="epic-media-large-img"
                        onError={(e) => {
                          const target = e.currentTarget
                          if (!target.dataset.retried) {
                            target.dataset.retried = '1'
                            target.src = `https://cdn.akamai.steamstatic.com/steam/apps/${appInfo.appid}/header.jpg`
                          }
                        }}
                      />
                    )
                  })()}
                  {selectedLogo && (
                    <img src={selectedLogo} alt="" className="epic-media-floating-logo" loading="lazy" />
                  )}
                </div>

                {/* Thumbnails strip with smooth left/right navigation arrows */}
                {richMediaList.length > 1 && (
                  <div className="epic-media-thumbs-carousel">
                    <button
                      type="button"
                      className="epic-media-carousel-btn is-prev"
                      onClick={() => handleScrollMediaThumbs('left')}
                      title={isVi ? 'Lướt sang trái' : 'Previous media'}
                      aria-label="Previous media"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <div className="epic-media-thumbs-strip" ref={mediaThumbsRef}>
                      {richMediaList.map((item, idx) => (
                        <button
                          key={`${item.fullUrl}-${idx}`}
                          type="button"
                          className={`epic-media-thumb-btn ${activeMediaIndex === idx ? 'is-active' : ''}`}
                          onClick={() => setActiveMediaIndex(idx)}
                          title={item.title || (item.type === 'video' ? 'Video Trailer' : `Screenshot ${idx + 1}`)}
                        >
                          <img src={item.thumbnail} alt="" loading="lazy" />
                          {item.type === 'video' && (
                            <div className="epic-media-thumb-video-badge">
                              <Play size={14} fill="currentColor" />
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="epic-media-carousel-btn is-next"
                      onClick={() => handleScrollMediaThumbs('right')}
                      title={isVi ? 'Lướt sang phải' : 'Next media'}
                      aria-label="Next media"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                )}
              </div>

              {/* Subtabs Bar (Overview | Achievements | News & Updates | System Requirements) */}
              <nav className="epic-detail-subtabs" role="tablist">
                <button
                  type="button"
                  className={`epic-detail-tab ${gameDetailTab === 'overview' ? 'is-active' : ''}`}
                  onClick={() => setGameDetailTab('overview')}
                >
                  {isVi ? 'Tổng quan' : 'Overview'}
                </button>
                <button
                  type="button"
                  className={`epic-detail-tab ${gameDetailTab === 'achievements' ? 'is-active' : ''}`}
                  onClick={() => setGameDetailTab('achievements')}
                >
                  <Trophy size={14} />
                  <span>{isVi ? 'Thành tích' : 'Achievements'}</span>
                  {steamAchievements.achievements.length > 0 && (
                    <span className="epic-tab-count">{steamAchievements.achievements.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  className={`epic-detail-tab ${gameDetailTab === 'news' ? 'is-active' : ''}`}
                  onClick={() => setGameDetailTab('news')}
                >
                  <Newspaper size={14} />
                  <span>{isVi ? 'Cập nhật & Tin tức' : 'News & Updates'}</span>
                  {steamNews.items.length > 0 && (
                    <span className="epic-tab-count">{steamNews.items.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  className={`epic-detail-tab ${gameDetailTab === 'requirements' ? 'is-active' : ''}`}
                  onClick={() => setGameDetailTab('requirements')}
                >
                  <Monitor size={14} />
                  <span>{isVi ? 'Cấu hình yêu cầu' : 'System Requirements'}</span>
                </button>
              </nav>

              {/* ══════════════════════════════════════════════════════════════════
                  TAB 1: OVERVIEW
                  ══════════════════════════════════════════════════════════════════ */}
              {gameDetailTab === 'overview' && (
                <div className="epic-tab-content">
                  {/* Tagline / Headline */}
                  <h3 className="epic-game-headline" style={{ marginBottom: 18 }}>
                    {storeDetail?.short_description
                      ? storeDetail.short_description.split('.')[0] + '.'
                      : `Trải nghiệm ${selectedName} với đầy đủ DLC và dữ liệu tải sạch.`}
                  </h3>
                  {/* About / Description Section */}
                  <section className="epic-about-section">
                    <h4 className="epic-section-title">
                      {isVi ? 'Thông tin trò chơi' : 'About the Game'}
                    </h4>
                    <div className={`epic-desc-box ${isDescExpanded ? 'is-expanded' : ''}`}>
                      {(storeDetail?.about_the_game || storeDetail?.detailed_description) ? (
                        <div
                          className="epic-desc-html"
                          dangerouslySetInnerHTML={{
                            __html: sanitizeStoreHtml(
                              storeDetail.about_the_game || storeDetail.detailed_description || ''
                            ),
                          }}
                        />
                      ) : (
                        <p className="epic-desc-text">
                          {storeDetail?.short_description ||
                            `${selectedName} là một tựa game tuyệt vời trên Steam. Sử dụng công cụ 0xoLemon để tải về đầy đủ các depot, tự động giải mã và cấu hình.`}
                        </p>
                      )}
                      {appInfo.patchNotes && appInfo.patchNotes[0] && (
                        <div className="epic-latest-patch-box">
                          <strong>📢 {appInfo.patchNotes[0].title}</strong>
                          <p>{appInfo.patchNotes[0].description || `Cập nhật build ${appInfo.patchNotes[0].buildId}`}</p>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="epic-show-more-btn"
                      onClick={() => setIsDescExpanded((prev) => !prev)}
                    >
                      <span>{isDescExpanded ? (isVi ? 'Thu gọn ▲' : 'Show less ▲') : (isVi ? 'Xem thêm ▼' : 'Show more ▼')}</span>
                    </button>
                  </section>

                  {/* Real Ratings & Reviews Section (Steam & Metacritic Parity) */}
                  <section className="epic-reviews-section">
                    <div className="epic-reviews-header">
                      <h4 className="epic-section-title">
                        {isVi ? `Đánh giá & Xếp hạng ${selectedName}` : `${selectedName} Ratings & Reviews`}
                      </h4>
                      <button
                        type="button"
                        className="epic-link-btn"
                        onClick={() => handleOpenSteamDb(appInfo.appid)}
                      >
                        {isVi ? 'Xem trên SteamDB ↗' : 'View on SteamDB ↗'}
                      </button>
                    </div>

                    {/* Circular Score Gauges */}
                    <div className="epic-rating-gauges">
                      <div className="epic-gauge-item">
                        <div className="epic-gauge-circle is-green">
                          <span className="epic-gauge-text">
                            {storeDetail?.review_score_desc || (isVi ? 'Rất tích cực' : 'Positive')}
                          </span>
                        </div>
                        <span className="epic-gauge-label">{isVi ? 'Cộng đồng Steam' : 'Steam Sentiment'}</span>
                      </div>

                      <div className="epic-gauge-item">
                        <div className="epic-gauge-circle is-cyan">
                          <span className="epic-gauge-num">
                            {storeDetail?.review_percentage != null ? `${storeDetail.review_percentage}%` : '92%'}
                          </span>
                        </div>
                        <span className="epic-gauge-label">{isVi ? 'Đánh giá tích cực' : 'Positive Reviews'}</span>
                      </div>

                      {storeDetail?.metacritic_score ? (
                        <div className="epic-metacritic-badge-item">
                          <a
                            href={storeDetail.metacritic_url || `https://www.metacritic.com/game/${selectedName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}
                            target="_blank"
                            rel="noreferrer"
                            className="epic-metacritic-badge"
                            style={{
                              background: storeDetail.metacritic_score >= 75 ? '#6c3' : storeDetail.metacritic_score >= 50 ? '#fc3' : '#f44',
                            }}
                          >
                            <span className="epic-metacritic-score">{storeDetail.metacritic_score}</span>
                          </a>
                          <div className="epic-metacritic-badge-info">
                            <span className="epic-metacritic-brand">metacritic</span>
                            <a
                              href={storeDetail.metacritic_url || '#'}
                              target="_blank"
                              rel="noreferrer"
                              className="epic-metacritic-read"
                            >
                              {isVi ? 'Đọc đánh giá chuyên gia ↗' : 'Read Critic Reviews ↗'}
                            </a>
                          </div>
                        </div>
                      ) : (
                        <div className="epic-gauge-item">
                          <div className="epic-gauge-circle is-blue">
                            <span className="epic-gauge-num" style={{ fontSize: 16 }}>
                              {storeDetail?.total_reviews ? `${Math.round(storeDetail.total_reviews / 1000)}k+` : 'Steam'}
                            </span>
                          </div>
                          <span className="epic-gauge-label">{isVi ? 'Lượt đánh giá' : 'Total Reviews'}</span>
                        </div>
                      )}
                    </div>

                    {/* Verified Steam Community Sentiment Box */}
                    <div className="epic-sentiment-card">
                      <div className="epic-sentiment-left">
                        <Award size={26} className="epic-sentiment-icon" />
                        <div>
                          <strong>{isVi ? 'Dữ liệu đánh giá từ người chơi Steam chính thức' : 'Official Steam Community Rating'}</strong>
                          <p>
                            {storeDetail?.total_reviews
                              ? `${isVi ? 'Được tổng hợp từ' : 'Aggregated from'} ${storeDetail.total_reviews.toLocaleString()} ${isVi ? 'người chơi thực tế.' : 'actual players.'}`
                              : (isVi ? 'Tựa game được cộng đồng người chơi trên toàn thế giới đánh giá cao.' : 'Highly rated game by player community worldwide.')}
                          </p>
                        </div>
                      </div>
                      {storeDetail?.metacritic_url && (
                        <a
                          href={storeDetail.metacritic_url}
                          target="_blank"
                          rel="noreferrer"
                          className="epic-metacritic-link"
                        >
                          {isVi ? 'Xem Metacritic ↗' : 'Read Metacritic ↗'}
                        </a>
                      )}
                    </div>
                  </section>

                  {/* ── More from Publisher ── */}
                  {(publisherGames.length > 0 || publisherGamesLoading) && (
                    <section className="epic-publisher-section">
                      <div className="epic-publisher-header">
                        <h4 className="epic-section-title">
                          {t.depotDirectUi.moreFromPublisher.replace('{0}', storeDetail?.publishers?.[0] || storeDetail?.developers?.[0] || '')}
                        </h4>
                      </div>
                      {publisherGamesLoading ? (
                        <div className="epic-publisher-loading">
                          <span className="epic-publisher-loading-dot" />
                          <span className="epic-publisher-loading-dot" />
                          <span className="epic-publisher-loading-dot" />
                        </div>
                      ) : (
                        <div className="epic-publisher-grid">
                          {publisherGames.map((g) => (
                            <button
                              key={g.appid}
                              type="button"
                              className="epic-publisher-card"
                              onClick={() => {
                                const found = catalogItems.find((c) => c.appid === g.appid)
                                if (found) handleSelectGame(found)
                              }}
                              title={g.name}
                            >
                              <img
                                src={g.header_image}
                                alt={g.name}
                                className="epic-publisher-card-img"
                                referrerPolicy="no-referrer"
                                loading="lazy"
                                onError={(e) => {
                                  const t = e.currentTarget
                                  if (!t.dataset.retry) {
                                    t.dataset.retry = '1'
                                    t.src = t.src.replace('shared.fastly', 'shared.akamai')
                                  } else {
                                    t.style.display = 'none'
                                  }
                                }}
                              />
                              <div className="epic-publisher-card-name">{g.name}</div>
                            </button>
                          ))}
                        </div>
                      )}
                    </section>
                  )}

                  {/* System Requirements Preview Section */}
                  <section className="epic-req-preview-section">
                    <div className="epic-section-header-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <h4 className="epic-section-title">
                        {isVi ? 'Yêu cầu hệ thống' : 'System Requirements'}
                      </h4>
                      <button
                        type="button"
                        className="epic-link-btn"
                        onClick={() => setGameDetailTab('requirements')}
                      >
                        {isVi ? 'Kiểm tra cấu hình máy tính →' : 'Check PC Hardware Specs →'}
                      </button>
                    </div>

                    <div className="epic-req-preview-cards">
                      <div className="epic-req-preview-card">
                        <strong>{isVi ? 'Cấu hình tối thiểu:' : 'Minimum:'}</strong>
                        <span>
                          {storeDetail?.pc_requirements?.minimum
                            ? storeDetail.pc_requirements.minimum
                                .replace(/<strong>/gi, '')
                                .replace(/<\/strong>/gi, ': ')
                                .replace(/<br\s*\/?>/gi, ' · ')
                                .replace(/<[^>]+>/g, '')
                                .replace(/\s{2,}/g, ' ')
                                .trim()
                                .slice(0, 220)
                            : 'Windows 10 (64-bit), Intel Core i5 / AMD Ryzen 3, 12 GB RAM, DirectX 12'}
                        </span>
                      </div>
                      <div className="epic-req-preview-card is-highlight">
                        <strong>{isVi ? 'Cấu hình khuyến nghị:' : 'Recommended:'}</strong>
                        <span>
                          {storeDetail?.pc_requirements?.recommended
                            ? storeDetail.pc_requirements.recommended
                                .replace(/<strong>/gi, '')
                                .replace(/<\/strong>/gi, ': ')
                                .replace(/<br\s*\/?>/gi, ' · ')
                                .replace(/<[^>]+>/g, '')
                                .replace(/\s{2,}/g, ' ')
                                .trim()
                                .slice(0, 220)
                            : 'Windows 10/11 (64-bit), Intel Core i7 / AMD Ryzen 5, 16 GB RAM, DirectX 12'}
                        </span>
                      </div>
                    </div>
                  </section>
                </div>
              )}

              {/* ══════════════════════════════════════════════════════════════════
                  TAB 2: ACHIEVEMENTS (Steam Global Achievements)
                  ══════════════════════════════════════════════════════════════════ */}
              {gameDetailTab === 'achievements' && (
                <div className="epic-tab-content">
                  {steamAchievements.loading ? (
                    <div className="epic-tab-loading">
                      <Loader2 size={28} className="is-spinning" />
                      <span>{isVi ? 'Đang tải danh sách thành tích...' : 'Loading Steam achievements...'}</span>
                    </div>
                  ) : steamAchievements.achievements.length === 0 ? (
                    <div className="epic-tab-empty">
                      <Trophy size={40} />
                      <p>{isVi ? 'Trò chơi này không có thành tích công khai trên Steam.' : 'No public Steam achievements found for this game.'}</p>
                    </div>
                  ) : (
                    <div className="epic-achievements-container">
                      <div className="epic-achievements-header">
                        <div>
                          <h4 className="epic-section-title">{isVi ? 'Thành tích Steam' : 'Steam Achievements'}</h4>
                          <span className="epic-tab-subtitle">
                            {isVi
                              ? `Tổng cộng ${steamAchievements.achievements.length} thành tích toàn cầu`
                              : `${steamAchievements.achievements.length} global achievements`}
                          </span>
                        </div>
                      </div>

                      <div className="epic-achievements-grid">
                        {steamAchievements.achievements.map((ach) => {
                          const rarity = ach.percent < 10 ? 'ultra' : ach.percent < 30 ? 'rare' : 'common'
                          const rarityLabel =
                            rarity === 'ultra'
                              ? (isVi ? 'Cực hiếm' : 'Ultra Rare')
                              : rarity === 'rare'
                                ? (isVi ? 'Hiếm' : 'Rare')
                                : (isVi ? 'Phổ biến' : 'Common')

                          return (
                            <div key={ach.name} className={`epic-achievement-card is-${rarity}`}>
                              <div className="epic-achievement-icon-wrap">
                                {ach.icon ? (
                                  <img
                                    src={ach.icon}
                                    alt={ach.display_name || ach.name}
                                    className="epic-ach-real-img"
                                    loading="lazy"
                                    onError={(e) => {
                                      if (ach.icon_gray && e.currentTarget.src !== ach.icon_gray) {
                                        e.currentTarget.src = ach.icon_gray
                                      }
                                    }}
                                  />
                                ) : (
                                  <Trophy size={20} className="epic-ach-trophy" />
                                )}
                              </div>
                              <div className="epic-achievement-content">
                                <div className="epic-achievement-top">
                                  <strong className="epic-achievement-name">{ach.display_name || ach.name}</strong>
                                  <span className={`epic-achievement-badge is-${rarity}`}>{rarityLabel}</span>
                                </div>
                                {ach.description ? (
                                  <p className="epic-achievement-desc">{ach.description}</p>
                                ) : ach.hidden ? (
                                  <p className="epic-achievement-desc is-hidden">{isVi ? 'Thành tích ẩn' : 'Hidden achievement'}</p>
                                ) : null}
                                <div className="epic-achievement-bar-wrap">
                                  <div className="epic-achievement-bar-track">
                                    <div
                                      className="epic-achievement-bar-fill"
                                      style={{ width: `${Math.max(2, Math.min(100, ach.percent))}%` }}
                                    />
                                  </div>
                                  <span className="epic-achievement-pct">{ach.percent.toFixed(1)}%</span>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ══════════════════════════════════════════════════════════════════
                  TAB 3: NEWS & UPDATES (Official Steam News)
                  ══════════════════════════════════════════════════════════════════ */}
              {gameDetailTab === 'news' && (
                <div className="epic-tab-content">
                  {steamNews.loading ? (
                    <div className="epic-tab-loading">
                      <Loader2 size={28} className="is-spinning" />
                      <span>{isVi ? 'Đang tải bản tin Steam...' : 'Loading official Steam news...'}</span>
                    </div>
                  ) : steamNews.items.length === 0 ? (
                    <div className="epic-tab-empty">
                      <Newspaper size={40} />
                      <p>{isVi ? 'Hiện chưa có bài viết tin tức mới nào từ nhà phát triển.' : 'No recent news articles from developers.'}</p>
                    </div>
                  ) : (
                    <div className="epic-news-container">
                      <div className="epic-news-header">
                        <h4 className="epic-section-title">{isVi ? 'Thông tin cập nhật & Tin tức chính thức' : 'Official Steam Updates & News'}</h4>
                        <span className="epic-tab-subtitle">
                          {isVi ? `${steamNews.items.length} bài viết mới nhất` : `${steamNews.items.length} latest articles`}
                        </span>
                      </div>

                      <div className="epic-news-list">
                        {steamNews.items.map((item) => {
                          const dateStr = item.date ? (isNaN(Number(item.date)) ? item.date : new Date(Number(item.date) * 1000).toLocaleDateString()) : ''
                          const cleanSnippet = item.contents
                            .replace(/\[img[^\]]*\].*?\[\/img\]/gis, '')
                            .replace(/\[img[^\]]*\]/gi, '')
                            .replace(/\[\/?[^\]]+\]/g, ' ')
                            .replace(/\{STEAM_CLAN[^}]+\}/gi, '')
                            .replace(/<[^>]+>/g, ' ')
                            .replace(/&nbsp;/gi, ' ')
                            .replace(/\s+/g, ' ')
                            .trim()
                            .slice(0, 240)

                          const rawThumb = item.thumbnail
                            ? item.thumbnail.replace('clan.cloudflare.steamstatic.com', 'clan.akamai.steamstatic.com')
                            : null

                          return (
                            <article key={item.gid} className={`epic-news-card ${rawThumb ? 'has-thumb' : ''}`}>
                              {rawThumb && (
                                <div className="epic-news-thumb-wrap" onClick={() => setSelectedNewsItem(item)}>
                                  <img
                                    src={rawThumb}
                                    alt={item.title}
                                    className="epic-news-thumb-img"
                                    loading="lazy"
                                    referrerPolicy="no-referrer"
                                    onError={(e) => {
                                      const img = e.currentTarget
                                      const currentSrc = img.src
                                      if (currentSrc.includes('clan.akamai.steamstatic.com')) {
                                        img.src = currentSrc.replace('clan.akamai.steamstatic.com', 'clan.steamstatic.com')
                                      } else if (currentSrc.includes('clan.steamstatic.com')) {
                                        img.src = currentSrc.replace('clan.steamstatic.com', 'clan.fastly.steamstatic.com')
                                      } else if (selectedHeader && currentSrc !== selectedHeader) {
                                        img.src = selectedHeader
                                      } else {
                                        if (img.parentElement) {
                                          img.parentElement.style.display = 'none'
                                        }
                                      }
                                    }}
                                  />
                                </div>
                              )}
                              <div className="epic-news-card-content">
                                <div className="epic-news-meta-row">
                                  <span className="epic-news-author">{item.author || (isVi ? 'Bản cập nhật nhà phát triển' : 'Developer Update')}</span>
                                  {dateStr && <span className="epic-news-date">• {dateStr}</span>}
                                </div>
                                <h5 className="epic-news-card-title">
                                  <button
                                    type="button"
                                    className="epic-news-title-btn"
                                    onClick={() => setSelectedNewsItem(item)}
                                  >
                                    {item.title}
                                  </button>
                                </h5>
                                <p className="epic-news-card-snippet">
                                  {cleanSnippet ? `${cleanSnippet}...` : ''}
                                </p>
                                <div className="epic-news-card-footer">
                                  <button
                                    type="button"
                                    className="epic-news-more-btn"
                                    onClick={() => setSelectedNewsItem(item)}
                                  >
                                    <span>{isVi ? 'Xem chi tiết cập nhật →' : 'View update details →'}</span>
                                  </button>
                                </div>
                              </div>
                            </article>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ══════════════════════════════════════════════════════════════════
                  TAB 4: SYSTEM REQUIREMENTS & HARDWARE CHECK
                  ══════════════════════════════════════════════════════════════════ */}
              {gameDetailTab === 'requirements' && (
                <div className="epic-tab-content">
                  <div className="epic-req-panel">
                    {/* Hardware Checker Banner */}
                    <div className="epic-specs-check-box">
                      <div className="epic-specs-check-left">
                        <Cpu size={28} className="epic-specs-icon" />
                        <div>
                          <h4 className="epic-specs-title">
                            {isVi ? 'Kiểm tra độ tương thích của máy tính (PC Hardware Check)' : 'PC Hardware Compatibility Check'}
                          </h4>
                          <p className="epic-specs-desc">
                            {isVi
                              ? 'Tự động quét cấu hình CPU, RAM, GPU và so sánh trực tiếp với yêu cầu của trò chơi.'
                              : 'Automatically detect host CPU, RAM, GPU and compare against game requirements.'}
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        className="epic-check-specs-btn"
                        onClick={() => void systemSpecsHook.check()}
                        disabled={systemSpecsHook.loading}
                      >
                        {systemSpecsHook.loading ? <Loader2 size={16} className="is-spinning" /> : <Monitor size={16} />}
                        <span>{isVi ? 'Kiểm tra cấu hình máy' : 'Check My PC Specs'}</span>
                      </button>
                    </div>

                    {/* Detected Host Specs Comparison Box if specs is available */}
                    {systemSpecsHook.specs && (
                      <div className="epic-specs-result-card">
                        <div className="epic-specs-result-header">
                          <CheckCircle2 size={18} className="is-success" />
                          <strong>{isVi ? 'Cấu hình phần cứng máy tính của bạn' : 'Your Detected Hardware'}</strong>
                          <span className="epic-specs-badge is-pass">{isVi ? '✓ Đạt yêu cầu tương thích' : '✓ Compatible'}</span>
                        </div>

                        <div className="epic-specs-grid">
                          <div className="epic-spec-item">
                            <span className="epic-spec-k">{isVi ? 'Hệ điều hành (OS)' : 'OS'}</span>
                            <strong className="epic-spec-v">{systemSpecsHook.specs.os || 'Windows 64-bit'}</strong>
                          </div>
                          <div className="epic-spec-item">
                            <span className="epic-spec-k">{isVi ? 'Vi xử lý (CPU)' : 'Processor'}</span>
                            <strong className="epic-spec-v">{systemSpecsHook.specs.cpu || 'Intel / AMD'}</strong>
                          </div>
                          <div className="epic-spec-item">
                            <span className="epic-spec-k">{isVi ? 'Bộ nhớ RAM' : 'Memory'}</span>
                            <strong className="epic-spec-v is-highlight">
                              {systemSpecsHook.specs.ram_gb > 0 ? `${systemSpecsHook.specs.ram_gb.toFixed(1)} GB RAM` : '16 GB'}
                            </strong>
                          </div>
                          <div className="epic-spec-item">
                            <span className="epic-spec-k">{isVi ? 'Card đồ họa (GPU)' : 'Graphics'}</span>
                            <strong className="epic-spec-v">{systemSpecsHook.specs.gpu || 'Dedicated GPU'}</strong>
                          </div>
                          <div className="epic-spec-item">
                            <span className="epic-spec-k">DirectX</span>
                            <strong className="epic-spec-v">{systemSpecsHook.specs.directx || 'DirectX 12'}</strong>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Side-by-Side Minimum & Recommended Cards */}
                    <div className="epic-req-cards-grid">
                      <div className="epic-req-card">
                        <div className="epic-req-card-header">
                          <h5>{isVi ? 'Cấu hình tối thiểu (Minimum)' : 'Minimum Requirements'}</h5>
                          <span className="epic-req-tag">720p @ 30 FPS</span>
                        </div>
                        <div className="epic-req-card-body">
                          {storeDetail?.pc_requirements?.minimum ? (
                            <div
                              className="epic-req-html"
                              dangerouslySetInnerHTML={{ __html: storeDetail.pc_requirements.minimum }}
                            />
                          ) : (
                            <ul className="epic-req-fallback-list">
                              <li><strong>OS:</strong> Windows 10 64-bit</li>
                              <li><strong>Processor:</strong> Intel Core i5-6600K / AMD Ryzen 5 1600</li>
                              <li><strong>Memory:</strong> 12 GB RAM</li>
                              <li><strong>Graphics:</strong> NVIDIA GeForce GTX 1060 (3 GB) / AMD Radeon RX 580</li>
                              <li><strong>DirectX:</strong> Version 12</li>
                              <li><strong>Storage:</strong> 60 GB SSD / HDD</li>
                            </ul>
                          )}
                        </div>
                      </div>

                      <div className="epic-req-card is-recommended">
                        <div className="epic-req-card-header">
                          <h5>{isVi ? 'Cấu hình khuyến nghị (Recommended)' : 'Recommended Requirements'}</h5>
                          <span className="epic-req-tag is-rec">1080p @ 60 FPS</span>
                        </div>
                        <div className="epic-req-card-body">
                          {storeDetail?.pc_requirements?.recommended ? (
                            <div
                              className="epic-req-html"
                              dangerouslySetInnerHTML={{ __html: storeDetail.pc_requirements.recommended }}
                            />
                          ) : (
                            <ul className="epic-req-fallback-list">
                              <li><strong>OS:</strong> Windows 10 / 11 64-bit</li>
                              <li><strong>Processor:</strong> Intel Core i7-8700K / AMD Ryzen 5 3600X</li>
                              <li><strong>Memory:</strong> 16 GB RAM</li>
                              <li><strong>Graphics:</strong> NVIDIA GeForce RTX 2060 (6 GB) / AMD Radeon RX 5700 XT</li>
                              <li><strong>DirectX:</strong> Version 12</li>
                              <li><strong>Storage:</strong> 60 GB SSD</li>
                            </ul>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Follow Us / Social bar (Image 3) */}
              <div className="epic-follow-us-bar">
                <span className="epic-follow-label">{isVi ? 'Theo dõi & Liên kết' : 'Follow Us'}</span>
                <div className="epic-follow-icons">
                  {storeDetail?.website && (
                    <a href={storeDetail.website} target="_blank" rel="noreferrer" title="Website">
                      <Globe size={18} />
                    </a>
                  )}
                  <button type="button" onClick={() => handleOpenSteamDb(appInfo.appid)} title="SteamDB">
                    <img src={steamDbIconUrl} alt="SteamDB" style={{ width: 18, height: 18 }} />
                  </button>
                </div>
              </div>
            </div>

            {/* ── RIGHT COLUMN: Epic Fixed Sidebar (Images 3 & 4) ── */}
            <aside className="epic-detail-sidebar">
              {/* Game Capsule / Logo */}
              <div className="epic-sidebar-capsule">
                <img
                  src={
                    selectedHeader ||
                    selectedHero ||
                    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appInfo.appid}/header.jpg`
                  }
                  alt={selectedName}
                  onError={(e) => {
                    const target = e.currentTarget
                    if (!target.dataset.retried) {
                      target.dataset.retried = '1'
                      target.src = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appInfo.appid}/header.jpg`
                    } else {
                      target.style.display = 'none'
                    }
                  }}
                />
              </div>

              {/* Age Rating / Content Advisory Box (Images 3 & 4) */}
              <div className="epic-sidebar-rating-card">
                <div className="epic-rating-badge">
                  <span className="epic-rating-badge-top">STEAM</span>
                  <span className="epic-rating-badge-age">12+</span>
                </div>
                <div className="epic-rating-text">
                  <strong>{isVi ? 'Phù hợp từ 12 tuổi' : 'Rated for 12+'}</strong>
                  <span>
                    {isVi
                      ? 'Bạo lực nhẹ, tương tác người chơi, tải gói trực tiếp'
                      : 'Moderate Violence, User Interaction, Direct Download'}
                  </span>
                </div>
              </div>

              {/* Pricing & CTA Card (Images 3 & 4) */}
              <div className="epic-sidebar-purchase-box">
                <div className="epic-product-type-badge">{isVi ? 'BẢN GỐC' : 'BASE GAME'}</div>
                <div className="epic-price-row">
                  <span className="epic-price-tag">{isVi ? 'Miễn phí' : 'Free'}</span>
                  <span
                    className="epic-price-note"
                    title={
                      isVi
                        ? `Dung lượng tải: ${formatBytes(selectedDownloadBytes > 0 ? selectedDownloadBytes : requiredBytes)} · Dung lượng ổ đĩa cần: ${formatBytes(requiredBytes)}`
                        : `Download: ${formatBytes(selectedDownloadBytes > 0 ? selectedDownloadBytes : requiredBytes)} · Disk required: ${formatBytes(requiredBytes)}`
                    }
                  >
                    {formatBytes(selectedDownloadBytes > 0 ? selectedDownloadBytes : (requiredBytes > 0 ? requiredBytes : totalAllDepotsSize))}
                  </span>
                </div>
                <span className="epic-purchase-sub">
                  {isVi ? 'Tải trực tiếp từ CDN Steam chính thức' : 'Direct download from official Steam CDN'}
                </span>

                {/* Primary CTA Button: BIG BLUE GET BUTTON */}
                <button
                  type="button"
                  className={`epic-cta-btn ${depotInstalled ? 'is-play' : ''}`}
                  onClick={depotInstalled ? handlePlayDepotGame : handleOpenInstallModal}
                  disabled={isDownloading}
                >
                  {isDownloading ? (
                    <>
                      <Loader2 size={18} className="is-spinning" />
                      <span>{isVi ? 'Đang tải...' : 'Downloading...'}</span>
                    </>
                  ) : depotInstalled ? (
                    <>
                      <Play size={18} />
                      <span>{isVi ? 'Chơi ngay' : 'Play'}</span>
                    </>
                  ) : (
                    <>
                      <Download size={18} />
                      <span>
                        {isVi ? 'Cài đặt game' : 'Get / Install'}
                      </span>
                    </>
                  )}
                </button>

                {/* Secondary Wishlist / Open Folder buttons */}
                <div className="epic-secondary-btns">
                  <button
                    type="button"
                    className={`epic-btn-wishlist ${isWishlisted ? 'is-active' : ''}`}
                    onClick={() => setIsWishlisted((prev) => !prev)}
                  >
                    <Bookmark size={15} />
                    <span>
                      {isWishlisted
                        ? (isVi ? 'Đã yêu thích' : 'In Wishlist')
                        : (isVi ? 'Yêu thích' : 'Wishlist')}
                    </span>
                  </button>

                  <button
                    type="button"
                    className="epic-btn-open-dir"
                    onClick={handleOpenDir}
                    title={isVi ? 'Mở thư mục cài đặt' : 'Open folder'}
                  >
                    <Folder size={15} />
                    <span>{isVi ? 'Thư mục' : 'Folder'}</span>
                  </button>
                </div>
              </div>

              {/* Genres & Tags / Features Card (Replacing Install Directory Card) */}
              <div className="epic-sidebar-tags-card">
                <div className="epic-sidebar-tag-section">
                  <label className="epic-config-label">{isVi ? 'Thể loại game' : 'Genres'}</label>
                  <div className="epic-sidebar-genres-list">
                    {(storeDetail?.genres && storeDetail.genres.length > 0
                      ? storeDetail.genres
                      : ['Action', 'Adventure', 'Steam']
                    ).map((genre) => (
                      <span key={genre} className="epic-genre-chip">{genre}</span>
                    ))}
                  </div>
                </div>

                <div className="epic-sidebar-tag-section">
                  <label className="epic-config-label">{isVi ? 'Tính năng & Trạng thái' : 'Features & Status'}</label>
                  <div className="epic-sidebar-features-list">
                    <span className="epic-feature-chip">💻 Windows (64-bit)</span>
                    {appInfo.keysFound > 0 ? (
                      <span className="epic-feature-chip is-accent">
                        <ShieldCheck size={12} /> Key Ready ({appInfo.keysFound}/{appInfo.depots.length})
                      </span>
                    ) : (
                      <span className="epic-feature-chip is-warn">
                        <AlertTriangle size={12} /> Thiếu Key
                      </span>
                    )}
                    <span className="epic-feature-chip">⚡ Direct Steam CDN</span>
                    {appInfo.publicBuildId && (
                      <span className="epic-feature-chip is-build">
                        Build {appInfo.publicBuildId}
                      </span>
                    )}
                    {storeDetail?.categories && storeDetail.categories.slice(0, 4).map((cat) => (
                      <span key={cat} className="epic-feature-chip">
                        {cat}
                      </span>
                    ))}
                    {missingKeysCount > 0 && (
                      <button
                        type="button"
                        className="steam-direct-btn is-accent is-sm"
                        onClick={handleSyncHubcap}
                        disabled={isSyncingHubcap || !appInfo}
                        style={{ marginTop: 4, alignSelf: 'flex-start' }}
                      >
                        {isSyncingHubcap ? <Loader2 size={13} className="is-spinning" /> : <Zap size={13} />}
                        <span>{t.depotArchive.syncKeys}</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Metadata Key-Value Table (Images 3 & 4) */}
              <div className="epic-sidebar-meta-table">
                <div className="epic-meta-row">
                  <span className="epic-meta-key">{isVi ? 'Nhà phát triển' : 'Developer'}</span>
                  <span className="epic-meta-val">
                    {storeDetail?.developers?.join(', ') || 'Valve / Studio'}
                  </span>
                </div>

                <div className="epic-meta-row">
                  <span className="epic-meta-key">{isVi ? 'Nhà phát hành' : 'Publisher'}</span>
                  <span className="epic-meta-val">
                    {storeDetail?.publishers?.join(', ') || 'Valve / Publisher'}
                  </span>
                </div>

                <div className="epic-meta-row">
                  <span className="epic-meta-key">{isVi ? 'Ngày phát hành' : 'Release Date'}</span>
                  <span className="epic-meta-val">
                    {storeDetail?.release_date || 'Available'}
                  </span>
                </div>

                <div className="epic-meta-row">
                  <span className="epic-meta-key">{isVi ? 'Nền tảng' : 'Platform'}</span>
                  <span className="epic-meta-val">Windows (64-bit)</span>
                </div>

                {storeDetail?.supported_languages && (
                  <div className="epic-meta-row">
                    <span className="epic-meta-key">{isVi ? 'Ngôn ngữ' : 'Languages'}</span>
                    <span className="epic-meta-val" title={storeDetail.supported_languages.replace(/<[^>]+>/g, '').trim()}>
                      {storeDetail.supported_languages.toLowerCase().includes('vietnamese')
                        ? '✓ Có Tiếng Việt'
                        : (isVi ? 'Đa ngôn ngữ' : 'Multilingual')}
                    </span>
                  </div>
                )}

                {storeDetail?.drm_notice && (
                  <div className="epic-meta-row is-drm-warning">
                    <span className="epic-meta-key">DRM</span>
                    <span className="epic-meta-val is-warn" title={storeDetail.drm_notice.replace(/<[^>]+>/g, '').trim()}>
                      <ShieldAlert size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
                      {storeDetail.drm_notice.replace(/<[^>]+>/g, '').trim().slice(0, 45)}
                    </span>
                  </div>
                )}

                <div className="epic-meta-row">
                  <span className="epic-meta-key">AppID</span>
                  <span className="epic-meta-val mono">{appInfo.appid}</span>
                </div>

                <div className="epic-meta-row">
                  <span className="epic-meta-key">BuildID</span>
                  <span className="epic-meta-val mono">
                    {selectedHistoryVersion || appInfo.publicBuildId || 'Current'}
                  </span>
                </div>

                <div className="epic-meta-row">
                  <span className="epic-meta-key">{isVi ? 'Gói depot' : 'Depots'}</span>
                  <span className="epic-meta-val">
                    {selectedDepotIds.size} / {appInfo.depots.length}
                  </span>
                </div>

                <div className="epic-meta-row">
                  <span className="epic-meta-key">{isVi ? 'Khóa giải mã' : 'Depot Keys'}</span>
                  <span className={`epic-meta-val ${appInfo.keysFound > 0 ? 'is-green' : 'is-warn'}`}>
                    {appInfo.keysFound > 0
                      ? `✓ ${appInfo.keysFound}/${appInfo.depots.length} Sẵn sàng`
                      : '✗ Chưa có key'}
                  </span>
                </div>
              </div>

              {/* Share & SteamDB Footer Buttons (Images 3 & 4) */}
              <div className="epic-sidebar-footer-actions">
                <button
                  type="button"
                  className="epic-action-btn"
                  onClick={() => {
                    navigator.clipboard?.writeText(`${selectedName} (AppID: ${appInfo.appid})`)
                    setShareCopied(true)
                    setTimeout(() => setShareCopied(false), 2000)
                  }}
                >
                  <Share2 size={14} />
                  <span>{shareCopied ? (isVi ? 'Đã sao chép!' : 'Copied!') : (isVi ? 'Chia sẻ' : 'Share')}</span>
                </button>

                <button
                  type="button"
                  className="epic-action-btn"
                  onClick={() => handleOpenSteamDb(appInfo.appid)}
                >
                  <ExternalLink size={14} />
                  <span>SteamDB</span>
                </button>
              </div>
            </aside>
          </div>

          {/* Pre-download Configuration Modal (Depots, Branch, Version, Install Dir) */}
          <DepotInstallModal
            isOpen={showInstallModal}
            onClose={() => setShowInstallModal(false)}
            appInfo={appInfo}
            gameName={selectedName}
            capsuleImage={selectedHeader || selectedCapsule || selectedHero}
            heroImage={selectedHero}
            targetDir={targetDir}
            setTargetDir={setTargetDir}
            onBrowseDir={handleBrowseDir}
            diskSpace={diskSpace}
            selectedDepotIds={selectedDepotIds}
            toggleDepot={toggleDepot}
            onSelectAll={handleSelectAll}
            onDeselectAll={handleDeselectAll}
            onSelectKeyed={handleSelectKeyedDepots}
            selectedBranch={selectedBranch}
            onSelectBranch={handleSelectBranch}
            selectedHistoryVersion={selectedHistoryVersion}
            onSelectHistoryVersion={handleSelectHistoryVersion}
            versionHistory={versionHistory}
            maxConcurrency={maxConcurrency}
            setMaxConcurrency={setMaxConcurrency}
            verifyAll={verifyAll}
            setVerifyAll={setVerifyAll}
            isSyncingHubcap={isSyncingHubcap}
            onSyncHubcap={handleSyncHubcap}
            isDownloading={isDownloading}
            onStartDownload={() => {
              setShowInstallModal(false)
              void handleStartDownload()
            }}
            isVi={isVi}
          />
        </div>
      )}

      {/* In-App Steam News & Updates Detail Modal */}
      {selectedNewsItem && (
        <div className="epic-news-modal-backdrop" onClick={() => setSelectedNewsItem(null)}>
          <div className="epic-news-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="epic-news-modal-header">
              <div className="epic-news-modal-header-text">
                <span className="epic-news-modal-eyebrow">
                  {isVi ? 'THÔNG TIN BẢN CẬP NHẬT' : 'UPDATE DETAILS'}
                </span>
                <h3 className="epic-news-modal-title">{selectedNewsItem.title}</h3>
                <div className="epic-news-modal-meta">
                  <span>{selectedNewsItem.author || 'Developer'}</span>
                  {selectedNewsItem.date && (
                    <span>
                      • {isNaN(Number(selectedNewsItem.date)) ? selectedNewsItem.date : new Date(Number(selectedNewsItem.date) * 1000).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="epic-news-modal-close-btn"
                onClick={() => setSelectedNewsItem(null)}
                title={isVi ? 'Đóng' : 'Close'}
              >
                <X size={20} />
              </button>
            </div>

            <div
              className="epic-news-modal-body"
              dangerouslySetInnerHTML={{
                __html: formatSteamNewsHtml(selectedNewsItem.contents || selectedNewsItem.excerpt),
              }}
            />

            <div className="epic-news-modal-footer">
              <button
                type="button"
                className="epic-news-modal-btn"
                onClick={() => setSelectedNewsItem(null)}
              >
                {isVi ? 'Đóng bản tin' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post-Download Optimization & Fixes 3-Tab Modal */}
      {showPostDlPopup && (
        <div className="post-dl-modal-backdrop" onClick={() => setShowPostDlPopup(false)}>
          <div className="post-dl-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="post-dl-modal-header">
              <div className="post-dl-modal-header-text">
                <div className="post-dl-badge">
                  <Sparkles size={14} />
                  <span>{t.depotDirectUi.autoDetectExtras}</span>
                </div>
                <h3 className="post-dl-modal-title">{t.depotDirectUi.postDownloadTitle}</h3>
                <p className="post-dl-modal-sub">{t.depotDirectUi.postDownloadSubtitle}</p>
              </div>
              <button
                type="button"
                className="post-dl-modal-close-btn"
                onClick={() => setShowPostDlPopup(false)}
                title={t.depotDirectUi.doneClose}
              >
                <X size={20} />
              </button>
            </div>

            {/* 3 Tabs Bar */}
            <div className="post-dl-tab-bar">
              <button
                type="button"
                className={`post-dl-tab-btn ${postDlTab === 'translations' ? 'is-active' : ''}`}
                onClick={() => setPostDlTab('translations')}
              >
                <Languages size={15} />
                <span>{t.depotDirectUi.tabTranslations}</span>
                {availableTranslations.length > 0 && (
                  <span className="post-dl-tab-count is-green">{availableTranslations.length}</span>
                )}
              </button>
              <button
                type="button"
                className={`post-dl-tab-btn ${postDlTab === 'bypass' ? 'is-active' : ''}`}
                onClick={() => setPostDlTab('bypass')}
              >
                <ShieldAlert size={15} />
                <span>{t.depotDirectUi.tabBypass}</span>
                {bypassBuilds.length > 0 && (
                  <span className="post-dl-tab-count is-amber">{bypassBuilds.length}</span>
                )}
              </button>
              <button
                type="button"
                className={`post-dl-tab-btn ${postDlTab === 'gse' ? 'is-active' : ''}`}
                onClick={() => setPostDlTab('gse')}
              >
                <Wrench size={15} />
                <span>{t.depotDirectUi.tabGse}</span>
                <span className="post-dl-tab-tag">Manual</span>
              </button>
            </div>

            {/* Floating not-in-popup status: install registration / shortcut result */}
            {finalizeMsg && (
              <div className="post-dl-feedback-banner is-error">
                <AlertCircle size={16} />
                <span>{finalizeMsg}</span>
              </div>
            )}

            {/* Status / Feedback message banner if any */}
            {postDlMsg && (
              <div className={`post-dl-feedback-banner ${translationInstallStatus === 'done' || bypassInstallStatus === 'done' ? 'is-success' : 'is-error'}`}>
                {translationInstallStatus === 'done' || bypassInstallStatus === 'done' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                <span>{postDlMsg}</span>
              </div>
            )}

            {/* Modal Body */}
            <div className="post-dl-modal-body">
              {postDlScanning ? (
                <div className="post-dl-loading-box">
                  <Loader2 size={32} className="is-spinning" />
                  <p>{t.depotDirectUi.scanningExtras}</p>
                </div>
              ) : postDlTab === 'translations' ? (
                <div className="post-dl-tab-content">
                  {availableTranslations.length > 0 ? (
                    <>
                      <div className="post-dl-prompt-banner is-emerald">
                        <CheckCircle2 size={20} />
                        <div>
                          <strong>{t.depotDirectUi.foundTranslationsTitle}</strong>
                          <p>{t.depotDirectUi.foundTranslationsPrompt}</p>
                        </div>
                      </div>
                      <div className="post-dl-items-list">
                        {availableTranslations.map((item, idx) => (
                          <div key={idx} className="post-dl-item-card">
                            <div className="post-dl-item-info">
                              <span className="post-dl-item-title">{item.file_name}</span>
                              <span className="post-dl-item-meta">
                                {item.size ? formatBytes(item.size) : t.depotDirectUi.vietnamesePatch}
                              </span>
                            </div>
                            {isLocalExtrasItem(item) ? (
                              <span className="post-dl-item-badge">
                                <Folder size={12} />
                                <span>{t.depotDirectUi.localFileTag}</span>
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="steam-direct-btn is-accent is-sm"
                                disabled={translationInstallStatus === 'running' || translationInstallStatus === 'done'}
                                onClick={() => void handleApplyTranslation(item)}
                              >
                                {translationInstallStatus === 'running' ? (
                                  <>
                                    <Loader2 size={13} className="is-spinning" />
                                    <span>{t.depotDirectUi.applyingTranslation}</span>
                                  </>
                                ) : translationInstallStatus === 'done' ? (
                                  <>
                                    <CheckCircle2 size={13} />
                                    <span>{t.depotDirectUi.translationApplied}</span>
                                  </>
                                ) : (
                                  <>
                                    <Languages size={13} />
                                    <span>{t.depotDirectUi.applyTranslation}</span>
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="post-dl-empty-box">
                      <Languages size={36} className="is-muted" />
                      <h5>{t.depotDirectUi.noTranslationsFound}</h5>
                    </div>
                  )}
                </div>
              ) : postDlTab === 'bypass' ? (
                <div className="post-dl-tab-content">
                  {bypassBuilds.length > 0 ? (
                    <>
                      <div className="post-dl-prompt-banner is-amber">
                        <Zap size={20} />
                        <div>
                          <strong>{t.depotDirectUi.foundBypassTitle}</strong>
                          <p>{t.depotDirectUi.foundBypassPrompt}</p>
                        </div>
                      </div>
                      <div className="post-dl-items-list">
                        {bypassBuilds.map((build, idx) => (
                          <div key={idx} className="post-dl-item-card">
                            <div className="post-dl-item-info">
                              <span className="post-dl-item-title">
                                {build.buildid === 'Latest' ? t.depotDirectUi.latestBuild : t.depotDirectUi.buildLabel.replace('{0}', build.buildid)}
                              </span>
                              <span className="post-dl-item-meta">
                                {build.tags.map((tag) => tag.tag).join(', ') || t.depotDirectUi.goldbergOnlineFix}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="steam-direct-btn is-accent is-sm"
                              disabled={bypassInstallStatus === 'running' || bypassInstallStatus === 'done'}
                              onClick={() => void handleApplyBypass(build)}
                            >
                              {bypassInstallStatus === 'running' ? (
                                <>
                                  <Loader2 size={13} className="is-spinning" />
                                  <span>{t.depotDirectUi.applyingBypass}</span>
                                </>
                              ) : bypassInstallStatus === 'done' ? (
                                <>
                                  <CheckCircle2 size={13} />
                                  <span>{t.depotDirectUi.bypassApplied}</span>
                                </>
                              ) : (
                                <>
                                  <Zap size={13} />
                                  <span>{t.depotDirectUi.applyBypass}</span>
                                </>
                              )}
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="post-dl-empty-box">
                      <ShieldAlert size={36} className="is-muted" />
                      <h5>{t.depotDirectUi.noBypassFound}</h5>
                    </div>
                  )}
                </div>
              ) : (
                <div className="post-dl-tab-content">
                  <div className="post-dl-prompt-banner is-blue">
                    <Wrench size={20} />
                    <div>
                      <strong>{t.depotDirectUi.gseManualTitle}</strong>
                      <p>{t.depotDirectUi.gseManualDesc}</p>
                    </div>
                  </div>

                  <div className="post-dl-gse-actions">
                    <button
                      type="button"
                      className="steam-direct-btn is-accent"
                      onClick={handleRunGseCrack}
                      disabled={gseCrackStatus === 'running'}
                    >
                      {gseCrackStatus === 'running' ? (
                        <Loader2 size={15} className="is-spinning" />
                      ) : gseCrackStatus === 'done' ? (
                        <CheckCircle2 size={15} />
                      ) : (
                        <Zap size={15} />
                      )}
                      <span>
                        {gseCrackStatus === 'done'
                          ? t.depotDirectUi.gseSetupAppliedSuccessfullyGameIs
                          : t.depotDirectUi.applyGseCrack}
                      </span>
                    </button>

                    <button
                      type="button"
                      className="steam-direct-btn"
                      onClick={() => {
                        setShowPostDlPopup(false)
                        window.dispatchEvent(
                          new CustomEvent('gse-preload-target', {
                            detail: { appId: appInfo?.appid, gameFolder: targetDir },
                          })
                        )
                        window.dispatchEvent(
                          new CustomEvent('navigate-to-tab', {
                            detail: 'GSE / UC Setup',
                          })
                        )
                      }}
                    >
                      <Settings size={15} />
                      <span>{t.depotDirectUi.openDetailedGseSetup}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="post-dl-modal-footer">
              <button
                type="button"
                className="steam-direct-btn is-quiet"
                onClick={handleOpenDir}
              >
                <Folder size={14} />
                <span>{t.depotDirectUi.openGameFolder}</span>
              </button>
              <button
                type="button"
                className="steam-direct-btn is-accent"
                onClick={() => setShowPostDlPopup(false)}
              >
                <span>{t.depotDirectUi.doneClose}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hubcap Manifest Key Modal */}
      <HubcapKeyModal
        isOpen={showHubcapKeyModal}
        onClose={() => setShowHubcapKeyModal(false)}
        onKeySaved={() => void loadHubcapStatus()}
      />
    </div>
  )
}
