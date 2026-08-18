import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { healthRoutes, _resetHealthCache } from '../../api/health/health.routes.js'
import { markDraining, startLoop, _reset } from '../../services/lifecycle.service.js'

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

/** Minimal res double — records status + body the way the handlers actually write them. */
function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) { res.statusCode = code; return res },
        json(payload) { res.body = payload; return res },
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
