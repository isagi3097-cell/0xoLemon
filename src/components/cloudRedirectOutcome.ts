export type CloudOperationNotice = { tone: 'success' | 'error' | 'info'; text: string }

/** The bundled engine's queue result is not a per-file save verification. */
export function cloudOperationNotice(
  value: unknown,
  successMessage: string | undefined,
  unconfirmedSyncMessage: string,
  isSyncOperation = false,
): CloudOperationNotice | null {
  const result = value !== null && typeof value === 'object'
    ? value as { success?: unknown; message?: unknown; syncVerification?: unknown }
    : undefined
  if (result?.success === false) {
    return { tone: 'error', text: typeof result.message === 'string' ? result.message : 'Cloud operation failed' }
  }
  // Also fail conservatively with an older backend that omits syncVerification.
  if (isSyncOperation || result?.syncVerification === 'notConfirmed') {
    return { tone: 'info', text: unconfirmedSyncMessage }
  }
  return successMessage ? { tone: 'success', text: successMessage } : null
}
