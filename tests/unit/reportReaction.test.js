import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectReports, reactionAt, spyOver200, REPORT_FEATURES } from '../../services/reportReaction.service.js'
import { prepare, targetRow } from '../../services/screenerLab.data.js'

// Can the run-up trade the report (Roy, 2026-10-26: test C) — what is known the evening before, against the reaction.

const DAY = 86_400_000
function bars(start, n, f) {
    const out = []
    for (let t = Date.parse(`${start}T04:00:00Z`), i = 0; out.length < n; t += DAY) {
        const d = new Date(t).getUTCDay()
        if (d === 0 || d === 6) continue
        const b = f(i++)
        out.push({ timestamp: t / 1000, open: b.open ?? b.close, high: b.close * 1.01, low: b.close * 0.99, close: b.close, volume: 1e6 })
    }
    return out
}
const etDay = (b) => new Date(b.timestamp * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

function fixture() {
    const n = 300, R = [60, 120, 180, 240]
    // Flat at 50; the session after each report it is 10% higher, and stays there.
    const rows = bars('2024-01-02', n, (i) => ({ close: 50 * 1.1 ** R.filter(k => i > k).length }))
    const ds = rows.map(etDay)
    const rep = (k, a, e) => ({ symbol: 'A', date: ds[k], epsActual: a, epsEstimated: e, revenueActual: 110, revenueEstimated: 100 })
    const raw = { names: { A: rows }, spy: bars('2024-01-02', n, (i) => ({ close: 400 + i })), sectors: {}, calendar_from: ds[0],
        calendar: [rep(R[0], 1.2, 1), rep(R[1], 1.2, 1), rep(R[2], 1.2, 1), { symbol: 'A', date: ds[R[3]], epsActual: null, epsEstimated: 1.5 }] }
    const g = (k) => ds[R[3] - k]
    const extras = {
        grades: { A: [[g(70), 'upgrade'], [g(30), 'upgrade'], [g(10), 'downgrade'], [ds[R[3]], 'upgrade']] },
        targets: { A: [[g(20), 70, 60, 1], [g(10), 66, 60, 1], [g(5), 50, 60, -1], [g(80), 90, 60, 0], [ds[R[3]], 99, 60, 1]] },
    }
    return { data: prepare(raw, extras), ds, R }
}

test('the reaction: the close before the report to the close after, less SPY’s', () => {
    const { data, R } = fixture()
    const s = data.names.get('A')
    const spy = (400 + R[1] + 1) / (400 + R[1] - 1) - 1
    assert.ok(Math.abs(reactionAt(s, R[1], data) - ((1.1 - 1) - spy) * 100) < 1e-9)
    assert.equal(reactionAt(s, s.rows.length - 1, data), null, 'no session after the last')
})

test('the facts the evening before: the last three reports, the analysts in their windows (the report day itself excluded)', () => {
    const { data, ds, R } = fixture()
    const rows = collectReports(data)
    const r = rows.find(x => x.week === ds[R[3]])
    assert.equal(r.f.beats3, 3)
    assert.equal(Math.round(r.f.last_surprise), 20)
    assert.equal(Math.round(r.f.last_rev_surprise), 10)
    assert.ok(r.f.last_reaction > 9, 'the last report’s own +10% (less a little SPY)')
    assert.equal(r.f.exp_growth, null, 'no report a year (four reports) before')
    assert.equal(r.f.net_upgrades60, 0, 'one upgrade and one downgrade inside 60 days; the 70-day-old one and the report day out')
    assert.equal(r.f.pt_net45, 1, 'two raises and a cut; the report day’s note out')
    assert.equal(r.f.pt_count45, 3)
    assert.equal(Math.round(r.f.pt_upside), 10, 'the median of 70, 66 and 50 over 60 → 66/60; the note 80 sessions back is past 90 calendar days')
    assert.equal(r.f.spy_over200, 1)
    assert.equal(r.rule, true, 'the last three beat, SPY over its 200-day')
    assert.equal(r.x.length, REPORT_FEATURES.length)
})

test('a report under 61 sessions of history is left out; one with too few priors has no streak', () => {
    const { data, ds, R } = fixture()
    const rows = collectReports(data)
    assert.equal(rows.some(x => x.week === ds[R[0]]), false)
    assert.equal(rows.find(x => x.week === ds[R[1]]).f.beats3, null)
    assert.equal(collectReports(data, { from: ds[R[3]] }).length, 1, '`from` bounds it')
})

test('SPY over its 200-day: none before 200 sessions', () => {
    const { data } = fixture()
    const m = spyOver200(data)
    assert.equal(m.has(data.spyDays[198]), false)
    assert.equal(m.get(data.spyDays[250]), 1)
})

test('a price-target note: the ET day, the target, the price, the direction off the title', () => {
    assert.deepEqual(targetRow({ publishedDate: '2026-10-20T01:00:09.000Z', priceTarget: 283, priceWhenPosted: 342.9, newsTitle: 'Apple price target lowered to $283 from $304' }),
        ['2026-10-19', 283, 342.9, -1])
    assert.equal(targetRow({ publishedDate: '2026-10-20T15:00:00Z', newsTitle: 'X price target raised to $50' })[3], 1)
    assert.equal(targetRow({ publishedDate: '2026-10-20T15:00:00Z', newsTitle: 'Y initiated with a Buy' })[3], 0)
    assert.equal(targetRow({ publishedDate: '2026-10-20T15:00:00Z', newsTitle: 'Executive cuts ribbon' })[3], -1, 'crude: a keyword on the title')
})
