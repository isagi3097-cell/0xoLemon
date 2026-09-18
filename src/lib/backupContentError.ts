const BACKUP_CONTENT_MESSAGES: Array<[string, string]> = [
  ['BACKUP_CONTENT_MISSING', 'Backup Game content for this version is not available.'],
  ['BACKUP_ACCESS_DENIED', 'Your Discord sign-in has expired or is missing. Sign in again to download Backup Game content.'],
  ['BACKUP_CONTENT_UNAVAILABLE', 'Backup Game content is temporarily unavailable. Please try again shortly.'],
  ['BACKUP_UPSTREAM_FAILED', 'Backup Game content could not be loaded. Please try again shortly.'],
]

/**
 * Converts broker failures into user-safe text.  A raw transport URL, provider
 * response, or catalog filename must never be surfaced in the install UI.
 */
export function backupContentErrorMessage(error: unknown): string | null {
  const text = String(error ?? '')
  for (const [code, message] of BACKUP_CONTENT_MESSAGES) {
    if (text.includes(code)) return message
  }
  if (/no download server is configured|unable to load (?:catalog|manifest|build-info)\.json/i.test(text)) {
    return 'Backup Game content could not be loaded. Please try again shortly.'
  }
  if (/\b404\b|endpoint not found|BACKUP_CONTENT_NOT_CONFIGURED/i.test(text)) {
    return 'Backup Game service is not deployed or enabled yet. Please try again later.'
  }
  // Never hide an unknown broker/Tauri error behind the generic "temporarily
  // unavailable" text. That made configuration and deployment failures look
  // like transient network failures and sent debugging in the wrong direction.
  if (text.trim()) {
    const normalized = text.replace(/^Error:\s*/i, '').trim()
    return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized
  }
  return null
}
