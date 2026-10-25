import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseShortVolume, shortInterestOn, shortInterestDates, shortVolumeOn } from '../../providers/finra.provider.js'
import { siKnownOn, siAsOf, svBucket, HYPOTHESES, indicators } from '../../services/screenerLab.service.js'
import { prepare } from '../../services/screenerLab.data.js'

// Short interest and short volume from FINRA (2026-10-25) — the provider, and the lab's tests on them.

test('the daily short-volume file: pipe rows by symbol, the header and junk skipped', () => {
    const m = parseShortVolume('Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\r\n20251103|aapl|500|5|1000|B,Q,N\r\n20251103|X|1|0|10|Q\r\n\r\n')
    assert.deepEqual(m.get('AAPL'), { short: 500, exempt: 5, total: 1000 })
    assert.equal(m.size, 2)
})

test('short interest: paged by 5,000 until a short page; the dates off one symbol; a holiday file is empty', async () => {
    const pages = []
    const get = async (url, { body }) => { pages.push(body.offset); return body.offset === 0 ? Array.from({ length: 5000 }, (_, k) => ({ symbolCode: `S${k}`, settlementDate: '2024-03-15', daysToCoverQuantity: 2 })) : [{ symbolCode: 'aapl', settlementDate: '2024-03-15', currentShortPositionQuantity: 10, daysToCoverQuantity: 1.5, changePercent: 4 }] }
    const rows = await shortInterestOn('2024-03-15', { get })
    assert.deepEqual(pages, [0, 5000])
    assert.equal(rows.length, 5001)
    assert.deepEqual(rows.at(-1), { symbol: 'AAPL', settlement: '2024-03-15', short: 10, previous: null, adv: null, dtc: 1.5, change_pct: 4 })
    assert.deepEqual(await shortInterestDates('2024-01-01', '2024-04-01', { get: async () => [{ settlementDate: '2024-03-15' }, { settlementDate: '2024-02-29' }, { settlementDate: '2024-03-15' }] }), ['2024-02-29', '2024-03-15'])
    assert.equal((await shortVolumeOn('2024-12-25', { fetchFn: async () => ({ status: 403 }) })).size, 0)
})

test('the lab: a report counts from its publication, once; the short-volume spike against the name’s own', () => {
    const DAY = 86_400_000
    const days = [], rows = []
    for (let t = Date.parse('2024-01-02T17:00:00Z'); rows.length < 120; t += DAY) {
        const d = new Date(t)
        if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue
        days.push(d.toISOString().slice(0, 10))
        rows.push({ timestamp: t / 1000, open: 10, high: 10.1, low: 9.9, close: 10, volume: 1e6 })
    }
    const sv = Object.fromEntries(days.map((d, k) => [d, { X: k >= 110 ? 600 : 400 }]))
    const data = prepare({ names: { X: rows }, spy: rows, sectors: {}, calendar: [], calendar_from: days[0] },
        { shortInterest: { '2024-03-15': [['X', 1000, 8.5, 30]] }, shortVolume: sv })
    const s = data.names.get('X')
    assert.equal(s.si[0].known, '2024-03-27', 'twelve days after settlement')
    const first = s.ind.date.findIndex(d => d > '2024-03-27')
    assert.equal(siKnownOn(s, s.ind, first).dtc, 8.5, 'the session after it was known')
    assert.equal(siKnownOn(s, s.ind, first + 1), null, 'once')
    assert.equal(siAsOf(s, '2024-03-26'), null)
    assert.equal(HYPOTHESES.si_level.signal({ i: first, ind: s.ind, name: s }), '7+ days')
    assert.equal(HYPOTHESES.si_change.signal({ i: first, ind: s.ind, name: s }), 'up 25%+')
    assert.equal(svBucket(s, s.ind, 115), 'spike +10pts', '60% against its usual 40%')
    assert.equal(svBucket(s, s.ind, 100), 'normal')
    assert.ok(indicators)
})

test('dark pools: a week’s ATS share of its own volume, its jump over the name’s eight before, from its publication', async () => {
    const { atsWeek } = await import('../../providers/finra.provider.js')
    const { dpShares, dpPublishedOn } = await import('../../services/screenerLab.service.js')
    const got = await atsWeek('2024-03-11', { get: async () => [{ issueSymbolIdentifier: 'x', weekStartDate: '2024-03-11', totalWeeklyShareQuantity: 10, totalWeeklyTradeCount: 2, initialPublishedDate: '2024-03-25', tierIdentifier: 'T1' }] })
    assert.deepEqual(got, [{ symbol: 'X', week: '2024-03-11', shares: 10, trades: 2, published: '2024-03-25', tier: 'T1' }])
    const DAY = 86_400_000, rows = [], mondays = []
    for (let t = Date.parse('2024-01-01T17:00:00Z'); rows.length < 100; t += DAY) {
        const d = new Date(t)
        if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue
        if (d.getUTCDay() === 1) mondays.push(d.toISOString().slice(0, 10))
        rows.push({ timestamp: t / 1000, open: 10, high: 10.1, low: 9.9, close: 10, volume: 1e6 })
    }
    // 10% of each week's 5M shares in dark pools, then 20% in the ninth week; each published two weeks on.
    const pub = (w) => new Date(Date.parse(`${w}T12:00:00Z`) + 14 * DAY).toISOString().slice(0, 10)
    const dp = mondays.slice(0, 9).map((w, k) => ['X', k === 8 ? 1e6 : 5e5, pub(w)])
    const data = prepare({ names: { X: rows }, spy: rows, sectors: {}, calendar: [], calendar_from: '2024-01-01' }, { darkPool: Object.fromEntries(mondays.slice(0, 9).map((w, k) => [w, [dp[k]]])) })
    const s = data.names.get('X')
    const xs = dpShares(s, s.ind)
    assert.equal(xs.length, 8, 'the first week has no close before it')
    assert.equal(Math.round(xs[0].share), 10)
    assert.equal(xs[2].jump, null, 'under four weeks before it')
    assert.equal(Math.round(xs[7].jump), 10, '20% against its usual 10%')
    const i = s.ind.date.findIndex(d => d > pub(mondays[8]))
    assert.equal(dpPublishedOn(s, s.ind, i).week, mondays[8])
    assert.equal(HYPOTHESES.dp_jump.signal({ i, ind: s.ind, name: s }), 'jump +5pts+ · price up')
    assert.equal(HYPOTHESES.dp_jump.signal({ i: i + 1, ind: s.ind, name: s }), null, 'once')
})
