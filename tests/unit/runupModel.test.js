import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectRunups, runupExtras, sectorSeasons, RUNUP_FEATURES, CSV_HEAD, csvRow } from '../../services/runupModel.service.js'
import { prepare } from '../../services/screenerLab.data.js'

// A model on the run-up (Roy, 2026-10-27: test K) — every run-up entry with the facts known the evening before it.

const DAY = 86_400_000
function bars(start, n, f) {
    const out = []
    for (let t = Date.parse(`${start}T04:00:00Z`), i = 0; out.length < n; t += DAY) {
        const d = new Date(t).getUTCDay()
        if (d === 0 || d === 6) continue
        const b = f(i++)
        out.push({ timestamp: t / 1000, open: b.close, high: b.close * 1.01, low: b.close * 0.99, close: b.close, volume: 1e6 })
    }
    return out
}
const etDay = (b) => new Date(b.timestamp * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

function fixture() {
    const n = 400, R = [100, 170, 240, 330]
    const rows = bars('2024-01-02', n, (i) => ({ close: 50 + i * 0.05 }))
    const ds = rows.map(etDay)
    const rep = (k, a, e) => ({ symbol: 'A', date: ds[k], epsActual: a, epsEstimated: e, revenueActual: 110, revenueEstimated: 100 })
    const raw = { names: { A: rows }, spy: bars('2024-01-02', n, (i) => ({ close: 400 + i })), sectors: { A: 'Tech' }, calendar_from: ds[0],
        calendar: [rep(R[0], 1, 1.1), rep(R[1], 1.2, 1), rep(R[2], 1.2, 1), { symbol: 'A', date: ds[R[3]], epsActual: null, epsEstimated: 1.5 }] }
    const e = R[3] - 5 // the entry bar; its evening before is e − 1
    const extras = {
        grades: { A: [[ds[e - 1], 'upgrade'], [ds[e], 'downgrade'], [ds[e - 80], 'downgrade']] },
        insiders: { A: [{ filingDate: ds[e - 2], transactionType: 'P-Purchase', reportingCik: '1', securitiesTransacted: 10, price: 5 },
            { filingDate: ds[e - 3], transactionType: 'P-Purchase', reportingCik: '1', securitiesTransacted: 10, price: 5 },
            { filingDate: ds[e], transactionType: 'P-Purchase', reportingCik: '2', securitiesTransacted: 10, price: 5 }] },
    }
    return { data: prepare(raw, extras), ds, R, e }
}

test('one entry per report, 5 sessions before it, out at the close before; the live gate needs 3 of 3 beat and SPY over its 200-day', () => {
    const { data, ds, R, e } = fixture()
    const rows = collectRunups(data)
    const last = rows.find(r => r.report_day === ds[R[3]])
    assert.equal(last.day, ds[e])
    assert.equal(last.exit_day, ds[R[3] - 1])
    assert.equal(last.live, 0, 'the report at R[0] missed — 2 of 3 beat')
    assert.equal(rows.filter(r => r.report_day === ds[R[3]]).length, 1)
    assert.ok(Number.isFinite(last.net))
    assert.deepEqual(Object.keys(last.f), [...RUNUP_FEATURES])
    assert.equal(last.f.spy_calm, 1, 'a steady SPY is calm')
})

test('the facts are known by the evening before the entry: the entry day’s grade and filing are out', () => {
    const { data, ds, R, e } = fixture()
    const s = data.names.get('A')
    s.reportDates = [...s.reports.keys()].sort()
    const f = runupExtras(s, data, e, ds[R[3]], sectorSeasons(data))
    assert.equal(f.net_upgrades60, 1, 'the upgrade the evening before in, the entry day’s downgrade and the 80-session-old one out')
    assert.equal(f.insider_buyers90, 1, 'one distinct buyer before the entry; the second filed on the entry day')
    assert.equal(f.exp_growth, null, 'three reports with an actual before — none a year (four) back')
    assert.equal(f.si_dtc, null, 'no short data')
    assert.equal(f.season_beat_share, null, 'under five reports in the sector’s 30 days')
})

test('the season: the sector’s reports in the 30 days to the evening before, the share that beat', () => {
    const { data, ds, e } = fixture()
    const s = data.names.get('A')
    s.reportDates = [...s.reports.keys()].sort()
    const day = ds[e - 1]
    const at = (k) => new Date(Date.parse(`${day}T12:00:00Z`) - k * DAY).toISOString().slice(0, 10)
    const seasons = new Map([['Tech', [{ day: at(40), beat: 0 }, { day: at(20), beat: 1 }, { day: at(10), beat: 1 }, { day: at(5), beat: 0 },
        { day: at(2), beat: 1 }, { day: at(0), beat: 1 }, { day: ds[e], beat: 0 }]]])
    const f = runupExtras(s, data, e, null, seasons)
    assert.equal(f.season_n, 5, 'the 40-day-old one and the entry day’s out')
    assert.equal(f.season_beat_share, 80)
})

test('the CSV: the header and a row line up, a missing fact is empty', () => {
    const { data } = fixture()
    const r = collectRunups(data).at(-1)
    const cells = csvRow(r).split(',')
    assert.equal(cells.length, CSV_HEAD.length)
    assert.equal(cells[CSV_HEAD.indexOf('si_dtc')], '')
})
