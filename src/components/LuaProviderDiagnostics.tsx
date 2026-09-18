import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useLocale } from '../context/locale'
import { luaErrorText, luaProviderDisplayName, luaUiLabel } from '../lib/luaUiText'
import './LuaProviderDiagnostics.css'

export type LuaExperienceSettings = {
  schemaVersion: number
  providerOrder: string[]
  pinnedProvider: string | null
  healthTtlSeconds: number
  confirmationPolicy: 'manual'
  changeImpacts: { providerSelection: 'applyNow'; runtimeProfile: 'relaunchGame'; steamCompatibility: 'restartSteam' }
}
type SettingsInput = Pick<LuaExperienceSettings, 'providerOrder' | 'pinnedProvider' | 'healthTtlSeconds'>
type Quota = { usage: number | null; limit: number | null; remaining: number | null }
type Observation = {
  checkedAt: string; result: 'ready' | 'failed' | 'notConfigured'; errorCode: string | null
  expiresAt: string | null; expiryEstimated: boolean
  daily: Quota; single: Quota; bundle: Quota; workshop: Quota
}
type Provider = {
  id: string; configured: boolean; enabled: boolean; freshness: 'fresh' | 'stale' | 'unknown'
  availability: string; checkedAt: string | null; errorCode: string | null
}
type ComponentHealth = {
  id: string; label: string; status: string; version: string | null; canonicalSource: string | null
  immutableCommit: string | null; artifactSha256: string | null; integrityVerified: boolean; provenanceVerified: boolean
}
type Health = {
  schemaVersion: number; observedAt: string; refreshed: boolean; settings: LuaExperienceSettings
  providers: Provider[]; capabilities: { id: string; state: string; reason: string; activationAllowed: boolean; changeImpact: string }[]
  components: ComponentHealth[]; steam: { build: number | null; buildAllowlisted: boolean; binaryFile: string; binarySha256: string | null; channel: string; identitySource: string; nativePatchApproved: boolean }
  hubcapHistory: Observation[]; quotaObservation: Observation | null; warnings: string[]
}









export function freshnessAt(checkedAt: string | null, ttl: number, now: number): 'fresh' | 'stale' | 'unknown' {
  if (!checkedAt) return 'unknown'
  const checked = Date.parse(checkedAt)
  if (!Number.isFinite(checked) || checked > now) return 'unknown'
  return now - checked <= ttl * 1000 ? 'fresh' : 'stale'
}

function settingsInput(settings: LuaExperienceSettings): SettingsInput {
  return { providerOrder: [...settings.providerOrder], pinnedProvider: settings.pinnedProvider, healthTtlSeconds: settings.healthTtlSeconds }
}

export function LuaProviderDiagnostics({ compact = false, onSettingsSaved }: {
  compact?: boolean
  onSettingsSaved?: (settings: LuaExperienceSettings) => void
}) {
  const { locale, t } = useLocale()
  const lx = t.luaExperience
  const c = lx.diagnostics
  const [health, setHealth] = useState<Health | null>(null)
  const [draft, setDraft] = useState<SettingsInput | null>(null)
  const [busy, setBusy] = useState<'read' | 'refresh' | 'save' | ''>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const alive = useRef(true)
  const requestSequence = useRef(0)

  const read = useCallback(async (refresh = false) => {
    const sequence = ++requestSequence.current
    setBusy(refresh ? 'refresh' : 'read')
    setError('')
    setNotice(false)
    try {
      const result = await invoke<Health>('lua_get_experience_health', { refresh })
      if (!alive.current || sequence !== requestSequence.current) return
      setHealth(result)
      setDraft((current) => current || settingsInput(result.settings))
      setNow(Date.now())
    } catch (cause) {
      if (alive.current && sequence === requestSequence.current) setError(String(cause))
    } finally {
      if (alive.current && sequence === requestSequence.current) setBusy('')
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void read(false)
    // Only age the local observation; never turn this timer into a provider poll.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => { alive.current = false; requestSequence.current += 1; window.clearInterval(timer) }
  }, [read])

  const save = async () => {
    if (!draft) return
    setBusy('save'); setError(''); setNotice(false)
    try {
      const result = await invoke<LuaExperienceSettings>('lua_save_experience_settings', { input: draft })
      if (!alive.current) return
      setDraft(settingsInput(result))
      setHealth((current) => current ? { ...current, settings: result } : current)
      setNotice(true)
      onSettingsSaved?.(result)
    } catch (cause) { if (alive.current) setError(String(cause)) }
    finally { if (alive.current) setBusy('') }
  }

  const reorder = (index: number, delta: number) => setDraft((current) => {
    if (!current || index + delta < 0 || index + delta >= current.providerOrder.length) return current
    const order = [...current.providerOrder]
    ;[order[index], order[index + delta]] = [order[index + delta], order[index]]
    return { ...current, providerOrder: order }
  })
  const label = (value: string) => luaUiLabel(c, value)
  const timestamp = (value: string | null) => value ? new Date(value).toLocaleString(locale) : c.never
  const quota = health?.quotaObservation

  return <section className={`lua-provider-diagnostics${compact ? ' is-compact' : ''}`} aria-label={c.title}>
    <header><div><h3>{c.title}</h3><p>{c.subtitle}</p></div><div className="lpd-actions">
      <button type="button" disabled={Boolean(busy)} onClick={() => void read(false)}>{c.localRead}</button>
      <button type="button" disabled={Boolean(busy) || !health?.providers.find((row) => row.id === 'hubcap')?.configured} onClick={() => void read(true)}>{busy === 'refresh' ? c.refreshing : c.refresh}</button>
    </div></header>
    <p className="lpd-note">{c.notice}</p>
    {error ? <p className="lpd-error" role="alert">{luaErrorText(lx, error)}</p> : null}
    {notice ? <p className="lpd-note" role="status">{c.saved}</p> : null}
    {!health && busy ? <p role="status">{c.loading}</p> : null}
    {health ? <>
      {health.warnings.map((warning) => <p className="lpd-warning" key={warning}>{luaUiLabel(lx.warnings, warning)}</p>)}
      <h4>{c.providers}</h4>
      <div className="lpd-provider-grid">{health.providers.map((provider) => {
        const fresh = freshnessAt(provider.checkedAt, health.settings.healthTtlSeconds, now)
        const last = health.hubcapHistory.find((row) => row.checkedAt === provider.checkedAt)
        const expired = last?.expiresAt && !last.expiryEstimated && Date.parse(last.expiresAt) <= now
        const availability = !provider.enabled ? 'disabled' : expired ? 'unavailable' : fresh !== 'fresh' ? 'unknown' : provider.availability
        return <article key={provider.id} className={`lpd-provider is-${availability}`}>
          <strong>{luaProviderDisplayName(provider.id)}{health.settings.pinnedProvider === provider.id ? ' · 📌' : ''}</strong>
          <span>{label(availability)} · {label(fresh)}</span>
          <small>{provider.configured ? c.configured : c.notConfigured}{!provider.enabled ? ` · ${c.notEnabled}` : ''}</small>
          <small>{c.checked}: {timestamp(provider.checkedAt)}</small>
          {provider.errorCode ? <span>{luaErrorText(lx, provider.errorCode)}</span> : null}
        </article>
      })}</div>
      <details open={!compact}><summary>{c.quota}</summary>
        {quota ? <><p className="lpd-note">{timestamp(quota.checkedAt)} · {label(freshnessAt(quota.checkedAt, health.settings.healthTtlSeconds, now))}. {c.previousQuota}</p>
          <div className="lpd-table-wrap"><table><thead><tr><th>{c.quota}</th><th>{c.used}</th><th>{c.limit}</th><th>{c.remaining}</th></tr></thead><tbody>
            {(['daily', 'single', 'bundle', 'workshop'] as const).map((key) => <tr key={key}><th>{c[key]}</th><td>{quota[key].usage ?? c.unknown}</td><td>{quota[key].limit ?? c.unknown}</td><td>{quota[key].remaining ?? c.unknown}</td></tr>)}
          </tbody></table></div>
          <p>{c.expiry}: {quota.expiresAt ? timestamp(quota.expiresAt) : c.unknown}{quota.expiryEstimated ? ` · ${c.estimated}` : ''}</p>
        </> : <p>{c.noQuota}</p>}
        <details><summary>{c.history}</summary>{health.hubcapHistory.length ? <ol className="lpd-history">{health.hubcapHistory.slice(-8).reverse().map((row, index) => <li key={`${row.checkedAt}-${index}`}><time>{timestamp(row.checkedAt)}</time> · {row.result === 'failed' ? c.unavailable : row.result === 'ready' ? c.ready : c.notConfigured}{row.errorCode ? ` · ${row.errorCode}` : ''}</li>)}</ol> : <p>{c.none}</p>}</details>
      </details>
      <details open={!compact}><summary>{c.capabilities}</summary><div className="lpd-capabilities">{health.capabilities.map((item) => <article key={item.id} className={`is-${item.state}`}>
        <strong>{luaUiLabel(lx.capabilities, item.id)}</strong><span>{label(item.state)}</span><small>{luaUiLabel(lx.reasons, item.reason)}</small>
      </article>)}</div></details>
      <details><summary>{c.identity}</summary><p>{c.build}: {health.steam.build ?? c.unknown} · {health.steam.buildAllowlisted ? c.allowlisted : c.unlisted}</p><p className="lpd-note">{c.channel}: {c.unknown} · {c.manifest}</p><code>{health.steam.binaryFile} · SHA-256: {health.steam.binarySha256 || c.unknown}</code><p className="lpd-note">{c.componentNote}</p>
        <div className="lpd-components">{health.components.map((component) => <article key={component.id}><strong>{component.label}</strong><span>{c.version}: {component.version || c.unknown}</span><small>{c.integrity}: {component.integrityVerified ? c.yes : c.no} · {c.provenance}: {component.provenanceVerified ? c.yes : c.no}</small><code>{c.commit}: {component.immutableCommit || c.unknown}</code><code>{c.hash}: {component.artifactSha256 || c.unknown}</code>{component.canonicalSource ? <small>{component.canonicalSource}</small> : null}</article>)}</div>
      </details>
      <details><summary>{c.policy}</summary>{draft ? <div className="lpd-policy">
        <label>{c.pin}<select value={draft.pinnedProvider || ''} disabled={Boolean(busy)} onChange={(event) => setDraft({ ...draft, pinnedProvider: event.target.value || null })}><option value="">{c.noPin}</option>{draft.providerOrder.map((id) => <option key={id} value={id}>{luaProviderDisplayName(id)}</option>)}</select></label>
        <p className="lpd-note">{c.pinNotice}</p><label>{c.ttl}<input type="number" min={60} max={3600} step={60} value={draft.healthTtlSeconds} disabled={Boolean(busy)} onChange={(event) => setDraft({ ...draft, healthTtlSeconds: Math.max(60, Math.min(3600, Number(event.target.value) || 60)) })} /></label>
        <h4>{c.order}</h4><ol className="lpd-order">{draft.providerOrder.map((id, index) => <li key={id}><span>{luaProviderDisplayName(id)}</span><button type="button" disabled={Boolean(busy) || index === 0} aria-label={`${c.up}: ${luaProviderDisplayName(id)}`} onClick={() => reorder(index, -1)}>↑</button><button type="button" disabled={Boolean(busy) || index === draft.providerOrder.length - 1} aria-label={`${c.down}: ${luaProviderDisplayName(id)}`} onClick={() => reorder(index, 1)}>↓</button></li>)}</ol>
        <button type="button" disabled={Boolean(busy)} onClick={() => void save()}>{c.save}</button>
        <h4>{c.effects}</h4><ul className="lpd-effects"><li>{c.applyNow}</li><li>{c.relaunchGame}</li><li>{c.restartSteam}</li></ul>
      </div> : null}</details>
    </> : null}
  </section>
}
