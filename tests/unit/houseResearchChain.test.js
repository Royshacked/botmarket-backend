import { test } from 'node:test'
import assert   from 'node:assert/strict'

import { unpackFloats, dailyRows, priceStats, beta, businessStats, estimateStats, orderCandidates, industryCandidates, candidateLine, POOL_MAX }
    from '../../services/houseScan.candidates.js'
import { normalizePicks, codePicks, argusPicks, pickText } from '../../services/houseScan.argus.js'
import { runHouseScan } from '../../services/houseScan.service.js'
import { researchWeek, resumeWeeks, weekSymbols, STALE_CLAIM_MS, BUDGET_WINDOW_MS } from '../../services/houseResearch.service.js'
import { startRun, getRun, researchOpening, offBookHorizon } from '../../services/researchRun.service.js'
import { gradePicks } from '../../api/strategy/pythiaCalls.service.js'
import { weekForTraders } from '../../api/strategy/strategy.controller.js'
import { _tick } from '../../monitoring/pythiaWeekly.monitor.service.js'

// The house research chain (docs/design/house-research-chain.md): Pythia's industries → the candidate list (code) →
// Argus's best 5 → Prometheus's coverage, by itself.

const packed = (xs) => { const b = Buffer.alloc(xs.length * 4); xs.forEach((v, i) => b.writeFloatLE(v ?? NaN, i * 4)); return { _bsontype: 'Binary', buffer: new Uint8Array([...b, 0, 0, 0, 0]), position: b.length } }
const series = (n, f) => Array.from({ length: n }, (_, i) => f(i))

// ─── the candidate list: the numbers ─────────────────────────────────────────

test('a packed field decodes to its numbers, NaN to null, and stops at the Binary position', () => {
    assert.deepEqual(unpackFloats(packed([1.5, null, 3])), [1.5, null, 3])
    assert.deepEqual(dailyRows({ format: 'arrays', close: [1, 'x'], volume: [10, 20] }), { close: [1, null], volume: [10, 20] })
    assert.deepEqual(dailyRows(null), { close: [], volume: [] })
})

test('price numbers: returns over 1/3/6/12 months, dollar volume, the 50-day trend', () => {
    const close = series(280, i => 100 + i)           // steadily up
    const p = priceStats({ close, volume: series(280, () => 1000) })
    assert.equal(p.ret_12m.toFixed(4), (379 / 127 - 1).toFixed(4))
    assert.equal(p.adv20_usd, 1000 * (360 + 379) / 2)
    assert.equal(p.above_50d, true)
    assert.equal(priceStats({ close: [1, 2], volume: [1, 1] }).ret_3m, null, 'too short a window is n/a, not 0')
})

test('beta to the industry: a name moving twice the basket reads 2; too few days is n/a', () => {
    const m = series(100, i => (i % 2 ? 0.01 : -0.01))
    assert.equal(beta(m.map(x => 2 * x), m).toFixed(3), '2.000')
    assert.equal(beta(m.slice(0, 30), m.slice(0, 30)), null)
})

test('the business: ROIC after tax over debt + equity − cash; a financial reads ROE; growth against the prior year', () => {
    const q = (rev, op, ni) => ({ is: { revenue: rev, operatingIncome: op, netIncome: ni, incomeBeforeTax: op, incomeTaxExpense: op * 0.2 }, bs: { totalDebt: 100, totalStockholdersEquity: 300, cashAndCashEquivalents: 0 } })
    const qs = [q(110, 20, 10), q(110, 20, 10), q(110, 20, 10), q(110, 20, 10), q(100, 15, 8), q(100, 15, 8), q(100, 15, 8), q(100, 15, 8)]
    const b = businessStats(qs)
    assert.equal(b.roic.toFixed(3), (80 * 0.8 / 400).toFixed(3))
    assert.equal(b.rev_growth.toFixed(3), '0.100')
    assert.equal(businessStats(qs, { financial: true }).roic.toFixed(4), (40 / 300).toFixed(4))
    assert.equal(businessStats(qs.slice(0, 3)).roic, null, 'under four quarters → n/a')
})

test('the Street: EPS growth from the year in progress to the next', () => {
    const snap = { years: [{ fy_end: '2025-12-31', eps_avg: 5 }, { fy_end: '2026-12-31', eps_avg: 10, n_eps: 4 }, { fy_end: '2027-12-31', eps_avg: 12, n_eps: 6 }] }
    const e = estimateStats(snap, '2026-10-23')
    assert.equal(e.fwd_eps_growth.toFixed(2), '0.20')
    assert.equal(e.analysts, 6)
    assert.equal(estimateStats(null, '2026-10-23').fwd_eps_growth, null)
})

test('the order: named first, then the book — swing leads with relative strength, long term with return on capital', () => {
    const rows = [
        { symbol: 'LAG', rel_6m: -0.2, rel_3m: -0.1, roic: 0.4, market_cap: 9 },
        { symbol: 'LEAD', rel_6m: 0.3, rel_3m: 0.1, roic: 0.05, market_cap: 1 },
        { symbol: 'HER', rel_6m: -0.5, rel_3m: -0.5, roic: 0, market_cap: 1 },
    ]
    assert.deepEqual(orderCandidates(rows, 'swing', { named: ['her'] }).map(r => r.symbol), ['HER', 'LEAD', 'LAG'])
    assert.deepEqual(orderCandidates(rows, 'long_term').map(r => r.symbol), ['LAG', 'LEAD', 'HER'])
    assert.equal(orderCandidates(series(60, i => ({ symbol: `S${i}` })), 'swing').length, POOL_MAX)
})

function fakeDb(collections) {
    return { collection: (name) => ({ find: (q) => {
        let rows = (collections[name] ?? []).filter(r => !q.symbol?.$in || q.symbol.$in.includes(r.symbol))
        const cur = { sort: () => cur, limit: (n) => { rows = rows.slice(0, n); return cur }, toArray: async () => rows }
        return cur
    } }) }
}

test('an industry\'s list: the liquidity floor holds, her named name stays below it, a second-order name never moves the median', async () => {
    const up = (k) => packed(series(280, i => 100 * (1 + k * i / 279)))
    const vol = (v) => packed(series(280, () => v))
    const db = fakeDb({
        daily_prices_recent: [
            { symbol: 'BIG', format: 'packed', close: up(0.5), volume: vol(1e6) },      // ~$100M+/day
            { symbol: 'THIN', format: 'packed', close: up(0.1), volume: vol(10) },      // nothing trades
            { symbol: 'HERS', format: 'packed', close: up(0.2), volume: vol(10) },      // thin, but named
            { symbol: 'FAR', format: 'packed', close: up(5), volume: vol(1e6) },        // second order: +500%
        ],
    })
    const deps = {
        db: async () => db,
        companies: async () => [{ symbol: 'BIG', market_cap: 5e10 }, { symbol: 'THIN', market_cap: 4e8 }, { symbol: 'HERS', market_cap: 5e8 }],
        bySymbol: async (s) => s.map(symbol => ({ symbol, sub_industry: 'Semiconductors', market_cap: 1e10 })),
    }
    const r = await industryCandidates({ code: '1' }, 'swing', { named: ['HERS', 'FAR'], covered: new Set(['BIG']), today: '2026-10-23', deps })
    assert.equal(r.total, 3)
    assert.equal(r.below_floor, 1)
    assert.deepEqual(r.rows.map(x => x.symbol).sort(), ['BIG', 'FAR', 'HERS'])
    const far = r.rows.find(x => x.symbol === 'FAR'), big = r.rows.find(x => x.symbol === 'BIG')
    assert.equal(far.second_order, 'Semiconductors')
    assert.ok(Math.abs(r.industry.ret_6m) < 0.5, 'the industry median is its own companies, not the +500% outsider')
    assert.equal(big.covered, true)
    assert.match(candidateLine(far), /NAMED BY PYTHIA \(second order — in Semiconductors\)/)
    assert.match(candidateLine(big), /\[OUR COVERAGE\]/)
})

test('an industry whose company read fails is an empty list, never a throw', async () => {
    const r = await industryCandidates({ code: '1' }, 'swing', { deps: { db: async () => fakeDb({}), companies: async () => { throw new Error('down') } } })
    assert.deepEqual(r.rows, [])
})

// ─── Argus's pick ─────────────────────────────────────────────────────────────

const ROWS = [{ symbol: 'AAA' }, { symbol: 'BBB' }, { symbol: 'CCC', covered: true }, { symbol: 'DDD', named: true }]
const CASE = { assessment: { verdict: 'swing', horizon: 'months', thesis: 'steel prices', names: [{ symbol: 'DDD', why: 'mini-mill' }] }, subject: 'Steel', rows: ROWS, max: 2 }

test('his answer is held to the list: off-list, covered and repeated picks are dropped, at most max', () => {
    const r = normalizePicks({ picks: [{ symbol: 'zzz' }, { symbol: 'ccc' }, { symbol: 'bbb', why: 'w' }, { symbol: 'BBB' }, { symbol: 'AAA' }, { symbol: 'DDD' }] }, ROWS, 2)
    assert.deepEqual(r.picks.map(p => p.symbol), ['BBB', 'AAA'])
    assert.deepEqual(codePicks(ROWS, 3).map(p => p.symbol), ['AAA', 'BBB', 'DDD'])
    assert.match(pickText(CASE), /SHE NAMED: DDD — mini-mill/)
    assert.match(pickText(CASE), /CHOOSE UP TO 2/)
})

test('a failed, unreadable or all-invalid answer falls back to the code order; an empty list he gave is a "none"', async () => {
    const model = async () => 'm'
    assert.equal((await argusPicks(CASE, { model, send: async () => { throw new Error('429') } })).source, 'code')
    assert.equal((await argusPicks(CASE, { model, send: async () => 'no json here' })).source, 'code')
    const bad = await argusPicks(CASE, { model, send: async () => '{"picks":[{"symbol":"ZZZ"}]}' })
    assert.equal(bad.source, 'code'); assert.deepEqual(bad.picks.map(p => p.symbol), ['AAA', 'BBB'])
    const none = await argusPicks(CASE, { model, send: async () => '{"picks":[],"note":"nothing carries it"}' })
    assert.equal(none.source, 'argus'); assert.deepEqual(none.picks, [])
    let booked = null
    const ok = await argusPicks(CASE, { model, onUsage: (u, m) => { booked = [u, m] }, send: async ({ onUsage }) => { onUsage({ t: 1 }); return '{"picks":[{"symbol":"DDD","why":"pure play","caution":"imports"}]}' } })
    assert.deepEqual(ok.picks, [{ symbol: 'DDD', why: 'pure play', caution: 'imports' }])
    assert.deepEqual(booked, [{ t: 1 }, 'm'])
})

// ─── the house scan with Argus ───────────────────────────────────────────────

function scanDeps(over = {}) {
    const queued = [], attached = [], booked = []
    return { queued, attached, booked, deps: {
        covered: async () => new Set(),
        sub: async (code) => ({ code }),
        candidates: async (sub) => ({ rows: [{ symbol: `${sub.code}1` }, { symbol: `${sub.code}2` }], total: 2 }),
        pick: async ({ rows, max }, { onUsage }) => { onUsage({ usd: 0.002 }, 'luna'); return { picks: rows.slice(0, max).map(r => ({ symbol: r.symbol, why: 'carries it', caution: 'c' })), source: 'argus' } },
        theme: async () => ({ links: [{ code: 'D', name: 'Direct', order: 1 }, { code: 'S', name: 'Supplier', order: 2 }, { code: 'X', name: 'Far', order: 3 }] }),
        assessment: async (r) => ({ subject: r.kind === 'theme' ? { kind: 'theme', id: r.id, name: 'AI' } : { kind: 'industry', code: r.code, name: 'Steel' }, verdict: 'swing', thesis: 't', risks: [] }),
        enqueue: async (row) => { queued.push(row); return { ok: true } },
        rejected: async () => [],
        attachPicks: async (subject, opts) => { attached.push([subject, opts]) },
        costOf: (m, u) => u.usd,
        book: async (userId, model) => { booked.push([userId, model]) },
        perIndustry: () => 5, weeklyMax: () => 50,
        ...over,
    } }
}

test('Argus\'s picks are queued with his reason, frozen on the call, and his spend booked to the week\'s ledger', async () => {
    const { queued, attached, booked, deps } = scanDeps()
    const r = await runHouseScan([{ kind: 'industry', code: 'A', name: 'Steel', outcome: 'published', verdict: 'swing' }], deps, { bookTo: 'admin1' })
    assert.deepEqual(queued.map(q => q.symbol), ['A1', 'A2'])
    assert.deepEqual(queued[0].context.argus, { why: 'carries it', caution: 'c', source: 'argus' })
    assert.equal(attached[0][1].source, 'argus')
    assert.deepEqual(attached[0][1].symbols, ['A1', 'A2'])
    assert.equal(r.cost_usd, 0.002)
    assert.deepEqual(booked, [['admin1', 'luna']])
    assert.equal(r.picks[0].source, 'argus')
})

test('a theme: supplier links first, then direct, order 3 never; one attach for the theme', async () => {
    const { queued, attached, deps } = scanDeps()
    await runHouseScan([{ kind: 'theme', id: 'th_ai', name: 'AI', outcome: 'published', verdict: 'swing' }], deps)
    assert.deepEqual(queued.map(q => q.symbol), ['S1', 'S2', 'D1', 'D2'])
    assert.equal(attached.length, 1)
    assert.equal(attached[0][0].id, 'th_ai')
})

// ─── Prometheus, on her book's horizon ───────────────────────────────────────

test('the opening carries Argus\'s reason and the horizon the book is graded on', () => {
    const o = researchOpening({ symbol: 'nue', context: { pythia: true, verdict: 'swing', kind: 'industry', subject: 'Steel', thesis: 't', argus: { why: 'mini-mill leader', caution: 'imports' } } })
    assert.match(o, /Argus chose it from the industry: mini-mill leader What would make it wrong: imports/)
    assert.match(o, /3m or 6m horizon/)
    assert.doesNotMatch(researchOpening({ symbol: 'X', context: { sector: 'Tech' } }), /horizon/)
})

test('a Pythia name off its book\'s horizon is held; other names never are', () => {
    const item = (verdict) => ({ context: { pythia: true, verdict } })
    assert.equal(offBookHorizon(item('swing'), { price_target: { horizon: '6m' } }), null)
    assert.match(offBookHorizon(item('swing'), { price_target: { horizon: '24m' } }), /24m — swing takes 3m\/6m/)
    assert.equal(offBookHorizon(item('long_term'), { price_target: {} }), null, 'stored as 12m — long term takes it')
    assert.equal(offBookHorizon({ context: { sector: 'x' } }, { price_target: { horizon: '24m' } }), null)
})

async function settled() {
    for (let i = 0; i < 50; i++) { await new Promise(r => setImmediate(r)); if (getRun()?.status !== 'running') return getRun() }
    throw new Error('run never settled')
}
function runDeps(answers) {
    const rejected = [], done = []
    return { rejected, done, deps: {
        listQueue: async () => Object.keys(answers).map(s => ({ id: `rq_${s}`, symbol: s, context: { pythia: true, verdict: 'swing' } })),
        coveredSymbols: async () => new Set(),
        startResearch: async () => ({ ok: true }),
        markDone: async (id) => { done.push(id); return { ok: true } },
        reject: async (id, reason) => { rejected.push([id, reason]); return { ok: true } },
        research: async ({ symbol, onSpend }) => { onSpend({ usd: 0.04 }, 'luna'); return answers[symbol] },
        initiate: async () => ({ ok: true, doc: { id: 'cv' } }),
        costOf: (m, u) => u.usd, houseLedger: async () => null, book: async () => {},
    } }
}

test('the run rejects an off-book horizon with its reason, and stops starting names once the budget is spent', async () => {
    const cov = (h) => ({ coverage: { symbol: 'x', price_target: { horizon: h } } })
    const { rejected, done, deps } = runDeps({ A: cov('24m'), B: cov('3m'), C: cov('3m') })
    await startRun({ userId: null, maxUsd: 0.07 }, deps)
    const run = await settled()
    assert.deepEqual(rejected, [['rq_A', 'horizon_off_book']])
    assert.deepEqual(done, ['rq_B'])
    assert.equal(run.budget_hit, true, 'C waits: the budget was spent after two names')
    assert.equal(run.results.length, 2)
})

// ─── the week's research, by itself ──────────────────────────────────────────

const NOW_MS = Date.parse('2026-10-23T12:00:00Z')
const WEEK = { asof: '2026-10-19', started_at: '2026-10-20T00:00:00Z', house_scan: { queued: [{ symbol: 'nue' }, { symbol: 'STLD' }, { symbol: 'NUE' }] } }

function weekDeps(rows, over = {}) {
    const calls = { starts: [], requeued: [], queries: [] }
    return { calls, deps: {
        // The queue's own filters, so the week's read and the budget's read see what Mongo would give them.
        listQueue: async (q) => {
            calls.queries.push(q); calls.query ??= q
            if (rows === null) return null
            return rows.filter(r => (!q.source || r.source === q.source) && (!q.updatedSince || (r.updated_at ?? '') >= q.updatedSince) && (!q.symbols || q.symbols.includes(r.symbol)))
        },
        requeueStale: async (o) => { calls.requeued.push(o); return { ok: true } },
        startRun: async (o) => { calls.starts.push(o); return { ok: true, run: { id: 'run_1' } } },
        getRun: () => null,
        maxUsd: () => 5,
        ...over,
    } }
}

test('the week researches its queued names as the house, with what is left of its budget', async () => {
    const rows = [
        { symbol: 'NUE', source: 'pythia', status: 'done', cost_usd: 1.5, updated_at: new Date(NOW_MS - 3600e3).toISOString() },
        { symbol: 'STLD', source: 'pythia', status: 'queued' },
        { symbol: 'STLD', source: 'argus', status: 'queued', cost_usd: 9 },   // not the week's
    ]
    const { calls, deps } = weekDeps(rows)
    assert.deepEqual(weekSymbols(WEEK), ['NUE', 'STLD'])
    const r = await researchWeek(WEEK, deps, { now: NOW_MS })
    assert.equal(r.outcome, 'started')
    assert.deepEqual(calls.query, { symbols: ['NUE', 'STLD'], since: WEEK.started_at, limit: 500 })
    assert.deepEqual(calls.starts, [{ userId: null, symbols: ['STLD'], maxUsd: 3.5, source: 'pythia' }])
})

test('a spent budget, a busy run and an unreadable queue start nothing', async () => {
    assert.equal((await researchWeek(WEEK, weekDeps([{ symbol: 'STLD', source: 'pythia', status: 'queued', cost_usd: 6, updated_at: new Date(NOW_MS).toISOString() }]).deps, { now: NOW_MS })).outcome, 'budget_spent')
    assert.equal((await researchWeek(WEEK, weekDeps([{ symbol: 'STLD', source: 'pythia', status: 'queued' }], { startRun: async () => ({ ok: false, reason: 'already_running' }) }).deps)).outcome, 'busy')
    assert.equal((await researchWeek(WEEK, weekDeps(null).deps)).outcome, 'queue_unavailable')
    assert.equal((await researchWeek({}, weekDeps([]).deps)).outcome, 'no_names')
})

test('the pick-up requeues the week\'s dead claims first — and touches nothing while a run is live', async () => {
    const { calls, deps } = weekDeps([{ symbol: 'NUE', source: 'pythia', status: 'queued' }])
    await resumeWeeks([WEEK], deps, { now: 1000 })
    assert.deepEqual(calls.requeued, [{ symbols: ['NUE', 'STLD'], olderThanMs: STALE_CLAIM_MS, now: 1000 }])
    assert.equal(calls.starts.length, 1)
    const busy = weekDeps([], { getRun: () => ({ status: 'running' }) })
    assert.equal((await resumeWeeks([WEEK], busy.deps)).outcome, 'busy')
    assert.equal(busy.calls.requeued.length, 0)
})

test('the monitor tick runs the week, then picks up its research', async () => {
    const order = []
    const r = await _tick({ enabled: () => true, run: async () => { order.push('week'); return { outcome: 'exists' } }, resume: async () => { order.push('research'); return { outcome: 'busy' } } })
    assert.deepEqual(order, ['week', 'research'])
    assert.deepEqual(r, { outcome: 'exists', research: { outcome: 'busy' } })
})

// ─── the record, and who sees what ───────────────────────────────────────────

test('the picks are graded against the basket and against the largest names', () => {
    // The basket is priced again with the picks: X/Y/Z from 20 → 21 is +5% over the picks' own window.
    const picks = { source: 'argus', symbols: ['A', 'B'], largest: ['L'], entry: { A: 10, B: 10, L: 10 }, basket_entry: { X: 20, Y: 20, Z: 20 } }
    const exit = { A: 12, B: 11, L: 10.5, X: 21, Y: 21, Z: 21 }
    const g = gradePicks(picks, exit, ['X', 'Y', 'Z'])
    assert.equal(g.return.toFixed(3), '0.150')
    assert.equal(g.vs_basket.toFixed(3), '0.100')
    assert.equal(g.vs_largest.toFixed(3), '0.100')
    assert.equal(gradePicks(picks, {}, ['X', 'Y', 'Z']), null)
    assert.equal(gradePicks({ ...picks, basket_entry: undefined }, exit, ['X', 'Y', 'Z']), null, 'no basket over the same window → no grade, never a mismatched one')
})

test('a trader sees the queued names, not Argus\'s lists or their spend', () => {
    const t = weekForTraders({ asof: 'x', results: [], house_scan: { queued: [{ symbol: 'NUE' }], cost_usd: 0.01, picks: [{ note: 'n' }] } })
    assert.deepEqual(t.house_scan, { queued: [{ symbol: 'NUE' }] })
})

test('a name already in line is off the list before Argus picks, so it never costs a slot', async () => {
    let seen = null
    const { queued, deps } = scanDeps({
        inLine: async () => [{ symbol: 'A1' }],
        pick: async ({ rows, max }) => { seen = rows.map(r => r.symbol); return { picks: rows.slice(0, max).map(r => ({ symbol: r.symbol })), source: 'argus' } },
    })
    await runHouseScan([{ kind: 'industry', code: 'A', name: 'Steel', outcome: 'published', verdict: 'swing' }], deps)
    assert.deepEqual(seen, ['A2'])
    assert.deepEqual(queued.map(q => q.symbol), ['A2'])
})

test("the pick-up spans the recent weeks: an older week's name goes first, and the budget is the last seven days' spend", async () => {
    const old = { asof: '2026-10-07', started_at: '2026-10-08T00:00:00Z', house_scan: { queued: [{ symbol: 'OLD' }] } }
    const rows = [
        { symbol: 'STLD', source: 'pythia', status: 'queued' },
        { symbol: 'OLD', source: 'pythia', status: 'queued' },
        { symbol: 'NUE', source: 'pythia', status: 'done', cost_usd: 4, updated_at: new Date(NOW_MS - BUDGET_WINDOW_MS - 86400e3).toISOString() },   // eight days ago
    ]
    const { calls, deps } = weekDeps(rows)
    assert.deepEqual(weekSymbols([WEEK, old]), ['OLD', 'NUE', 'STLD'])
    await resumeWeeks([WEEK, old], deps, { now: NOW_MS })
    assert.equal(calls.query.since, old.started_at)
    assert.deepEqual(calls.starts, [{ userId: null, symbols: ['OLD', 'STLD'], maxUsd: 5, source: 'pythia' }], "last week's spend is outside the window")
})

// ─── the code review of 2026-10-23 ──────────────────────────────────────────

test("the budget counts every Pythia name researched in the last seven days, not only this week's", async () => {
    const rows = [
        { symbol: 'STLD', source: 'pythia', status: 'queued' },
        { symbol: 'OLDER', source: 'pythia', status: 'done', cost_usd: 4.5, updated_at: new Date(NOW_MS - 2 * 86400e3).toISOString() },   // an older week's name, two days ago
    ]
    const { calls, deps } = weekDeps(rows)
    await researchWeek(WEEK, deps, { now: NOW_MS })
    assert.deepEqual(calls.starts, [{ userId: null, symbols: ['STLD'], maxUsd: 0.5, source: 'pythia' }])
})

test('a run the admin stopped is not started again by the pick-up', async () => {
    const { calls, deps } = weekDeps([{ symbol: 'NUE', source: 'pythia', status: 'queued' }], { getRun: () => ({ status: 'stopped' }) })
    assert.equal((await resumeWeeks([WEEK], deps)).outcome, 'stopped_by_admin')
    assert.equal(calls.requeued.length, 0)
    assert.equal(calls.starts.length, 0)
})

test('a failed save leaves its cost ONCE and a reason on the row; a turn that throws after the save leaves it once too', async () => {
    const annotated = []
    const base = runDeps({ A: { coverage: { symbol: 'A', price_target: { horizon: '3m' } } } })
    const deps = { ...base.deps, annotate: async (id, o) => { annotated.push([id, o]) }, initiate: async () => ({ ok: false, reason: 'rating_contradicts_target' }) }
    await startRun({ userId: null }, deps)
    await settled()
    assert.deepEqual(annotated, [['rq_A', { addCost: 0.04 }], ['rq_A', { addCost: 0, reason: 'rating_contradicts_target', detail: null }]])
    annotated.length = 0
    await startRun({ userId: null }, { ...deps, initiate: async () => { throw new Error('mongo') } })
    await settled()
    assert.equal(annotated.reduce((s, [, o]) => s + o.addCost, 0), 0.04, 'the cost once, however many paths touch the row')
    assert.equal(annotated.at(-1)[1].reason, 'failed')
})

test('the horizon is judged as the save stores it: a missing one is 12m — right for long term, off book for swing', () => {
    const item = (verdict) => ({ context: { pythia: true, verdict } })
    assert.equal(offBookHorizon(item('long_term'), { price_target: { value: 180 } }), null)
    assert.equal(offBookHorizon(item('long_term'), { price_target: 180 }), null)
    assert.match(offBookHorizon(item('swing'), { price_target: 180 }), /12m — swing/)
})

test('a run for given symbols reads the queue BY them, not out of its first page', async () => {
    let asked = null
    const { deps } = runDeps({ A: { coverage: null } })
    await startRun({ userId: null, symbols: ['a'] }, { ...deps, listQueue: async (q) => { asked = q; return [{ id: 'rq_A', symbol: 'A', context: {} }] } })
    await settled()
    assert.deepEqual(asked, { status: 'queued', symbols: ['A'], limit: 1000 })
})

test("one list that throws is that industry's; the week's other verdicts still send names", async () => {
    const { queued, deps } = scanDeps({ candidates: async (sub) => { if (sub.code === 'A') throw new Error('engine'); return { rows: [{ symbol: 'B1' }] } } })
    await runHouseScan([
        { kind: 'industry', code: 'A', name: 'Steel', outcome: 'published', verdict: 'swing' },
        { kind: 'industry', code: 'B', name: 'Banks', outcome: 'published', verdict: 'swing' },
    ], deps)
    assert.deepEqual(queued.map(q => q.symbol), ['B1'])
    assert.deepEqual((await industryCandidates({ code: '1' }, 'swing', { deps: { db: async () => { throw new Error('down') }, companies: async () => [{ symbol: 'X' }] } })).rows, [])
})

test('a theme with no link to read still sends the companies she named', async () => {
    const { queued, deps } = scanDeps({
        theme: async () => ({ links: [{ code: 'X', name: 'Far', order: 3 }] }),
        assessment: async () => ({ subject: { kind: 'theme', id: 'th_ai', name: 'AI' }, verdict: 'swing', thesis: 't', risks: [], names: [{ symbol: 'NVDA', why: 'w' }] }),
    })
    await runHouseScan([{ kind: 'theme', id: 'th_ai', name: 'AI', outcome: 'published', verdict: 'swing' }], deps)
    assert.deepEqual(queued.map(q => q.symbol), ['NVDA'])
    assert.equal(queued[0].context.named_why, 'w')
})
