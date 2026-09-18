import test from 'node:test'
import assert from 'node:assert/strict'
import { selectLuaProvider, orderedLuaSources } from './luaProviderSelection.ts'
const source = (provider, available = true) => ({provider, enabled: true, available, onDemand: false, requiresKey: false, keyReady: true})
test('per-game source cannot silently fall back when unavailable', () => {
  assert.equal(selectLuaProvider([source('hubcap', false), source('openlua')], {providerOrder:['openlua'], pinnedProvider:null}, 'hubcap'), null)
})
test('global pin cannot silently fall back and per-game choice takes precedence', () => {
  const sources = [source('hubcap', false), source('openlua')]
  const policy = {providerOrder:['openlua'], pinnedProvider:'hubcap'}
  assert.equal(selectLuaProvider(sources, policy), null)
  assert.equal(selectLuaProvider(sources, policy, 'openlua'), 'openlua')
})
test('saved ordering is stable and never mutates source inventory', () => {
  const sources = [source('hubcap'), source('openlua'), source('other')]
  assert.deepEqual(orderedLuaSources(sources, {providerOrder:['openlua'], pinnedProvider:null}).map(x=>x.provider), ['openlua','hubcap','other'])
  assert.equal(sources[0].provider, 'hubcap')
})
test('missing required key is not an eligible provider', () => {
  assert.equal(selectLuaProvider([{...source('hubcap'),requiresKey:true,keyReady:false}], {providerOrder:[],pinnedProvider:null}), null)
})
