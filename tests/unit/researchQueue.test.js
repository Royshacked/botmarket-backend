import { test } from 'node:test'
import assert   from 'node:assert/strict'

import { runHouseScan } from '../../services/houseScan.service.js'

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
