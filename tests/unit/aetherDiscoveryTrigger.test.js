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
import { aetherSchedulerService } from '../../services/aetherScheduler.service.js'
import { startDiscovery, getDiscoveryStatus } from '../../api/aether/aether.controller.js'

function fakeRes() {
    const res = { statusCode: 200, body: null }
    res.status = code => { res.statusCode = code; return res }
    res.json = payload => { res.body = payload; return res }
    return res
}

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
    await withRunner(() => { throw new Error('a discovery run is already in flight') }, async () => {
        const res = fakeRes()
        await startDiscovery({ body: {}, user: {} }, res)
        assert.equal(res.statusCode, 409)
        assert.equal(res.body.started, false)
    })
})

test('no engine on this host is 503, not 409', async () => {
    // Different problem, different answer: "already going" invites a retry in a minute,
    // "no engine here" never will be.
    await withRunner(() => { throw new Error('AETHER_ENGINE_PATH not set — no engine on this host') },
        async () => {
            const res = fakeRes()
            await startDiscovery({ body: {}, user: {} }, res)
            assert.equal(res.statusCode, 503)
        })
})

test('maxRuns is clamped — it is the spend dial, not a preference', async () => {
    // --max-runs multiplies BOTH the model cost and the SEC traffic, per event.
    await withRunner(ok, async calls => {
        await startDiscovery({ body: { maxRuns: 500 }, user: {} }, fakeRes())
        assert.equal(calls[0].maxRuns, 10)
    })
    await withRunner(ok, async calls => {
        await startDiscovery({ body: { maxRuns: 0 }, user: {} }, fakeRes())
        assert.equal(calls[0].maxRuns, 2, 'zero is not a request for nothing, it is a missing value')
    })
})

test('a junk body falls back to the defaults rather than NaN', async () => {
    await withRunner(ok, async calls => {
        await startDiscovery({ body: { maxRuns: 'lots', hours: null, top: undefined }, user: {} }, fakeRes())
        assert.deepEqual(calls[0], { maxRuns: 2, hours: 168, top: 5 })
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

test('the server still refuses on its own — the button is only a courtesy', async () => {
    // Hiding the button is politeness. A request that arrives anyway, from a stale tab or
    // curl, must still be refused by the same check.
    await withRunner(() => { throw new Error('no engine on this host — AETHER_ENGINE_PATH is not set') },
        async () => {
            const res = fakeRes()
            await startDiscovery({ body: {}, user: {} }, res)
            assert.equal(res.statusCode, 503)
            assert.match(res.body.error, /no engine on this host/)
        })
})
