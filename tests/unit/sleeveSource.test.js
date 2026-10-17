import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
    sourceSleeve, buildSleeveSourced, screenFiltersFor, pendingSleeves, _resetSleeves, SCHOOL_SCREEN, SLEEVE_HITS,
    onSleeveSettled, sleeveOutcome,
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
    // …and on THIS sleeve's names only: the house queue beside it is not researched on a user's request (2026-10-11).
    assert.deepEqual(h.starts[0], { userId: null, audience: null, model: null, symbols: ['AAA', 'CCC'] })
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
    // the deleted tilt house scan's rows read as a plain coverage request now
    assert.equal(researchOpening({ symbol: 'XOM', context: { sector: 'Energy', active_bp: 150 } }), 'Research XOM for coverage.')
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

// ── the house's long-term industries first (argus-on-pythia.md §3.5, Roy 2026-10-13: up to half) ──────────

import { houseFirst, HOUSE_POOL } from '../../services/sleeveSource.service.js'

const POOL = Array.from({ length: 30 }, (_, i) => `S${String(i).padStart(2, '0')}`)
// Every fifth symbol of the pool is in the house's industry 'H1'; the rest in 'X'.
const IND_OF = Object.fromEntries(POOL.map((s, i) => [s, i % 5 === 0 ? 'H1' : 'X']))

test('houseFirst: the house names lead, up to the cap; the screen fills the rest in its order', () => {
    const r = houseFirst(POOL, IND_OF, new Set(['H1']), { hits: 12, max: 6 })
    assert.deepEqual(r.house, ['S00', 'S05', 'S10', 'S15', 'S20', 'S25'])
    assert.equal(r.symbols.length, 12)
    assert.deepEqual(r.symbols.slice(0, 6), r.house)
    assert.deepEqual(r.symbols.slice(6), ['S01', 'S02', 'S03', 'S04', 'S06', 'S07'])
    const capped = houseFirst(POOL, IND_OF, new Set(['H1']), { hits: 12, max: 3 })
    assert.deepEqual(capped.house, ['S00', 'S05', 'S10'], 'the cap is a ceiling')
    const short = houseFirst(POOL.slice(0, 8), IND_OF, new Set(['H1']), { hits: 12, max: 6 })
    assert.deepEqual(short.house, ['S00', 'S05'], 'a short house list takes what it has')
    assert.equal(short.symbols.length, 8)
    assert.deepEqual(houseFirst(POOL, IND_OF, new Set(), { hits: 12, max: 6 }).symbols, POOL.slice(0, 12), 'no house: the screen as it was')
    assert.deepEqual(houseFirst(POOL, IND_OF, new Set(['H1']), { hits: 12, max: 0 }).house, [])
})

test('a sector Pythia rates long term: the screen widens, the house names lead, the card counts them', async () => {
    const h = harness({ screened: POOL, covered: ['S05'] })
    const filters = []
    h.deps.screen = async (f) => { filters.push(f); return POOL }
    h.deps.houseIndustries = async (sector) => { assert.equal(sector, 'Technology'); return [{ code: 'H1' }, { code: 'X', avoid: true }] }
    h.deps.industryOf = async () => IND_OF
    h.deps.houseMax = () => 6
    const res = await sourceSleeve(req(), h.deps)
    assert.equal(res.ok, true)
    assert.equal(filters[0].limit, HOUSE_POOL)
    assert.deepEqual(res.sleeve.house, ['S00', 'S10', 'S15', 'S20', 'S25'], 'a covered house name is in the book, not in the sleeve')
    assert.equal(res.sleeve.symbols.length + 1, SLEEVE_HITS, 'twelve screened, one already covered')
    assert.deepEqual(h.enqueued.slice(0, 5).map(e => e.symbol), ['S00', 'S10', 'S15', 'S20', 'S25'])
    await h.settled(run(res.sleeve.symbols.map(symbol => ({ symbol, outcome: 'covered' }))))
    const card = h.posted.at(-1)
    assert.match(card.content, /5 of the 11 came from the house's long-term industries/)
    assert.deepEqual(card.payload.house, ['S00', 'S10', 'S15', 'S20', 'S25'])
})

test('no house industries, or an unreadable list, or unreadable industries: the sleeve screens as before', async () => {
    for (const houseIndustries of [async () => [], async () => { throw new Error('db down') }]) {
        _resetSleeves()
        const h = harness({ screened: POOL })
        const filters = []
        h.deps.screen = async (f) => { filters.push(f); return POOL.slice(0, SLEEVE_HITS) }
        h.deps.houseIndustries = houseIndustries
        const res = await sourceSleeve(req(), h.deps)
        assert.equal(filters[0].limit, SLEEVE_HITS)
        assert.deepEqual(res.sleeve.house, [])
        assert.doesNotMatch(buildSleeveSourced({ ...res.sleeve, userId: 'u1', outcomes: {} })?.content ?? '', /house/)
    }
    _resetSleeves()
    const h = harness()
    h.deps.screen = async () => POOL
    h.deps.houseIndustries = async () => [{ code: 'H1' }]
    h.deps.industryOf = async () => { throw new Error('db down') }
    const res = await sourceSleeve(req(), h.deps)
    assert.deepEqual(res.sleeve.symbols, POOL.slice(0, SLEEVE_HITS), 'the wide screen is still cut to the sleeve, in its order')
    assert.deepEqual(res.sleeve.house, [])
})

test('an industry the house rates AVOID never leads a sleeve, even through a long-term theme (code review 2026-10-13)', async () => {
    const h = harness()
    const filters = []
    h.deps.screen = async (f) => { filters.push(f); return POOL.slice(0, f.limit) }
    h.deps.houseIndustries = async () => [{ code: 'H1', avoid: true }]
    h.deps.industryOf = async () => IND_OF
    const res = await sourceSleeve(req(), h.deps)
    assert.equal(filters[0].limit, SLEEVE_HITS, 'only an Avoid industry: no house list, the plain screen')
    assert.deepEqual(res.sleeve.house, [])
    assert.deepEqual(res.sleeve.symbols, POOL.slice(0, SLEEVE_HITS), 'its names still come through the screen in its order')
})

// ── settling into a session (unified-chat plan phase 5d) ─────────────────────

test('a sleeve sourced from a session settles into its chain — no card — when the hook takes it', async () => {
    const seen = []
    onSleeveSettled(async (sleeve, outcome) => { seen.push({ sleeve, outcome }); return true })
    try {
        const h = harness({ screened: ['AAA', 'BBB'], covered: ['AAA', 'BBB'] })   // all covered → settles at once
        await sourceSleeve(req({ sessionId: 'ses1' }), h.deps)
        assert.equal(h.posted.length, 0, 'no card — the session carries it')
        assert.equal(seen[0].sleeve.sessionId, 'ses1')
        assert.equal(seen[0].outcome.screened, 2)
    } finally { onSleeveSettled(null) }
})

test('the card is posted as today when the sleeve has no session, or the hook declines (the session is gone)', async () => {
    onSleeveSettled(async () => false)
    try {
        const declined = harness({ screened: ['AAA'], covered: ['AAA'] })
        await sourceSleeve(req({ sessionId: 'gone' }), declined.deps)
        assert.equal(declined.posted.length, 1)
        const plain = harness({ screened: ['AAA'], covered: ['AAA'] })
        await sourceSleeve(req(), plain.deps)
        assert.equal(plain.posted.length, 1)
    } finally { onSleeveSettled(null) }
})

test('sleeveOutcome is the one reading of a settled sleeve — skipped names count as covered', () => {
    const o = sleeveOutcome({ symbols: ['A', 'B', 'C', 'D'], outcomes: { A: 'covered', B: 'skipped', C: 'passed', D: 'unresolved' }, alreadyCovered: 1 })
    assert.deepEqual(o.covered, ['A', 'B'])
    assert.deepEqual(o.passed, ['C'])
    assert.deepEqual(o.unresolved, ['D'])
    assert.equal(o.screened, 5)
})
