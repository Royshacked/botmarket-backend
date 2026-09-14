import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
    sourceSleeve, buildSleeveSourced, screenFiltersFor, pendingSleeves, _resetSleeves, SCHOOL_SCREEN, SLEEVE_HITS,
} from '../../services/sleeveSource.service.js'
import { researchOpening } from '../../services/researchRun.service.js'

// The autonomous Atlas → Argus → Prometheus → Atlas hop. Everything here is injected: the screener,
// the coverage book, the queue, the run and the card transport are all seams, so what is asserted
// is the JUDGMENT — which pond a school screens, when a sleeve counts as sourced, what the card says.

function harness({ screened = ['AAA', 'BBB', 'CCC'], covered = [], startRun = null, queueRows = [] } = {}) {
    const h = { enqueued: [], posted: [], starts: [], settled: null }
    h.deps = {
        screen:         async () => screened,
        coveredSymbols: async () => new Set(covered),
        enqueue:        async (a) => { h.enqueued.push(a); return { ok: true, id: `rq_${a.symbol}` } },
        listQueue:      async () => queueRows,
        startRun:       async (a) => { h.starts.push(a); return startRun ? startRun(a) : { ok: true, run: { id: 'run_1' } } },
        onRunSettled:   (fn) => { h.settled = fn },
        post:           async (card) => { h.posted.push(card); return { id: 'm1' } },
    }
    return h
}

const req = (over = {}) => ({ userId: 'u1', threadId: 't1', sector: 'Technology', school: 'quality-value', ...over })
const run = (results, status = 'done') => ({ id: 'run_1', status, results })

beforeEach(() => _resetSleeves())

// ── the school as a screen ───────────────────────────────────────────────────

test('each school screens its own pond; no school → the default; passive has no pond at all', () => {
    assert.equal(screenFiltersFor('Energy', 'income').dividendMoreThan, 0.5)
    assert.equal(screenFiltersFor('Energy', 'quality-value').marketCapMoreThan, SCHOOL_SCREEN['quality-value'].marketCapMoreThan)
    assert.equal(screenFiltersFor('Energy', null).marketCapMoreThan, SCHOOL_SCREEN.default.marketCapMoreThan)
    assert.equal(screenFiltersFor('Energy', 'nonsense').marketCapMoreThan, SCHOOL_SCREEN.default.marketCapMoreThan)
    assert.equal(SCHOOL_SCREEN.passive, undefined)
    const f = screenFiltersFor('Technology', 'growth-durability', { industry: 'Semiconductors' })
    assert.equal(f.sector, 'Technology')
    assert.equal(f.industry, 'Semiconductors')
    assert.equal(f.isEtf, 'false')
    assert.equal(f.limit, SLEEVE_HITS)
})

// ── the request ───────────────────────────────────────────────────────────────

test('a passive sleeve, a sleeve with no sector, or no user → refused before anything is screened', async () => {
    const h = harness()
    assert.equal((await sourceSleeve(req({ school: 'passive' }), h.deps)).reason, 'passive')
    assert.equal((await sourceSleeve(req({ sector: null }), h.deps)).reason, 'sector_required')
    assert.equal((await sourceSleeve(req({ userId: null }), h.deps)).reason, 'user_required')
    assert.equal(h.enqueued.length, 0)
    assert.equal(h.starts.length, 0)
})

test('an empty screen sources nothing and starts nothing', async () => {
    const h = harness({ screened: [] })
    assert.equal((await sourceSleeve(req(), h.deps)).reason, 'nothing_screened')
    assert.equal(h.starts.length, 0)
    assert.equal(pendingSleeves().length, 0)
})

test('the fresh hits are queued as argus rows carrying the sleeve, and the run is started AS THE HOUSE', async () => {
    const h = harness({ screened: ['AAA', 'BBB', 'CCC'], covered: ['BBB'] })
    const r = await sourceSleeve(req({ note: '3-year hold' }), h.deps)
    assert.equal(r.ok, true)
    assert.deepEqual(r.sleeve.symbols, ['AAA', 'CCC'])
    assert.equal(r.sleeve.alreadyCovered, 1)

    assert.deepEqual(h.enqueued.map(e => e.symbol), ['AAA', 'CCC'])
    const row = h.enqueued[0]
    assert.equal(row.source, 'argus')
    assert.equal(row.requestedBy, 'u1')
    assert.equal(row.context.sector, 'Technology')
    assert.equal(row.context.school, 'quality-value')
    assert.equal(row.context.sleeve.threadId, 't1')

    // No user on the run: house coverage is researched on the house's model and the house's spend,
    // never degraded by the requester's ceiling (agentUtils) or billed to them.
    assert.equal(h.starts.length, 1)
    assert.deepEqual(h.starts[0], { userId: null, audience: null, model: null })
    assert.equal(pendingSleeves().length, 1)
})

test('every hit already covered → no queue, no run, the card goes out at once', async () => {
    const h = harness({ screened: ['AAA', 'BBB'], covered: ['AAA', 'BBB'] })
    const r = await sourceSleeve(req(), h.deps)
    assert.equal(r.reason, 'all_covered')
    assert.equal(h.enqueued.length, 0)
    assert.equal(h.starts.length, 0)
    assert.equal(h.posted.length, 1)
    assert.match(h.posted[0].content, /every name the screen found is already in coverage \(2\)/)
    assert.equal(pendingSleeves().length, 0)
})

test('a run already going is not a failure — the sleeve waits for it', async () => {
    const h = harness({ startRun: () => ({ ok: false, reason: 'already_running' }) })
    const r = await sourceSleeve(req(), h.deps)
    assert.equal(r.ok, true)
    assert.equal(pendingSleeves().length, 1)
})

test('the queue opening names the sleeve and the school, not the house view', () => {
    const item = { symbol: 'AAA', context: { sector: 'Technology', school: 'quality-value', note: '3-year hold', sleeve: { id: 'slv_1' } } }
    assert.equal(researchOpening(item), 'Research AAA for coverage — a candidate for the Technology sleeve of a portfolio build under a quality-value selection (3-year hold).')
    // the house scan's row still reads as it always did
    assert.match(researchOpening({ symbol: 'XOM', context: { sector: 'Energy', active_bp: 150 } }), /the house is overweight Energy \+150bp/)
})

// ── the run settles ───────────────────────────────────────────────────────────

test('when the run has decided every name, the user gets one Atlas card and the sleeve is gone', async () => {
    const h = harness({ screened: ['AAA', 'BBB', 'CCC'] })
    await sourceSleeve(req(), h.deps)
    await h.settled(run([
        { symbol: 'AAA', outcome: 'covered', coverageId: 'cov_a' },
        { symbol: 'BBB', outcome: 'passed', reason: 'no_edge' },
        { symbol: 'CCC', outcome: 'covered', coverageId: 'cov_c' },
        { symbol: 'ZZZ', outcome: 'covered' },   // somebody else's name in the same run
    ]))
    assert.equal(h.posted.length, 1)
    const card = h.posted[0]
    assert.equal(card.userId, 'u1')
    assert.equal(card.botId, 'portfolio')
    assert.equal(card.type, 'sleeve_sourced')
    assert.equal(card.visibility, 'own')
    assert.equal(card.forUserId, 'u1')
    assert.equal(card.actions.primary.label, 'Resume build')
    assert.equal(card.content, 'Technology sleeve sourced (quality-value): 2 of 3 screened names now in coverage — AAA, CCC; 1 passed on (no edge). Resume the build and Atlas allocates from coverage.')
    assert.deepEqual(card.payload.covered, ['AAA', 'CCC'])
    assert.deepEqual(card.payload.passed, ['BBB'])
    assert.equal(card.payload.threadId, 't1')
    assert.equal(pendingSleeves().length, 0)
    assert.equal(h.starts.length, 1)   // nothing restarted
})

test('a run that ended before reaching the sleeve (it listed the queue first) → the next run is started', async () => {
    const h = harness({ screened: ['AAA', 'BBB'] })
    await sourceSleeve(req(), h.deps)
    await h.settled(run([{ symbol: 'ZZZ', outcome: 'covered' }], 'done'))
    assert.equal(h.posted.length, 0)
    assert.equal(h.starts.length, 2)
    assert.equal(pendingSleeves().length, 1)
})

test('a run the admin STOPPED is not restarted from here — the sleeve waits for the next Start', async () => {
    const h = harness({ screened: ['AAA', 'BBB'] })
    await sourceSleeve(req(), h.deps)
    await h.settled(run([{ symbol: 'AAA', outcome: 'covered' }, { symbol: 'BBB', outcome: 'stopped' }], 'stopped'))
    assert.equal(h.starts.length, 1)
    assert.equal(h.posted.length, 0)
    assert.deepEqual(pendingSleeves()[0].outcomes, { AAA: 'covered' })   // a stopped name has no outcome yet
})

test('two runs can finish one sleeve — outcomes accumulate', async () => {
    const h = harness({ screened: ['AAA', 'BBB'] })
    await sourceSleeve(req(), h.deps)
    await h.settled(run([{ symbol: 'AAA', outcome: 'covered' }], 'stopped'))
    await h.settled(run([{ symbol: 'BBB', outcome: 'failed', reason: 'save_failed' }], 'done'))
    assert.equal(h.posted.length, 1)
    assert.match(h.posted[0].content, /1 of 2 screened names now in coverage — AAA; 1 failed to save/)
})

test('names that left the queue outside any run are closed as unresolved rather than waited on forever', async () => {
    // The run reports nothing queued (the rows were rejected by hand); the queue confirms BBB is gone.
    const h = harness({ screened: ['AAA', 'BBB'], startRun: () => ({ ok: false, reason: 'nothing_queued' }), queueRows: [] })
    await sourceSleeve(req(), h.deps)
    assert.equal(h.posted.length, 1)
    assert.deepEqual(h.posted[0].payload.unresolved, ['AAA', 'BBB'])
    assert.match(h.posted[0].content, /put none into coverage/)
    assert.equal(pendingSleeves().length, 0)
})

test('a name covered by hand between the screen and the turn (the run skipped it) counts as covered', () => {
    const card = buildSleeveSourced({ userId: 'u1', sector: 'Energy', school: null, symbols: ['XOM', 'CVX'], outcomes: { XOM: 'skipped', CVX: 'covered' }, alreadyCovered: 0 })
    assert.match(card.content, /2 of 2 screened names now in coverage — CVX, XOM/)
    assert.deepEqual(card.payload.covered, ['CVX'])
    assert.deepEqual(card.payload.skipped, ['XOM'])
    assert.equal(card.payload.inBook, 2)
})

test('the card needs a user and a sector', () => {
    assert.equal(buildSleeveSourced({ sector: 'Energy', symbols: [] }), null)
    assert.equal(buildSleeveSourced({ userId: 'u1', symbols: [] }), null)
})
