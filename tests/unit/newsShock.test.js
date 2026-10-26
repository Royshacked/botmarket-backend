import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findShocks, shockTrades, sizeBand, classifyHeadlines, headlinesFor, peerReaction, industryDays, peerRows } from '../../services/newsShock.service.js'
import { prepare } from '../../services/screenerLab.data.js'

// After the news (Roy, 2026-10-26: test A) — a 5%+ day on twice the volume, bought at the next open.

const DAY = 86_400_000
function bars(start, n, f) {
    const out = []
    for (let t = Date.parse(`${start}T04:00:00Z`), i = 0; out.length < n; t += DAY) {
        const d = new Date(t).getUTCDay()
        if (d === 0 || d === 6) continue
        const b = f(i++)
        out.push({ timestamp: t / 1000, open: b.open ?? b.close, high: b.close * 1.01, low: b.close * 0.99, close: b.close, volume: b.volume ?? 1e6 })
    }
    return out
}
const etDay = (b) => new Date(b.timestamp * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

function fixture({ shockAt = 40, jump = 1.1, vol = 3e6, report = false } = {}) {
    const n = 80
    const rows = bars('2025-06-02', n, (i) => ({ close: i < shockAt ? 50 : i === shockAt ? 50 * jump : 50 * jump + (i - shockAt) * 0.1,
        open: i === shockAt + 1 ? 50 * jump + 0.2 : undefined, volume: i === shockAt ? vol : 1e6 }))
    const ds = rows.map(etDay)
    const raw = { names: { A: rows }, spy: bars('2025-06-02', n, () => ({ close: 500 })), sectors: {}, calendar_from: '2025-06-02',
        calendar: report ? [{ symbol: 'A', date: ds[shockAt - 1] }] : [] }
    return { data: prepare(raw), ds, shockAt }
}

test('a shock: 5%+ against SPY on 2x the dollar volume; a report that day or the day before marks it', () => {
    const { data, ds, shockAt } = fixture()
    const [k, ...rest] = findShocks(data)
    assert.equal(rest.length, 0, 'only the jump')
    assert.equal(k.day, ds[shockAt])
    assert.equal(k.dir, 'up')
    assert.equal(Math.round(k.size), 10)
    assert.ok(k.volx > 2)
    assert.equal(k.report, false)
    assert.equal(findShocks(fixture({ report: true }).data)[0].report, true, 'a report the session before counts — the bell is unknown')
})

test('no shock without the volume, or under the size; a fall is a down shock', () => {
    assert.equal(findShocks(fixture({ vol: 1.5e6 }).data).length, 0, '1.5x volume is not enough')
    assert.equal(findShocks(fixture({ jump: 1.04 }).data).length, 0, '4% is under the bar')
    assert.equal(findShocks(fixture({ jump: 0.9 }).data)[0].dir, 'down')
})

test('the trade is bought at the NEXT open — the shock day itself is never in it', () => {
    const { data, ds, shockAt } = fixture()
    const [t] = shockTrades(data, findShocks(data), 5, (k) => k.dir)
    assert.equal(t.day, ds[shockAt + 1])
    assert.equal(t.tag, 'up')
    assert.equal(t.gap, Math.round((55.2 / 55 - 1) * 10000) / 100, 'the next open against the shock close')
    const entry = 55.2, exit = 55 + (shockAt + 5 - shockAt) * 0.1
    assert.ok(Math.abs(t.ret - (exit / entry - 1) * 100) < 1e-9)
    assert.equal(shockTrades(data, findShocks(data), 5, () => null).length, 0, 'a null tag drops the trade')
})

test('size bands', () => {
    assert.equal(sizeBand(6), '5-10%')
    assert.equal(sizeBand(-12), '10-20%')
    assert.equal(sizeBand(25), '20%+')
})

test('headline types: the first type in order wins; none matched is other; none at all is no headline', () => {
    assert.equal(classifyHeadlines(['Analyst upgrades X', 'X to acquire Y for $2B']), 'deal', 'the deal outranks the note that follows it')
    assert.equal(classifyHeadlines(['FDA approves drug']), 'fda/trial')
    assert.equal(classifyHeadlines(['X prices $500M offering']), 'offering')
    assert.equal(classifyHeadlines(['X raises full-year guidance']), 'guidance')
    assert.equal(classifyHeadlines(['Morgan Stanley downgrades X']), 'analyst')
    assert.equal(classifyHeadlines(['Why X stock is soaring today']), 'other')
    assert.equal(classifyHeadlines([]), 'no headline')
    assert.equal(classifyHeadlines(undefined), 'no headline')
})

test('headlines: from 16:00 the session before to 13:00 on the entry day, by symbol', () => {
    const news = [
        { symbol: 'a', title: 'too early', publishedDate: '2026-01-05 15:59:00' },
        { symbol: 'A', title: 'after the close', publishedDate: '2026-01-05 16:00:00' },
        { symbol: 'A', title: 'shock day', publishedDate: '2026-01-06 11:00:00' },
        { symbol: 'A', title: 'before the entry', publishedDate: '2026-01-07 12:59:00' },
        { symbol: 'A', title: 'too late', publishedDate: '2026-01-07 13:00:00' },
        { symbol: 'B', title: '', publishedDate: '2026-01-06 11:00:00' },
    ]
    const h = headlinesFor(news, '2026-01-05', '2026-01-07')
    assert.deepEqual(h.get('A'), ['after the close', 'shock day', 'before the entry'])
    assert.equal(h.has('B'), false, 'no title, no headline')
})

test('the peer’s reaction: under 2% is quiet; otherwise along or against the shock', () => {
    assert.equal(peerReaction('up', 1.9), 'quiet')
    assert.equal(peerReaction('up', 2.5), 'along')
    assert.equal(peerReaction('up', -2.5), 'against')
    assert.equal(peerReaction('down', -3), 'along')
    assert.equal(peerReaction('down', 3), 'against')
})

test('industry-days: one per industry and session; a day with shocks both ways is dropped', () => {
    const industryOf = new Map([['A', 'X'], ['B', 'X'], ['C', 'Y'], ['D', 'Y']])
    const g = industryDays([
        { symbol: 'A', day: 'd1', dir: 'up', report: false }, { symbol: 'B', day: 'd1', dir: 'up', report: true },
        { symbol: 'C', day: 'd1', dir: 'up', report: false }, { symbol: 'D', day: 'd1', dir: 'down', report: false },
        { symbol: 'Z', day: 'd1', dir: 'up', report: false },
    ], industryOf)
    assert.equal(g.length, 1, 'Y is mixed, Z has no industry')
    assert.equal(g[0].industry, 'X')
    assert.equal(g[0].report, true, 'any shocker reporting marks the day')
    assert.deepEqual([...g[0].shockers].sort(), ['A', 'B'])
})

test('peer rows: the shocker is not its own peer; the day-0 move, the reaction, and the leader by the cap THAT DAY', () => {
    const n = 60, at = 40
    // L shocks +10%; P is flat on the day; Q rises 3%. L is smaller TODAY than P, but P has tripled since the shock —
    // on the day, L was the bigger one.
    const mk = (f) => bars('2025-06-02', n, f)
    const raw = { spy: mk(() => ({ close: 500 })), sectors: {}, calendar_from: '2025-06-02', calendar: [], names: {
        L: mk((i) => ({ close: i < at ? 50 : 55, volume: i === at ? 3e6 : 1e6 })),
        // P's dollar volume held flat, so its own jump after is no shock.
        P: mk((i) => ({ close: i <= at ? 50 : 150, volume: 50e6 / (i <= at ? 50 : 150) })),
        Q: mk((i) => ({ close: i < at ? 50 : 51.5 })),
        R: mk(() => ({ close: 50 })),
    } }
    const data = prepare(raw)
    const industryOf = new Map([['L', 'X'], ['P', 'X'], ['Q', 'X'], ['R', 'X']])
    const capOf = new Map([['L', 2e9], ['P', 3e9], ['Q', 1e9], ['R', 1e9]])
    const idays = industryDays(findShocks(data), industryOf)
    const rows = peerRows(data, idays, { industryOf, capOf })
    assert.deepEqual(rows.map(r => r.symbol).sort(), ['P', 'Q', 'R'])
    const p = rows.find(r => r.symbol === 'P'), q = rows.find(r => r.symbol === 'Q')
    assert.equal(p.reaction, 'quiet')
    assert.equal(q.reaction, 'along')
    assert.equal(Math.round(q.day0), 3)
    assert.equal(p.leader, true, 'P was $1B on the shock day against L’s $2B — today’s caps would say the opposite')
    assert.equal(peerRows(data, idays, { industryOf, capOf, minMembers: 5 }).length, 0, 'an industry under minMembers is skipped')
})
