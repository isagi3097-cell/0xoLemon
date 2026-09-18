import { useMemo } from 'react'
import { useCatalogResource } from './useCatalogResource'
import type { GameSummary, GameInstallMetadata, CloudSaveMetadata } from '../types'
import { globalAssetsOverride } from './useRealtimeAssets'
import { normalizeGameVersions } from '../lib/catalogVersions'
import { normalizeLocalRuntime } from '../lib/localRuntime'

const DEFAULT_CLOUD_SAVE: CloudSaveMetadata = {
  enabled: false,
  saveRoots: [],
  include: [],
  exclude: [],
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function normalizeCloudSave(value: unknown): CloudSaveMetadata {
  const raw = recordValue(value)
  if (!raw) return DEFAULT_CLOUD_SAVE
  return {
    enabled: raw.enabled === true,
    saveRoots: stringArray(raw.saveRoots),
    include: stringArray(raw.include),
    exclude: stringArray(raw.exclude),
  }
}

function buildInstall(gameId: string, title: string, raw?: Record<string, unknown>): GameInstallMetadata {
  const storeRoot = 'E:\\0xoLemon store'
  const folderName = title.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim() || gameId
  return {
    defaultStoreRoot: storeRoot,
    defaultInstallFolder: `${storeRoot}\\common\\${folderName}`,
    defaultDownloadingFolder: `${storeRoot}\\downloading\\${folderName}`,
    storageLabel: stringValue(raw?.storageLabel) || 'SSD',
    supportsResume: typeof raw?.supportsResume === 'boolean' ? raw.supportsResume : true,
    launchExecutable: stringValue(raw?.launchExecutable) || `${folderName}.exe`,
  }
}

function normalizeSummary(raw: Record<string, unknown>): GameSummary {
  const gameId = stringValue(raw.id).trim()
  const title = stringValue(raw.title).trim() || gameId
  const assetOverride = globalAssetsOverride[gameId] ?? {}

  const rawLatestVersion = stringValue(raw.latestVersion)
  const cleanedLatestVersion = rawLatestVersion.replace(/\s*-\s*Uploaded\s+\d{4}-\d{2}-\d{2}.*$/, '').trim()
  const allVersionTags = (typeof window !== 'undefined' && window.globalVersionTags) || {}
  const versionTags = allVersionTags[gameId] ?? {}

  return {
    id: gameId,
    appid: typeof raw.appid === 'number' || typeof raw.appid === 'string' ? raw.appid : undefined,
    title,
    subtitle: stringValue(raw.subtitle),
    developer: stringValue(raw.developer),
    publisher: stringValue(raw.publisher),
    latestVersion: cleanedLatestVersion,
    availableVersions: normalizeGameVersions(raw.availableVersions, versionTags),
    gridAssetId: stringValue(assetOverride.grid) || stringValue(raw.gridAssetId),
    heroAssetId: stringValue(assetOverride.hero) || stringValue(raw.heroAssetId),
    logoAssetId: stringValue(assetOverride.logo) || stringValue(raw.logoAssetId),
    iconAssetId: stringValue(assetOverride.icon) || stringValue(raw.iconAssetId),
    install: buildInstall(gameId, title, recordValue(raw.install)),
    cloudSave: normalizeCloudSave(raw.cloudSave),
    ...normalizeLocalRuntime(raw),
    assetPackPath: stringValue(raw.assetPackPath) || `assets/games/${gameId}/core.0xo`,
  }
}

function safeNormalizeSummary(raw: unknown, index: number): GameSummary | null {
  const record = recordValue(raw)
  if (!record) {
    console.error(`[useFirestoreCatalog] Skipping invalid game at index ${index}: expected object`, raw)
    return null
  }
  try {
    const game = normalizeSummary(record)
    if (!game.id) {
      console.error(`[useFirestoreCatalog] Skipping invalid game at index ${index}: missing id`, record)
      return null
    }
    return game
  } catch (error) {
    console.error(`[useFirestoreCatalog] Skipping malformed game at index ${index}:`, error, record)
    return null
  }
}

export function useLegacyCatalog(assetOverrideVersion?: number, generation = 0) {
  const resource = useCatalogResource(`${import.meta.env.VITE_BACKEND_URL || 'https://zeroxolemon-launcher.onrender.com'}/api/0xolemon/catalog`, 'legacyBackend', generation, safeNormalizeSummary)
  return useMemo(() => ({
    ...resource,
    data: resource.data
      ? {
          ...resource.data,
          games: resource.data.games.map((game) => {
            // Re-read the (possibly just-arrived) override for this game every time
            // assetOverrideVersion changes. The initial normalize() pass inside
            // useCatalogResource only runs once, when the catalog fetch resolves —
            // if useRealtimeAssets() resolves *after* that (the common case), the
            // override data must be merged in again here, or grid/hero/logo/icon
            // stay stuck on whatever (often empty) fallback was present at first.
            const override = globalAssetsOverride[game.id]
            if (!override) return game
            return {
              ...game,
              gridAssetId: stringValue(override.grid) || game.gridAssetId,
              heroAssetId: stringValue(override.hero) || game.heroAssetId,
              logoAssetId: stringValue(override.logo) || game.logoAssetId,
              iconAssetId: stringValue(override.icon) || game.iconAssetId,
            }
          }),
        }
      : undefined,
  }), [resource, assetOverrideVersion])
}
