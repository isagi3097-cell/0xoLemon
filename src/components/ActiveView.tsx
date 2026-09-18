import { lazy, Suspense } from 'react'
import { Database } from 'lucide-react'
import type { CloudSaveStatus, DiscordAuthUser, GameCatalog, GameDetail, GameInstallState, GameSummary, GameToolsLibraryItem, GameVersionInfo, JobJournal, JobLog, PhaseProgress, Snapshot, TabId, VerifyUiStatus } from '../types'
import type { UiThemeId } from '../lib/uiThemes'
import { rollbackVersionFor, assetUrlForId } from '../lib/gameMeta'
import { TabEmptyState, ScopedTabEmptyState } from './layout'
import { StoreLibraryView } from './library'
import { DownloadQueuePanel } from './downloads'
import { CachePanel, RollbackPanel, InstallSummaryPanel, ChangedFiles } from './panels'
import { TranslationsView } from './TranslationsView'
import { BypassFixView } from './BypassFixView'
import { WhatsNewView } from './WhatsNewView'
import { OfflineActivation } from './OfflineActivation'
import { LuaInstaller } from './LuaInstaller'
import { LuaShop } from './LuaShop'
import './ActiveViewLegacy.css'

const GameToolsView = lazy(() => import('./LightningHub'))

export function ActiveView({
  activeTab,
  catalog,
  catalogLoadState,
  onRetryCatalog,
  selectedGame,
  selectedGameId,
  onSelectGame,
  onRequestAsset,
  detail,
  assets,
  snapshot,
  installPath: _installPath,
  installTarget,
  scanStatus: _scanStatus,
  selectedVersion,
  selectedCurrentVersion,
  selectedVersionInfo,
  selectedInstallState,
  verifyStatus,
  installMode,
  updateReady,
  showVersionAction,
  canUpdate,
  isJobRunning,
  isGameRunning,
  isStarting,
  onBrowse: _onBrowse,
  onScan: _onScan,
  onPrimaryAction,
  onPlay,
  onStop,
  onVerify,
  onUninstall,
  job,
  hasJob,
  progress,
  phaseProgress,
  updateSize,
  isRunning,
  onOpenInstallOptions,
  onPause,
  onCancel,
  onResume,
  isResuming,
  isPaused,
  logs: _logs,
  onOpenStore,
  cloudSaveStatus,
  cloudSaveBusy,
  cloudLaunchBlocked,
  desktopDetail = false,
  onToggleCloudSave,
  onAddCloudSaveFolder,
  onSyncCloudSave,
  onResolveCloudConflict,
  onRestoreCloudSnapshot,
  onLaunchWithoutCloudSync,
  onConnectGoogleDrive,
  onDisconnectGoogleDrive,
  onBackupGoogleDrive,
  onRestoreMissingSaveFiles,
  cacheBusy,
  onClearCache,
  discordUser,
  installStates,
  steamInstalledAppIds,
  steamBuildIds,
  uiTheme,
  onOpenLibrary,
  onNavigate,
}: {
  activeTab: TabId
  catalog: GameCatalog
  catalogLoadState: 'loading' | 'ready' | 'stale' | 'error'
  onRetryCatalog: () => void
  selectedGame: GameSummary | null
  selectedGameId: string | null
  onSelectGame: (gameId: string | null) => void
  onRequestAsset: (game: GameSummary, assetId: string | undefined, urgent?: boolean) => void
  detail: GameDetail | null
  assets: Record<string, string>
  snapshot: Snapshot
  installPath: string
  installTarget: string
  scanStatus: string
  selectedVersion: string
  selectedCurrentVersion: string
  selectedVersionInfo?: GameVersionInfo
  selectedInstallState?: GameInstallState
  verifyStatus: VerifyUiStatus | null
  installMode: boolean
  updateReady: boolean
  showVersionAction: boolean
  canUpdate: boolean
  isJobRunning: boolean
  isGameRunning: boolean
  /** A start request is in flight (job journal not yet returned). */
  isStarting: boolean
  onBrowse: () => void
  onScan: () => void
  onPrimaryAction: () => void
  onPlay: () => void
  onStop: () => void
  onVerify: () => void
  onUninstall: () => void
  job: JobJournal
  hasJob: boolean
  progress: number
  phaseProgress: PhaseProgress
  updateSize: number
  isRunning: boolean
  onOpenInstallOptions: () => void
  onPause: () => void
  onCancel: () => void
  onResume?: () => void
  isResuming?: boolean
  isPaused: boolean
  logs: JobLog[]
  onOpenStore: () => void
  cloudSaveStatus: CloudSaveStatus | null
  cloudSaveBusy: boolean
  cloudLaunchBlocked: boolean
  /** Backup Game uses the leightweight desktop detail surface instead of the depot store layout. */
  desktopDetail?: boolean
  onToggleCloudSave: (enabled: boolean) => void
  onAddCloudSaveFolder: () => void
  onSyncCloudSave: () => void
  onResolveCloudConflict: (conflictId: string, resolution: 'local' | 'cloud') => void
  onRestoreCloudSnapshot: (snapshotId: string) => void
  onLaunchWithoutCloudSync: () => void
  onConnectGoogleDrive: () => void
  onDisconnectGoogleDrive: () => void
  onBackupGoogleDrive: () => void
  onRestoreMissingSaveFiles: () => void
  cacheBusy: boolean
  onClearCache: () => void
  discordUser?: DiscordAuthUser | null
  installStates?: Record<string, GameInstallState>
  steamInstalledAppIds?: number[]
  steamBuildIds?: Record<number, string>
  uiTheme: UiThemeId
  onOpenLibrary: (gameId: string) => void
  onNavigate: (tab: TabId) => void
}) {
  if (activeTab === 'Backup Game' || activeTab === 'Library') {
    return (
      <StoreLibraryView
        viewMode={activeTab === 'Backup Game' ? 'store' : 'library'}
        desktopDetail={desktopDetail}
        catalog={catalog}
        catalogLoadState={catalogLoadState}
        onRetryCatalog={onRetryCatalog}
        selectedGame={selectedGame}
        selectedGameId={selectedGameId}
        onSelectGame={onSelectGame}
        onRequestAsset={onRequestAsset}
        onPrimaryAction={onPrimaryAction}
        onPlay={() => onPlay()}
        onStop={() => onStop()}
        onVerify={() => onVerify()}
        detail={detail}
        assets={assets}
        selectedVersion={selectedVersion}
        selectedCurrentVersion={selectedCurrentVersion}
        selectedVersionInfo={selectedVersionInfo}
        selectedInstallState={selectedInstallState}
        verifyStatus={verifyStatus}
        updateReady={updateReady}
        showVersionAction={showVersionAction}
        canUpdate={canUpdate}
        updateSize={updateSize}
        installSize={snapshot.installSize}
        temporarySpace={snapshot.temporarySpace}
        isJobRunning={isJobRunning}
        isGameRunning={isGameRunning}
        isStarting={isStarting}
        onUninstall={onUninstall}
        onOpenInstallOptions={onOpenInstallOptions}
        onOpenStore={onOpenStore}
        cloudSaveStatus={cloudSaveStatus}
        cloudSaveBusy={cloudSaveBusy}
        cloudLaunchBlocked={cloudLaunchBlocked}
        onToggleCloudSave={onToggleCloudSave}
        onAddCloudSaveFolder={onAddCloudSaveFolder}
        onSyncCloudSave={onSyncCloudSave}
        onResolveCloudConflict={onResolveCloudConflict}
        onRestoreCloudSnapshot={onRestoreCloudSnapshot}
        onLaunchWithoutCloudSync={onLaunchWithoutCloudSync}
        onConnectGoogleDrive={onConnectGoogleDrive}
        onDisconnectGoogleDrive={onDisconnectGoogleDrive}
        onBackupGoogleDrive={onBackupGoogleDrive}
        onRestoreMissingSaveFiles={onRestoreMissingSaveFiles}
        discordUser={discordUser}
        installStates={installStates}
        steamInstalledAppIds={steamInstalledAppIds}
        steamBuildIds={steamBuildIds}
        uiTheme={uiTheme}
        onOpenLibrary={onOpenLibrary}
        onPause={onPause}
        onCancel={onCancel}
        isPaused={isPaused}
      />
    )
  }

  if (activeTab === 'Bypass-fix') {
    return (
      <BypassFixView
        catalog={catalog}
        selectedGameId={selectedGameId}
        installStates={installStates}
        onSelectGame={onSelectGame}
        onVerify={onVerify}
      />
    )
  }

  if (activeTab === 'Translations') {
    return <TranslationsView
      catalog={catalog}
      selectedGameId={selectedGameId}
      assets={assets}
      installStates={installStates}
      onSelectGame={onSelectGame}
      onRequestAsset={onRequestAsset}
      onVerify={onVerify}
    />
  }

  if (activeTab === 'Cache') {
    return (
      <section className="single-view cache-tab-view">
        <CachePanel snapshot={snapshot} busy={cacheBusy} onClear={onClearCache} />
        {selectedGame && detail ? (
          <>
            <RollbackPanel snapshot={snapshot} rollbackVersion={rollbackVersionFor(detail, selectedVersion)} />
            {installMode ? (
              <InstallSummaryPanel
                selectedVersion={selectedVersion}
                downloadSize={updateSize}
                installSize={snapshot.installSize}
                temporarySpace={snapshot.temporarySpace}
              />
            ) : (
              <ChangedFiles files={snapshot.changedFiles} />
            )}
          </>
        ) : (
          <ScopedTabEmptyState
            icon={<Database size={34} />}
            title="No game selected"
            body="Choose a game in Library to inspect rollback and changed-file cache state."
          />
        )}
      </section>
    )
  }

  if (activeTab === 'What\'s New!') {
    return <WhatsNewView />
  }

  if (activeTab === 'Offline Activation') {
    return <OfflineActivation catalog={catalog} assets={assets} />
  }

  if (activeTab === 'Lua Installer') {
    return <LuaInstaller />
  }

  if (activeTab === 'Lua Shop') {
    return <LuaShop />
  }

  if (activeTab === 'Tools') {
    const steamApps = new Set(steamInstalledAppIds ?? [])
    const gameToolsLibrary: GameToolsLibraryItem[] = catalog.games.map((game) => {
      const numericAppId = Number(game.appid)
      const appId = Number.isInteger(numericAppId) && numericAppId > 0 ? numericAppId : null
      return {
        gameId: game.id,
        appId,
        title: game.title,
        subtitle: game.subtitle || game.developer,
        imageUrl: assetUrlForId(game.gridAssetId, assets) ?? null,
        installed: Boolean(installStates?.[game.id]?.installed || (appId && steamApps.has(appId))),
      }
    })
    return (
      <Suspense fallback={<div className="lightning-hub-loading">Loading Game Tools...</div>}>
        <GameToolsView
          steamInstalledAppIds={steamInstalledAppIds}
          libraryItems={gameToolsLibrary}
          onNavigate={onNavigate}
          onReloadLibrary={onRetryCatalog}
        />
      </Suspense>
    )
  }

  if (activeTab === 'Downloads') {
    // The merged Downloads queue only renders a transfer card when a job is
    // genuinely running/queued. A merely selected game must NOT surface a fake
    // progress card, so we fall back to the browsable list in that case.
    if (!hasJob) {
      return (
        <TabEmptyState
          activeTab={activeTab}
          catalog={catalog}
          onSelectGame={onSelectGame}
          assets={assets}
          onRequestAsset={onRequestAsset}
        />
      )
    }

    const transferGame = catalog.games.find((game) => game.id === job.gameId) ?? selectedGame

    return (
      <section className="content-grid single-main">
        <div className="main-column">
          <DownloadQueuePanel
            gameTitle={transferGame?.title ?? 'Selected game'}
            gameArtwork={assetUrlForId(transferGame?.gridAssetId, assets)}
            layout="storeGameDetail"
            installTarget={installTarget}
            job={job}
            hasJob={hasJob}
            progress={progress}
            phaseProgress={phaseProgress}
            selectedVersion={selectedVersion}
            downloadSize={updateSize}
            isInstalled={!installMode}
            isRunning={isRunning}
            isPaused={isPaused}
            onOpenOptions={onOpenInstallOptions}
            onPause={onPause}
            onCancel={onCancel}
            onResume={onResume}
            isResuming={isResuming}
          />
        </div>
      </section>
    )
  }

  return null
}
