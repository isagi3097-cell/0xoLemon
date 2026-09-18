import type { LuaGameChannel, LuaGameState, LuaSourceProvider } from '../types'
export type LuaTaskStatus = 'queued' | 'running' | 'pausing' | 'cancelling' | 'paused' | 'cancelled' | 'failed' | 'completed'
export type LuaTaskAction =
  | { kind: 'metadataRefresh'; appid: number }
  | { kind: 'workshopDownload'; appid: number; publishedFileId: string; accountApproval?: { accountId: string; updatedAt: number; expectedBytes: number } | null }
  | { kind: 'luaInstall'; appid: number; gameName: string; provider: LuaSourceProvider; channel: LuaGameChannel; buildId: string | null; statSteamId: string | null; conflictResolution: string | null; timezone?: string }
  | { kind: 'luaUpdate'; appid: number; provider: LuaSourceProvider; mode: 'sync' | 'update'; statSteamId: string | null; conflictResolution: string | null; timezone?: string }
  | { kind: 'luaSwitchChannel'; appid: number; provider: LuaSourceProvider; channel: LuaGameChannel; buildId: string | null; conflictResolution: string | null }
export type LuaTask = { taskId: string; action: LuaTaskAction; status: LuaTaskStatus; attempt: number; createdAt: string; updatedAt: string; progress: number | null; errorCode: string | null; receipt: { gameState?: LuaGameState; [key: string]: unknown } | null }
export function luaTaskControls(task: LuaTask): ('pause' | 'resume' | 'cancel' | 'retry')[] {
  switch (task.status) {
    case 'queued': return ['pause', 'cancel']
    case 'paused': return ['resume', 'cancel']
    case 'failed': return ['retry', 'cancel']
    case 'running': return task.action.kind === 'workshopDownload' ? ['pause', 'cancel'] : []
    default: return []
  }
}
export function parseLuaAppId(value: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(value)) return null
  const id = Number(value)
  return id <= 4294967295 ? id : null
}
