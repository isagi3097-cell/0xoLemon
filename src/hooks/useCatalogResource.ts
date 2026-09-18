import { useEffect, useState } from 'react'
import type { GameCatalog } from '../types'

export type CatalogResourceState = 'loading' | 'ready' | 'stale' | 'error'
export type CatalogResource = {
  state: CatalogResourceState; data?: GameCatalog; generation: number;
  source: 'primaryBackend' | 'legacyBackend'; attempt: number;
  fetchedAt?: number; lastSuccessAt?: number; nextRetryAt?: number;
  errorCode?: string; httpStatus?: number;
}
const MAX_AGE = 7 * 86400000
async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
  function abort() { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
  signal.addEventListener('abort', abort, { once: true })
})

// A generation owns its requests, timers and cache writes. Late generations
// cannot replace a newer catalog or erase the last successfully validated copy.
export function useCatalogResource(url: string, source: CatalogResource['source'], generation: number,
  normalize: (raw: unknown, index: number) => GameCatalog['games'][number] | null) {
  const [resource, setResource] = useState<CatalogResource>({ state: 'loading', source, generation, attempt: 0 })
  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    const key = `0xolemon.catalog.v1:${url}`
    let good: GameCatalog | undefined
    let lastSuccessAt: number | undefined
    let settled = false
    const publish = (state: CatalogResourceState, extra: Partial<CatalogResource> = {}) => {
      if (!signal.aborted) setResource({ state, source, generation, attempt: 0, data: good, lastSuccessAt, ...extra })
    }
    publish('loading')
    const warming = setTimeout(() => {
      if (!settled) publish(good ? 'stale' : 'error', { errorCode: 'CATALOG_WARMING' })
    }, 8000)
    const deadline = setTimeout(() => controller.abort(), 65000)
    void (async () => {
      try {
        const cached = JSON.parse(localStorage.getItem(key) || 'null')
        if (cached?.schemaVersion === 1 && Array.isArray(cached.data?.games) && cached.data.games.length
          && (Date.now() - cached.savedAt <= MAX_AGE || !navigator.onLine)
          && await hash(JSON.stringify(cached.data)) === cached.hash) {
          good = cached.data; lastSuccessAt = cached.savedAt; publish('stale')
        }
      } catch { /* A damaged/unavailable cache must not block the network. */ }
      for (let attempt = 1; attempt <= 3 && !signal.aborted; attempt++) {
        let status: number | undefined
        let retryMs = 1000 * 2 ** attempt
        let code = 'CATALOG_NETWORK_ERROR'
        try {
          const response = await fetch(url, { signal, headers: { Accept: 'application/json' } })
          status = response.status
          if (!response.ok) {
            code = status === 429 ? 'CATALOG_RATE_LIMITED' : `CATALOG_HTTP_${status}`
            const retry = response.headers.get('Retry-After')
            if (retry) retryMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())
            throw new Error(code)
          }
          const payload = await response.json()
          if (!Array.isArray(payload.games)) { code = 'CATALOG_INVALID_PAYLOAD'; throw new Error(code) }
          const games = payload.games.map(normalize).filter(Boolean) as GameCatalog['games']
          if (payload.games.length && !games.length) { code = 'CATALOG_INVALID_PAYLOAD'; throw new Error(code) }
          const data: GameCatalog = { defaultLocale: typeof payload.defaultLocale === 'string' ? payload.defaultLocale : 'en-US', games }
          if (signal.aborted) return
          good = data; lastSuccessAt = Date.now(); settled = true
          publish('ready', { attempt, fetchedAt: lastSuccessAt })
          if (games.length) {
            const digest = await hash(JSON.stringify(data))
            if (!signal.aborted) {
              try { localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, savedAt: lastSuccessAt, hash: digest, data })) } catch { /* storage quota is non-fatal */ }
            }
          }
          return
        } catch {
          if (signal.aborted) return
          const retryable = !status || status === 429 || status >= 500
          retryMs += Math.floor(Math.random() * 500)
          publish(good ? 'stale' : 'error', { attempt, errorCode: code, httpStatus: status,
            nextRetryAt: retryable && attempt < 3 ? Date.now() + retryMs : undefined })
          if (!retryable || attempt === 3) { settled = true; return }
          try { await delay(retryMs, signal) } catch { return }
        }
      }
    })().finally(() => { clearTimeout(warming); clearTimeout(deadline) })
    const onAbort = () => {
      if (!settled) setResource(current => current.generation === generation
        ? { ...current, state: good ? 'stale' : 'error', errorCode: 'CATALOG_TIMEOUT', nextRetryAt: undefined } : current)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return () => { signal.removeEventListener('abort', onAbort); controller.abort(); clearTimeout(warming); clearTimeout(deadline) }
  }, [url, source, generation, normalize])
  return resource
}
