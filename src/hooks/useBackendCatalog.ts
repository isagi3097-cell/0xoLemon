import { useMemo } from 'react'
import { useCatalogResource } from './useCatalogResource'
import type { GameSummary, GameInstallMetadata, CloudSaveMetadata } from '../types'
import { normalizeGameVersions } from '../lib/catalogVersions'
import { normalizeLocalRuntime } from '../lib/localRuntime'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://zeroxolemon-launcher.onrender.com'
const TENANT_ID = import.meta.env.VITE_TENANT_ID || '0xolemon1'

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

  const globalAssetsOverride = (typeof window !== 'undefined' && window.globalAssetsOverride) || {}
  const globalVersionTags = (typeof window !== 'undefined' && window.globalVersionTags) || {}
  const assetOverride = {
    grid: globalAssetsOverride[`${gameId}-grid`],
    hero: globalAssetsOverride[`${gameId}-hero`],
    logo: globalAssetsOverride[`${gameId}-logo`],
    icon: globalAssetsOverride[`${gameId}-icon`],
  }
  const versionTags = globalVersionTags[gameId] ?? {}

  return {
    id: gameId,
    appid: typeof raw.appid === 'number' || typeof raw.appid === 'string' ? raw.appid : undefined,
    title,
    subtitle: stringValue(raw.subtitle),
    developer: stringValue(raw.developer),
    publisher: stringValue(raw.publisher),
    latestVersion: stringValue(raw.latestVersion),
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
    console.error(`[useBackendCatalog] Skipping invalid game at index ${index}: expected object`, raw)
    return null
  }
  try {
    const game = normalizeSummary(record)
    if (!game.id) {
      console.error(`[useBackendCatalog] Skipping invalid game at index ${index}: missing id`, record)
      return null
    }
    return game
  } catch (error) {
    console.error(`[useBackendCatalog] Skipping malformed game at index ${index}:`, error, record)
    return null
  }
}

export function useBackendCatalog(assetOverrideVersion?: number, generation = 0) {
  const resource = useCatalogResource(`${BACKEND_URL}/api/${TENANT_ID}/catalog`, 'primaryBackend', generation, safeNormalizeSummary)
  return useMemo(() => ({
    ...resource,
    data: resource.data
      ? {
          ...resource.data,
          games: resource.data.games.map((game) => {
            // Same fix as useFirestoreCatalog: re-read window.globalAssetsOverride
            // every time assetOverrideVersion changes, instead of only merging it
            // once inside the one-shot normalize() call in useCatalogResource.
            const globalAssetsOverride = (typeof window !== 'undefined' && window.globalAssetsOverride) || {}
            const grid = globalAssetsOverride[`${game.id}-grid`]
            const hero = globalAssetsOverride[`${game.id}-hero`]
            const logo = globalAssetsOverride[`${game.id}-logo`]
            const icon = globalAssetsOverride[`${game.id}-icon`]
            if (!grid && !hero && !logo && !icon) return game
            return {
              ...game,
              gridAssetId: stringValue(grid) || game.gridAssetId,
              heroAssetId: stringValue(hero) || game.heroAssetId,
              logoAssetId: stringValue(logo) || game.logoAssetId,
              iconAssetId: stringValue(icon) || game.iconAssetId,
            }
          }),
        }
      : undefined,
  }), [resource, assetOverrideVersion])
}
