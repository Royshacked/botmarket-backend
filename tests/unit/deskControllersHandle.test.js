import { test } from 'node:test'
import assert from 'node:assert/strict'

import { listResearchQueue, getResearchRun } from '../../api/analyst/analyst.controller.js'
import { getTilt } from '../../api/strategy/strategy.controller.js'

// The analyst queue/run handlers and every strategy handler used to be bare async functions with no
// try/catch — they leaned on the services catching everything, which is true today and one thrown
// read away from a request that never ends (Express 4 does not see an async rejection). They ride
// makeHandle now. What that buys is exactly one thing, and it is what these pin: a throw inside the
// handler reaches `next(err)` instead of nowhere.
//
// The throw is induced with a malformed request rather than a stubbed service, so the test needs no
// seam: a missing `req.query` / `req.params` is a TypeError on the handler's first line.

import { fakeRes } from '../helpers/http.js'
const nextSpy = () => { const calls = []; const next = (e) => calls.push(e); next.calls = calls; return next }

test('analyst: a throw inside a queue handler reaches next(err) — it does not hang the request', async () => {
    const next = nextSpy()
    await listResearchQueue({ /* no query */ }, fakeRes(), next)
    assert.equal(next.calls.length, 1)
    assert.ok(next.calls[0] instanceof TypeError)
})

test('strategy: a throw inside a tilt handler reaches next(err)', async () => {
    const next = nextSpy()
    await getTilt({ /* no params */ }, fakeRes(), next)
    assert.equal(next.calls.length, 1)
    assert.ok(next.calls[0] instanceof TypeError)
})

test('a handler that does not throw answers normally and never calls next', async () => {
    const next = nextSpy()
    const res  = fakeRes()
    await getResearchRun({}, res, next)   // null when no run has happened in this process
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, null)
    assert.equal(next.calls.length, 0)
})
