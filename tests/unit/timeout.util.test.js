import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withTimeout } from '../../services/timeout.util.js'

test('withTimeout: passes a fast resolve straight through', async () => {
    assert.equal(await withTimeout(Promise.resolve('ok'), 1000), 'ok')
})

test('withTimeout: a rejecting promise surfaces its own error, not the timeout', async () => {
    await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 1000), /boom/)
})

test('withTimeout: rejects a hung promise after ms (caller self-heals)', async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 20), /timed out/)
})

// The monitors relied on the exact string 'check timed out after Nms' before the
// util moved out of monitorUtils — the default label keeps that message unchanged.
test('withTimeout: default label reads "check"', async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 20), /^Error: check timed out after 20ms$/)
})

test('withTimeout: a custom label names the operation (chart render, etc.)', async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 20, 'own-render'), /^Error: own-render timed out after 20ms$/)
})

// A resolved race must not leave the timer pending, or a short-lived process would
// stay alive for the full timeout window after the work is done.
test('withTimeout: clears its timer once the promise settles', async () => {
    const before = process._getActiveHandles?.().length ?? 0
    await withTimeout(Promise.resolve('ok'), 60_000)
    const after = process._getActiveHandles?.().length ?? 0
    assert.ok(after <= before, 'timer should be cleared, leaving no extra handle')
})
