import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = p => readFile(new URL(p, import.meta.url), 'utf8')
const [app, layout, detail, library, fixture] = await Promise.all([read('../../App.tsx'), read('../../hooks/useLauncherLibraryLayout.ts'), read('./SteamLibraryDetail.tsx'), read('../../components/library.tsx'), read('../ThemeFixture.tsx')])

test('Library add, selection, and persistence contracts', () => {
  for (const value of ['0xo-add-to-library', 'addLauncherLibraryGameIds', 'setSelectedGameId', 'Library']) assert.ok(app.includes(value), value)
  for (const value of ['isTauriRuntime', 'invoke', 'localStorage.getItem', 'localStorage.setItem', '0xo_launcher_library_game_ids_v1', 'setLayout']) assert.ok(layout.includes(value), value)
})

test('Steam detail artwork and seven tabs', () => {
  const ids = ['overview', 'achievements', 'community', 'discussions', 'guides', 'workshop', 'store']
  for (const id of ids) assert.ok(detail.includes(`id: '${id}'`), id)
  for (const value of ['setActiveTab', 'role="tablist"', 'role="tab"', 'aria-selected', 'heroUrl', 'logoUrl', 'coverUrl']) assert.ok(detail.includes(value), value)
  assert.ok((library + fixture).includes('SteamLibraryDetail'))
})

test('keyboard, reduced motion, and safe Steam links', () => {
  for (const value of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'onKeyDown', '.focus(', 'useReducedMotion']) assert.ok(detail.includes(value), value)
  assert.ok(!detail.includes('http://'))
  const urls = detail.match(/https:\/\/[a-z0-9.-]+/gi) || []
  assert.ok(urls.length > 0)
  for (const url of urls) { const host = new URL(url).hostname; const allowed = host.endsWith('.steampowered.com') ? true : (host === 'steamcommunity.com' ? true : host.endsWith('.steamcommunity.com')); assert.ok(allowed, host) }
  assert.ok(detail.includes('onOpenExternal'))
})
