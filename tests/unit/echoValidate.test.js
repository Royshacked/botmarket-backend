import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draw, stats, standInsFor, dueHorizons, gradeEvent, report, _setDeps } from '../../services/echoValidate.service.js'

// Echo Step 7 — validation to the simulator doc (docs/design/echo-pipeline.md).

test('the stand-in draw: the same every time for an event and link, different across them', () => {
    const pool = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
    assert.deepEqual(draw(pool, 5, 'ev|FN'), draw([...pool].reverse(), 5, 'ev|FN'), 'order of the pool does not matter')
    assert.notDeepEqual(draw(pool, 5, 'ev|FN'), draw(pool, 5, 'ev|JBL'))
    assert.equal(new Set(draw(pool, 5, 'x')).size, 5)
})

test("the doc's distribution: mean, median, up 20%+, down 10%+", () => {
    assert.deepEqual(stats([0.3, -0.15, 0.05, 0.0]), { n: 4, mean: 0.05, median: 0.025, up20: 0.25, down10: 0.25 })
    assert.equal(stats([null]).n, 0)
})

test('stand-ins: same sector, half to twice the size, never on the map', async () => {
    let asked
    _setDeps({ screen: async (q) => { asked = q; return [{ symbol: 'FN' }, { symbol: 'X1' }, { symbol: 'X2' }, { symbol: 'BRK.B' }, { symbol: 'X3' }, { symbol: 'X4' }, { symbol: 'X5' }, { symbol: 'X6' }] } })
    const s = await standInsFor({ _id: 'ev' }, { ticker: 'JBL', sector: 'Technology', marketCap: 20e9 }, new Set(['FN', 'JBL']))
    assert.match(asked, /sector=Technology&marketCapMoreThan=10000000000&marketCapLowerThan=40000000000/)
    assert.equal(s.length, 5)
    assert.ok(!s.includes('FN') && !s.includes('BRK.B'))
    assert.deepEqual(await standInsFor({ _id: 'ev' }, { ticker: 'Q', sector: null, marketCap: 1 }, new Set()), [], 'no sector, no stand-ins')
})

test('the horizons come due h sessions after the day-5 close', () => {
    const sessions = Array.from({ length: 30 }, (_, i) => `d${String(i).padStart(3, '0')}`)
    assert.deepEqual(dueHorizons({ check: { checkDay: 'd000' } }, sessions), [5, 20])
    assert.deepEqual(dueHorizons({ check: { checkDay: 'd000' }, grades: { 5: {} } }, sessions), [20])
    assert.deepEqual(dueHorizons({ check: { checkDay: 'd025' } }, sessions), [])
})

const row = (ticker, x5) => ({ ticker, horizons: { 5: { xsSpyReaction: x5 } } })

test('gradeEvent: flagged vs their stand-ins and vs the unflagged, signed by direction, from the day-5 close', async () => {
    const writes = []
    _setDeps({
        now: () => new Date('2026-12-01T00:00:00Z'),
        screen: async () => ['S1', 'S2', 'S3', 'S4', 'S5'].map(symbol => ({ symbol })),
        events: { advance: async (id, status, patch) => { writes.push(patch) } },
        calendar: async () => ['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27'],
        returns: async (from) => {
            assert.deepEqual(from, { _id: 'ev', date: '2026-11-19', timing: 'after_close' }, 'the window opens at the day-5 close')
            return { sessions: ['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27'],
                rows: [row('VRT', 0.10), row('DVA', -0.02), row('ANET', 0.02), ...['S1', 'S2', 'S3', 'S4', 'S5'].map(s => row(s, 0.01))] }
        },
    })
    const ev = { _id: 'ev', status: 'watching', originTickers: ['NVDA'],
        map: { links: [{ ticker: 'VRT', sector: 'Industrials', marketCap: 40e9 }, { ticker: 'DVA', sector: 'Healthcare', marketCap: 10e9 }, { ticker: 'ANET', sector: 'Technology', marketCap: 100e9 }] },
        check: { checkDay: '2026-11-19', links: [
            { ticker: 'VRT', direction: 'gains', flag: 'underreacted_winner' },
            { ticker: 'DVA', direction: 'loses', flag: 'overreacted_loser' },
            { ticker: 'ANET', direction: 'gains', flag: 'fully_priced' },
            { ticker: 'PEER', direction: 'unclear', flag: null }] } }
    const r = await gradeEvent(ev)
    assert.deepEqual(r.graded, [5])
    const g = r.grades[5]
    assert.deepEqual(g.rows.map(x => [x.ticker, x.group, x.signed]), [['VRT', 'flagged', 0.10], ['DVA', 'flagged', 0.02], ['ANET', 'unflagged', 0.02]])
    assert.equal(g.standIns.DVA[0].signed, -0.01, "a loser's stand-ins are signed as it is")
    assert.ok(Math.abs(g.vsStandIns - (0.06 - 0)) < 1e-12, 'flagged mean 6%; stand-ins +1% and -1% net 0')
    assert.ok(Math.abs(g.vsUnflagged - 0.04) < 1e-12)
    assert.ok(writes[0].grades[5])
})

test('the report: distributions per horizon, each factor alone, and whether walk-forward is ready', () => {
    const ev = (signedVrt, scoreBneck) => ({
        scores: { links: [{ ticker: 'VRT', factors: { bottleneck: { score: scoreBneck }, coverage: { score: 1 } } }, { ticker: 'X', factors: { bottleneck: { score: 0 } } }] },
        grades: { 20: { rows: [{ ticker: 'VRT', group: 'flagged', signed: signedVrt }, { ticker: 'X', group: 'unflagged', signed: 0 }], vsStandIns: signedVrt, vsUnflagged: signedVrt } },
    })
    const r = report([ev(0.3, 2), ev(0.1, 2)])
    assert.equal(r.horizons[20].events, 2)
    assert.equal(r.horizons[20].flagged.up20, 0.5)
    assert.ok(Math.abs(r.factors[20].bottleneck.separates - 0.2) < 1e-12, 'bottleneck 2 names +20% on average vs 0 for the 0s')
    assert.equal(r.factors[20].coverage.separates, null, 'no 2s and 0s to compare')
    assert.equal(r.walkForward.ready, false)
    assert.match(r.walkForward.note, /^0 of 30 events graded at 120 sessions/)
})

test('nothing due: no name fetched, the next grade dated from the calendar (CR 2026-11-19)', async () => {
    const writes = []
    let fetched = 0
    _setDeps({
        now: () => new Date('2026-11-21T00:00:00Z'), events: { advance: async (id, status, patch) => { writes.push(patch) } },
        calendar: async () => ['2026-11-19', '2026-11-20'], returns: async () => { fetched++; return { sessions: [], rows: [] } }, screen: async () => { fetched++; return [] },
    })
    const r = await gradeEvent({ _id: 'ev', status: 'watching', check: { checkDay: '2026-11-19', links: [] } })
    assert.deepEqual(r.graded, [])
    assert.equal(fetched, 0)
    assert.match(writes[0].nextGradeAt, /^2026-11-2[5-7]T21:45:00\.000Z$/, 'about five sessions after the day-5 close')
})

test('the grade is of the DAY-5 flags, never a flag a later rescore moved', async () => {
    _setDeps({
        now: () => new Date('2026-12-01T00:00:00Z'), events: { advance: async () => {} }, screen: async () => [],
        calendar: async () => ['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27'],
        returns: async () => ({ sessions: ['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27'], rows: [row('VRT', 0.1), row('ANET', 0.02)] }),
    })
    const r = await gradeEvent({ _id: 'ev', status: 'watching', map: { links: [] }, check: { checkDay: '2026-11-19',
        flagsAtDay5: { VRT: null, ANET: 'underreacted_winner' },
        links: [{ ticker: 'VRT', direction: 'gains', flag: 'underreacted_winner' }, { ticker: 'ANET', direction: 'gains', flag: null }] } })
    assert.deepEqual(r.grades[5].rows.map(x => [x.ticker, x.group]), [['VRT', 'unflagged'], ['ANET', 'flagged']])
})
