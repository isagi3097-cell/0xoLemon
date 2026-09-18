import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { DownloadWaveCard } from './DownloadWaveCard'
import { listen } from '@tauri-apps/api/event'
import { useLocale } from '../context/locale'
import { luaErrorText, luaUiLabel } from '../lib/luaUiText'
import { luaTaskControls, parseLuaAppId, type LuaTask } from '../lib/luaTasks'
import { LuaMetadataPanel } from './LuaMetadataPanel'
import { LuaProviderDiagnostics } from './LuaProviderDiagnostics'
import { LuaWorkshopSettings } from './LuaWorkshopSettings'
import type { LuaSteamAccountIdentity } from './LuaSteamAccount'
import './LuaWorkspace.css'

type WorkshopItem = { publishedFileId: string; appid: number; title: string; sizeBytes: number; updatedAt: number; authentication: string; downloadAvailable: boolean; availabilityReason?: string; accountApproval?: { accountId: string; updatedAt: number; expectedBytes: number } | null }
type WorkshopHealth = { directDownloadAvailable: boolean; officialToolAvailable: boolean; authenticationAvailable: boolean; reasonCode: string; downloadingRoot: string }
type CacheHealth = { metadataEntries: number; imageEntries: number; imageBytes: number; dbBytes: number; namespace: string }

export function LuaWorkspace({ onTasksChanged }: { onTasksChanged?: () => void }) {
  const { locale, t } = useLocale()
  const lx = t.luaExperience
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'tasks' | 'metadata' | 'workshop' | 'providers'>('tasks')
  const [tasks, setTasks] = useState<LuaTask[]>([])
  const [error, setError] = useState<string | null>(null)
  const [verification, setVerification] = useState<string | null>(null)
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [appIdInput, setAppIdInput] = useState('')
  const [inspectedApp, setInspectedApp] = useState<number | null>(null)
  const [itemInput, setItemInput] = useState('')
  const [workshopAppId, setWorkshopAppId] = useState('')
  const [account, setAccount] = useState<LuaSteamAccountIdentity | null>(null)
  const [useAccount, setUseAccount] = useState(false)
  const [item, setItem] = useState<WorkshopItem | null>(null)
  const [workshop, setWorkshop] = useState<WorkshopHealth | null>(null)
  const [cache, setCache] = useState<CacheHealth | null>(null)
  const onChanged = useRef(onTasksChanged)
  useEffect(() => { onChanged.current = onTasksChanged }, [onTasksChanged])
  useEffect(() => {
    let active = true
    let stop: (() => void) | undefined
    // Subscribe before snapshot; the persistent queue remains the authority across tab unmounts.
    let version = 0
    let observed = new Map<string, string>()
    void listen<LuaTask[]>('lua-tasks-changed', event => {
      if (!active) return
      const luaCommitted = event.payload.some(task => task.receipt?.gameState && task.status === 'completed' && observed.get(task.taskId) !== 'completed')
      observed = new Map(event.payload.map(task => [task.taskId, task.status]))
      version++; setTasks(event.payload)
      // Byte progress from Workshop must not rescan the Lua registry or rerender every catalog card.
      if (luaCommitted) onChanged.current?.()
    }).then(async unlisten => {
      if (!active) { unlisten(); return }
      stop = unlisten
      const before = version
      const snapshot = await invoke<LuaTask[]>('lua_list_tasks')
      if (active && before === version) { setTasks(snapshot); observed = new Map(snapshot.map(task => [task.taskId, task.status])) }
    }).catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false; stop?.() }
  }, [])
  useEffect(() => {
    if (!open) return
    let active = true
    void Promise.allSettled([
      invoke<WorkshopHealth>('lua_get_workshop_health'), invoke<CacheHealth>('lua_get_cache_health'),
    ]).then(([workshopResult, cacheResult]) => {
      if (!active) return
      if (workshopResult.status === 'fulfilled') setWorkshop(workshopResult.value)
      if (cacheResult.status === 'fulfilled') setCache(cacheResult.value)
    })
    return () => { active = false }
  }, [open, tab])
  const run = useCallback(async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await operation(); setTasks(await invoke<LuaTask[]>('lua_list_tasks')) }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }, [])
  const activeCount = tasks.filter(task => ['queued', 'running', 'paused', 'pausing', 'cancelling'].includes(task.status)).length
  const inspect = () => {
    const appid = parseLuaAppId(appIdInput.trim())
    if (!appid) { setError('INVALID_APPID'); return }
    setError(null); setInspectedApp(appid)
  }
  const moveFirst = async (taskId: string) => {
    const taskIds = tasks.filter(task => task.status === 'queued').map(task => task.taskId)
    await invoke('lua_reorder_tasks', { taskIds: [taskId, ...taskIds.filter(id => id !== taskId)] })
  }
  return <section className="lua-workspace" aria-label={lx.workspace.luaShopWorkspace}>
    <header className="lua-workspace-heading">
      <div><h3>{lx.common.workspace} {activeCount > 0 ? `· ${activeCount}` : ''}</h3><p className="lua-workspace-note">{lx.workspace.metadataWorkshopLuaTasksProvidersIndependentOf}</p></div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? (lx.workspace.collapse) : (lx.workspace.openLuaTools)}</button>
    </header>
    {error && <p className="lua-workspace-error" role="alert">{luaErrorText(lx, error)}</p>}
    {open && <>
      <div className="lua-workspace-tabs" role="tablist" aria-label={lx.common.workspace}>
        {(['tasks', 'metadata', 'workshop', 'providers'] as const).map(name => <button key={name} id={`lua-tab-${name}`} type="button" role="tab" aria-selected={tab === name} aria-controls={`lua-panel-${name}`} onClick={() => setTab(name)}>{lx.tabs[name]}</button>)}
      </div>
      <div id={`lua-panel-${tab}`} role="tabpanel" aria-labelledby={`lua-tab-${tab}`}>
        {tab === 'tasks' && <>
          <button type="button" disabled={busy || !tasks.some(task => task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed')} onClick={() => void run(async () => {
            setArchiveNotice(null)
            const taskIds = tasks.filter(task => task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed').map(task => task.taskId)
            const archive = await invoke<{ archivePath: string; archivedCount: number }>('lua_archive_finished_tasks', { taskIds })
            setArchiveNotice(`${archive.archivedCount} · ${archive.archivePath}`)
          })}>{lx.workspace.archiveFinishedHistory}</button>
          {archiveNotice && <p role="status">{lx.workspace.auditReceiptsRetainedAt}: <code>{archiveNotice}</code></p>}
          <p className="lua-workspace-note">{lx.workspace.luaShopAddSyncUpdateRunHere}</p>
          {tasks.length === 0 ? <p>{lx.workspace.noLuaTasksYet}</p> : <div className="lua-workspace-task-list">{tasks.map(task => <article key={task.taskId} className="lua-workspace-task">
            <header className="lua-workspace-heading"><strong>{lx.taskKind[task.action.kind]} · {lx.common.appId} {task.action.appid}</strong><span role="status">{lx.status[task.status]}</span></header>
            <DownloadWaveCard telemetry={{ transferId: `lua:${task.taskId}`, owner: 'lua',
              state: task.status === 'paused' ? 'paused' : task.status === 'completed' ? 'complete' : task.status === 'failed' || task.status === 'cancelled' ? 'failed' : 'resolving',
              progress: task.progress === null ? undefined : task.progress * 100, updatedAt: Date.parse(task.updatedAt),
            }} />
            <small>{task.taskId} · {lx.workspace.attempt} {task.attempt}</small>
            {task.errorCode && <p className="lua-workspace-error">{luaErrorText(lx, task.errorCode)}</p>}
            <div className="lua-workspace-actions">{luaTaskControls(task).map(operation => <button key={operation} type="button" disabled={busy} onClick={() => void run(() => invoke('lua_control_task', { taskId: task.taskId, operation }))}>{({pause:lx.workspace.pause,resume:lx.workspace.resume,cancel:lx.workspace.cancel,retry:lx.workspace.retry})[operation]}</button>)}
              {task.status === 'queued' && <button type="button" disabled={busy} onClick={() => void run(() => moveFirst(task.taskId))}>{lx.workspace.moveFirst}</button>}
            </div>
            {task.receipt && <details><summary>{lx.common.receipt}</summary><pre><code>{JSON.stringify(task.receipt, null, 2)}</code></pre></details>}
            {task.status === 'completed' && task.action.kind === 'workshopDownload' && <button type="button" disabled={busy} onClick={() => void run(async () => {
              if (task.action.kind !== 'workshopDownload') return
              setVerification(null)
              await invoke('lua_verify_workshop_receipt', { appid: task.action.appid, publishedFileId: task.action.publishedFileId, taskId: task.taskId })
              setVerification(task.taskId)
            })}>{lx.workspace.verifyFilesAgainstReceipt}</button>}
            {verification === task.taskId && <p role="status">{lx.workspace.fileHashesMatchTheReceipt}</p>}
          </article>)}</div>}
        </>}
        {tab === 'metadata' && <>
          <form className="lua-workspace-form" onSubmit={event => { event.preventDefault(); inspect() }}><label>AppID<input inputMode="numeric" value={appIdInput} onChange={event => setAppIdInput(event.target.value)} /></label><button type="submit">{lx.workspace.inspectMetadata}</button></form>
          {cache && <p className="lua-workspace-note">{cache.namespace} · {cache.metadataEntries} metadata · {cache.imageEntries} {lx.common.images} · {(cache.dbBytes / 1048576).toFixed(1)} MiB SQLite ({(cache.imageBytes / 1048576).toFixed(1)} MiB {lx.common.artwork})</p>}
          {inspectedApp && <><button type="button" disabled={busy} onClick={() => void run(() => invoke('lua_enqueue_task', { action: { kind: 'metadataRefresh', appid: inspectedApp } }))}>{lx.workspace.queueMetadataRefresh}</button><LuaMetadataPanel key={inspectedApp} appId={inspectedApp} onInspectApp={appid => { setInspectedApp(appid); setAppIdInput(String(appid)) }} /></>}
        </>}
        {tab === 'workshop' && <>
          <LuaWorkshopSettings onSaved={() => { void invoke<WorkshopHealth>('lua_get_workshop_health').then(setWorkshop).catch(reason => setError(String(reason))); setItem(null) }} onAccountChanged={next => { setAccount(next); setItem(null); if (!next) setUseAccount(false) }} />
          <label className="lua-workspace-actions"><input type="checkbox" checked={useAccount} disabled={!account || busy} onChange={event => { setUseAccount(event.target.checked); setItem(null) }} />{lx.steamAccount.useForItem}{account ? ` · ${account.steamId}` : ''}</label>
          {useAccount && <p className="lua-workspace-note">{lx.steamAccount.directOnly}</p>}
          <p>{lx.workspace.resolveAPublishedFileIDBeforeDownloadingFilesStay}</p>
          {workshop && <p className="lua-workspace-note"><code>{workshop.downloadingRoot}</code><br />{luaUiLabel(lx.reasons, workshop.reasonCode)}</p>}
          <form className="lua-workspace-form" onSubmit={event => {
            event.preventDefault(); setItem(null)
            void run(async () => {
              const resolved = useAccount && account
                ? await invoke<WorkshopItem>('lua_resolve_authenticated_workshop_item', { accountId: account.accountId, appid: parseLuaAppId(workshopAppId.trim()), publishedFileId: itemInput.trim() })
                : await invoke<WorkshopItem>('lua_resolve_workshop_item', { publishedFileId: itemInput.trim() })
              setItem(resolved)
            })
          }}>
            {useAccount && <label>AppID<input inputMode="numeric" value={workshopAppId} onChange={event => { setWorkshopAppId(event.target.value); setItem(null) }} /></label>}
            <label>PublishedFileID<input inputMode="numeric" value={itemInput} onChange={event => { setItemInput(event.target.value); setItem(null) }} /></label><button type="submit" disabled={busy || !/^[1-9]\d{0,19}$/.test(itemInput.trim()) || (useAccount && !parseLuaAppId(workshopAppId.trim()))}>{lx.workspace.resolveWorkshopItem}</button></form>
          {item && <article><h4>{item.title}</h4><p>AppID {item.appid} · {item.publishedFileId} · {(item.sizeBytes / 1048576).toFixed(2)} MiB · {new Date(item.updatedAt * 1000).toLocaleString(locale)}</p>
            <p>{item.authentication === 'steamAccountVerified' ? lx.steamAccount.verifiedItem : luaUiLabel(lx.status, item.authentication)} · {item.availabilityReason ? item.authentication === 'steamAccountVerified' ? luaErrorText(lx, item.availabilityReason) : luaUiLabel(lx.reasons, item.availabilityReason) : item.accountApproval ? lx.steamAccount.directAvailable : lx.workspace.publicDownloadAvailable}</p>
            <button type="button" disabled={busy || !item.downloadAvailable || Boolean(item.accountApproval && item.accountApproval.accountId !== account?.accountId)} onClick={() => void run(async () => { await invoke('lua_enqueue_task', { action: { kind: 'workshopDownload', appid: item.appid, publishedFileId: item.publishedFileId, ...(item.accountApproval ? { accountApproval: item.accountApproval } : {}) } }); setTab('tasks') })}>{lx.workspace.approveQueueInLua}</button>
          </article>}
        </>}
        {tab === 'providers' && <LuaProviderDiagnostics />}
      </div>
    </>}
  </section>
}
