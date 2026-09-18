import type { GameSummary } from '../types'

export type RemoteAssetType = 'grid' | 'hero' | 'logo' | 'icon'

const ALLOWED_DIRECT_HOSTS = new Set([
  'cdn2.steamgriddb.com',
  'cdn.steamgriddb.com',
  'cdn.cloudflare.steamstatic.com',
  'shared.cloudflare.steamstatic.com',
  'steamcdn-a.akamaihd.net',
])

export function getRemoteAssetType(assetId: string, game: GameSummary): RemoteAssetType | undefined {
  if (assetId === game.gridAssetId) return 'grid'
  if (assetId === game.heroAssetId) return 'hero'
  if (assetId === game.logoAssetId) return 'logo'
  if (assetId === game.iconAssetId) return 'icon'
  return undefined
}

export function isAllowedDirectImageUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ALLOWED_DIRECT_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

export async function fetchRemoteAssetUrl(assetId: string, game: GameSummary): Promise<string | undefined> {
  if (!getRemoteAssetType(assetId, game)) return undefined
  // Existing official CDN metadata is consumed directly. Generated IDs fall through
  // to the existing local/repository fallback; no relay or browser API credential is used.
  return isAllowedDirectImageUrl(assetId) ? assetId : undefined
}
