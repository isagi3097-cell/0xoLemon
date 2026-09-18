import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useLocale } from '../context/locale'

type Manifest = { depotId: number; manifestGid: string; os?: string; language?: string }
type Build = { buildId: string; branchNames: string[]; firstSeenAt?: number; observedAt: number; completeness: string; provenance: string; lua: { sha256: string }; manifests: Manifest[]; warnings: string[]; packageSha256?: string }
type Branch = { name: string; buildId: string; updatedAt?: number; passwordRequired: boolean }

export function DepotVersionsPanel({ appId, onSelectBranch }: { appId: number; onSelectBranch?: (name: string, buildId: string, manifests: Map<number, string>) => void }) {
  const { t, locale } = useLocale()
  const [branches, setBranches] = useState<Branch[]>([])
  const [rawDepots, setRawDepots] = useState<Record<string, { manifests?: Record<string, { gid?: string }> }>>({})
  const [builds, setBuilds] = useState<Build[]>([])
  const [error, setError] = useState(false)
  const [generation, refresh] = useState(0)
  const [comparison, setComparison] = useState('')
  const [downloading, setDownloading] = useState<string | null>(null)
  const [cachedPath, setCachedPath] = useState('')
  useEffect(() => {
    let active = true
    setBranches([]); setBuilds([]); setError(false); setComparison(''); setCachedPath('')
    void invoke<{ appinfo: { data: Record<string, { depots: Record<string, unknown> & { branches: Record<string, { buildid?: string; timeupdated?: string; pwdrequired?: string }> } }> } }>('get_depot_steam_snapshot', { appId }).then(result => {
      if (!active) return
      const depots = result.appinfo.data[String(appId)].depots
      setRawDepots(depots as typeof rawDepots)
      setBranches(Object.entries(depots.branches || {}).map(([name, b]) => ({ name, buildId: String(b.buildid || ''), updatedAt: b.timeupdated ? Number(b.timeupdated) * 1000 : undefined, passwordRequired: String(b.pwdrequired || '0') === '1' })))
    }).catch(() => { if (active) setError(true) })
    void invoke<{ builds: Build[] }>('list_depot_archive_versions', { appId }).then(result => { if (active) setBuilds(result.builds || []) }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [appId, generation])
  const selected = builds.find(b => b.buildId === comparison)
  const latest = builds.at(-1)
  const changes = selected && latest ? [...new Set([...selected.manifests, ...latest.manifests].map(m => m.depotId))].filter(id => selected.manifests.find(m => m.depotId === id)?.manifestGid !== latest.manifests.find(m => m.depotId === id)?.manifestGid) : []
  return <section className="steam-direct-game-panel" style={{ padding: 16, marginTop: 16 }}>
    <header><strong>{t.depotArchive.branches}</strong> <button type="button" onClick={() => refresh(g => g + 1)}>{t.depotArchive.refresh}</button></header>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {branches.map(b => <button type="button" key={b.name} disabled={b.passwordRequired || !onSelectBranch} title={b.updatedAt ? new Date(b.updatedAt).toLocaleString(locale) : ''} onClick={() => {
        const manifests = new Map<number, string>()
        for (const [id, depot] of Object.entries(rawDepots)) if (depot.manifests?.[b.name]?.gid) manifests.set(Number(id), String(depot.manifests[b.name].gid))
        onSelectBranch?.(b.name, b.buildId, manifests)
      }}>{b.name} · BuildID {b.buildId}{b.passwordRequired ? ' 🔒' : ''}</button>)}
    </div>
    {/* 0xoLemon Version Archive hidden per user request to avoid UI clutter while preserving logic */}
    <div style={{ display: 'none' }}>
      <h3>{t.depotArchive.archive}</h3>
      {error && <p role="status">{t.catalogRecovery.unavailable}</p>}
      {!builds.length && !error && <p>{t.depotArchive.unknown}</p>}
      <div style={{ overflowX: 'auto' }}><table><thead><tr><th>BuildID</th><th>{t.depotArchive.branches}</th><th>{t.depotArchive.coverage}</th><th>{t.depotArchive.status}</th></tr></thead><tbody>
        {builds.map(b => <tr key={b.buildId}><td><label><input type="radio" name={`compare-${appId}`} checked={comparison === b.buildId} onChange={() => setComparison(b.buildId)} />{b.buildId}</label><br />{new Date(b.observedAt).toLocaleString(locale)}</td>
          <td>{b.branchNames.join(', ')}</td><td>{b.manifests.length} · {[...new Set(b.manifests.map(m => m.os).filter(Boolean))].join(', ')}<br /><code title={b.lua.sha256}>{b.lua.sha256.slice(0, 12)}</code></td>
          <td>{b.provenance === 'hubcapVerified' && b.completeness === 'completeForCoverage' ? t.depotArchive.verified : b.completeness === 'partial' ? t.depotArchive.partial : t.depotArchive.unresolved}
            {b.packageSha256 && <button type="button" disabled={downloading !== null} onClick={async () => {
              setDownloading(b.buildId); setError(false)
              try { const saved = await invoke<{ path: string }>('cache_depot_archive_build', { appId, buildId: b.buildId }); setCachedPath(saved.path) }
              catch { setError(true) } finally { setDownloading(null) }
            }}>{downloading === b.buildId ? t.catalogRecovery.loading : t.depotArchive.downloadPackage}</button>}
          </td></tr>)}
      </tbody></table></div>
      {selected && latest && <p>{t.depotArchive.changedDepots.replace('{count}', String(changes.length))}: {changes.join(', ') || '—'}</p>}
      {cachedPath && <p role="status">{t.depotArchive.cachedPackage}: <code>{cachedPath}</code></p>}
    </div>
  </section>
}
