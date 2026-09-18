type Candidate = { provider: string; enabled: boolean; available: boolean; onDemand: boolean; requiresKey: boolean; keyReady: boolean; errorCode?: string | null }
export type LuaProviderPolicy = { providerOrder: string[]; pinnedProvider: string | null }

export function usableLuaSource(source: Candidate): boolean {
  return source.enabled && (source.available || source.onDemand)
    && (!source.requiresKey || source.keyReady) && source.errorCode !== 'HUBCAP_KEY_INVALID'
}

export function orderedLuaSources<T extends Candidate>(sources: T[], policy: LuaProviderPolicy): T[] {
  const priorities = new Map(policy.providerOrder.map((name, index) => [name, index]))
  return [...sources].sort((a, b) => (priorities.get(a.provider) ?? 999) - (priorities.get(b.provider) ?? 999))
}

/** A remembered per-game source wins over defaults. An unavailable pin is not permission to fall back. */
export function selectLuaProvider<T extends Candidate>(sources: T[], policy: LuaProviderPolicy, preferred?: string | null): string | null {
  const pinned = preferred ?? policy.pinnedProvider
  if (pinned) return sources.some(source => source.provider === pinned && usableLuaSource(source)) ? pinned : null
  return orderedLuaSources(sources, policy).find(usableLuaSource)?.provider ?? null
}
