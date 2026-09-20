// Discovery runs when an admin asks, and at no other time.
//
// Every other leg of the engine is a data fetch on a schedule. This one is an Opus call
// with web search per selected event plus several hundred SEC requests, so it is the only
// part whose cost scales with how often it fires — which is why it is off the scheduler
// (scheduler.py's six jobs do not include it) and behind requireAdmin.
//
// The two properties worth guarding are the ones that cost money if they slip: a second
// press while a run is in flight must not start a second run, and the spend dial must be
// clamped whatever arrives in the body.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aetherSchedulerService, _onEngineLine, _onDiscoveryExit, DISCOVERY_EVENT } from '../../services/aetherScheduler.service.js'
import { _register, _unregister } from '../../api/chat/chatWs.js'
import { startDiscovery as _startDiscovery, getDiscoveryStatus } from '../../api/aether/aether.controller.js'
import { errorHandler } from '../../api/_shared/handle.util.js'
import { httpError } from '../../services/httpError.util.js'
import { fakeRes } from '../helpers/http.js'

// The controller rides makeHandle: a throw goes to next(err), and the global handler answers. The
// test runs the same pipe the server does, so what it asserts is what the client gets.
const startDiscovery = (req, res) => _startDiscovery(req, res, err => errorHandler(err, { method: 'POST', originalUrl: '/api/aether/discover' }, res, () => {}))

/** Swap runDiscovery for a spy, restore afterwards. */
async function withRunner(impl, fn) {
    const real = aetherSchedulerService.runDiscovery
    const calls = []
    aetherSchedulerService.runDiscovery = opts => { calls.push(opts); return impl(opts) }
    try {
        await fn(calls)
    } finally {
        aetherSchedulerService.runDiscovery = real
    }
}

const ok = () => ({ startedAt: '2026-09-09T00:00:00.000Z', pid: 1234 })

test('a run starts and answers 202 — started, never finished', async () => {
    // A run takes minutes. Answering 200 with a result would mean holding the request
    // open for the whole EDGAR pass, and the honest answer is that it is going.
    await withRunner(ok, async () => {
        const res = fakeRes()
        await startDiscovery({ body: {}, user: { username: 'roy_shacked' } }, res)
        assert.equal(res.statusCode, 202)
        assert.equal(res.body.started, true)
        assert.equal(res.body.pid, 1234)
    })
})

test('a second press while one is in flight is 409, not a second run', async () => {
    // The selector reads recently-run subjects from Mongo at start-up, so a concurrent
    // run would re-pick the first one's events before it had written any of them — and
    // pay for each of them twice.
    // The STATUS rides on the error (runDiscovery mints it with httpError); the controller no longer
    // regexes the sentence to decide between 409 and 503.
    await withRunner(() => { throw httpError(409, 'a discovery run is already in flight') }, async () => {
        const res = fakeRes()
        await startDiscovery({ body: {}, user: {} }, res)
        assert.equal(res.statusCode, 409)
        assert.match(res.body.error, /already in flight/)
    })
})

test('no engine on this host is 503, not 409', async () => {
    // Different problem, different answer: "already going" invites a retry in a minute,
    // "no engine here" never will be.
    await withRunner(() => { throw httpError(503, 'AETHER_ENGINE_PATH not set — no engine on this host') },
        async () => {
            const res = fakeRes()
            await startDiscovery({ body: {}, user: {} }, res)
            assert.equal(res.statusCode, 503)
        })
})

test('a throw with NO minted status is a real fault — 500, and in production the sentence stays inside', async () => {
    const saved = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
        await withRunner(() => { throw new Error('ENOMEM: spawn failed with internals in the message') }, async () => {
            const res = fakeRes()
            await startDiscovery({ body: {}, user: {} }, res)
            assert.equal(res.statusCode, 500)
            assert.equal(res.body.error, 'Internal server error')
        })
    } finally {
        if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved
    }
})

test('maxRuns is clamped — it is the spend dial, not a preference', async () => {
    // --max-runs multiplies BOTH the model cost and the SEC traffic, per event.
    await withRunner(ok, async calls => {
        await startDiscovery({ body: { maxRuns: 500 }, user: {} }, fakeRes())
        assert.equal(calls[0].maxRuns, 10)
    })
    await withRunner(ok, async calls => {
        await startDiscovery({ body: { maxRuns: 0 }, user: {} }, fakeRes())
        assert.equal(calls[0].maxRuns, 5, 'zero is not a request for nothing, it is a missing value')
    })
})

test('a junk body falls back to the defaults rather than NaN', async () => {
    await withRunner(ok, async calls => {
        await startDiscovery({ body: { maxRuns: 'lots', hours: null, top: undefined }, user: {} }, fakeRes())
        // maxRuns = top: a press runs what the selector picked, nothing deferred (2026-09-20).
        assert.deepEqual(calls[0], { maxRuns: 5, hours: 168, top: 5 })
    })
})

test('a missing body does not throw', async () => {
    // requireAdmin runs before this, but a POST with no JSON body still reaches it.
    await withRunner(ok, async calls => {
        const res = fakeRes()
        await startDiscovery({ user: {} }, res)
        assert.equal(res.statusCode, 202)
        assert.equal(calls[0].hours, 168)
    })
})

test('hours is clamped to a week', async () => {
    await withRunner(ok, async calls => {
        await startDiscovery({ body: { hours: 10_000 }, user: {} }, fakeRes())
        assert.equal(calls[0].hours, 168)
    })
})

test('status reports no run and no history on a fresh process', async () => {
    const res = fakeRes()
    await getDiscoveryStatus({}, res)
    assert.equal(res.body.running, false)
    assert.equal(res.body.last, null)
})

test('the scheduler does not run discovery itself', async () => {
    // scheduler.py keeps the queues fresh and stops there. If discovery ever joins that
    // job table, this trigger becomes a way to pay twice for the same events.
    assert.equal(typeof aetherSchedulerService.runDiscovery, 'function')
    assert.equal(typeof aetherSchedulerService.discoveryStatus, 'function')
})

// ── capability, not identity ─────────────────────────────────────────────────
//
// There are two admins on two different hosts: one with a local aether-engine checkout,
// one using the deployed app. Discovery spawns a Python process on the SERVER's own
// filesystem, so what decides whether a run is possible is the host — never the person.
//
// Gating on the person would be wrong in both directions at once: it would offer the run
// to whoever it named while they were on the deployed app, where nothing can be spawned,
// and withhold it from a second admin whose local checkout works.

test('status reports whether THIS host can run a discovery', async () => {
    const res = fakeRes()
    await getDiscoveryStatus({}, res)
    assert.equal(typeof res.body.available, 'boolean')
})

test('an unavailable host says why, in words worth reading', async () => {
    // "no engine on this host" and "no engine venv at <path>" are different problems with
    // different fixes; a boolean would collapse them.
    const real = aetherSchedulerService.discoveryStatus
    aetherSchedulerService.discoveryStatus = () => ({
        running: false, available: false,
        unavailableReason: 'no engine on this host — AETHER_ENGINE_PATH is not set',
    })
    try {
        const res = fakeRes()
        await getDiscoveryStatus({}, res)
        assert.equal(res.body.available, false)
        assert.match(res.body.unavailableReason, /AETHER_ENGINE_PATH/)
    } finally {
        aetherSchedulerService.discoveryStatus = real
    }
})

// ── The run announces itself ─────────────────────────────────────────────────
// The candidate list used to sit on a five-minute timer and learn of a finished run up to ten
// minutes after the button already knew. A stage change now goes out over the socket to
// everyone connected, in the shape GET /discover answers, and the list refetches on the frame
// that says the run is over.

const OPEN = 1
function fakeSocket() {
    return { readyState: OPEN, sent: [], send(f) { this.sent.push(JSON.parse(f)) } }
}

test('an engine line that moves the stage is broadcast in the status shape', () => {
    const ws = fakeSocket()
    _register('viewer', ws)
    try {
        _onEngineLine('INFO    selector: 358 queued -> 12 after cheap cuts', 'warn')

        assert.equal(ws.sent.length, 1)
        const { event, data } = ws.sent[0]
        assert.equal(event, DISCOVERY_EVENT)
        assert.equal(data.progress.stage, 'triage')
        assert.equal(data.progress.detail, 'reading 12 of 358 headlines')
        // The full status, not just the stage: a client that never polled still learns
        // whether this host can run and whether one is in flight.
        assert.equal(typeof data.running, 'boolean')
        assert.equal(typeof data.available, 'boolean')
    } finally {
        _unregister('viewer', ws)
    }
})

test('the finished frame goes out AFTER the mirror — the list refetches on it, so the rows must be there', async () => {
    // Split host: engine writes the house db, the app reads its own. The exit handler used to
    // announce first and mirror after; the log read `finished` → `GET /candidates` → `mirrored`
    // one second apart, and the new run was only on screen after a manual reload.
    const ws = fakeSocket()
    _register('viewer3', ws)
    const order = []
    try {
        await _onDiscoveryExit({ code: 0, startedAt: '2026-09-20T13:06:23.000Z' }, async since => {
            order.push(`mirror:${since}`)
            await new Promise(r => setTimeout(r, 5))
            assert.equal(ws.sent.length, 0, 'nothing announced while the mirror is still copying')
        })
        order.push('announced')

        assert.deepEqual(order, ['mirror:2026-09-20T13:06:23.000Z', 'announced'])
        assert.equal(ws.sent.length, 1)
        const { event, data } = ws.sent[0]
        assert.equal(event, DISCOVERY_EVENT)
        assert.equal(data.running, false)
        assert.equal(data.last.ok, true)
        assert.equal(data.last.code, 0)
    } finally {
        _unregister('viewer3', ws)
    }
})

test('a mirror that throws still ends the run — never a permanent 409', async () => {
    const ws = fakeSocket()
    _register('viewer4', ws)
    try {
        await assert.rejects(_onDiscoveryExit({ code: 1, startedAt: '2026-09-20T13:06:23.000Z' },
                                              async () => { throw new Error('sibling db unreachable') }))
        assert.equal(ws.sent.length, 1)
        assert.equal(ws.sent[0].data.running, false)
        assert.equal(ws.sent[0].data.last.ok, false)
        assert.equal(aetherSchedulerService.discoveryStatus().running, false)
    } finally {
        _unregister('viewer4', ws)
    }
})

test('a line that says nothing about the stage is logged, not broadcast', () => {
    const ws = fakeSocket()
    _register('viewer2', ws)
    try {
        _onEngineLine('WARNING price fetch failed for NBIS: read timed out', 'warn')
        assert.equal(ws.sent.length, 0)
    } finally {
        _unregister('viewer2', ws)
    }
})

test('the server still refuses on its own — the button is only a courtesy', async () => {
    // Hiding the button is politeness. A request that arrives anyway, from a stale tab or
    // curl, must still be refused by the same check.
    await withRunner(() => { throw httpError(503, 'no engine on this host — AETHER_ENGINE_PATH is not set') },
        async () => {
            const res = fakeRes()
            await startDiscovery({ body: {}, user: {} }, res)
            assert.equal(res.statusCode, 503)
            assert.match(res.body.error, /no engine on this host/)
        })
})
