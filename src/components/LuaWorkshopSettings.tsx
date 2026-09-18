import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useLocale } from '../context/locale'
import { luaErrorText } from '../lib/luaUiText'
import { LuaSteamAccount, type LuaSteamAccountIdentity } from './LuaSteamAccount'
import './LuaWorkspace.css'

type Tool = { executablePath: string; sha256: string; sourceReleaseUrl: string; approved: boolean }
type Settings = { downloadingRoot: string; officialTool: Tool | null }
const EMPTY_TOOL: Tool = { executablePath: '', sha256: '', sourceReleaseUrl: '', approved: false }

export function LuaWorkshopSettings({ onSaved, onAccountChanged }: { onSaved?: () => void; onAccountChanged?: (account: LuaSteamAccountIdentity | null) => void }) {
  const { t } = useLocale()
  const lx = t.luaExperience
  const [saved, setSaved] = useState<Settings | null>(null)
  const [root, setRoot] = useState('')
  const [tool, setTool] = useState<Tool>({ ...EMPTY_TOOL })
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState(false)
  const reset = (settings: Settings) => { setRoot(settings.downloadingRoot); setTool(settings.officialTool ?? { ...EMPTY_TOOL }); setEnabled(Boolean(settings.officialTool)) }
  useEffect(() => {
    let active = true
    void invoke<Settings>('lua_get_workshop_settings').then(settings => {
      if (active) { setSaved(settings); reset(settings) }
    }).catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [])
  const save = async () => {
    setBusy(true); setError(null); setMessage(false)
    try {
      const settings = await invoke<Settings>('lua_save_workshop_settings', { settings: { downloadingRoot: root.trim(), officialTool: enabled ? tool : null } })
      setSaved(settings); reset(settings); setMessage(true); onSaved?.()
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  return <details className="lua-workspace"><summary>Lua Workshop · {lx.workshop.storageAdapter}</summary>
    <LuaSteamAccount onAccountChanged={onAccountChanged} />
    <p className="lua-workspace-note">{lx.workshop.onlyLuaWorkshopDoesNotChangeStore}</p>
    {error && <p role="alert" className="lua-workspace-error">{luaErrorText(lx, error)}</p>}{message && <p role="status">{lx.workshop.savedAppliesToTheNextWorkshopTask}</p>}
    <label>{lx.workshop.downloadingDirectory}<input value={root} disabled={!saved || busy} onChange={event => { setRoot(event.target.value); setMessage(false) }} /></label>
    <label className="lua-workspace-actions"><input type="checkbox" checked={enabled} disabled={!saved || busy} onChange={event => { setEnabled(event.target.checked); setMessage(false) }} />{lx.workshop.useAnApprovedOfficialDepotDownloaderAnonymous}</label>
    {enabled && <>
      <p className="lua-workspace-note">{lx.workshop.onlySelfContainedDepotDownloaderExeFromA}</p>
      <label>DepotDownloader.exe<input value={tool.executablePath} disabled={busy} onChange={event => setTool({ ...tool, executablePath: event.target.value, approved: false })} /></label>
      <label>SHA-256<input value={tool.sha256} disabled={busy} onChange={event => setTool({ ...tool, sha256: event.target.value.trim(), approved: false })} /></label>
      <label>{lx.workshop.canonicalReleaseAssetURL}<input value={tool.sourceReleaseUrl} disabled={busy} onChange={event => setTool({ ...tool, sourceReleaseUrl: event.target.value.trim(), approved: false })} /></label>
      <label className="lua-workspace-actions"><input type="checkbox" checked={tool.approved} disabled={busy} onChange={event => setTool({ ...tool, approved: event.target.checked })} />{lx.workshop.iCheckedTheSourceAndApproveThis}</label>
    </>}
    <div className="lua-workspace-actions"><button type="button" disabled={busy || !saved || (enabled && !tool.approved)} onClick={() => void save()}>{lx.workshop.verifySave}</button><button type="button" disabled={busy || !saved} onClick={() => { if (saved) reset(saved); setMessage(false); setError(null) }}>{lx.workshop.discardChanges}</button></div>
  </details>
}
