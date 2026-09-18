import type { enUS } from '../i18n/en-US'

export type LuaUiMessages = typeof enUS.luaExperience

/** Localize presentation only. Provider IDs, transport fields and audit bytes stay unchanged. */
export function luaUiLabel(labels: Readonly<Record<string, string>>, value: string, fallback = value): string {
  return Object.hasOwn(labels, value) ? labels[value] : fallback
}

export function luaProviderDisplayName(provider: string): string {
  const names: Readonly<Record<string, string>> = {
    hubcap: 'Hubcap Manifest', huggingface: 'Hugging Face', openlua: 'OpenLua', sushi: 'Sushi',
    githubmirrors: 'GitHub mirrors', steamtools: 'SteamTools', ryuu: 'Ryuu', luie: 'LUIE',
    twentytwocloud: 'DepotBox', skyflare: 'Skyflare',
    empress: 'Empress Fix', lua_tools: 'LuaTools',
  }
  const key = provider.toLowerCase()
  return Object.hasOwn(names, key) ? names[key] : provider
}

export function luaErrorText(copy: LuaUiMessages, value: unknown): string {
  const raw = String(value)
  const code = raw.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)?.[0]
  const message = code ? luaUiLabel(copy.errors, code, '') : ''
  // Retain diagnostic identifiers, never change IDs/URLs or mask a failed operation.
  return message ? `${message} (${code})` : `${copy.common.failed}: ${raw}`
}

export function luaMetadataTransportText(result: {
  nativeSteamKitAvailable: boolean
  sourceObservations: ReadonlyArray<{ provider: string; freshness: string; errorCode: string | null }>
}, copy: LuaUiMessages): string {
  if (result.nativeSteamKitAvailable && result.sourceObservations.some(source => source.provider === 'steamKit' && source.freshness === 'fresh' && !source.errorCode)) {
    return copy.metadata.nativeObserved
  }
  if (result.nativeSteamKitAvailable) return copy.metadata.nativeAvailable
  return copy.metadata.steamcmdHereIsAnHTTPProxySource
}
