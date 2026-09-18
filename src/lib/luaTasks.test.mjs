import test from 'node:test'
import assert from 'node:assert/strict'
import { luaTaskControls, parseLuaAppId } from './luaTasks.ts'
test('Lua atomic operations cannot pretend they can pause mid-commit', () => {
  assert.deepEqual(luaTaskControls({status:'running',action:{kind:'luaInstall'}}), [])
  assert.deepEqual(luaTaskControls({status:'running',action:{kind:'workshopDownload'}}), ['pause','cancel'])
})
test('completed and pending-cancel tasks have no duplicate retry controls', () => {
  for (const status of ['completed','cancelled','cancelling','pausing']) assert.deepEqual(luaTaskControls({status,action:{kind:'luaUpdate'}}), [])
  assert.deepEqual(luaTaskControls({status:'failed',action:{kind:'luaUpdate'}}), ['retry','cancel'])
})
test('AppIDs are exact u32s, never paths or imprecise integer values', () => {
  for (const input of ['0','-1','4.8','480junk','../480','4294967296','Infinity',' 480','0480']) assert.equal(parseLuaAppId(input),null,input)
  assert.equal(parseLuaAppId('480'),480)
  assert.equal(parseLuaAppId('4294967295'),4294967295)
})
