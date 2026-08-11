import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { streamAgentResponse } from '../../api/_shared/sse.util.js'

// Minimal fake req/res that record the SSE frames streamAgentResponse writes, so we can
// assert the done / error / abort control flow of the shared helper without a live server.
function makeReqRes() {
    const res = new EventEmitter()
    res.headers = {}
    res.writes  = []
    res.ended   = false
    res.setHeader   = (k, v) => { res.headers[k] = v }
    res.flushHeaders = () => {}
    res.write = (chunk) => { res.writes.push(chunk); return true }
    res.end   = () => { res.ended = true }
    return { req: new EventEmitter(), res }
}

// Parse `event: X\ndata: {...}\n\n` frames (ignore heartbeat/ping lines).
function events(res) {
    return res.writes
        .join('')
        .split('\n\n')
        .map(block => {
            const ev = block.match(/event: (\w+)/)?.[1]
            const dt = block.match(/data: (.+)/)?.[1]
            return ev ? { event: ev, data: dt ? JSON.parse(dt) : null } : null
        })
        .filter(Boolean)
}

test('streamAgentResponse: success → emits the handler payload as `done` and ends', async () => {
    const { req, res } = makeReqRes()
    await streamAgentResponse(req, res, {
        log: '[test]',
        handler: async ({ sendEvent }) => {
            sendEvent('token', { text: 'hi' })
            return { reply: 'done-reply' }
        },
    })
    const evs = events(res)
    assert.deepEqual(evs.find(e => e.event === 'token').data, { text: 'hi' })
    assert.deepEqual(evs.find(e => e.event === 'done').data, { reply: 'done-reply' })
    assert.equal(res.ended, true)
})

test('streamAgentResponse: undefined payload → sends an empty done object', async () => {
    const { req, res } = makeReqRes()
    await streamAgentResponse(req, res, { log: '[test]', handler: async () => undefined })
    assert.deepEqual(events(res).find(e => e.event === 'done').data, {})
    assert.equal(res.ended, true)
})

test('streamAgentResponse: handler throws → emits `error`, no `done`', async () => {
    const { req, res } = makeReqRes()
    await streamAgentResponse(req, res, {
        log: '[test]',
        handler: async () => { throw new Error('boom') },
    })
    const evs = events(res)
    assert.equal(evs.some(e => e.event === 'done'), false)
    assert.deepEqual(evs.find(e => e.event === 'error').data, { message: 'Streaming failed' })
    assert.equal(res.ended, true)
})

// ─── Walking away is not stopping (2026-08-11) ──────────────────────────────────
//
// These two used to assert the opposite, and that was the bug: `res.close` aborted the model call, so
// leaving a desk mid-answer killed the turn and threw away work the user had already paid for. A closed
// socket now means only "nobody is watching" — the handler runs to completion and its side effects
// (persisting the thread) happen. Nothing is WRITTEN, because there is no one to write to.

test('the client leaving does not abort the turn — the handler finishes and persists', async () => {
    const { req, res } = makeReqRes()
    let ranToCompletion = false
    let sawAbort        = null
    await streamAgentResponse(req, res, {
        log: '[test]',
        handler: async ({ signal }) => {
            res.emit('close')          // the user navigates away mid-answer
            ranToCompletion = true
            sawAbort = signal.aborted  // the gate every controller uses for persistence
            return { reply: 'saved anyway' }
        },
    })
    assert.equal(ranToCompletion, true, 'the turn is still worth finishing')
    assert.equal(sawAbort, false, 'so `signal.aborted` must NOT read as stopped — that gate guards saving')
    // Nothing written: the socket is gone. Silence here is correct; losing the work was not.
    assert.equal(events(res).some(e => e.event === 'done'), false)
})

test('writes after the client leaves are no-ops, not errors on a dead socket', async () => {
    const { req, res } = makeReqRes()
    await streamAgentResponse(req, res, {
        log: '[test]',
        handler: async ({ sendEvent }) => {
            res.emit('close')
            sendEvent('token', { text: 'nobody is listening' })   // must not throw
            return {}
        },
    })
    assert.equal(events(res).some(e => e.event === 'token'), false)
})

test('an explicit stop DOES silence the turn — no done, no end', async () => {
    // The other half of the split: stopping still means stopping. Simulated by aborting the signal the
    // way the turn registry does, rather than by closing the socket.
    const { req, res } = makeReqRes()
    await streamAgentResponse(req, res, {
        log: '[test]',
        handler: async ({ signal }) => {
            // eslint-disable-next-line no-undef
            const ac = signal
            // Reach the same end state stopTurn produces.
            Object.defineProperty(ac, 'aborted', { value: true, configurable: true })
            return { reply: 'ignored' }
        },
    })
    const evs = events(res)
    assert.equal(evs.some(e => e.event === 'done'), false)
    assert.equal(res.ended, false)
})
