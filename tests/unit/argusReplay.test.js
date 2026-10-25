import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seeded, sampleWeek, headlinesBefore, scoreWeek, summarizeArgusReplay, weekMovers, boardFor, replayArgusWeek } from '../../services/argusReplay.service.js'
import { labWeeks, winnersStudy } from '../../services/screenerLab.service.js'
import { prepare } from '../../services/screenerLab.data.js'

// Argus's judgment replayed on past weeks (Roy, 2026-10-25) — the movers, the outcome hidden, his picks scored.

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

// 300 sessions; the last week (5 sessions) is the test week. WILD swings ±15% a day (a mover) and ends +30%; SWAN swings
// as much and ends −30%; CALM is flat — not a mover, never in the sample.
const N = 300
const wild = (end) => (i) => ({ close: i < N - 5 ? 50 * (i % 2 ? 1.15 : 0.87) : 50 * (1 + end * (i - (N - 6)) / 5) })
const raw = {
    names: { WILD: bars('2025-06-02', N, wild(0.3)), SWAN: bars('2025-06-02', N, wild(-0.3)), CALM: bars('2025-06-02', N, () => ({ close: 40 })) },
    spy: bars('2025-06-02', N, () => ({ close: 500 })), sectors: { WILD: 'Technology', SWAN: 'Healthcare' }, calendar: [], calendar_from: '2025-06-02',
}
const data = prepare(raw)

test('the weeks: grouped by Monday, complete only; the winners study takes the top movers, its mirror the bottom', () => {
    assert.deepEqual(labWeeks(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20'], 5), [['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']])
    const up = winnersStudy(data, { weeks: 1, top: 5, min: 5 })
    assert.deepEqual(up.weeks[0].winners.map(w => w.symbol), ['WILD'])
    assert.equal(up.lift.sector.Technology.winners, 100)
    const down = winnersStudy(data, { weeks: 1, top: 5, min: 5, side: 'down' })
    assert.deepEqual(down.weeks[0].winners.map(w => w.symbol), ['SWAN'])
})

test('the movers: volatile names (or reporting), banded by how the week went; CALM is not one', () => {
    const [ds] = labWeeks(data.spyDays, 1)
    const m = weekMovers(data, ds)
    assert.deepEqual(m.map(x => [x.symbol, x.band]).sort(), [['SWAN', 'down'], ['WILD', 'up']])
})

test('the sample: per band, the same draw for the same seed, shuffled', () => {
    const movers = [...Array(30)].map((_, k) => ({ symbol: `S${k}`, band: ['up', 'down', 'flat'][k % 3] }))
    const a = sampleWeek(movers, { per: 4, rand: seeded('2026-10-19') }), b = sampleWeek(movers, { per: 4, rand: seeded('2026-10-19') })
    assert.equal(a.length, 12)
    assert.deepEqual(a, b)
    for (const band of ['up', 'down', 'flat']) assert.equal(a.filter(x => x.band === band).length, 4)
})

test('headlines: only what was out before the cutoff, by symbol', () => {
    const h = headlinesBefore([
        { symbol: 'wild', title: 'A contract', publishedDate: '2026-10-17 20:00:00' },
        { symbol: 'WILD', title: 'After the open', publishedDate: '2026-10-19 14:00:00' },
        { symbol: 'SWAN', title: '', publishedDate: '2026-10-17 20:00:00' },
    ], '2026-10-19 13:00')
    assert.deepEqual([...h.keys()], ['WILD'])
    assert.equal(h.get('WILD').length, 1)
})

test('the board: the live week-column shape, the outcome nowhere on it', () => {
    const [ds] = labWeeks(data.spyDays, 1)
    const sample = weekMovers(data, ds)
    const board = boardFor(data, ds, sample, new Map([['WILD', [{ title: 'A contract', at: '2026-01-01 10:00:00' }]]]))
    assert.deepEqual(board.columns, ['week'])
    assert.equal(board.rows.length, 2)
    const w = board.rows.find(r => r.symbol === 'WILD')
    assert.equal(w.cells.week.grade, 'in play')
    assert.ok(w.cells.week.range, 'the free range from the overnight stats')
    assert.equal(w.news.length, 1)
    assert.ok(!JSON.stringify(board).includes('"net"') && !JSON.stringify(board).includes('band'), 'no outcome on the board')
})

test('scoring: picks, avoids and the rest; summed per call with each week once', async () => {
    const [ds] = labWeeks(data.spyDays, 1)
    const w = await replayArgusWeek(data, ds, { per: 5, deps: {
        rand: seeded('x'), news: async () => [],
        read: async (board) => ({ summary: 's', model: 'm', picks: [{ symbol: 'WILD', column: 'week' }], avoid: [{ symbol: 'SWAN' }], boardRows: board.rows.length }),
    } })
    assert.equal(w.picks.up, 1)
    assert.equal(w.avoid.down, 1)
    assert.ok(w.picks.net_mean > 5 && w.avoid.net_mean < -5)
    const s = summarizeArgusReplay([w, scoreWeek('2026-10-26', [{ symbol: 'A', net: 2, band: 'flat' }], { picks: [{ symbol: 'A' }] })])
    assert.equal(s.picks.names, 2)
    assert.equal(s.picks.weeks, 2)
    assert.equal(s.picks.up_share, 100)
    assert.equal(s.rest.names, 0)
    assert.equal(await replayArgusWeek(data, ds, { deps: { news: async () => [], read: async () => null } }), null, 'a failed read is no week')
})

test('technicals: one line from the overnight stats, the 200-day when given; on the board only with `tech`', async () => {
    const { techLine, boardText } = await import('../../services/hotlist.argus.js')
    const line = techLine({ close: 110, sma20: 100, sma50: 120, ret5: 6.2, rs5: 4.1, ret20: -3, rs20: -5.5, vol5_vs_50: 1.8, high52w: 125, low52w: 55, nr7: true }, { sma200: 90 })
    assert.equal(line, 'trend over 20d · under 50d · over 200d · 5d +6.2% (RS +4.1) · 20d -3.0% (RS -5.5) · vol 1.8× its 50d · 12% under 52w high · 100% over 52w low · NR7')
    assert.equal(techLine(null), null)
    const [ds] = labWeeks(data.spyDays, 1)
    const sample = weekMovers(data, ds)
    assert.equal(boardFor(data, ds, sample).rows[0].tech, undefined, 'off by default — the first run’s board')
    const board = boardFor(data, ds, sample, new Map(), { tech: true })
    assert.match(board.rows[0].tech, /^trend .* 200d · 5d /)
    assert.match(boardText(board), /\| tech: trend /)
})
