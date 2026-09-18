import { useLocale } from '../context/locale'
import type { CatalogResource } from '../hooks/useCatalogResource'

export function CatalogStatusBanner({ active, resources, onRetry }: { active: boolean; resources: CatalogResource[]; onRetry: () => void }) {
  const { t, locale } = useLocale()
  if (!active || resources.every(r => r.state === 'ready' || r.state === 'loading')) return null
  const stale = resources.some(r => r.data?.games.length)
  const warming = resources.some(r => r.errorCode === 'CATALOG_WARMING')
  return <aside role="status" style={{ padding: '12px 24px', border: '1px solid var(--border-color, #555)', borderRadius: 8, marginBottom: 12 }}>
    <strong>{stale ? t.catalogRecovery.stale : warming ? t.catalogRecovery.warming : t.catalogRecovery.unavailable}</strong>
    <p>{t.catalogRecovery.description}</p>
    {resources.map(r => <div key={r.source}>
      {r.source === 'primaryBackend' ? t.catalogRecovery.primary : t.catalogRecovery.legacy}: {t.catalogRecovery[r.state]}
      {r.httpStatus ? ` · HTTP ${r.httpStatus}` : ''}
      {r.lastSuccessAt ? ` · ${new Date(r.lastSuccessAt).toLocaleString(locale)}` : ''}
    </div>)}
    <button type="button" onClick={onRetry}>{t.catalogRecovery.retry}</button>
  </aside>
}
