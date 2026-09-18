import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudOperationNotice } from './cloudRedirectOutcome.ts'

test('a rejected operation never emits a success notification', () => {
  assert.deepEqual(cloudOperationNotice({ success: false, message: 'failed' }, 'done', 'unconfirmed'), { tone: 'error', text: 'failed' })
})

test('a drained queue is informative, not verified save success', () => {
  assert.deepEqual(cloudOperationNotice({ success: true, syncVerification: 'notConfirmed' }, 'done', 'unconfirmed'), { tone: 'info', text: 'unconfirmed' })
})

test('old sync response cannot bypass verification by omitting the field', () => {
  assert.deepEqual(cloudOperationNotice({ success: true }, 'done', 'unconfirmed', true), { tone: 'info', text: 'unconfirmed' })
})

test('a sync failure takes precedence over its unconfirmed state', () => {
  assert.deepEqual(cloudOperationNotice({ success: false, message: 'network failed', syncVerification: 'notConfirmed' }, 'done', 'unconfirmed', true), { tone: 'error', text: 'network failed' })
})

test('ordinary successful non-sync operations retain their success message', () => {
  assert.deepEqual(cloudOperationNotice({ success: true }, 'saved', 'unconfirmed'), { tone: 'success', text: 'saved' })
})

test('no message requested means no synthetic success notice', () => {
  assert.equal(cloudOperationNotice(null, undefined, 'unconfirmed'), null)
})
