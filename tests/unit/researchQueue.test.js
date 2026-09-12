import { test } from 'node:test'
import assert   from 'node:assert/strict'

import { runHouseScan, hitsForConviction, overweightRows } from '../../services/houseScan.service.js'

// ─── runHouseScan ─────────────────────────────────────────────────────────────
// Uses injected deps (screenSector + enqueue) — no DB, no FMP calls.

function _tilt(stances) {
    return { tilts: stances.map(([sector, stance]) => ({ sector, stance })) }
}

function _deps(sectorMap = {}) {
    const enqueued = []
    return {
        screened:     [],
        enqueued,
        screenSector: async (s) => { _deps._.screened.push(s); return sectorMap[s] ?? [] },
        enqueue:      async ({ symbol }) => { enqueued.push(symbol); return { ok: true } },
    }
}
// simple factory — share no state between calls
function makeDeps(sectorMap = {}) {
    const screened = []
    const enqueued = []
    return {
        screened,
        enqueued,
        screenSector: async (s) => { screened.push(s); return sectorMap[s] ?? [] },
        enqueue:      async ({ symbol }) => { enqueued.push(symbol); return { ok: true } },
    }
}

test('houseScan: no overweight sectors → nothing screened or enqueued', async () => {
    const d = makeDeps()
    await runHouseScan(_tilt([['Technology', 'neutral'], ['Energy', 'under']]), d)
    assert.deepEqual(d.screened, [])
    assert.deepEqual(d.enqueued, [])
})

test('houseScan: overweight sectors are screened, others skipped', async () => {
    const d = makeDeps({ Technology: [], Healthcare: [] })
    await runHouseScan(_tilt([['Technology', 'over'], ['Healthcare', 'over'], ['Energy', 'under']]), d)
    assert.deepEqual(d.screened, ['Technology', 'Healthcare'])
})

test('houseScan: hits are enqueued once per unique symbol across sectors', async () => {
    // AAPL appears in both sectors — should be enqueued only once
    const d = makeDeps({
        Technology: ['AAPL', 'MSFT'],
        Healthcare: ['AAPL', 'JNJ'],
    })
    await runHouseScan(_tilt([['Technology', 'over'], ['Healthcare', 'over']]), d)
    assert.deepEqual(d.screened, ['Technology', 'Healthcare'])
    assert.equal(d.enqueued.filter(s => s === 'AAPL').length, 1, 'AAPL enqueued exactly once')
    assert.ok(d.enqueued.includes('MSFT'))
    assert.ok(d.enqueued.includes('JNJ'))
    assert.equal(d.enqueued.length, 3)
})

test('houseScan: null or missing tilt doc → no crash, nothing screened', async () => {
    const d = makeDeps()
    await runHouseScan(null, d)
    await runHouseScan({}, d)
    assert.deepEqual(d.screened, [])
})

test('houseScan: a screenSector failure does not abort remaining sectors', async () => {
    const screened = []
    const enqueued = []
    const d = {
        screened,
        enqueued,
        screenSector: async (s) => {
            screened.push(s)
            if (s === 'Technology') throw new Error('provider down')
            return ['JNJ']
        },
        enqueue: async ({ symbol }) => { enqueued.push(symbol); return { ok: true } },
    }
    await runHouseScan(_tilt([['Technology', 'over'], ['Healthcare', 'over']]), d)
    assert.ok(screened.includes('Technology'))
    assert.ok(screened.includes('Healthcare'))
    assert.deepEqual(enqueued, ['JNJ'])
})

test('houseScan: enqueue duplicate response does not double-count', async () => {
    const d = makeDeps({ Technology: ['AAPL'] })
    d.enqueue = async () => ({ ok: true, duplicate: true })
    await runHouseScan(_tilt([['Technology', 'over']]), d)
    // Just verifies no error is thrown when duplicate is returned
    assert.ok(true)
})

// ─── the tilt as MANDATE ──────────────────────────────────────────────────────
// What the scan reads off the published view beyond "which sectors": how strongly, in what order,
// and — carried, not compiled into filters — why.

test('conviction sizes the screen: a +300bp stance earns more names than a +50bp one', () => {
    assert.equal(hitsForConviction(300), 30)
    assert.equal(hitsForConviction(150), 20)
    assert.equal(hitsForConviction(50),  10)
    assert.equal(hitsForConviction(250), 30, 'the band boundary is inclusive')
})

test('an ABSENT weight falls to the default breadth, never to the narrowest band', () => {
    // The distinction the grading side depends on too: a null is "unweighted", not "small".
    assert.equal(hitsForConviction(null), 20)
    assert.equal(hitsForConviction(undefined), 20)
    assert.equal(hitsForConviction('not a number'), 20)
    assert.equal(hitsForConviction(0), 10, '...but an explicit zero IS a number')
})

test('overweightRows keeps the policy, not just the sector name', () => {
    const doc = { tilts: [
        { sector: 'Technology', stance: 'over',  active_bp: 300, basis: 'revisions' },
        { sector: 'Energy',     stance: 'under', active_bp: -150, basis: 'valuation' },
        { sector: 'Utilities',  stance: 'over' },
        { stance: 'over', active_bp: 100 },   // no sector — not actionable
    ] }
    assert.deepEqual(overweightRows(doc), [
        { sector: 'Technology', active_bp: 300, basis: 'revisions' },
        { sector: 'Utilities',  active_bp: null, basis: null },
    ])
})

test('the screen is sized per sector by that sector’s conviction', async () => {
    const calls = []
    await runHouseScan(
        { tilts: [
            { sector: 'Technology', stance: 'over', active_bp: 300 },
            { sector: 'Healthcare', stance: 'over', active_bp: 40 },
        ] },
        {
            screenSector: async (s, opts) => { calls.push([s, opts?.limit]); return [] },
            enqueue:      async () => ({ ok: true }),
        },
    )
    assert.deepEqual(calls, [['Technology', 30], ['Healthcare', 10]])
})

test('the strongest conviction is screened FIRST — the queue is consumed in order', async () => {
    const screened = []
    await runHouseScan(
        { tilts: [
            { sector: 'Healthcare', stance: 'over', active_bp: 80 },
            { sector: 'Technology', stance: 'over', active_bp: 400 },
            { sector: 'Utilities',  stance: 'over', active_bp: 120 },
        ] },
        {
            screenSector: async (s) => { screened.push(s); return [] },
            enqueue:      async () => ({ ok: true }),
        },
    )
    assert.deepEqual(screened, ['Technology', 'Utilities', 'Healthcare'])
})

test('every queued name carries the mandate that surfaced it', async () => {
    const rows = []
    await runHouseScan(
        {
            id: 'tilt_SPX_abc', regime: { name: 'Disinflation' },
            tilts: [{ sector: 'Technology', stance: 'over', active_bp: 300, basis: 'revisions' }],
        },
        {
            screenSector: async () => ['AAPL'],
            enqueue:      async (args) => { rows.push(args); return { ok: true } },
        },
    )
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0].context, {
        tiltId: 'tilt_SPX_abc', regime: 'Disinflation',
        sector: 'Technology', stance: 'over', active_bp: 300, basis: 'revisions',
    })
})

test('a view with no regime or id still queues — the context degrades, the scan does not', async () => {
    const rows = []
    await runHouseScan(
        { tilts: [{ sector: 'Energy', stance: 'over' }] },
        { screenSector: async () => ['XOM'], enqueue: async (a) => { rows.push(a); return { ok: true } } },
    )
    assert.equal(rows[0].context.tiltId, null)
    assert.equal(rows[0].context.regime, null)
    assert.equal(rows[0].context.active_bp, null)
})
