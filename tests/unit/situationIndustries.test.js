import { test } from 'node:test'
import assert from 'node:assert/strict'

import { weekKey, weekly, ols, sensitivities, dailyReactions, exposureLine, buildExposures, _setIO as setExposureIO } from '../../services/situation/exposure.js'
import { mapSchema, branchList, mapPrompt, shapeEffects, mapBranches, rng, walkOrder, scoreIndustries, wouldBeEntries, _setIO } from '../../services/situation/industries.js'
import { checkIndustry } from '../../services/situation/model.js'

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`)
const node = (node_id, opts, given = null) => ({ node_id, question: node_id, status: 'live', given, options: Object.entries(opts).map(([key, p]) => ({ key, label: key, p })) })

// ── exposure ──

test('weekKey is ISO, Monday-based; weekly keeps the last value of each week', () => {
    assert.equal(weekKey('2025-01-01'), '2025-W01')
    assert.equal(weekKey('2024-12-30'), '2025-W01')
    assert.equal(weekKey('2025-01-06'), '2025-W02')
    const w = weekly([{ date: '2025-01-07', value: 2 }, { date: '2025-01-06', value: 1 }, { date: '2025-01-10', value: 3 }])
    assert.deepEqual([...w.entries()], [['2025-W02', 3]])
})

test('ols recovers a slope and calls a clean fit significant', () => {
    const x = Array.from({ length: 50 }, (_, i) => i), y = x.map(v => 2 * v + 1 + (v % 2 ? 0.1 : -0.1))
    const r = ols(x, y)
    near(r.slope, 2, 0.01)
    assert.ok(r.t > 50)
    assert.equal(ols([1, 2], [1, 2]), null)
})

test('sensitivities: beta to the market, then the rate slope of what is left', () => {
    const weeks = 80
    const days = Array.from({ length: weeks }, (_, i) => new Date(Date.UTC(2024, 8, 6) + i * 7 * 864e5).toISOString().slice(0, 10))
    const m = days.map((_, i) => (i % 3 === 0 ? 0.01 : i % 3 === 1 ? -0.008 : 0.004))
    const dy = days.map((_, i) => (i % 4 === 0 ? 0.1 : i % 4 === 1 ? -0.05 : i % 4 === 2 ? 0.02 : -0.07))
    let spx = 100, b = 100, y10 = 4
    const spxP = [], bP = [], yP = [], oilP = [], usdP = []
    days.forEach((d, i) => {
        if (i > 0) { spx *= 1 + m[i]; y10 += dy[i]; b *= 1 + 1.5 * m[i] - 0.05 * dy[i] }
        spxP.push({ date: d, value: spx }); bP.push({ date: d, value: b }); yP.push({ date: d, value: y10 }); oilP.push({ date: d, value: 80 }); usdP.push({ date: d, value: 120 })
    })
    const s = sensitivities(weekly(bP), weekly(spxP), { rates: weekly(yP), oil: weekly(oilP), dollar: weekly(usdP) })
    near(s.beta, 1.5, 0.05)
    near(s.rates.slope, -5, 0.3)
    assert.ok(s.rates.t < -2)
    assert.equal(s.oil, null, 'a flat factor has no slope')
})

test('dailyReactions: each basket against the mean of all baskets, day 0 and days 0–5', () => {
    const dates = Array.from({ length: 20 }, (_, i) => `2025-01-${String(i + 10).padStart(2, '0')}`)
    const docs = Array.from({ length: 12 }, (_, k) => ({ _id: `b${k}`, dates, levels: dates.map((_, i) => (i >= 17 ? 100 * (1 + 0.01 * k) : 100)) }))
    const ev = dailyReactions(docs, [{ id: 'e', date: '2025-01-27', label: 'E' }])
    assert.equal(ev.length, 0, 'not five days after the event in the data → skipped')
    const ev2 = dailyReactions(docs.map(d => ({ ...d, levels: d.dates.map((_, i) => (i >= 10 ? 100 * (1 + 0.01 * Number(d._id.slice(1))) : 100)) })), [{ id: 'e', date: '2025-01-20', label: 'E' }])
    const r = ev2[0].rows
    near(r.reduce((s, x) => s + x.d0, 0), 0, 1e-12)
    assert.ok(r.find(x => x.basket === 'b11').d0 > 0 && r.find(x => x.basket === 'b0').d0 < 0)
})

test('exposureLine: material sensitivities only, and the largest reactions', () => {
    const line = exposureLine({ code: '15104030', name: 'Gold', sens: { beta: 0.4, rates: { slope: -6.1, t: -3.2 }, oil: { slope: 0.3, t: 1.1 }, dollar: { slope: -1.2, t: -2.5 } },
        reactions: [{ label: 'COVID crash (2020-03)', v: 0.05 }, { label: 'Small', v: 0.005 }] })
    assert.match(line, /^15104030 Gold: beta 0\.40\. after the market: -6\.10% per \+1pt 10y \(t -3\.2\), -1\.20% per \+1% dollar \(t -2\.5\)\. reactions vs all industries: COVID crash \(2020-03\) \+5\.0%$/)
})

test('buildExposures: no engine database is a gap, not a throw', async () => {
    setExposureIO({ engineDb: async () => { throw new Error('down') } })
    const r = await buildExposures()
    assert.deepEqual(r.industries, [])
    assert.ok(r.gaps.some(g => /engine database: down/.test(g)))
})

// ── mapping ──

test('the mapping: schema strict, branches numbered, unknown codes and repeats dropped, at most 8', () => {
    assert.equal(mapSchema().properties.branches.items.additionalProperties, false)
    const nodes = [node('iran', { strike: 0.2, standoff: 0.8 })]
    const branches = branchList(nodes)
    assert.equal(branches.length, 2)
    const p = mapPrompt(branches, [{ code: '10102010', name: 'Integrated Oil & Gas', sens: null, reactions: [] }])
    assert.match(p, /1\. "iran" → strike \(20%\)/)
    const eff = shapeEffects({ branches: [{ branch: 1, effects: [
        { code: '10102010', direction: 'up', bucket: 'large', why: 'oil' }, { code: '10102010', direction: 'up', bucket: 'small', why: 'again' },
        { code: '99999999', direction: 'up', bucket: 'small', why: 'nope' },
    ] }] }, branches, new Set(['10102010']))
    assert.deepEqual(eff.effects.get('iran|strike').map(e => e.code), ['10102010'])
    assert.equal(eff.dropped, 1)
})

test('mapBranches: two calls, the cost of both measured; no answer at all is said', async () => {
    _setIO({ payer: async () => null, system: () => 'S', call: async (a) => { a.onUsage({ input_tokens: 1000, output_tokens: 1000 }, 'claude-opus-5-5'); return { data: { branches: [] } } } })
    const r = await mapBranches([node('x', { a: 0.5, b: 0.5 })], [])
    assert.equal(r.ok, true)
    near(r.cost_usd, 2 * (1000 * 4 + 1000 * 20) / 1e6)
    _setIO({ call: async () => { throw new Error('overloaded') } })
    assert.match((await mapBranches([node('x', { a: 0.5, b: 0.5 })], [])).reason, /no mapping run answered/)
})

// ── scoring ──

test('rng is seeded and in [0, 1); walkOrder puts a child after its parent', () => {
    const a = rng(1), b = rng(1)
    assert.equal(a(), b())
    const xs = Array.from({ length: 1000 }, rng(7))
    assert.ok(xs.every(x => x >= 0 && x < 1))
    const order = walkOrder([node('child', { a: 0.5, b: 0.5 }, { node_id: 'root', option: 'yes' }), node('root', { yes: 0.5, no: 0.5 })])
    assert.deepEqual(order.map(n => n.node_id), ['root', 'child'])
})

test('scoreIndustries: one branch → chance of winning ≈ its probability; opposite branches split an industry', () => {
    const nodes = [node('iran', { strike: 0.3, calm: 0.7 })]
    const effects = new Map([['iran|strike', [{ code: 'OIL', direction: 'up', bucket: 'large' }]], ['iran|calm', [{ code: 'AIR', direction: 'up', bucket: 'small' }, { code: 'OIL', direction: 'down', bucket: 'small' }]]])
    const rows = scoreIndustries(nodes, [], effects, [{ code: 'OIL', name: 'Oil', level: 'industry' }, { code: 'AIR', name: 'Airlines', level: 'industry' }], { samples: 20000 })
    const oil = rows.find(r => r.code === 'OIL'), air = rows.find(r => r.code === 'AIR')
    near(oil.p_win, 0.3, 0.02)
    near(oil.p_lose, 0.7, 0.02)
    near(air.p_win, 0.7, 0.02)
    assert.equal(air.agreement, 1)
    assert.ok(rows.every(r => checkIndustry(r).ok))
    assert.equal(oil.paths[0].node_id, 'iran')
})

test('scoreIndustries: a child counts only on its branch; a link makes paths coherent', () => {
    const nodes = [node('tariffs', { yes: 0.5, no: 0.5 }), node('retal', { yes: 0.8, no: 0.2 }, { node_id: 'tariffs', option: 'yes' })]
    const effects = new Map([['retal|yes', [{ code: 'FARM', direction: 'down', bucket: 'medium' }]]])
    const rows = scoreIndustries(nodes, [], effects, [{ code: 'FARM', name: 'Farm', level: 'industry' }], { samples: 20000 })
    near(rows[0].p_lose, 0.4, 0.02)
    // A strong link from tariffs:yes to inflation:up makes inflation-up mostly happen WITH tariffs.
    const n2 = [node('tariffs', { yes: 0.5, no: 0.5 }), node('infl', { up: 0.5, down: 0.5 })]
    const links = [{ link_id: 'L', from: { node_id: 'tariffs', option: 'yes' }, to: { node_id: 'infl', option: 'up' }, shift: 3, live: true }]
    // X wins only when tariffs come AND inflation does not fall (+2 medium; inflation down is −3 large): with the link,
    // yes and up come together (0.5 × 0.82 ≈ 0.41); without it, 0.25.
    const both = new Map([['tariffs|yes', [{ code: 'X', direction: 'up', bucket: 'medium' }]], ['infl|down', [{ code: 'X', direction: 'down', bucket: 'large' }]]])
    const linked = scoreIndustries(n2, links, both, [{ code: 'X', name: 'X', level: 'industry' }], { samples: 20000 })
    const free = scoreIndustries(n2, [], both, [{ code: 'X', name: 'X', level: 'industry' }], { samples: 20000 })
    assert.ok(linked[0].p_win > free[0].p_win + 0.1, 'correlated paths stack the same way')
})

test('wouldBeEntries: an upward crossing of 30 / 50 / 70%, either side', () => {
    const e = wouldBeEntries([{ code: 'G', p_win: 0.45, p_lose: 0.1 }], [{ code: 'G', name: 'Gold', p_win: 0.72, p_lose: 0.1 }, { code: 'N', name: 'New', p_win: 0.1, p_lose: 0.35 }], '2025-01-07')
    assert.deepEqual(e.map(x => `${x.code} ${x.side} ${x.level}`), ['G win 0.5', 'G win 0.7', 'N lose 0.3'])
})

// Prod, 2026-11-24 (Roy, on the Industries tab): Rail and Cargo Ground at 0% / 0% with no path, and Axl naming "a 61% call
// under the code 20101010".
test("an industry mapped only on a dropped question gets no row; each path carries its question's resolve-by date", () => {
    const live = { ...node('boeing', { yes: 0.6, no: 0.4 }), resolve_by: '2027-06-30' }
    const gone = { ...node('old', { a: 0.5, b: 0.5 }), status: 'dropped' }
    const effects = new Map([['boeing|yes', [{ code: 'AD', direction: 'up', bucket: 'medium' }]], ['boeing|no', []], ['old|a', [{ code: 'RAIL', direction: 'up', bucket: 'small' }]], ['old|b', []]])
    const rows = scoreIndustries([live, gone], [], effects, [{ code: 'AD', name: 'Aerospace & Defense', level: 'sub_industry' }, { code: 'RAIL', name: 'Rail', level: 'sub_industry' }], { samples: 2000 })
    assert.deepEqual(rows.map(r => r.code), ['AD'])
    assert.equal(rows[0].paths[0].resolve_by, '2027-06-30')
})

test("buildExposures names every basket from the engine's latest timing rows when the passed names lack it or are a bare code", async () => {
    const { memDb } = await import('../helpers/memDb.js')
    const { db } = memDb()
    const dates = ['2026-10-01', '2026-10-08', '2026-10-15']
    await db.collection('industry_index').insertMany([
        { _id: 'sub_industry:20101010', dates, levels: [1, 1.01, 1.02] },
        { _id: 'sub_industry:45103020', dates, levels: [1, 0.99, 1.01] },
        { _id: 'sub_industry:10102010', dates, levels: [1, 1, 1] },
    ])
    await db.collection('industry_timing').insertMany([
        { _id: 'a', asof: '2026-11-13', basket: 'sub_industry:20101010', basket_name: 'OLD NAME' },
        { _id: 'b', asof: '2026-11-20', basket: 'sub_industry:20101010', basket_name: 'Aerospace & Defense' },
        { _id: 'c', asof: '2026-11-20', basket: 'sub_industry:45103020', name: 'Systems Software' },
    ])
    setExposureIO({ engineDb: async () => db, spx: async () => [], series: async () => [] })
    const passed = new Map([['sub_industry:20101010', '20101010'], ['sub_industry:10102010', 'Integrated Oil & Gas']])
    const r = await buildExposures(passed)
    const name = (code) => r.industries.find(i => i.code === code)?.name
    assert.equal(name('20101010'), 'Aerospace & Defense', 'a bare code passed in is replaced')
    assert.equal(name('45103020'), 'Systems Software', 'missing from the passed names')
    assert.equal(name('10102010'), 'Integrated Oil & Gas', 'a passed name stands')
})
