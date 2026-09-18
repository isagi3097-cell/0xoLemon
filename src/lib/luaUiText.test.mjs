import assert from 'node:assert/strict'
import test from 'node:test'
import { enUS } from '../i18n/en-US.ts'
import { viVN } from '../i18n/vi-VN.ts'
import { luaErrorText, luaMetadataTransportText, luaProviderDisplayName, luaUiLabel } from './luaUiText.ts'
import { getLuaSourceMeta, LUA_SOURCES_METADATA } from './luaSourcesMeta.ts'

function leaves(value, prefix = '', output = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') output[path] = child
    else leaves(child, path, output)
  }
  return output
}

test('Lua experience locale keys and interpolation placeholders have EN/VN parity', () => {
  const en = leaves(enUS.luaExperience), vi = leaves(viVN.luaExperience)
  assert.deepEqual(Object.keys(en).sort(), Object.keys(vi).sort())
  assert.ok(Object.keys(en).length > 300)
  for (const [key, text] of Object.entries(en)) {
    assert.ok(text.trim() && vi[key].trim(), `${key} must be translated`)
    assert.deepEqual(text.match(/\{[A-Za-z]+\}/g) ?? [], vi[key].match(/\{[A-Za-z]+\}/g) ?? [], key)
  }
})

test('display brand for Hubcap is Hubcap Manifest without changing persisted provider identity', () => {
  for (const copy of [enUS, viVN]) {
    const meta = getLuaSourceMeta('hubcap', { sourcesMeta: copy.luaExperience.sourceMetadata })
    assert.equal(meta.provider, 'hubcap')
    assert.equal(meta.displayName, 'Hubcap Manifest')
    assert.equal(meta.sourceType, 'hybrid')
  }
  assert.equal(luaProviderDisplayName('Hubcap'), 'Hubcap Manifest')
  assert.equal(luaProviderDisplayName('hubcap'), 'Hubcap Manifest')
  assert.equal(LUA_SOURCES_METADATA.hubcap.provider, 'hubcap')
  assert.equal(luaProviderDisplayName('unrecognized-id'), 'unrecognized-id')
  assert.equal(luaProviderDisplayName('constructor'), 'constructor')
  assert.equal(luaUiLabel(enUS.luaExperience.status, '__proto__'), '__proto__')
  assert.equal(getLuaSourceMeta('constructor', { sourcesMeta: enUS.luaExperience.sourceMetadata }).displayName, 'Lua source constructor')
})

test('every provider description uses the selected locale and keeps its original capabilities', () => {
  for (const identity of Object.values(LUA_SOURCES_METADATA)) {
    const en = getLuaSourceMeta(identity.provider, { sourcesMeta: enUS.luaExperience.sourceMetadata })
    const vi = getLuaSourceMeta(identity.provider, { sourcesMeta: viVN.luaExperience.sourceMetadata })
    assert.equal(en.provider, vi.provider)
    assert.equal(en.stars, vi.stars)
    assert.equal(en.sourceType, vi.sourceType)
    assert.notEqual(en.summary, vi.summary)
    assert.notEqual(en.details, vi.details)
  }
})

test('task states, task kinds, freshness and independent capability labels are translated', () => {
  for (const key of ['queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'failed', 'completed', 'fresh', 'stale', 'unknown']) {
    assert.notEqual(luaUiLabel(viVN.luaExperience.status, key), key)
  }
  for (const key of ['metadataRefresh', 'workshopDownload', 'luaInstall', 'luaUpdate', 'luaSwitchChannel']) {
    assert.notEqual(luaUiLabel(viVN.luaExperience.taskKind, key), key)
  }
  assert.equal(luaUiLabel(viVN.luaExperience.metadataSources, 'steamKit'), 'SteamKit native')
  assert.match(luaUiLabel(viVN.luaExperience.reasons, 'PUBLIC_STEAM_CONTENT_ONLY_APPROVED_TOOL_REQUIRED'), /công khai/)
})

test('native metadata claim requires an actual fresh successful SteamKit observation', () => {
  const source = { provider: 'steamKit', freshness: 'fresh', errorCode: null }
  for (const copy of [enUS.luaExperience, viVN.luaExperience]) {
    assert.equal(luaMetadataTransportText({ nativeSteamKitAvailable: false, sourceObservations: [] }, copy), copy.metadata.steamcmdHereIsAnHTTPProxySource)
    assert.equal(luaMetadataTransportText({ nativeSteamKitAvailable: true, sourceObservations: [] }, copy), copy.metadata.nativeAvailable)
    assert.equal(luaMetadataTransportText({ nativeSteamKitAvailable: true, sourceObservations: [source] }, copy), copy.metadata.nativeObserved)
    assert.equal(luaMetadataTransportText({ nativeSteamKitAvailable: true, sourceObservations: [{ ...source, errorCode: 'STEAMKIT_FAILURE' }] }, copy), copy.metadata.nativeAvailable)
    assert.equal(luaMetadataTransportText({ nativeSteamKitAvailable: true, sourceObservations: [{ ...source, freshness: 'stale' }] }, copy), copy.metadata.nativeAvailable)
    assert.equal(luaMetadataTransportText({ nativeSteamKitAvailable: false, sourceObservations: [source] }, copy), copy.metadata.steamcmdHereIsAnHTTPProxySource)
  }
})

test('provider errors are localized while exact diagnostic codes remain available', () => {
  const translated = luaErrorText(viVN.luaExperience, 'HUBCAP_RATE_LIMITED')
  assert.match(translated, /Hubcap Manifest/)
  assert.match(translated, /giới hạn/)
  assert.match(translated, /HUBCAP_RATE_LIMITED/)
  assert.match(luaErrorText(enUS.luaExperience, 'LUA_TASK_INTERRUPTED_REVIEW_BEFORE_RETRY'), /review/i)
  assert.match(luaErrorText(viVN.luaExperience, 'steamKit:CM_DISCONNECTED'), /Kết nối metadata với Steam bị ngắt/)
  assert.match(luaErrorText(viVN.luaExperience, 'steamStore:HTTP_TIMEOUT'), /hết thời gian chờ/)
})
