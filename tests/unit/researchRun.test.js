import { test } from 'node:test'
import assert   from 'node:assert/strict'

import { startRun, stopRun, getRun, researchOpening, requeueStalled, isRunFatal } from '../../services/researchRun.service.js'

// ─── researchRun ──────────────────────────────────────────────────────────────
// Injected deps — no DB, no agent. `research` is a stub that answers per symbol; `covered` is the
// book as the run reads it at the start.
//
// The run is fire-and-forget, so each test drains it with `settled(run)` — polling getRun until the
// status leaves `running`. The stubs resolve on the microtask queue, so a handful of ticks is plenty.

function makeDeps({ queued = [], covered = [], answers = {}, initiate } = {}) {
    const calls = { started: [], done: [], rejected: [], researched: [], initiated: [], requeued: [] }
    return {
        calls,
        listQueue:      async () => queued,
        // The queue's own bulk move; records what it was asked to leave alone.
        requeueInResearch: async ({ except } = {}) => { calls.requeued.push(except); return { ok: true, requeued: 22 } },
        coveredSymbols: async () => new Set(covered),
        startResearch:  async (id) => { calls.started.push(id); return { ok: true } },
        markDone:       async (id) => { calls.done.push(id); return { ok: true } },
        reject:         async (id, reason) => { calls.rejected.push([id, reason]); return { ok: true } },
        research:       async ({ symbol, opening }) => {
            calls.researched.push({ symbol, opening })
            const a = answers[symbol]
            if (a instanceof Error) throw a
            if (typeof a === 'function') return a()
            return a ?? { reply: 'no edge', coverage: null }
        },
        initiate: initiate ?? (async (coverage) => { calls.initiated.push(coverage.symbol); return { ok: true, doc: { id: `cv_${coverage.symbol}` } } }),
    }
}

const q = (symbol, over = {}) => ({ id: `rq_${symbol}`, symbol, status: 'queued', source: 'argus', ...over })
const draft = symbol => ({ reply: 'thesis…', coverage: { symbol, thesis: 't' } })

async function settled() {
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setImmediate(r))
        if (getRun()?.status !== 'running') return getRun()
    }
    throw new Error('run never settled')
}

test('researchRun: covered names are skipped, the rest are researched and their coverage written', async () => {
    const d = makeDeps({
        queued:  [q('JNJ'), q('UNH'), q('LLY')],
        covered: ['JNJ'],
        answers: { UNH: draft('UNH'), LLY: draft('LLY') },
    })
    const start = await startRun({ userId: 'u1' }, d)
    assert.equal(start.ok, true)
    const run = await settled()

    assert.equal(run.status, 'done')
    assert.deepEqual(d.calls.rejected, [['rq_JNJ', 'already_covered']])
    assert.deepEqual(d.calls.researched.map(r => r.symbol), ['UNH', 'LLY'])
    assert.deepEqual(d.calls.initiated, ['UNH', 'LLY'])
    assert.deepEqual(d.calls.done, ['rq_UNH', 'rq_LLY'])
    assert.deepEqual(d.calls.started, ['rq_UNH', 'rq_LLY'])   // the skip never claims the row
    assert.equal(run.covered, 2); assert.equal(run.skipped, 1); assert.equal(run.position, 3); assert.equal(run.total, 3)
    assert.deepEqual(run.results.map(r => r.outcome), ['skipped', 'covered', 'covered'])
})

test('researchRun: a turn with no <coverage> is a pass, rejected with reason no_edge', async () => {
    const d = makeDeps({ queued: [q('PFE')], answers: { PFE: { reply: 'Nothing here.', coverage: null } } })
    await startRun({ userId: 'u1' }, d)
    const run = await settled()
    assert.deepEqual(d.calls.rejected, [['rq_PFE', 'no_edge']])
    assert.deepEqual(d.calls.initiated, [])
    assert.equal(run.passed, 1)
})

test('researchRun: a failed save leaves the row in_research and the run continues', async () => {
    const d = makeDeps({
        queued:   [q('A'), q('B')],
        answers:  { A: draft('A'), B: draft('B') },
        initiate: async (c) => c.symbol === 'A' ? { ok: false, reason: 'rating_contradicts_target', detail: 'x' } : { ok: true, doc: { id: 'cv_B' } },
    })
    await startRun({ userId: 'u1' }, d)
    const run = await settled()
    assert.deepEqual(d.calls.done, ['rq_B'])
    assert.deepEqual(d.calls.rejected, [])          // A is neither done nor rejected — still in_research
    assert.equal(run.failed, 1); assert.equal(run.covered, 1)
    assert.equal(run.results[0].reason, 'rating_contradicts_target')
})

test('researchRun: a name covered by hand mid-run is a skip, not a failure', async () => {
    const d = makeDeps({
        queued:   [q('MRK')],
        answers:  { MRK: draft('MRK') },
        initiate: async () => ({ ok: false, reason: 'already_covered', id: 'cv_existing' }),
    })
    await startRun({ userId: 'u1' }, d)
    const run = await settled()
    assert.deepEqual(d.calls.rejected, [['rq_MRK', 'already_covered']])
    assert.equal(run.skipped, 1); assert.equal(run.failed, 0)
})

test('researchRun: a research error is recorded and the run moves on', async () => {
    const d = makeDeps({ queued: [q('X'), q('Y')], answers: { X: new Error('provider down'), Y: draft('Y') } })
    await startRun({ userId: 'u1' }, d)
    const run = await settled()
    assert.equal(run.failed, 1); assert.equal(run.covered, 1)
    assert.equal(run.results[0].reason, 'provider down')
    assert.deepEqual(d.calls.done, ['rq_Y'])
})

test('researchRun: stop ends the run after the name in flight, which stays in_research', async () => {
    let release
    const d = makeDeps({
        queued:  [q('P'), q('Q')],
        answers: { P: () => new Promise(r => { release = r }), Q: draft('Q') },
    })
    await startRun({ userId: 'u1' }, d)
    await new Promise(r => setImmediate(r))
    assert.equal(getRun().current, 'P')
    assert.equal(stopRun().ok, true)
    release(draft('P'))                       // the turn finishes after the stop — its result is not written
    const run = await settled()
    assert.equal(run.status, 'stopped')
    assert.deepEqual(d.calls.initiated, [])   // nothing saved for P, Q never started
    assert.deepEqual(d.calls.researched.map(r => r.symbol), ['P'])
    assert.equal(run.results[0].outcome, 'stopped')
})

test('researchRun: refuses to start over a running run, an empty queue, or an unreadable book', async () => {
    let release
    const d = makeDeps({ queued: [q('Z')], answers: { Z: () => new Promise(r => { release = r }) } })
    assert.equal((await startRun({ userId: 'u1' }, d)).ok, true)
    assert.equal((await startRun({ userId: 'u1' }, d)).reason, 'already_running')
    release(draft('Z')); await settled()

    assert.equal((await startRun({}, makeDeps({ queued: [] }))).reason, 'nothing_queued')
    assert.equal((await startRun({}, { ...makeDeps(), listQueue: async () => null })).reason, 'queue_unavailable')
    assert.equal((await startRun({}, { ...makeDeps({ queued: [q('Z')] }), coveredSymbols: async () => { throw new Error('dns') } })).reason, 'coverage_unavailable')
})

test('researchRun: the opening turn carries the mandate, and is the desk\'s sentence', () => {
    assert.equal(researchOpening({ symbol: 'unh' }), 'Research UNH for coverage.')
    assert.equal(
        researchOpening({ symbol: 'UNH', context: { sector: 'Healthcare', active_bp: 200, regime: 'Late-cycle', basis: 'bottom_up' } }),
        'Research UNH for coverage — the house is overweight Healthcare +200bp on a “Late-cycle” regime (basis: bottom up).',
    )
})

// The SDK's shape for the refusal that emptied the first real run: a 400 whose body says the
// account has no credit. Every later name would get the same answer.
const noCredit = () => Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'),
    { status: 400, error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } } })

test('researchRun: an account-level refusal aborts the run on the first name, not the twenty-second', async () => {
    const d = makeDeps({ queued: [q('AZN'), q('TMO'), q('AMGN')], answers: { AZN: noCredit(), TMO: draft('TMO'), AMGN: draft('AMGN') } })
    await startRun({ userId: 'u1' }, d)
    const run = await settled()
    assert.equal(run.status, 'failed')
    assert.match(run.error, /credit balance/)
    assert.deepEqual(d.calls.researched.map(r => r.symbol), ['AZN'])   // TMO and AMGN never asked
    assert.equal(run.failed, 1); assert.equal(run.position, 1)
    assert.deepEqual(d.calls.rejected, [])                              // AZN stays in_research
})

test('researchRun: isRunFatal — billing, auth and permission are; a name-level 400 and a rate limit are not', () => {
    assert.equal(isRunFatal(noCredit()), true)
    assert.equal(isRunFatal(Object.assign(new Error('x'), { status: 401 })), true)
    assert.equal(isRunFatal(Object.assign(new Error('x'), { error: { error: { type: 'permission_error', message: 'no' } } })), true)
    assert.equal(isRunFatal(Object.assign(new Error('x'), { status: 429, error: { error: { type: 'rate_limit_error', message: 'slow down' } } })), false)
    assert.equal(isRunFatal(Object.assign(new Error('400 bad request'), { status: 400, error: { error: { type: 'invalid_request_error', message: 'messages: too long' } } })), false)
    assert.equal(isRunFatal(new Error('provider down')), false)
})

test('researchRun: requeueStalled works off the queue, not the run — it needs no run at all', async () => {
    const d = makeDeps()
    // No run has happened in this process (or the one that had was lost to a restart).
    const res = await requeueStalled(d)
    assert.deepEqual(res, { ok: true, requeued: 22 })
    assert.deepEqual(d.calls.requeued, [[]])   // nothing to spare
})

test('researchRun: requeueStalled spares the name a running batch is mid-turn on', async () => {
    let release
    const d = makeDeps({ queued: [q('R')], answers: { R: () => new Promise(r => { release = r }) } })
    await startRun({ userId: 'u1' }, d)
    await new Promise(r => setImmediate(r))
    assert.equal(getRun().current, 'R')
    await requeueStalled(d)
    assert.deepEqual(d.calls.requeued, [['R']])
    release(draft('R')); await settled()
})

test('researchRun: requeueStalled reports an unreadable queue', async () => {
    const d = { ...makeDeps(), requeueInResearch: async () => ({ ok: false, error: new Error('dns') }) }
    assert.equal((await requeueStalled(d)).reason, 'queue_unavailable')
})

test('researchRun: getRun is a snapshot, not the live object', async () => {
    const d = makeDeps({ queued: [q('S')], answers: { S: draft('S') } })
    await startRun({ userId: 'u1' }, d)
    const run = await settled()
    run.results.push({ symbol: 'HACK' })
    assert.equal(getRun().results.length, 1)
    assert.equal('stop' in getRun(), false)
})
