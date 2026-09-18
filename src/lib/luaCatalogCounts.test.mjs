import test from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('./luaCatalogCounts.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { mergeLuaCatalogCounts } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
test('fallback and search totals never overwrite the full catalog', () => {
  let state = mergeLuaCatalogCounts({ currentResultCount: 0, fullCatalogStale: true }, { catalogSource: 'fullSteamCatalog', totalEstimate: 184576, items: [] }, '', 10)
  state = mergeLuaCatalogCounts(state, { catalogSource: 'curatedFallback', totalEstimate: 334, items: [] }, '', 20)
  assert.equal(state.fullCatalogTotal, 184576)
  assert.equal(state.archiveAvailableCount, 334)
  assert.equal(state.fullCatalogStale, true)
  state = mergeLuaCatalogCounts(state, { catalogSource: 'backend', totalEstimate: 100, items: [] }, 'among us', 30)
  assert.equal(state.fullCatalogTotal, 184576)
  assert.equal(state.currentResultCount, 100)
  state = mergeLuaCatalogCounts(state, { catalogSource: 'fullSteamCatalog', totalEstimate: 184580, items: [] }, '', 40)
  assert.equal(state.fullCatalogTotal, 184580)
  assert.equal(state.fullCatalogStale, false)
})

test('unmarked backend totals and invalid numbers cannot poison a saved full total', () => {
  const previous = { fullCatalogTotal: 184576, currentResultCount: 0, fullCatalogStale: false }
  for (const page of [{ catalogSource: 'backend', totalEstimate: 100 }, { catalogSource: 'fullSteamCatalog', totalEstimate: -1 }, { catalogSource: 'fullSteamCatalog', totalEstimate: NaN }]) {
    assert.equal(mergeLuaCatalogCounts(previous, { ...page, items: [] }, '').fullCatalogTotal, 184576)
  }
})
