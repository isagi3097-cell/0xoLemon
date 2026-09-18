export type ProviderQuotaBucket = { used?: number | null; limit?: number | null; remaining?: number | null; resetAt?: string }
export type ProviderQuotaV1 = {
  configured: boolean; valid: boolean; serviceReady: boolean; fetchedAt: number; stale: boolean;
  buckets: { single: ProviderQuotaBucket; bundle: ProviderQuotaBucket; daily: ProviderQuotaBucket };
  errorCode?: string | null;
}
// Compatibility adapter for the settings DTO; UI consumers share one schema.
export function providerQuotaFromKeyState(state: HubcapKeyState): ProviderQuotaV1 {
  const bucket = (value: HubcapKeyState['single']) => ({ used: value.usage, limit: value.limit, remaining: value.remaining })
  const checked = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : NaN
  return { configured: state.configured, valid: state.valid, serviceReady: state.serviceReady,
    fetchedAt: Number.isFinite(checked) ? checked : 0, stale: Boolean(state.lastError) || !Number.isFinite(checked),
    buckets: { single: bucket(state.single), bundle: bucket(state.bundle), daily: bucket(state.daily) }, errorCode: state.lastError }
}
import type { HubcapKeyState } from '../types'
