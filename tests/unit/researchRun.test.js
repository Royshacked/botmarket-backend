import { test } from 'node:test'
import assert   from 'node:assert/strict'

import { startRun, stopRun, getRun, researchOpening, isRunFatal } from '../../services/researchRun.service.js'

// ─── researchRun ──────────────────────────────────────────────────────────────
// Injected deps — no DB, no agent. `research` is a stub that answers per symbol; `covered` is the
// book as the run reads it at the start.
//
// The run is fire-and-forget, so each test drains it with `settled(run)` — polling getRun until the
// status leaves `running`. The stubs resolve on the microtask queue, so a handful of ticks is plenty.

function makeDeps({ queued = [], covered = [], answers = {}, initiate } = {}) {
    const calls = { started: [], done: [], rejected: [], researched: [], initiated: [], requeued: [], backInLine: [] }
    return {
        calls,
        listQueue:      async () => queued,
        // The queue's own bulk move; records what it was asked to leave alone.
        coveredSymbols: async () => new Set(covered),
        startResearch:  async (id) => { calls.started.push(id); return { ok: true } },
        markDone:       async (id) => { calls.done.push(id); return { ok: true } },
        reject:         async (id, reason) => { calls.rejected.push([id, reason]); return { ok: true } },
        requeue:        async (id) => { calls.backInLine.push(id); return { ok: true } },
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
    // The tilt's house scan is gone (2026-10-05); a row it left behind reads as a plain coverage request.
    assert.equal(researchOpening({ symbol: 'UNH', context: { sector: 'Healthcare', active_bp: 200 } }), 'Research UNH for coverage.')
    // The house scan on Pythia's verdicts (step 7): the verdict, its thesis and risks travel; priced-in is the question.
    assert.equal(
        researchOpening({ symbol: 'lrcx', context: { pythia: true, kind: 'theme', subject: 'AI compute', link: 'Semiconductor Materials & Equipment', verdict: 'swing', horizon: 'months', thesis: 'Capex is still rising.', risks: ['capex pause'] } }),
        'Research LRCX for coverage — Pythia rates the theme AI compute (via Semiconductor Materials & Equipment) FOR SWING (months): Capex is still rising. Risks it named: capex pause. Judge whether LRCX is already priced for it. Set the price target on a 3m or 6m horizon — FOR SWING is graded there.',
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
    assert.deepEqual(d.calls.rejected, [])
    // The account, not AZN: back in line for the run after the top-up — left claimed, no pick-up ever read it (2026-10-28).
    assert.deepEqual(d.calls.backInLine, ['rq_AZN'])
})

test('researchRun: a name-level failure is not put back in line — it keeps its reason for the admin', async () => {
    const d = makeDeps({ queued: [q('X')], answers: { X: new Error('provider down') } })
    await startRun({ userId: 'u1' }, d)
    await settled()
    assert.deepEqual(d.calls.backInLine, [])
})

test('researchRun: isRunFatal — billing, auth and permission are; a name-level 400 and a rate limit are not', () => {
    assert.equal(isRunFatal(noCredit()), true)
    assert.equal(isRunFatal(Object.assign(new Error('x'), { status: 401 })), true)
    assert.equal(isRunFatal(Object.assign(new Error('x'), { error: { error: { type: 'permission_error', message: 'no' } } })), true)
    assert.equal(isRunFatal(Object.assign(new Error('x'), { status: 429, error: { error: { type: 'rate_limit_error', message: 'slow down' } } })), false)
    assert.equal(isRunFatal(Object.assign(new Error('400 bad request'), { status: 400, error: { error: { type: 'invalid_request_error', message: 'messages: too long' } } })), false)
    assert.equal(isRunFatal(new Error('provider down')), false)
    // OpenRouter's no-balance refusal, by its words alone (2026-10-28).
    assert.equal(isRunFatal(new Error('This request requires more credits, or fewer max_tokens. You requested up to 16000 tokens, but can only afford 12285.')), true)
})

test('researchRun: getRun is a snapshot, not the live object', async () => {
    const d = makeDeps({ queued: [q('S')], answers: { S: draft('S') } })
    await startRun({ userId: 'u1' }, d)
    const run = await settled()
    run.results.push({ symbol: 'HACK' })
    assert.equal(getRun().results.length, 1)
    assert.equal('stop' in getRun(), false)
})

// ─── the claim is read, and the start is single-flight ─────────────────────────
// startResearch is a guarded transition (queued → in_research). Its answer used to be discarded, so
// a row someone else had already claimed was researched anyway — a four-minute turn whose save could
// only answer already_covered. And the "one run at a time" check ran BEFORE two awaits, so two Starts
// pressed together both became the run.

test('researchRun: a row that is no longer queued is skipped, not researched — the claim is read', async () => {
    const d = makeDeps({ queued: [q('UNH'), q('LLY')], answers: { UNH: draft('UNH'), LLY: draft('LLY') } })
    d.startResearch = async (id) => { d.calls.started.push(id); return id === 'rq_UNH' ? { ok: false, reason: 'not_found_or_wrong_status' } : { ok: true } }
    assert.equal((await startRun({ userId: 'u1' }, d)).ok, true)
    const run = await settled()

    assert.deepEqual(d.calls.researched.map(r => r.symbol), ['LLY'], 'the unclaimed row is never researched')
    assert.deepEqual(d.calls.rejected, [], 'and its row is left exactly as it was — it is not ours')
    assert.deepEqual(run.results.map(r => [r.outcome, r.reason ?? null]), [['skipped', 'not_queued'], ['covered', null]])
    assert.equal(run.skipped, 1); assert.equal(run.covered, 1); assert.equal(run.position, 2)
})

test('researchRun: two Starts pressed together → one run, the other answers already_running', async () => {
    let releaseQueue
    const d = makeDeps({ queued: [q('Z')], answers: { Z: draft('Z') } })
    d.listQueue = () => new Promise(r => { releaseQueue = () => r([q('Z')]) })   // the first Start is mid-read
    const first  = startRun({ userId: 'u1' }, d)
    const second = await startRun({ userId: 'u2' }, d)                            // arrives before the read resolves
    assert.equal(second.reason, 'already_running')
    releaseQueue()
    assert.equal((await first).ok, true)
    await settled()
    assert.deepEqual(d.calls.researched.map(r => r.symbol), ['Z'], 'researched once, not twice')
})

test('researchRun: a Start that refuses (empty queue) does not leave the next one locked out', async () => {
    assert.equal((await startRun({}, makeDeps({ queued: [] }))).reason, 'nothing_queued')
    const d = makeDeps({ queued: [q('Z')], answers: { Z: draft('Z') } })
    assert.equal((await startRun({ userId: 'u1' }, d)).ok, true)
    await settled()
})

test('researchRun: a run for given symbols researches only those — a sleeve does not pay for the house queue', async () => {
    const deps = makeDeps({ queued: [q('AAA'), q('HOUSE', { source: 'pythia' })] })
    assert.equal((await startRun({ symbols: ['aaa'] }, deps)).ok, true)
    await settled()
    assert.deepEqual(deps.calls.researched.map(r => r.symbol), ['AAA'])
    assert.equal((await startRun({ symbols: ['ZZZ'] }, makeDeps({ queued: [q('AAA')] }))).reason, 'nothing_queued')
})

// ─── what each name cost (house-research-chain.md step 1) ─────────────────────

function meteredDeps(over = {}) {
    const d = makeDeps(over)
    d.calls.booked = []; d.calls.annotated = []
    d.costOf      = (model, usage) => usage.usd
    d.houseLedger = async () => 'admin1'
    d.book        = async (userId, model, usage) => { d.calls.booked.push([userId, model, usage.usd]) }
    d.annotate    = async (id, o) => { d.calls.annotated.push([id, o]); return { ok: true } }
    const inner = d.research
    // The turn spends: the desk's own call and a consult, through the tap the run hands it.
    d.research = async (args) => {
        args.onSpend({ usd: 0.1 }, 'gpt-6-luna')
        args.onSpend({ usd: 0.25 }, 'claude-opus-5-5')
        return inner(args)
    }
    return d
}

test('researchRun: a HOUSE run measures each name and books it to the house ledger', async () => {
    const d = meteredDeps({ queued: [q('AAA'), q('BBB')], answers: { AAA: draft('AAA') } })
    await startRun({ userId: null }, d)
    const run = await settled()
    assert.deepEqual(run.results.map(r => [r.symbol, r.outcome, r.cost_usd]), [['AAA', 'covered', 0.35], ['BBB', 'passed', 0.35]])
    assert.equal(run.cost_usd, 0.7)
    assert.deepEqual(d.calls.annotated, [['rq_AAA', { addCost: 0.35 }], ['rq_BBB', { addCost: 0.35 }]], 'the queue row carries what it cost')
    assert.deepEqual(d.calls.booked, [['admin1', 'gpt-6-luna', 0.1], ['admin1', 'claude-opus-5-5', 0.25], ['admin1', 'gpt-6-luna', 0.1], ['admin1', 'claude-opus-5-5', 0.25]])
})

test('researchRun: a user\'s run is measured but not booked again — the turn already booked it', async () => {
    const d = meteredDeps({ queued: [q('AAA')], answers: { AAA: draft('AAA') } })
    let asked = 0
    d.houseLedger = async () => { asked++; return 'admin1' }
    await startRun({ userId: 'u1' }, d)
    const run = await settled()
    assert.equal(run.cost_usd, 0.35)
    assert.deepEqual(d.calls.booked, [])
    assert.equal(asked, 0)
})

test('researchRun: no house ledger → the name is still measured, nothing booked, the run goes on', async () => {
    const d = meteredDeps({ queued: [q('AAA')] })
    d.houseLedger = async () => { throw new Error('users unreadable') }
    await startRun({}, d)
    const run = await settled()
    assert.equal(run.status, 'done')
    assert.equal(run.results[0].cost_usd, 0.35)
    assert.deepEqual(d.calls.booked, [])
})
