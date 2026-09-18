import type { LuaSourceProvider } from '../types'
import type { enUS } from '../i18n/en-US'

export type LuaSourceType = 'live' | 'locked' | 'hybrid'
export type LuaSourceMeta = {
  provider: LuaSourceProvider
  displayName: string
  sourceType: LuaSourceType
  sourceTypeLabel: string
  stars: number
  rankLabel: string
  summary: string
  details: string
  whenToUse: string
  complementarity: string
}

type SourceCopy = typeof enUS.luaExperience.sourceMetadata
type ProviderIdentity = { provider: LuaSourceProvider; sourceType: LuaSourceType; stars: number }

// Provider IDs and rating/compatibility data are not localized or renamed.
export const LUA_SOURCES_METADATA: Readonly<Record<string, ProviderIdentity>> = {
  hubcap: { provider: 'hubcap', sourceType: 'hybrid', stars: 5 },
  openlua: { provider: 'openLua', sourceType: 'live', stars: 4.5 },
  huggingface: { provider: 'huggingFace', sourceType: 'live', stars: 4 },
  sushi: { provider: 'sushi', sourceType: 'live', stars: 4 },
  githubmirrors: { provider: 'githubMirrors', sourceType: 'locked', stars: 4 },
  steamtools: { provider: 'steamTools', sourceType: 'locked', stars: 3 },
  luie: { provider: 'luie', sourceType: 'live', stars: 4.5 },
  twentytwocloud: { provider: 'twentyTwoCloud', sourceType: 'hybrid', stars: 4.5 },
  skyflare: { provider: 'skyflare', sourceType: 'live', stars: 4 },
  ryuu: { provider: 'ryuu', sourceType: 'hybrid', stars: 4.5 },
}

export function getLuaSourceMeta(provider: string, copy: { sourcesMeta: SourceCopy }): LuaSourceMeta {
  const key = provider.toLowerCase()
  const identity = Object.hasOwn(LUA_SOURCES_METADATA, key) ? LUA_SOURCES_METADATA[key] : undefined
  const sourceType = identity?.sourceType ?? 'live'
  const text = copy.sourcesMeta
  const descriptions: Readonly<Record<string, { displayName: string; summary: string; details: string }>> = text.providers
  const localized = identity ? descriptions[identity.provider] : undefined
  return {
    provider: provider as LuaSourceProvider,
    sourceType,
    stars: identity?.stars ?? 3,
    displayName: localized?.displayName ?? text.fallbackName.replace('{provider}', provider),
    sourceTypeLabel: text.sourceTypes[sourceType],
    rankLabel: text.rankLabel,
    summary: localized?.summary ?? text.fallbackSummary,
    details: localized?.details ?? text.fallbackDetails,
    whenToUse: text.whenToUse,
    complementarity: text.complementarity,
  }
}
