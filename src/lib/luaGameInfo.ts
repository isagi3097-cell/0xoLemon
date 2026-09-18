import { invoke } from '@tauri-apps/api/core'

// This module is intentionally separate from steamGameInfo: only Lua surfaces import it.
export type SteamGameInfo = { name: string; header_image: string }
export type SteamStoreSearchItem = { id: number; name: string; header_image?: string }
export type LuaFreshness = 'unknown' | 'fresh' | 'stale'
export type LuaSourceObservation = {
  provider: 'steamStore' | 'steamCmd' | 'steamKit' | 'steamGlobalStats' | 'scopedGseSchema'
  revision: string
  observedAt: number | null
  expiresAt: number | null
  freshness: LuaFreshness
  errorCode: string | null
}
export type LuaAchievement = {
  id: string
  name: string | null
  description: string | null
  iconUrl: string | null
  hidden: boolean
  maximum: number | null
  globalPercent: number | null
  source: string
}
export type LuaMetadata = {
  appId: number
  name: string
  headerImage: string | null
  shortDescription: string | null
  appType: string | null
  developers: string[]
  publishers: string[]
  dlcAppIds: number[]
  parentAppId: number | null
  depots: { depotId: string; name: string | null; manifests: Record<string, string> }[]
  branches: { name: string; buildId: string | null; updatedAt: number | null }[]
  launchOptions: { executable: string; arguments: string | null; osList: string | null; description: string | null }[]
  saveRoots: { root: string; path: string; pattern: string | null }[]
  achievements: LuaAchievement[]
}
export type LuaMetadataResult = {
  appId: number
  locale: string
  data: LuaMetadata | null
  freshness: LuaFreshness
  observedAt: number | null
  expiresAt: number | null
  sourceObservations: LuaSourceObservation[]
  winnerProvider: string | null
  nativeSteamKitAvailable: boolean
  errorCodes: string[]
}
export type LuaCacheHealth = {
  namespace: 'lua_shop'
  metadataEntries: number
  imageEntries: number
  imageBytes: number
  dbBytes: number
  nativeSteamKitAvailable: boolean
}
export type LuaImageBlob = {
  dataUrl: string
  sha256: string
  mime: string
  size: number
  fromCache: boolean
  sourceUrl: string
  revision: string
}

const MAX_CACHE_ENTRIES = 500
const SUCCESS_TTL_MS = 600_000
const FAILURE_TTL_MS = 120_000
const previews = new Map<string, { info: SteamGameInfo; expiresAt: number }>()
const failedUntil = new Map<string, number>()
const pending = new Map<string, Promise<SteamGameInfo | null>>()
const fullPending = new Map<string, Promise<LuaMetadataResult>>()
const MAX_IMAGE_ENTRIES = 32
const MAX_IMAGE_STRING_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_PENDING = 32
const MAX_IMAGE_BODY_BYTES = 4 * 1024 * 1024
const images = new Map<string, { blob: LuaImageBlob; expiresAt: number; stringBytes: number }>()
const imagePending = new Map<string, Promise<LuaImageBlob>>()
const imageFailedUntil = new Map<string, number>()
let imageStringBytes = 0
const artworkHosts = new Set([
  'shared.akamai.steamstatic.com', 'shared.fastly.steamstatic.com', 'shared.cloudflare.steamstatic.com',
  'cdn.akamai.steamstatic.com', 'cdn.cloudflare.steamstatic.com', 'cdn.fastly.steamstatic.com',
  'steamcdn-a.akamaihd.net', 'cdn.steamstatic.com', 'images.steamusercontent.com',
  'avatars.steamstatic.com', 'avatars.akamai.steamstatic.com',
])

function safeArtwork(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !artworkHosts.has(url.hostname) || url.username || url.password || url.port || url.hash) return ''
    const query = [...url.searchParams]
    if (query.length && (query.length !== 1 || query[0][0] !== 't' || !/^\d{1,20}$/.test(query[0][1]))) return ''
    return url.href
  } catch { return '' }
}

function validAppId(value: string | number): number {
  const text = String(value)
  if (!/^[1-9]\d{0,9}$/.test(text)) throw new Error('LUA_INVALID_APPID')
  const id = Number(text)
  if (!Number.isSafeInteger(id) || id > 0xffff_ffff) throw new Error('LUA_INVALID_APPID')
  return id
}

function remember(appid: string, info: SteamGameInfo) {
  previews.delete(appid)
  previews.set(appid, { info, expiresAt: Date.now() + SUCCESS_TTL_MS })
  failedUntil.delete(appid)
  while (previews.size > MAX_CACHE_ENTRIES) {
    const first = previews.keys().next().value
    if (first === undefined) break
    previews.delete(first)
  }
}

export function steamHeaderImageUrl(appid: string) {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${validAppId(appid)}/header.jpg`
}
export function steamCapsuleImageUrl(appid: string) {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${validAppId(appid)}/capsule_231x87.jpg`
}

export function getCachedSteamGameInfo(appid: string): SteamGameInfo | undefined {
  const cached = previews.get(appid)
  if (!cached || cached.expiresAt <= Date.now()) return undefined
  return cached.info
}

export function seedSteamGameInfo(appid: string, info: SteamGameInfo) {
  try { validAppId(appid) } catch { return }
  if (typeof info?.name !== 'string' || !info.name.trim() || getCachedSteamGameInfo(appid)) return
  // Existing catalog names are usable immediately; a card does not trigger full metadata fan-out.
  remember(appid, { name: info.name.trim().slice(0, 4096), header_image: safeArtwork(info.header_image) })
}

export function fetchSteamGameInfo(appid: string): Promise<SteamGameInfo | null> {
  let id: number
  try { id = validAppId(appid) } catch { return Promise.resolve(null) }
  const cached = getCachedSteamGameInfo(appid)
  if (cached) return Promise.resolve(cached)
  if ((failedUntil.get(appid) ?? 0) > Date.now()) return Promise.resolve(previews.get(appid)?.info ?? null)
  const existing = pending.get(appid)
  if (existing) return existing
  if (pending.size >= 128) return Promise.resolve(previews.get(appid)?.info ?? null)
  const request = invoke<LuaMetadataResult>('lua_get_basic_metadata', { appid: id, locale: 'english' })
    .then((result) => {
      if (typeof result?.data?.name !== 'string' || !result.data.name.trim()) throw new Error('LUA_METADATA_UNAVAILABLE')
      const info = { name: result.data.name.trim().slice(0, 4096), header_image: safeArtwork(result.data.headerImage) }
      remember(appid, info)
      return info
    })
    .catch(() => {
      failedUntil.set(appid, Date.now() + FAILURE_TTL_MS)
      while (failedUntil.size > MAX_CACHE_ENTRIES) {
        const first = failedUntil.keys().next().value
        if (first === undefined) break
        failedUntil.delete(first)
      }
      return previews.get(appid)?.info ?? null
    })
    .finally(() => pending.delete(appid))
  pending.set(appid, request)
  return request
}

export function fetchLuaMetadata(appid: number | string, locale = 'english', refresh = false): Promise<LuaMetadataResult> {
  const id = validAppId(appid)
  const key = `${id}:${locale.trim().toLowerCase()}:${refresh}`
  const existing = fullPending.get(key)
  if (existing) return existing
  if (fullPending.size >= 128) return Promise.reject(new Error('LUA_REQUEST_QUEUE_FULL'))
  const request = invoke<LuaMetadataResult>('lua_get_metadata', { appid: id, locale, refresh })
    .then((result) => {
      // Localized detail must not leak into English card cache identity.
      if (result.locale === 'english' && typeof result.data?.name === 'string' && result.data.name.trim()) remember(String(id), {
        name: result.data.name.trim().slice(0, 4096), header_image: safeArtwork(result.data.headerImage),
      })
      return result
    })
    .finally(() => fullPending.delete(key))
  fullPending.set(key, request)
  return request
}

export function getLuaCacheHealth(): Promise<LuaCacheHealth> {
  return invoke('lua_get_cache_health')
}

function evictImage(url: string) {
  const entry = images.get(url)
  if (!entry) return
  imageStringBytes -= entry.stringBytes
  images.delete(url)
}

function validateImageBlob(value: unknown, url: string): LuaImageBlob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LUA_IMAGE_INVALID_RESPONSE')
  const blob = value as Partial<LuaImageBlob>
  if (typeof blob.mime !== 'string' || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.mime)
    || typeof blob.dataUrl !== 'string'
    || blob.dataUrl.length > Math.ceil(MAX_IMAGE_BODY_BYTES / 3) * 4 + 32
    || typeof blob.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(blob.sha256)
    || typeof blob.revision !== 'string' || blob.revision.length < 1 || blob.revision.length > 256
    || typeof blob.size !== 'number' || !Number.isInteger(blob.size) || blob.size < 1 || blob.size > MAX_IMAGE_BODY_BYTES
    || typeof blob.fromCache !== 'boolean' || blob.sourceUrl !== url) throw new Error('LUA_IMAGE_INVALID_RESPONSE')
  const prefix = `data:${blob.mime};base64,`
  if (!blob.dataUrl.startsWith(prefix)) throw new Error('LUA_IMAGE_INVALID_RESPONSE')
  const encoded = blob.dataUrl.slice(prefix.length)
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)
    || (encoded.includes('=') && encoded.indexOf('=') !== encoded.length - padding)
    || encoded.length / 4 * 3 - padding !== blob.size) throw new Error('LUA_IMAGE_INVALID_RESPONSE')
  // Copy only declared fields: untrusted extra properties must not bypass the memory budget.
  return Object.freeze({ dataUrl: blob.dataUrl, sha256: blob.sha256, mime: blob.mime, size: blob.size,
    fromCache: blob.fromCache, sourceUrl: url, revision: blob.revision })
}

export function cacheLuaImage(source: string): Promise<LuaImageBlob> {
  const url = safeArtwork(source)
  if (!url) return Promise.reject(new Error('LUA_IMAGE_URL_NOT_ALLOWED'))
  const clock = Date.now()
  for (const [key, entry] of images) if (entry.expiresAt <= clock) evictImage(key)
  for (const [key, expiresAt] of imageFailedUntil) if (expiresAt <= clock) imageFailedUntil.delete(key)
  const cached = images.get(url)
  if (cached) {
    images.delete(url)
    images.set(url, cached)
    return Promise.resolve({ ...cached.blob, fromCache: true })
  }
  const existing = imagePending.get(url)
  if (existing) return existing
  if ((imageFailedUntil.get(url) ?? 0) > clock) return Promise.reject(new Error('LUA_IMAGE_RETRY_BACKOFF'))
  if (imagePending.size >= MAX_IMAGE_PENDING) return Promise.reject(new Error('LUA_IMAGE_QUEUE_FULL'))
  const request = invoke<unknown>('lua_cache_image', { url })
    .then(value => {
      const blob = validateImageBlob(value, url)
      // Count UTF-16 storage conservatively, including URL/revision strings and record overhead.
      const stringBytes = 2 * (blob.dataUrl.length + blob.sha256.length + blob.mime.length + url.length * 2 + blob.revision.length) + 256
      evictImage(url)
      while (images.size >= MAX_IMAGE_ENTRIES || imageStringBytes + stringBytes > MAX_IMAGE_STRING_BYTES) {
        const oldest = images.keys().next().value
        if (oldest === undefined) break
        evictImage(oldest)
      }
      if (stringBytes <= MAX_IMAGE_STRING_BYTES) {
        images.set(url, { blob, expiresAt: Date.now() + SUCCESS_TTL_MS, stringBytes })
        imageStringBytes += stringBytes
      }
      imageFailedUntil.delete(url)
      return blob
    })
    .catch(error => {
      imageFailedUntil.delete(url)
      imageFailedUntil.set(url, Date.now() + FAILURE_TTL_MS)
      while (imageFailedUntil.size > MAX_CACHE_ENTRIES) {
        const oldest = imageFailedUntil.keys().next().value
        if (oldest === undefined) break
        imageFailedUntil.delete(oldest)
      }
      throw error
    })
    .finally(() => imagePending.delete(url))
  imagePending.set(url, request)
  return request
}
