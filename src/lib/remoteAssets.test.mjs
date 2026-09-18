import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import ts from 'typescript'

const source = fs.readFileSync(new URL('./remoteAssets.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')
const { fetchRemoteAssetUrl, getRemoteAssetType, isAllowedDirectImageUrl } = await import(moduleUrl)

const game = {
  gridAssetId: 'https://cdn2.steamgriddb.com/grid/a.png',
  heroAssetId: 'https://cdn.steamgriddb.com/hero/b.png',
  logoAssetId: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1/logo.png',
  iconAssetId: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1/icon.png',
}

test('maps grid, hero, logo, and icon IDs explicitly', () => {
  assert.equal(getRemoteAssetType(game.gridAssetId, game), 'grid')
  assert.equal(getRemoteAssetType(game.heroAssetId, game), 'hero')
  assert.equal(getRemoteAssetType(game.logoAssetId, game), 'logo')
  assert.equal(getRemoteAssetType(game.iconAssetId, game), 'icon')
  assert.equal(getRemoteAssetType('unknown', game), undefined)
})

test('accepts only HTTPS URLs on official direct image hosts', () => {
  for (const url of [
    'https://cdn2.steamgriddb.com/grid/a.png',
    'https://cdn.steamgriddb.com/hero/a.png',
    'https://cdn.cloudflare.steamstatic.com/steam/apps/1/a.jpg',
    'https://shared.cloudflare.steamstatic.com/store_item_assets/a.jpg',
    'https://steamcdn-a.akamaihd.net/steam/apps/1/a.jpg',
  ]) assert.equal(isAllowedDirectImageUrl(url), true, url)
})

test('rejects relay, Firebase, arbitrary, malformed, and non-HTTPS values', () => {
  for (const value of [
    'https://example-relay.onrender.com/image',
    'https://example.firebaseio.com/assets/a.json',
    'https://example.firebaseapp.com/a.png',
    'https://images.example.com/a.png',
    'http://cdn2.steamgriddb.com/grid/a.png',
    'not a url',
    '',
  ]) assert.equal(isAllowedDirectImageUrl(value), false, value)
})

test('returns direct metadata for every category and falls back when unresolved', async () => {
  for (const assetId of Object.values(game)) assert.equal(await fetchRemoteAssetUrl(assetId, game), assetId)
  assert.equal(await fetchRemoteAssetUrl('generated-local-placeholder-id', game), undefined)
  const rejected = { ...game, gridAssetId: 'https://example-relay.onrender.com/grid.png' }
  assert.equal(await fetchRemoteAssetUrl(rejected.gridAssetId, rejected), undefined)
})
