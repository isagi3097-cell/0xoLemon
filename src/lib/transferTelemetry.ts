export type TransferTelemetryV1 = {
  transferId: string; owner: 'store' | 'depot' | 'launcherUpdate' | 'lua' | 'resource' | 'cloudSave' | 'translation';
  state: 'queued' | 'resolving' | 'downloading' | 'paused' | 'verifying' | 'complete' | 'failed';
  phaseLabel?: string; downloadedBytes?: number; totalBytes?: number; bytesPerSecond?: number;
  peakBytesPerSecond?: number; etaSeconds?: number; progress?: number; updatedAt: number;
}
type WaveState = { telemetry: TransferTelemetryV1; samples: number[] }
const states = new Map<string, WaveState>()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
function notify() { listeners.forEach(fn => fn()) }
function sampleable(value: WaveState) {
  return value.telemetry.state === 'downloading' && value.telemetry.bytesPerSecond !== undefined
    && Number.isFinite(value.telemetry.bytesPerSecond) && value.telemetry.bytesPerSecond >= 0
    && Date.now() - value.telemetry.updatedAt >= 0 && Date.now() - value.telemetry.updatedAt < 3000
    && !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
}
function tick() {
  let changed = false
  for (const [id, value] of states) {
    if (!sampleable(value)) continue
    const speed = value.telemetry.bytesPerSecond
    if (speed !== undefined && Number.isFinite(speed) && speed >= 0 && Date.now() - value.telemetry.updatedAt < 3000) {
      states.set(id, { ...value, samples: [...value.samples.slice(-44), speed] }); changed = true
    }
  }
  if (changed) notify()
  if (![...states.values()].some(sampleable)) { clearInterval(timer); timer = undefined }
}
export function publishTransfer(telemetry: TransferTelemetryV1) {
  if (!telemetry.transferId || !Number.isFinite(telemetry.updatedAt)) return
  const previous = states.get(telemetry.transferId)
  if (previous && previous.telemetry.updatedAt > telemetry.updatedAt) return
  const restart = previous && ['complete', 'failed'].includes(previous.telemetry.state) && !['complete', 'failed'].includes(telemetry.state)
  states.set(telemetry.transferId, { telemetry, samples: restart ? [] : previous?.samples || [] })
  // Retain only a bounded amount of finished telemetry across long sessions.
  if (states.size > 64) for (const [id, value] of states) { if (['complete', 'failed'].includes(value.telemetry.state) && id !== telemetry.transferId) { states.delete(id); if (states.size <= 64) break } }
  if (!timer && sampleable(states.get(telemetry.transferId)!)) timer = setInterval(tick, 280)
  if (timer && ![...states.values()].some(sampleable)) { clearInterval(timer); timer = undefined }
  notify()
}
export const subscribeTransfers = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const readTransfer = (id: string) => states.get(id)
