import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useLocale } from '../context/locale'
import { luaErrorText } from '../lib/luaUiText'

export type LuaSteamAccountIdentity = { accountId: string; steamId: string }
type AuthStatus = {
  phase: 'idle' | 'connecting' | 'awaitingConfirmation' | 'saved' | 'failed' | 'cancelled'
  attemptId: string | null; account: LuaSteamAccountIdentity | null
  qrImage: string | null; expiresAt: number | null; errorCode: string | null
}

export function LuaSteamAccount({ onAccountChanged }: { onAccountChanged?: (account: LuaSteamAccountIdentity | null) => void }) {
  const { t, locale } = useLocale()
  const lx = t.luaExperience
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const version = useRef(0)
  const ownedAttempt = useRef<string | null>(null)
  const onChanged = useRef(onAccountChanged)
  useEffect(() => { onChanged.current = onAccountChanged }, [onAccountChanged])
  const active = status?.phase === 'connecting' || status?.phase === 'awaitingConfirmation'
  useEffect(() => {
    mounted.current = true
    const generation = ++version.current
    void invoke<AuthStatus>('lua_get_steam_auth_status').then(value => {
      if (mounted.current && version.current === generation) setStatus(value)
    }).catch(reason => { if (mounted.current && version.current === generation) setError(String(reason)) })
    return () => {
      mounted.current = false; version.current++
      // Only cancel the attempt this component created, never another mounted observer.
      if (ownedAttempt.current) void invoke('lua_cancel_steam_qr_login', { attemptId: ownedAttempt.current }).catch(() => {})
    }
  }, [])
  // The first loaded result may be null after another Lua panel forgot the
  // account. Distinguish "not loaded" from "loaded with no account" as well.
  useEffect(() => { if (status) onChanged.current?.(status.account) }, [status?.account?.accountId, status === null])
  useEffect(() => {
    if (!active || busy) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const generation = version.current
    const poll = async () => {
      try {
        const next = await invoke<AuthStatus>('lua_get_steam_auth_status')
        if (!cancelled && mounted.current && generation === version.current) {
          setStatus(next)
          if (next.phase === 'connecting' || next.phase === 'awaitingConfirmation') timer = setTimeout(() => void poll(), 1000)
          else ownedAttempt.current = null
        }
      } catch (reason) { if (!cancelled && mounted.current) setError(String(reason)) }
    }
    timer = setTimeout(() => void poll(), 500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [active, busy, status?.attemptId])
  const perform = async (operation: 'begin' | 'cancel' | 'disconnect') => {
    const generation = ++version.current
    setBusy(true); setError(null)
    try {
      const next = operation === 'begin'
        ? await invoke<AuthStatus>('lua_begin_steam_qr_login')
        : operation === 'cancel'
          ? await invoke<AuthStatus>('lua_cancel_steam_qr_login', { attemptId: status?.attemptId })
          : await invoke<AuthStatus>('lua_disconnect_steam_workshop')
      if (operation === 'begin' && next.attemptId) {
        if (!mounted.current || generation !== version.current) {
          await invoke('lua_cancel_steam_qr_login', { attemptId: next.attemptId }); return
        }
        ownedAttempt.current = next.attemptId
      } else ownedAttempt.current = null
      if (mounted.current && generation === version.current) setStatus(next)
    } catch (reason) { if (mounted.current && generation === version.current) setError(String(reason)) }
    finally { if (mounted.current && generation === version.current) setBusy(false) }
  }
  return <section className="lua-steam-account" aria-label={lx.steamAccount.title}>
    <h4>{lx.steamAccount.title}</h4>
    <p className="lua-workspace-note">{lx.steamAccount.privacy}</p>
    <p role="status">{status ? lx.steamAccount.phases[status.phase] : lx.steamAccount.loading}</p>
    {status?.account && <p>{lx.steamAccount.savedAccount}: <code>{status.account.steamId}</code></p>}
    {(error || status?.errorCode) && <p role="alert" className="lua-workspace-error">{luaErrorText(lx, error || status!.errorCode!)}</p>}
    {active && status?.qrImage && <div className="lua-steam-qr">
      <img src={status.qrImage} alt={lx.steamAccount.qrAlt} width={256} height={256} />
      <p>{lx.steamAccount.scanInstruction}</p>
      {status.expiresAt && <p>{lx.steamAccount.expires}: {new Date(status.expiresAt * 1000).toLocaleTimeString(locale)}</p>}
    </div>}
    <div className="lua-workspace-actions">
      {!active && <button type="button" disabled={busy || !status} onClick={() => void perform('begin')}>{status?.account ? lx.steamAccount.switchAccount : lx.steamAccount.connect}</button>}
      {active && <button type="button" disabled={busy} onClick={() => void perform('cancel')}>{lx.steamAccount.cancel}</button>}
      {(status?.account || status?.errorCode?.startsWith('LUA_STEAM_AUTH_VAULT_')) && <button type="button" disabled={busy} onClick={() => void perform('disconnect')}>{lx.steamAccount.disconnect}</button>}
    </div>
    <p className="lua-workspace-note">{lx.steamAccount.disconnectNote}</p>
  </section>
}
