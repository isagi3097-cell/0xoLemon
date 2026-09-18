import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8')
test('Lua production modules cannot import Store/local install orchestration', () => {
  for (const name of ['lua_experience/mod.rs','lua_experience/metadata.rs','lua_experience/store.rs','lua_task_queue.rs','lua_workshop.rs','lua_steam_auth.rs','lua_experience_policy.rs']) {
    const source = read(`../../src-tauri/src/${name}`)
    assert.doesNotMatch(source,/crate::(?:job|depot_downloader|process_manager)::/, name)
  }
  for (const name of ['LuaWorkspace','LuaMetadataPanel','LuaWorkshopSettings','LuaSteamAccount','LuaProviderDiagnostics']) {
    assert.doesNotMatch(read(`../components/${name}.tsx`),/from\s+['"][^'"]*(?:storeSearch|steamGameInfo|downloads|App)['"]/, name)
  }
})
test('Lua metadata consumer is mounted in Lua Shop, not the shared Store adapter', () => {
  const shop = read('../components/LuaShop.tsx')
  assert.match(shop,/from ['"]\.\.\/lib\/luaGameInfo['"]/)
  assert.match(shop,/<LuaWorkspace\s/)
  assert.doesNotMatch(read('./steamGameInfo.ts'),/lua_get_metadata|lua_get_basic_metadata|lua_experience/)
  assert.doesNotMatch(read('../App.tsx'),/LuaWorkspace|lua_enqueue_task|lua_experience/)
})
test('Lua source confirm enqueues intent and does not claim installation success or force Steam restart', () => {
  const shop = read('../components/LuaShop.tsx')
  const confirm = shop.slice(shop.indexOf('const handleSourceConfirm'), shop.indexOf('const handleRemove'))
  assert.match(confirm,/'lua_enqueue_task'/)
  assert.doesNotMatch(confirm,/performRestart\(|addToSteamSuccess|setInstalledLuas|invoke<LuaGameState>/)
  const queue = read('../../src-tauri/src/lua_task_queue.rs')
  assert.match(queue,/restart_steam_if_needed:\s*false/)
})
