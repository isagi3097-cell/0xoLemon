import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'
import { fetchSteamGameInfo, fetchLuaMetadata, seedSteamGameInfo, getCachedSteamGameInfo, steamHeaderImageUrl, cacheLuaImage } from './luaGameInfo.ts'

globalThis.window = {}
afterEach(() => clearMocks())

test('Lua catalog seed renders immediately without global or full metadata IPC', async () => {
  let calls = 0
  mockIPC(() => { calls++; throw new Error('no calls expected') })
  seedSteamGameInfo('700001', { name: 'Seeded', header_image: steamHeaderImageUrl('700001') })
  assert.equal((await fetchSteamGameInfo('700001')).name, 'Seeded')
  assert.equal(calls, 0)
})

test('unseeded cards coalesce a basic Lua command, never full or global metadata', async () => {
  const commands = []
  mockIPC(async (cmd, args) => {
    commands.push([cmd, args])
    await new Promise(resolve => setTimeout(resolve, 20))
    return { data: { name: 'Basic', headerImage: steamHeaderImageUrl('700002') } }
  })
  const results = await Promise.all([fetchSteamGameInfo('700002'), fetchSteamGameInfo('700002')])
  assert.equal(results[0].name, 'Basic')
  assert.deepEqual(commands, [['lua_get_basic_metadata', { appid: 700002, locale: 'english' }]])
})

test('invalid/prototype IDs and malformed catalog values do not invoke or poison cache', async () => {
  let calls = 0
  mockIPC(() => { calls++ })
  for (const id of ['__proto__', 'constructor', '../480', '0', '-1', '4294967296', '480?key=secret']) {
    assert.equal(await fetchSteamGameInfo(id), null)
    assert.throws(() => steamHeaderImageUrl(id), /LUA_INVALID_APPID/)
  }
  seedSteamGameInfo('700003', { name: {}, header_image: 'javascript:alert(1)' })
  assert.equal(getCachedSteamGameInfo('700003'), undefined)
  assert.equal(calls, 0)
})

test('Lua preview rejects arbitrary image origins, credentials and malformed response names', async () => {
  seedSteamGameInfo('700004', { name: 'Safe text', header_image: 'https://evil.example/track.png' })
  assert.equal(getCachedSteamGameInfo('700004').header_image, '')
  seedSteamGameInfo('700005', { name: 'Safe text', header_image: 'https://key@shared.akamai.steamstatic.com/a.jpg' })
  assert.equal(getCachedSteamGameInfo('700005').header_image, '')
  mockIPC(() => ({ data: { name: {}, headerImage: 1 } }))
  assert.equal(await fetchSteamGameInfo('700006'), null)
})

test('full detail preserves locale identity and explicit refresh is not swallowed', async () => {
  const requests = []
  mockIPC(async (_cmd, args) => {
    requests.push(args)
    await new Promise(resolve => setTimeout(resolve, 20))
    return { locale: args.locale, data: { name: 'Deutsch', headerImage: null } }
  })
  await Promise.all([fetchLuaMetadata(700007, 'german', false), fetchLuaMetadata(700007, 'german', true)])
  assert.equal(requests.length, 2)
  assert.deepEqual(requests.map(x => x.refresh), [false, true])
  assert.equal(getCachedSteamGameInfo('700007'), undefined)
})

function imageResponse(url, bytes = Buffer.from('fixture')) {
  const sha256 = 'a'.repeat(64)
  return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, sha256, mime: 'image/png',
    size: bytes.length, fromCache: false, sourceUrl: url, revision: sha256 }
}

test('same artwork URL coalesces IPC and repeated reads reuse memory', async () => {
  const url = steamHeaderImageUrl('800001')
  let release
  let calls = 0
  mockIPC((cmd, args) => {
    assert.equal(cmd, 'lua_cache_image'); assert.equal(args.url, url); calls++
    return new Promise(resolve => { release = () => resolve(imageResponse(url)) })
  })
  const first = cacheLuaImage(url)
  const second = cacheLuaImage(url)
  assert.equal(first, second)
  release()
  const blob = await first
  assert.equal((await cacheLuaImage(url)).dataUrl, blob.dataUrl)
  assert.equal((await cacheLuaImage(url)).fromCache, true)
  assert.equal(calls, 1)
})

test('image failures back off for 120 seconds without a direct-network fallback', async (t) => {
  let clock = Date.now()
  t.mock.method(Date, 'now', () => clock)
  const url = steamHeaderImageUrl('800002')
  let calls = 0
  mockIPC(() => { calls++; throw new Error('HTTP_TIMEOUT') })
  await assert.rejects(cacheLuaImage(url), /HTTP_TIMEOUT/)
  clock += 119_999
  await assert.rejects(cacheLuaImage(url), /LUA_IMAGE_RETRY_BACKOFF/)
  assert.equal(calls, 1)
  clock++
  mockIPC((_cmd, args) => { calls++; return imageResponse(args.url) })
  assert.equal((await cacheLuaImage(url)).sourceUrl, url)
  assert.equal(calls, 2)
})

test('image cache rejects disallowed URLs and malformed IPC fields before caching', async () => {
  let calls = 0
  mockIPC(() => { calls++ })
  for (const url of ['https://evil.example/a.png', 'javascript:alert(1)', 'https://key@shared.akamai.steamstatic.com/a.png', 'https://shared.akamai.steamstatic.com/a.png?token=secret']) {
    await assert.rejects(cacheLuaImage(url), /LUA_IMAGE_URL_NOT_ALLOWED/)
  }
  assert.equal(calls, 0)
  const alterations = [
    { mime: 'text/html' }, { size: 0 }, { size: 5 * 1024 * 1024 }, { sha256: '__proto__' },
    { revision: null }, { fromCache: 'true' }, { sourceUrl: 'https://evil.example/a.png' },
    { dataUrl: 'data:image/png;base64,=AAA' }, { dataUrl: 'data:image/png;base64,AAAA' },
  ]
  for (const [index, alteration] of alterations.entries()) {
    const url = steamHeaderImageUrl(String(810000 + index))
    mockIPC(() => ({ ...imageResponse(url), ...alteration }))
    await assert.rejects(cacheLuaImage(url), /LUA_IMAGE_INVALID_RESPONSE/)
    await assert.rejects(cacheLuaImage(url), /LUA_IMAGE_RETRY_BACKOFF/)
  }
})

test('image TTL expires at ten minutes instead of extending on memory hits', async (t) => {
  let clock = Date.now()
  t.mock.method(Date, 'now', () => clock)
  let calls = 0
  const url = steamHeaderImageUrl('820001')
  mockIPC((_cmd, args) => { calls++; return imageResponse(args.url) })
  await cacheLuaImage(url)
  clock += 599_999
  await cacheLuaImage(url)
  assert.equal(calls, 1)
  clock++
  await cacheLuaImage(url)
  assert.equal(calls, 2)
})

test('image revision remains opaque and is preserved without requiring hash equality', async () => {
  const url = steamHeaderImageUrl('820002')
  mockIPC(() => ({ ...imageResponse(url), revision: 'artwork/revision:42' }))
  assert.equal((await cacheLuaImage(url)).revision, 'artwork/revision:42')
  assert.equal((await cacheLuaImage(url)).revision, 'artwork/revision:42')
})

test('image LRU evicts old records once 32 entries are retained', async () => {
  const calls = new Map()
  mockIPC((_cmd, args) => {
    calls.set(args.url, (calls.get(args.url) ?? 0) + 1)
    return imageResponse(args.url)
  })
  for (let index = 0; index < 33; index++) await cacheLuaImage(steamHeaderImageUrl(String(830000 + index)))
  const newest = steamHeaderImageUrl('830032')
  const oldest = steamHeaderImageUrl('830000')
  await cacheLuaImage(newest)
  assert.equal(calls.get(newest), 1)
  await cacheLuaImage(oldest)
  assert.equal(calls.get(oldest), 2)
})

test('image cache also evicts by its conservative 16 MiB string budget', async () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024)
  const calls = new Map()
  mockIPC((_cmd, args) => {
    calls.set(args.url, (calls.get(args.url) ?? 0) + 1)
    return imageResponse(args.url, bytes)
  })
  const first = steamHeaderImageUrl('840001')
  const second = steamHeaderImageUrl('840002')
  await cacheLuaImage(first)
  await cacheLuaImage(second)
  await cacheLuaImage(second)
  assert.equal(calls.get(second), 1)
  await cacheLuaImage(first)
  assert.equal(calls.get(first), 2)
})

test('image pending requests are bounded and a duplicate can still join at capacity', async () => {
  const releases = []
  let calls = 0
  mockIPC((_cmd, args) => {
    calls++
    return new Promise(resolve => releases.push(() => resolve(imageResponse(args.url))))
  })
  const pending = Array.from({ length: 32 }, (_, index) => cacheLuaImage(steamHeaderImageUrl(String(850000 + index))))
  assert.equal(cacheLuaImage(steamHeaderImageUrl('850000')), pending[0])
  await assert.rejects(cacheLuaImage(steamHeaderImageUrl('850032')), /LUA_IMAGE_QUEUE_FULL/)
  assert.equal(calls, 32)
  releases.forEach(release => release())
  await Promise.all(pending)
})
