import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { healthRoutes, _resetHealthCache } from '../../api/health/health.routes.js'
import { markDraining, startLoop, _reset } from '../../services/lifecycle.service.js'
import { setLoopLeader } from '../../services/loopLeader.js'

// Liveness and readiness are different questions and the failure mode of conflating them is
// specific: a liveness probe that reports "not ok" during a graceful shutdown gets the container
// RESTARTED, which turns the orderly deploy this whole change exists to enable back into a hard
// kill. So the tests below care mostly about which one answers what, and when.
//
// Both endpoints are reachable without a cookie by necessity — a platform probe has none — so the
// auth boundary is asserted too. Following brokerRoutes.test.js, the router is inspected rather
// than served: nothing in this suite spins an HTTP listener.

const routesOf = router => router.stack
    .filter(l => l.route)
    .map(l => ({ path: l.route.path, methods: Object.keys(l.route.methods).filter(m => l.route.methods[m]) }))

/**
 * Minimal res double, shaped like the chain the handlers actually use:
 * status().set().type().end(). NOT .json() — see the 304 test at the bottom for why that matters.
 */
function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) { res.statusCode = code; return res },
        set(k, v) { res.headers[String(k).toLowerCase()] = v; return res },
        type(t) { res.headers['content-type'] = t; return res },
        end(raw) { res.body = raw ? JSON.parse(raw) : null; return res },
        json(payload) { throw new Error('handlers must not use res.json() — it ETags and 304s') },
    }
    return res
}

beforeEach(() => { _reset(); _resetHealthCache() })

test('both probes are registered on the paths the platform is pointed at', () => {
    assert.deepEqual(routesOf(healthRoutes), [
        { path: '/',      methods: ['get'] },
        { path: '/ready', methods: ['get'] },
    ])
})

test('health carries NO auth layer — a probe has no cookie', () => {
    const guarded = healthRoutes.stack.some(l => l.name === 'requireAuth'
        || l.route?.stack?.some(h => h.name === 'requireAuth'))
    assert.equal(guarded, false)
})

test('liveness reports the registered loop count', () => {
    startLoop('a', { start() {}, stop() {} })
    startLoop('b', { start() {}, stop() {} })

    const res = mockRes()
    healthRoutes.stack.find(l => l.route?.path === '/').route.stack[0].handle({}, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 'ok')
    assert.equal(res.body.loops, 2)
    assert.equal(typeof res.body.uptimeSec, 'number')
})

test('liveness stays 200 while draining — a 503 here would get us RESTARTED mid-shutdown', () => {
    markDraining()

    const res = mockRes()
    healthRoutes.stack.find(l => l.route?.path === '/').route.stack[0].handle({}, res)

    assert.equal(res.statusCode, 200, 'liveness means "do not restart me", not "send me traffic"')
})

test('readiness answers 503 the moment shutdown begins, and asks the database nothing', async () => {
    // The skipped ping is what makes this assertable offline at all — and it is not a test
    // affordance: once shutdown has started, the answer is already 'not ready', so an outbound
    // command against a pool being closed would only log a pointless error.
    markDraining()

    const res = mockRes()
    await healthRoutes.stack.find(l => l.route?.path === '/ready').route.stack[0].handle({}, res)

    assert.equal(res.statusCode, 503)
    assert.equal(res.body.ready, false)
    assert.equal(res.body.draining, true)
    assert.equal(res.body.db, 'skipped')
})

// ── the 304 (found on the first real boot, 2026-08-18) ───────────────────────

test('health responses are UNCACHEABLE — a readiness probe must never 304', async () => {
    // The bug: res.json() makes Express compute an ETag. Liveness carries uptimeSec so its body
    // changes every second and it rarely trips, but the readiness body is byte-identical call to
    // call — so a browser sending If-None-Match got a 304 with NO BODY. A probe checking for
    // exactly 200 reads that as an outage, and anything parsing the JSON gets nothing.
    //
    // Both halves are asserted: no-store (so nothing asks again conditionally) and the fact that
    // the handlers write through .end() rather than .json() — the mock throws on .json(), so
    // reaching this line at all is part of the test.
    for (const path of ['/', '/ready']) {
        const res = mockRes()
        // /ready is async — awaiting matters, or the assert runs before the header is written.
        await healthRoutes.stack.find(l => l.route?.path === path).route.stack[0].handle({}, res)
        assert.equal(res.headers['cache-control'], 'no-store', path)
    }
})

// ── follower vs fault ─────────────────────────────────────────────────────────

test('a FOLLOWER is ready, and says so — zero loops there is correct, not broken', async () => {
    // The distinction this field exists for: zero loops on a FOLLOWER is the lease working, and
    // zero loops on a LEADER is an incident. Same number, opposite meanings, and nothing outside
    // the process can tell them apart without this flag. A follower also stays READY — it serves
    // HTTP perfectly well, so failing it would pull a healthy process out of rotation for doing
    // exactly the right thing.
    setLoopLeader(false)
    const live = mockRes()
    healthRoutes.stack.find(l => l.route?.path === '/').route.stack[0].handle({}, live)
    assert.equal(live.body.leader, false)
    assert.equal(live.body.loops, 0)
    assert.equal(live.statusCode, 200)

    setLoopLeader(true)
    startLoop('a', { start() {}, stop() {} })
    const led = mockRes()
    healthRoutes.stack.find(l => l.route?.path === '/').route.stack[0].handle({}, led)
    assert.equal(led.body.leader, true)
    assert.equal(led.body.loops, 1)
    setLoopLeader(false)
})
