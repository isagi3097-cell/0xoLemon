import { useEffect, useMemo, useState } from 'react'
import { useLocale } from '../context/locale'
import { luaErrorText, luaMetadataTransportText, luaUiLabel } from '../lib/luaUiText'
import { cacheLuaImage, fetchLuaMetadata, type LuaMetadataResult } from '../lib/luaGameInfo'
import './LuaWorkspace.css'

export function LuaMetadataPanel({ appId, onInspectApp }: { appId: number; onInspectApp?: (appId: number) => void }) {
  const { locale, t } = useLocale()
  const lx = t.luaExperience
  const vi = locale === 'vi-VN'
  const [result, setResult] = useState<LuaMetadataResult | null>(null)
  const [header, setHeader] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let active = true
    setResult(null); setLoading(true); setError(null); setQuery('')
    void fetchLuaMetadata(appId, vi ? 'vietnamese' : 'english', refresh > 0)
      .then(value => { if (active) setResult(value) })
      .catch(reason => { if (active) setError(String(reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [appId, vi, refresh])
  useEffect(() => {
    let active = true
    setHeader(null)
    const url = result?.data?.headerImage
    if (url) void cacheLuaImage(url).then(image => { if (active) setHeader(image.dataUrl) }).catch(() => { /* Metadata stays usable when an optional image is unavailable. */ })
    return () => { active = false }
  }, [result?.data?.headerImage])
  const achievements = useMemo(() => {
    const search = query.trim().toLowerCase()
    return (result?.data?.achievements ?? []).filter(item => `${item.id} ${item.name ?? ''} ${item.description ?? ''}`.toLowerCase().includes(search))
  }, [result, query])
  const data = result?.data
  return <section className="lua-workspace lua-metadata" aria-label={lx.metadata.luaGameMetadata} aria-busy={loading}>
    <header className="lua-workspace-heading">
      <div><h3>{data?.name || `AppID ${appId}`}</h3><p>{lx.metadata.metadataAchievementsReadOnly}</p></div>
      <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{lx.metadata.refreshMetadata}</button>
    </header>
    {loading && <p role="status">{lx.metadata.readingMetadata}</p>}
    {error && <p className="lua-workspace-error" role="alert">{luaErrorText(lx, error)}</p>}
    {result && <>
      <p className="lua-workspace-note">{lx.status[result.freshness]} · {luaUiLabel(lx.metadataSources, result.winnerProvider ?? '—')} · {lx.common.appId} {appId}
        {result.observedAt ? ` · ${new Date(result.observedAt * 1000).toLocaleString(locale)}` : ''}</p>
      <p className="lua-workspace-note">{luaMetadataTransportText(result, lx)}</p>
      {result.errorCodes.length > 0 && <p className="lua-workspace-error" role="status">{result.errorCodes.map(code => luaErrorText(lx, code)).join(' · ')}</p>}
      {!data && <p>{lx.metadata.noVerifiedMetadataIsAvailableForThis}</p>}
      {data && <>
        {header && <img className="lua-metadata-header-image" src={header} alt="" />}
        <p>{data.shortDescription}</p>
        <p>{luaUiLabel(lx.status, data.appType ?? '—')} · {data.developers.join(', ') || '—'} · {data.publishers.join(', ') || '—'}</p>
        {data.parentAppId && <p>{lx.metadata.dlcBaseGame}: <button type="button" disabled={!onInspectApp} onClick={() => onInspectApp?.(data.parentAppId!)}>AppID {data.parentAppId}</button></p>}
        {data.dlcAppIds.length > 0 && <details><summary>DLC ({data.dlcAppIds.length})</summary><div className="lua-workspace-actions">{data.dlcAppIds.map(id => <button key={id} type="button" disabled={!onInspectApp} onClick={() => onInspectApp?.(id)}>AppID {id}</button>)}</div></details>}
        <details><summary>{lx.metadata.buildsBranchesDepots} ({data.branches.length}/{data.depots.length})</summary>
          <div className="lua-workspace-scroll"><table><thead><tr><th>{lx.common.branch}</th><th>{lx.common.buildId}</th></tr></thead><tbody>{data.branches.map(branch => <tr key={branch.name}><td>{branch.name}</td><td>{branch.buildId ?? '—'}</td></tr>)}</tbody></table>
          <table><thead><tr><th>{lx.common.depot}</th><th>{lx.common.manifest}</th></tr></thead><tbody>{data.depots.map(depot => <tr key={depot.depotId}><td>{depot.depotId} {depot.name}</td><td>{Object.entries(depot.manifests).map(([branch, gid]) => `${branch}: ${gid}`).join('; ') || '—'}</td></tr>)}</tbody></table></div>
        </details>
        <details><summary>{lx.metadata.launchOptionsSaveRoots} ({data.launchOptions.length}/{data.saveRoots.length})</summary>
          <p className="lua-workspace-note">{lx.metadata.metadataReportedPathsLocalSavePresenceIs}</p>
          {data.launchOptions.map((entry, index) => <p key={index}><code>{entry.executable} {entry.arguments}</code> · {entry.osList ?? '—'}</p>)}
          {data.saveRoots.map((entry, index) => <p key={index}><code>{entry.root}/{entry.path}</code> · {entry.pattern ?? '*'}</p>)}
        </details>
        <details><summary>{lx.common.achievementSchema} ({data.achievements.length})</summary>
          <p className="lua-workspace-note">{lx.metadata.schemaCatalogNotYourUnlockStateGlobal}</p>
          <label>{lx.metadata.findAchievement}<input value={query} onChange={event => setQuery(event.target.value)} type="search" /></label>
          <div className="lua-workspace-achievements">{achievements.slice(0, 100).map(item => <article key={item.id}><strong>{item.name ?? item.id}</strong><p>{item.description || lx.metadata.noSchemaDescriptionAvailable}</p><small>{item.id} · {luaUiLabel(lx.metadataSources, item.source)}{item.globalPercent != null ? ` · ${item.globalPercent.toFixed(1)}%` : ''}</small></article>)}</div>
          {achievements.length > 100 && <p>{lx.metadata.showingTheFirst100ResultsNarrowThe}</p>}
        </details>
      </>}
      <details><summary>{lx.metadata.sourcesRevisions}</summary>{result.sourceObservations.map(source => <p key={source.provider}><strong>{luaUiLabel(lx.metadataSources, source.provider)}</strong> · {lx.status[source.freshness]} · <code>{source.revision}</code>{source.errorCode ? ` · ${luaErrorText(lx, source.errorCode)}` : ''}</p>)}</details>
    </>}
  </section>
}
