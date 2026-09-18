export type LuaCatalogCountsV1 = { fullCatalogTotal?: number; archiveAvailableCount?: number; currentResultCount: number; fullCatalogAsOf?: number; fullCatalogStale: boolean }
export function mergeLuaCatalogCounts(previous: LuaCatalogCountsV1, page: { totalEstimate: number | null; catalogSource?: string; items: unknown[] }, query: string, now = Date.now()): LuaCatalogCountsV1 {
  const full = !query.trim() && page.catalogSource === 'fullSteamCatalog' && Number.isSafeInteger(page.totalEstimate) && page.totalEstimate! >= 0
  return {
    ...previous,
    fullCatalogTotal: full ? page.totalEstimate! : previous.fullCatalogTotal,
    fullCatalogAsOf: full ? now : previous.fullCatalogAsOf,
    fullCatalogStale: full ? false : query.trim() ? previous.fullCatalogStale : true,
    archiveAvailableCount: page.catalogSource === 'curatedFallback' ? page.totalEstimate ?? undefined : previous.archiveAvailableCount,
    currentResultCount: page.totalEstimate ?? page.items.length,
  }
}
export function loadLuaCatalogCounts(): LuaCatalogCountsV1 {
  const empty = { currentResultCount: 0, fullCatalogStale: true }
  try {
    const value = JSON.parse(localStorage.getItem('0xolemon.lua.fullCatalog.v1') || 'null')
    return value && Number.isSafeInteger(value.fullCatalogTotal) && value.fullCatalogTotal >= 0
      ? { ...empty, fullCatalogTotal: value.fullCatalogTotal, fullCatalogAsOf: value.fullCatalogAsOf } : empty
  } catch { return empty }
}
