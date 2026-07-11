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

test('streamAgentResponse: client aborted mid-handler → no `done`, no end', async () => {
    const { req, res } = makeReqRes()
    await streamAgentResponse(req, res, {
        log: '[test]',
        handler: async () => {
            res.emit('close')   // client disconnects → startSseStream aborts the signal
            return { reply: 'ignored' }
        },
    })
    const evs = events(res)
    assert.equal(evs.some(e => e.event === 'done'), false)
    assert.equal(res.ended, false)
})

test('streamAgentResponse: aborted handler that throws → stays silent (no error frame)', async () => {
    const { req, res } = makeReqRes()
    await streamAgentResponse(req, res, {
        log: '[test]',
        handler: async () => { res.emit('close'); throw new Error('post-abort') },
    })
    const evs = events(res)
    assert.equal(evs.some(e => e.event === 'error'), false)
    assert.equal(res.ended, false)
})
