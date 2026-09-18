import { useState, useEffect, useRef, useCallback } from 'react'
import {
  KeyRound,
  Loader2,
  RefreshCcw,
  ExternalLink,
  Compass,
  ShieldCheck,
  X,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useLocale } from '../context/locale'
import { luaErrorText } from '../lib/luaUiText'
import { HubcapExplorerModal } from './HubcapExplorerModal'
import type {
  HubcapKeyState,
  HubcapHealthResponse,
  HubcapUserStats,
  HubcapDepotKeysSummary,
  LuaSourceSettingsState,
} from '../types'
import './HubcapKeyModal.css'

interface HubcapKeyModalProps {
  isOpen: boolean
  onClose: () => void
  onKeySaved?: () => void
}

export function HubcapKeyModal({ isOpen, onClose, onKeySaved }: HubcapKeyModalProps) {
  const { t } = useLocale()
  const keyInputRef = useRef<HTMLInputElement>(null)

  const [hubcap, setHubcap] = useState<HubcapKeyState | null>(null)
  const [hubcapHealth, setHubcapHealth] = useState<HubcapHealthResponse | null>(null)
  const [hubcapUserStats, setHubcapUserStats] = useState<HubcapUserStats | null>(null)
  const [hubcapDepotKeys, setHubcapDepotKeys] = useState<HubcapDepotKeysSummary | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [showHubcapExplorer, setShowHubcapExplorer] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const sourceState = await invoke<LuaSourceSettingsState>('get_lua_source_settings')
      setHubcap(sourceState.hubcap)

      invoke<HubcapHealthResponse>('get_hubcap_health')
        .then(setHubcapHealth)
        .catch(() => setHubcapHealth(null))

      if (sourceState.hubcap.configured) {
        invoke<HubcapUserStats>('get_hubcap_user_stats')
          .then(setHubcapUserStats)
          .catch(() => setHubcapUserStats(null))
        invoke<HubcapDepotKeysSummary>('get_hubcap_depot_keys_summary')
          .then(setHubcapDepotKeys)
          .catch(() => setHubcapDepotKeys(null))
      }
    } catch (error) {
      console.error('Failed to load Hubcap state:', error)
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      setMessage(null)
      void loadData()
    }
  }, [isOpen, loadData])

  const handleSaveKey = async () => {
    const rawKey = keyInputRef.current?.value.trim() || ''
    if (!rawKey) {
      setMessage({ type: 'error', text: t.settings.hubcapKeyRequired })
      return
    }
    setBusy('save-key')
    setMessage(null)
    try {
      const updated = await invoke<HubcapKeyState>('save_hubcap_api_key', { apiKey: rawKey })
      if (keyInputRef.current) keyInputRef.current.value = ''
      setHubcap(updated)
      setMessage({ type: 'success', text: t.settings.hubcapKeySaved })
      await loadData()
      onKeySaved?.()
    } catch (error) {
      setMessage({ type: 'error', text: luaErrorText(t.luaExperience, error) })
    } finally {
      setBusy(null)
    }
  }

  const handleTestKey = async () => {
    setBusy('test-key')
    setMessage(null)
    try {
      const updated = await invoke<HubcapKeyState>('refresh_hubcap_key_state')
      setHubcap(updated)
      if (updated.valid) {
        setMessage({ type: 'success', text: t.settings.hubcapKeyValid })
      } else if (updated.lastError) {
        setMessage({ type: 'error', text: luaErrorText(t.luaExperience, updated.lastError) })
      } else {
        setMessage({ type: 'error', text: t.settings.hubcapKeyInvalid })
      }
      await loadData()
      onKeySaved?.()
    } catch (error) {
      setMessage({ type: 'error', text: luaErrorText(t.luaExperience, error) })
    } finally {
      setBusy(null)
    }
  }

  const handleClearKey = async () => {
    setBusy('clear-key')
    setMessage(null)
    try {
      await invoke('clear_hubcap_api_key')
      if (keyInputRef.current) keyInputRef.current.value = ''
      await loadData()
      setMessage({ type: 'success', text: t.settings.hubcapKeyCleared })
      onKeySaved?.()
    } catch (error) {
      setMessage({ type: 'error', text: luaErrorText(t.luaExperience, error) })
    } finally {
      setBusy(null)
    }
  }

  if (!isOpen) return null

  return (
    <>
      <div className="hubcap-key-modal-backdrop" onClick={onClose}>
        <div className="hubcap-key-modal-dialog" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="hubcap-key-modal-header">
            <div className="hubcap-key-modal-header-info">
              <div className="hubcap-key-modal-icon-wrap">
                <KeyRound size={20} />
              </div>
              <div className="hubcap-key-modal-title-wrap">
                <h3 className="hubcap-key-modal-title">{t.settings.hubcapApiKey}</h3>
                <p className="hubcap-key-modal-desc">{t.settings.hubcapApiKeyDesc}</p>
              </div>
            </div>
            <div className="hubcap-key-modal-header-actions">
              <span
                className={`hubcap-key-status-badge ${
                  hubcap?.valid ? 'is-online' : hubcap?.configured ? 'is-error' : ''
                }`}
              >
                {hubcap?.configured
                  ? hubcap.maskedKey || t.settings.hubcapConfigured
                  : t.settings.hubcapNotConfigured}
              </span>
              <button
                type="button"
                className="hubcap-key-modal-close-btn"
                onClick={onClose}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Input Row */}
          <div className="hubcap-key-input-row">
            <div className="hubcap-key-input-wrapper">
              <input
                ref={keyInputRef}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={t.settings.hubcapKeyPlaceholder}
                className="hubcap-key-input"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSaveKey()
                }}
              />
            </div>
            <button
              type="button"
              className="hubcap-key-save-btn"
              onClick={() => void handleSaveKey()}
              disabled={Boolean(busy)}
            >
              {busy === 'save-key' ? <Loader2 size={14} className="spin" /> : null}
              {t.settings.saveKey}
            </button>
          </div>

          {/* Action Row */}
          <div className="hubcap-key-action-row">
            <button
              type="button"
              className="hubcap-key-action-btn"
              onClick={() => void handleTestKey()}
              disabled={!hubcap?.configured || Boolean(busy)}
            >
              <RefreshCcw size={14} className={busy === 'test-key' ? 'spin' : ''} />
              {t.settings.testKey}
            </button>
            <button
              type="button"
              className="hubcap-key-action-btn"
              onClick={() => void handleClearKey()}
              disabled={!hubcap?.configured || Boolean(busy)}
            >
              {busy === 'clear-key' ? <Loader2 size={14} className="spin" /> : null}
              {t.settings.clearKey}
            </button>
            <button
              type="button"
              className="hubcap-key-action-btn"
              onClick={() => void openUrl('https://hubcapmanifest.com/')}
            >
              <ExternalLink size={14} />
              {t.settings.openHubcap}
            </button>
            <button
              type="button"
              className="hubcap-key-action-btn is-explorer"
              onClick={() => setShowHubcapExplorer(true)}
            >
              <Compass size={14} />
              Khám Phá Hubcap & Công Cụ
            </button>
          </div>

          {/* Feedback Message */}
          {message && (
            <div className={`hubcap-message-alert is-${message.type}`}>
              {message.type === 'success' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
              <span>{message.text}</span>
            </div>
          )}

          {/* Server Health Status */}
          {hubcapHealth && (
            <div className="hubcap-server-health-row">
              <span
                className={`hubcap-health-indicator-dot ${
                  hubcapHealth.status === 'healthy' ? 'is-healthy' : 'is-down'
                }`}
              />
              <span>
                Server Hubcap: <strong>{hubcapHealth.status.toUpperCase()}</strong> (v
                {hubcapHealth.apiVersion || '1.0'})
              </span>
              {hubcapDepotKeys ? (
                <span>
                  • Đã index: <strong>{hubcapDepotKeys.totalDepotIds.toLocaleString()}</strong> depot keys
                </span>
              ) : null}
            </div>
          )}

          {/* Quota & User Stats Grid */}
          {hubcap?.configured && (
            <div className="hubcap-quota-grid">
              <div className="hubcap-quota-card">
                <span>{t.settings.dailyHubcapQuota}</span>
                <strong>
                  {hubcap.daily.remaining ?? '-'}/{hubcap.daily.limit ?? '-'}
                </strong>
              </div>
              <div className="hubcap-quota-card">
                <span>{t.settings.singleManifestQuota}</span>
                <strong>
                  {hubcap.single.remaining ?? '-'}/{hubcap.single.limit ?? '-'}
                </strong>
              </div>
              <div className="hubcap-quota-card">
                <span>{t.settings.bundleQuota}</span>
                <strong>
                  {hubcap.bundle.remaining ?? '-'}/{hubcap.bundle.limit ?? '-'}
                </strong>
              </div>
              <div className="hubcap-quota-card">
                <span>{t.settings.workshopQuota}</span>
                <strong>
                  {hubcap.workshop.remaining ?? '-'}/{hubcap.workshop.limit ?? '-'}
                </strong>
              </div>
              <div className="hubcap-quota-card">
                <span>{t.settings.serviceStatus}</span>
                <strong>{hubcap.serviceReady ? t.settings.ready : t.settings.unavailable}</strong>
              </div>
              <div className="hubcap-quota-card">
                <span>{t.settings.keyExpiry}</span>
                <strong>
                  {hubcap.expiresAt ? new Date(hubcap.expiresAt).toLocaleString() : t.settings.unknown}
                </strong>
              </div>
              {hubcapUserStats && (
                <>
                  <div className="hubcap-quota-card">
                    <span>Tài khoản</span>
                    <strong>{hubcapUserStats.username || hubcapUserStats.userId || 'User'}</strong>
                  </div>
                  <div className="hubcap-quota-card">
                    <span>Custom Limit</span>
                    <strong>
                      {hubcapUserStats.usingCustomApiLimit
                        ? `${hubcapUserStats.customApiLimit} / ngày`
                        : 'Mặc định'}
                    </strong>
                  </div>
                  <div className="hubcap-quota-card">
                    <span>Auto Update</span>
                    <strong>{hubcapUserStats.autoUpdateEnabled ? 'Bật' : 'Tắt'}</strong>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Security Best Practices */}
          <div className="hubcap-security-box">
            <ShieldCheck size={18} className="hubcap-security-icon" />
            <div className="hubcap-security-content">
              <strong>{t.settings.securityBestPractices}</strong>
              <span>• {t.settings.securityNeverShare}</span>
              <span>• {t.settings.securityStoreSecurely}</span>
              <span>• {t.settings.securityExpiry}</span>
              <span>• {t.settings.securityRevoke}</span>
            </div>
          </div>

          {/* Footer */}
          <div className="hubcap-key-modal-footer">
            <button
              type="button"
              className="hubcap-key-modal-dismiss-btn"
              onClick={onClose}
            >
              {t.luaShop.hubcapManifestKeyDismiss || 'Đóng'}
            </button>
          </div>
        </div>
      </div>

      {/* Sub-modal: Hubcap Explorer & Tools */}
      <HubcapExplorerModal
        isOpen={showHubcapExplorer}
        onClose={() => setShowHubcapExplorer(false)}
      />
    </>
  )
}
