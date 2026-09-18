import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useLocale } from '../context/locale'
type Receipt = { candidateId: string; serverCandidateId?: string; appId: number; state: string }
export function DepotArchiveContributions() {
  const { t } = useLocale()
  const [enabled, setEnabled] = useState(false)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true, running = false
    const refresh = async () => {
      if (running) return
      running = true
      try {
        const outbox = await invoke<{ enabled: boolean; receipts: Receipt[] }>('get_depot_archive_outbox')
        if (!active) return
        setEnabled(outbox.enabled); setReceipts(outbox.receipts); setError(false)
        if (outbox.enabled && navigator.onLine) for (const receipt of outbox.receipts.filter(r => ['queued', 'awaitingProviderProof', 'validating'].includes(r.state)).slice(0, 3)) {
          if (!active) break
          try {
            const next = await invoke<Receipt>(receipt.state === 'queued' ? 'submit_depot_archive_candidate' : 'get_depot_archive_candidate_status', { candidateId: receipt.candidateId })
            if (active) setReceipts(rows => rows.map(r => r.candidateId === receipt.candidateId ? next : r))
          } catch { break }
        }
      } catch { if (active) setError(true) } finally { running = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 60000)
    window.addEventListener('online', refresh)
    return () => { active = false; clearInterval(timer); window.removeEventListener('online', refresh) }
  }, [])
  return (
    <div style={{ display: 'none' }}>
      <details style={{ marginTop: 12 }}><summary>{t.depotArchive.contributions} · {receipts.length}</summary>
        <label><input type="checkbox" checked={enabled} onChange={async e => {
          const value = e.target.checked
          try { await invoke('set_depot_archive_enabled', { enabled: value }); setEnabled(value); setError(false) } catch { setError(true) }
        }} />{t.depotArchive.contributions}</label>
        {error && <p role="status">{t.catalogRecovery.unavailable}</p>}
        {receipts.slice(-20).map(r => <p key={r.candidateId}>AppID {r.appId} · {t.depotArchive[r.state as 'queued' | 'awaitingProviderProof' | 'published' | 'alreadyKnown' | 'rejected'] || t.depotArchive.unresolved}</p>)}
      </details>
    </div>
  )
}
