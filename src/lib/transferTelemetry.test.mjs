import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

test('transfer store bounds samples, shares one ticker, freezes pause and stops stale/reduced-motion sampling', async () => {
  const originals = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, now: Date.now, matchMedia: globalThis.matchMedia }
  const timers = new Map(); let next = 0, now = 10000, reduced = false
  globalThis.setInterval = fn => { timers.set(++next, fn); return next }
  globalThis.clearInterval = id => timers.delete(id)
  globalThis.matchMedia = () => ({ matches: reduced })
  Date.now = () => now
  try {
    const js = ts.transpileModule(readFileSync(new URL('./transferTelemetry.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
    const { publishTransfer: publish, readTransfer: read } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
    const base = { transferId: 'one', owner: 'depot', state: 'downloading', updatedAt: now, bytesPerSecond: 200 }
    publish(base); publish({ ...base, transferId: 'two' }); assert.equal(timers.size, 1)
    for (let i = 0; i < 80; i++) for (const fn of timers.values()) fn()
    assert.equal(read('one').samples.length, 45)
    publish({ ...base, state: 'paused' }); const frozen = read('one').samples
    for (const fn of timers.values()) fn()
    assert.strictEqual(read('one').samples, frozen)
    now += 4000; for (const fn of [...timers.values()]) fn(); assert.equal(timers.size, 0)
    publish({ ...base, updatedAt: now, state: 'complete' })
    publish({ ...base, updatedAt: now + 1 }); assert.equal(read('one').samples.length, 0)
    publish({ ...base, updatedAt: now - 1, state: 'failed' }); assert.equal(read('one').telemetry.state, 'downloading')
    reduced = true; publish({ ...base, updatedAt: now + 1 }); assert.equal(timers.size, 0)
    publish({ ...base, transferId: 'percent', bytesPerSecond: undefined, progress: 40 }); assert.equal(read('percent').samples.length, 0)
  } finally {
    globalThis.setInterval = originals.setInterval; globalThis.clearInterval = originals.clearInterval
    Date.now = originals.now
    if (originals.matchMedia) globalThis.matchMedia = originals.matchMedia; else delete globalThis.matchMedia
  }
})
