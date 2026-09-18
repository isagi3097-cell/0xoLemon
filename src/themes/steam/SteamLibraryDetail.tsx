import { useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  AlertCircle,
  BookOpen,
  Clock3,
  Download,
  ExternalLink,
  FolderOpen,
  Heart,
  Library,
  MessageSquare,
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
import { formatBytes } from '../../lib/format'
import { assetUrlForId } from '../../lib/gameMeta'
import { SteamLibraryActivity } from './SteamLibraryActivity'
import { useSteamLibraryData } from '../../lib/steamLibraryData'

type SteamLibraryDetailProps = {
  game: GameSummary
  detail: GameDetail
  assets: Record<string, string>
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

type DetailTabId = 'overview' | 'achievements' | 'community' | 'discussions' | 'guides' | 'workshop' | 'store'

const DETAIL_TABS: { id: DetailTabId; label: string; icon: typeof Trophy }[] = [
  { id: 'overview', label: 'Overview / Activity', icon: Library },
  { id: 'achievements', label: 'Achievements', icon: Trophy },
  { id: 'community', label: 'Community', icon: Users },
  { id: 'discussions', label: 'Discussions', icon: MessageSquare },
  { id: 'guides', label: 'Guides', icon: BookOpen },
  { id: 'workshop', label: 'Workshop', icon: Wrench },
  { id: 'store', label: 'Store / Support', icon: Store },
]

const STEAM_HOSTS = new Set(['store.steampowered.com', 'steamcommunity.com', 'help.steampowered.com'])

function formatPlaytime(minutes: number | null | undefined): string {
  if (minutes == null) return 'No playtime yet'
  if (minutes < 60) return `${minutes} min`
  return `${(minutes / 60).toFixed(minutes >= 600 ? 0 : 1)} hours`
}

function formatLastPlayed(value: string | null | undefined): string {
  if (!value) return 'Never played'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

function steamAppUrl(appid: GameSummary['appid'], destination: DetailTabId | 'support'): string | null {
  const appId = String(appid ?? '').trim()
  if (!/^\d+$/.test(appId)) return null
  const routes: Record<DetailTabId | 'support', string> = {
    overview: `https://store.steampowered.com/app/${appId}/`,
    achievements: `https://steamcommunity.com/stats/${appId}/achievements/`,
    community: `https://steamcommunity.com/app/${appId}/`,
    discussions: `https://steamcommunity.com/app/${appId}/discussions/`,
    guides: `https://steamcommunity.com/app/${appId}/guides/`,
    workshop: `https://steamcommunity.com/app/${appId}/workshop/`,
    store: `https://store.steampowered.com/app/${appId}/`,
    support: `https://help.steampowered.com/en/wizard/HelpWithGame/?appid=${appId}`,
  }
  const url = new URL(routes[destination])
  return url.protocol === 'https:' && STEAM_HOSTS.has(url.hostname) ? url.toString() : null
}

export function SteamLibraryDetail({
  game,
  detail,
  assets,
  installState,
  displayedVersion,
  heroUrl,
  logoUrl,
  coverUrl,
  downloadSize,
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
}: SteamLibraryDetailProps) {
  const { t } = useLocale()
  const reducedMotion = Boolean(useReducedMotion())
  const [activeTab, setActiveTab] = useState<DetailTabId>('overview')
  const steamData = useSteamLibraryData(game.id, game.appid ?? detail.appid)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  // While a job is starting the button must stay inert: a second click would
  // replay the whole install preflight (Backup Game catalog + manifest fetch)
  // and spam the backend with duplicate requests.
  const primary = playing
    ? { label: 'Stop', icon: <Square size={18} fill="currentColor" />, action: onStop, state: 'stop' }
    : installing
      ? { label: 'Downloading', icon: <Download size={19} />, action: () => {}, state: 'busy' }
      : installed && updateReady
        ? { label: t.library.update, icon: <RefreshCcw size={19} />, action: onUpdate, state: 'update' }
        : installed
          ? { label: t.library.play, icon: <Play size={20} fill="currentColor" />, action: onPlay, state: 'play' }
          : { label: t.library.chooseInstall, icon: <Download size={19} />, action: onInstall, state: 'install' }
  const primaryDisabled = installing || installBlocked || primary.state === 'busy'
  const features = detail.categories.slice(0, 4)
  const liveAchievements = steamData.data?.achievements ?? []
  const achievementTotal = liveAchievements.length || detail.achievements.length
  const unlockedAchievements = steamData.data?.unlockedAchievements ?? 0
  const verificationText = verifying ? `${Math.round((verifyStatus?.percent ?? 0) * 100)}%` : t.library.verifyIntegrity

  const selectTab = (tab: DetailTabId, focus = false) => {
    setActiveTab(tab)
    if (focus) tabRefs.current[DETAIL_TABS.findIndex((item) => item.id === tab)]?.focus()
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % DETAIL_TABS.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + DETAIL_TABS.length) % DETAIL_TABS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = DETAIL_TABS.length - 1
    else return
    event.preventDefault()
    selectTab(DETAIL_TABS[nextIndex].id, true)
  }

  const openSteamDestination = (destination: DetailTabId | 'support') => {
    const url = steamAppUrl(game.appid ?? detail.appid, destination)
    if (url) onOpenExternal(url)
  }

  const renderExternalPanel = (tab: Exclude<DetailTabId, 'overview' | 'achievements' | 'store'>) => {
    const current = DETAIL_TABS.find((item) => item.id === tab)!
    const Icon = current.icon
    const url = steamAppUrl(game.appid ?? detail.appid, tab)
    return (
      <section className="steam-library-external-panel">
        <Icon size={34} aria-hidden="true" />
        <div><h2>{current.label}</h2><p>Continue to the official Steam {current.label.toLowerCase()} page for {game.title}.</p></div>
        <button type="button" disabled={!url} onClick={() => openSteamDestination(tab)}>
          Open in Steam <ExternalLink size={15} />
        </button>
        {!url ? <small>A numeric Steam app ID is not available for this game.</small> : null}
      </section>
    )
  }

  return (
    <main className="steam-library-detail-surface" aria-label={`${game.title} library page`}>
      <section className="steam-library-detail-hero">
        {heroUrl ? <img className="steam-library-detail-hero-art" src={heroUrl} alt="" loading="eager" decoding="async" /> : <div className="steam-library-detail-hero-placeholder"><Library size={48} /></div>}
        <div className="steam-library-detail-hero-vignette" />
        <div className="steam-library-detail-brand">
          {logoUrl ? <img src={logoUrl} alt={`${game.title} logo`} loading="eager" decoding="async" /> : <h1>{game.title}</h1>}
        </div>
      </section>

      <section className="steam-library-detail-actionbar" aria-label="Game actions">
        <button type="button" className="steam-library-primary-action" data-action-state={primary.state} disabled={primaryDisabled} onClick={primary.action}>
          {primary.icon}<span>{primary.label}</span>
        </button>
        <div className="steam-library-action-summary">
          <strong>{game.title}</strong>
          <span>{installed ? `Installed ${displayedVersion}` : `In Library · ${displayedVersion}`}{downloadSize > 0 ? ` · ${formatBytes(downloadSize)}` : ''}</span>
        </div>
        <div className="steam-library-play-stats" aria-live="polite">
          <span><Clock3 size={15} /><small>Last played</small><strong>{steamData.loading && !steamData.data ? 'Loading...' : formatLastPlayed(steamData.data?.lastPlayedAt)}</strong></span>
          <span><Play size={15} /><small>Playtime</small><strong>{steamData.loading && !steamData.data ? 'Loading...' : formatPlaytime(steamData.data?.playtimeMinutes)}</strong></span>
          <span><Trophy size={15} /><small>Achievements</small><strong>{steamData.loading && !steamData.data ? 'Loading...' : `${unlockedAchievements} / ${achievementTotal}`}</strong></span>
        </div>
        <div className="steam-library-action-tools">
          {showVersionAction && installed ? <button type="button" onClick={onVersions} disabled={installBlocked || installing} title="Manage versions"><Settings2 size={18} /><span>Versions</span></button> : null}
          <button type="button" onClick={onVerify} disabled={!installed || verifying || installBlocked} title={verificationText}><ShieldCheck size={18} /><span>{verificationText}</span></button>
          <button type="button" onClick={onBrowse} disabled={!installed || installBlocked} title="Browse local files"><FolderOpen size={18} /><span>Browse</span></button>
          <button type="button" className={favorite ? 'is-favorite' : ''} onClick={onToggleFavorite} aria-pressed={favorite} title={favorite ? 'Remove from favorites' : 'Add to favorites'}>
            <Heart size={18} fill={favorite ? 'currentColor' : 'none'} /><span>{favorite ? 'Favorite' : 'Add favorite'}</span>
          </button>
        </div>
      </section>

      {steamData.error ? <div className="steam-library-data-notice" role="status"><AlertCircle size={15} /><span>{steamData.error}{steamData.data?.source === 'launcher' ? ' Showing launcher play history.' : ''}</span><button type="button" onClick={steamData.reload}>Retry</button></div> : null}

      <div className="steam-library-detail-tabs" role="tablist" aria-label="Game detail sections">
        {DETAIL_TABS.map((tab, index) => {
          const Icon = tab.icon
          const selected = activeTab === tab.id
          return (
            <button key={tab.id} ref={(node) => { tabRefs.current[index] = node }} id={`steam-tab-${tab.id}`} type="button" role="tab" aria-selected={selected} aria-controls={`steam-panel-${tab.id}`} tabIndex={selected ? 0 : -1} onClick={() => selectTab(tab.id)} onKeyDown={(event) => handleTabKeyDown(event, index)}>
              <Icon size={14} aria-hidden="true" /><span>{tab.label}</span>
            </button>
          )
        })}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={activeTab} id={`steam-panel-${activeTab}`} className="steam-library-tabpanel" role="tabpanel" aria-labelledby={`steam-tab-${activeTab}`} tabIndex={0} initial={reducedMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reducedMotion ? undefined : { opacity: 0, y: -5 }} transition={{ duration: reducedMotion ? 0 : 0.18 }}>
          {activeTab === 'overview' ? (
            <>
              <section className="steam-library-detail-overview">
                {coverUrl ? <img className="steam-library-detail-cover" src={coverUrl} alt={`${game.title} library artwork`} loading="eager" decoding="async" /> : <div className="steam-library-detail-cover steam-library-detail-cover-fallback"><Library size={30} /><span>{game.title}</span></div>}
                <div className="steam-library-detail-description">
                  <p>{detail.shortDescription || game.subtitle}</p>
                  <dl><div><dt>Developer</dt><dd>{detail.developers.join(', ') || game.developer}</dd></div><div><dt>Publisher</dt><dd>{detail.publishers.join(', ') || game.publisher}</dd></div><div><dt>Release date</dt><dd>{detail.releaseDate || 'Available now'}</dd></div></dl>
                </div>
                <div className="steam-library-detail-features" aria-label="Game features">{(features.length > 0 ? features : ['Launcher library']).map((feature) => <span key={feature}>{feature}</span>)}</div>
              </section>
              <SteamLibraryActivity game={game} detail={detail} assets={assets} installState={installState} displayedVersion={displayedVersion} steamData={steamData.data} loading={steamData.loading} />
            </>
          ) : null}
          {activeTab === 'achievements' ? (
            <section className="steam-library-achievements-grid" aria-label={`${game.title} achievements`}>
              <header><div><Trophy size={22} /><div><h2>Achievements</h2><p>{unlockedAchievements} unlocked · {achievementTotal} available</p></div></div><button type="button" disabled={!steamAppUrl(game.appid ?? detail.appid, 'achievements')} onClick={() => openSteamDestination('achievements')}>View global stats <ExternalLink size={14} /></button></header>
              {liveAchievements.length ? liveAchievements.map((achievement) => (
                <article key={achievement.id} className={achievement.unlocked ? 'is-unlocked' : 'is-locked'}>
                  {achievement.iconUrl ? <img src={achievement.iconUrl} alt="" loading="lazy" decoding="async" /> : <div className="steam-library-achievement-fallback"><Trophy size={22} /></div>}
                  <div><h3>{achievement.name}</h3><p>{achievement.description || 'Achievement details unavailable'}</p>{achievement.unlocked ? <small>Unlocked{achievement.unlockTime ? ` · ${formatLastPlayed(new Date(achievement.unlockTime * 1000).toISOString())}` : ''}</small> : null}</div>
                </article>
              )) : detail.achievements.length ? detail.achievements.map((achievement) => {
                const iconUrl = assetUrlForId(achievement.iconAssetId, assets)
                return <article key={achievement.id}>{iconUrl ? <img src={iconUrl} alt="" loading="lazy" decoding="async" /> : <div className="steam-library-achievement-fallback"><Trophy size={22} /></div>}<div><h3>{achievement.name}</h3><p>{achievement.description || (achievement.hidden ? 'Hidden achievement' : 'Achievement details unavailable')}</p></div></article>
              }) : steamData.loading ? <p className="steam-library-tab-empty">Loading achievements...</p> : <p className="steam-library-tab-empty">No achievement data is available for this game.</p>}
            </section>
          ) : null}
          {activeTab === 'community' || activeTab === 'discussions' || activeTab === 'guides' || activeTab === 'workshop' ? renderExternalPanel(activeTab) : null}
          {activeTab === 'store' ? (
            <section className="steam-library-external-panel steam-library-store-support-panel"><Store size={34} aria-hidden="true" /><div><h2>Store & Support</h2><p>See the launcher store page, official Steam listing, or Steam Support.</p></div><div className="steam-library-external-actions"><button type="button" onClick={onOpenStore}>Launcher store page</button><button type="button" disabled={!steamAppUrl(game.appid ?? detail.appid, 'store')} onClick={() => openSteamDestination('store')}>Steam store <ExternalLink size={15} /></button><button type="button" disabled={!steamAppUrl(game.appid ?? detail.appid, 'support')} onClick={() => openSteamDestination('support')}>Steam Support <ExternalLink size={15} /></button></div></section>
          ) : null}
        </motion.div>
      </AnimatePresence>

      {installed ? <footer className="steam-library-detail-danger-zone"><button type="button" onClick={onUninstall} disabled={installBlocked || installing || playing}><Trash2 size={15} /> {t.library.uninstall}</button></footer> : null}
    </main>
  )
}
