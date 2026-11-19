import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferTiming, dayZeroMove, awardsIn, triagePrompt, intake, earnings, SYSTEM, _setDeps } from '../../services/echoIntake.service.js'
import { echoEventsService } from '../../services/echoEvents.service.js'

// Echo Step 1 — the intake (docs/design/echo-pipeline.md; the simulator doc's Step 1).

const D = ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16']
const bars = (o) => Object.fromEntries(D.map(d => [d, { open: 100, close: 100, ...o[d] }]))
const SPY = bars({})

test("the doc's filter and skip list are the triage's instructions", () => {
    for (const w of ['SURPRISE', 'LARGE', 'MORE THAN A ONE-OFF', 'macro data', 'analyst upgrades', 'rumours', 'never how the stock moved', 'durability']) assert.ok(SYSTEM.includes(w), w)
})

test('timing from the gap: the larger excess gap decides (the engine rule)', () => {
    const after = bars({ '2026-11-13': { open: 92, close: 93 } })              // gap on the NEXT day → reported after the close
    assert.deepEqual(inferTiming(after, SPY, '2026-11-12'), { timing: 'after_close', day0: '2026-11-13', base: '2026-11-12' })
    const before = bars({ '2026-11-12': { open: 108, close: 109 }, '2026-11-13': { open: 109, close: 109 }, '2026-11-16': { open: 109, close: 109 } })   // gap that day → before the open
    assert.deepEqual(inferTiming(before, SPY, '2026-11-12'), { timing: 'before_open', day0: '2026-11-12', base: '2026-11-11' })
    assert.equal(inferTiming(after, SPY, '2026-11-16'), null, 'no next session yet')
})

test("Day 0's move vs SPY is the size test", () => {
    const b = bars({ '2026-11-13': { open: 92, close: 94 } })
    assert.ok(Math.abs(dayZeroMove(b, SPY, { day0: '2026-11-13', base: '2026-11-12' }) - -0.06) < 1e-12)
})

test('defense awards of $500M and up, one paragraph each', () => {
    const t = '<div><p>CONTRACTS FOR NOV. 18, 2026. The Department announced $9,000,000,000 in awards today.</p>'
        + '<p>Lockheed Martin Corp., Fort Worth, Texas, is awarded $1,234,567,890 for F-35 sustainment.</p><p>Small Co., Dayton, Ohio, is awarded $4,500,000 for parts.</p>'
        + '<p>General Dynamics Electric Boat, Groton, Connecticut, has been awarded a $750,000,000 modification.</p></div>'
    const a = awardsIn(t)
    assert.deepEqual(a.map(x => x.usd), [1234567890, 750000000])
    assert.match(a[0].text, /^Lockheed Martin/)
})

test('earnings: only the universe, only 5%+ vs SPY on Day 0; an open Day 0 waits', async () => {
    _setDeps({
        now: () => new Date('2026-11-17T12:00:00Z'), sleep: async () => {},
        calendar: async () => [{ symbol: 'CSCO', date: '2026-11-12', epsActual: 1.4, epsEstimated: 1.33 }, { symbol: 'ZZZZ', date: '2026-11-12', epsActual: 1 },
            { symbol: 'AAPL', date: '2026-11-12', epsActual: 2 }, { symbol: 'MSFT', date: '2026-11-16', epsActual: 3 }],
        bars: async (s) => (s === 'SPY' ? SPY : s === 'CSCO' ? bars({ '2026-11-13': { open: 97, close: 94 } }) : bars({})),
        stockNews: async () => [{ publishedDate: '2026-11-12', title: 'Cisco guides below', text: 'x' }],
    })
    const r = await earnings()
    assert.deepEqual(r.candidates.map(c => c.key), ['earnings|CSCO|2026-11-12'], 'AAPL did not move; ZZZZ is not in the universe')
    assert.equal(r.candidates[0].timing, 'after_close')
    assert.match(r.candidates[0].size, /^Day 0 -6\.0% vs SPY/)
    assert.deepEqual(r.pending, ['MSFT'], 'its Day 0 has no next session yet')
})

test('the triage prompt says the source, the hint and the text', () => {
    assert.match(triagePrompt([{ key: 'k1', source: 'Federal Register', hint: 'policy', date: '2026-11-19', tickers: [], title: 'Advanced Semiconductors', text: 'RULE.' }], '2026-11-19'),
        /\[1\] Federal Register \(likely policy\), 2026-11-19\nAdvanced Semiconductors\nRULE\./)
})

test('intake: new candidates triaged, events that pass the filter stored, seen ones not asked again, a failing source costs itself', async () => {
    const seen = new Map([['fr|old', { _id: 'fr|old' }]])
    const created = []
    const events = { ...echoEventsService, findSame: async () => null, create: async (ev, o) => { created.push([ev, o]); return { _id: `ev_${created.length}` } } }
    const asked = []
    const D2 = (key, verdict, extra = {}) => ({ key, verdict, skip_reason: verdict === 'skip' ? 'macro data' : '', type: 'policy', origin: 'United States', tickers: [], terms: [],
        what_changed: 'BIS restricted remote access to advanced chips', size: 'all US cloud providers', effect: 'down', timing: 'after_close',
        durability: { kind: 'policy_follow_through', why: 'a rule' }, filter: { surprise: true, large: true, lasting: true, why: 'a new regime' }, ...extra })
    _setDeps({
        now: () => new Date('2026-11-19T22:00:00Z'), sleep: async () => {}, houseLedger: async () => 'house', record: async () => {}, events,
        calendar: async () => { throw new Error('FMP down') }, eightKs: async () => ({ filings: [] }),
        http: async (url) => {
            if (url.includes('federalregister')) return { results: [{ document_number: 'new', publication_date: '2026-11-19', title: 'Remote Access to Advanced Semiconductors', type: 'Rule', agencies: [], abstract: 'x' }, { document_number: 'old', title: 'old' }, { document_number: 'cpi', publication_date: '2026-11-19', title: 'CPI', type: 'Rule' }] }
            return url.includes('RSS') ? '' : { studies: [], results: [] }
        },
        fmp: async () => [],
        db: { collection: () => ({
            find: (q) => ({ toArray: async () => q._id.$in.filter(k => seen.has(k)).map(k => ({ _id: k })) }),
            updateOne: async (q, u) => { seen.set(q._id, u.$set) },
        }) },
        call: async (o) => { asked.push(o.user); return { data: { decisions: [D2('1', 'event'), D2('2', 'skip'),
            D2('9', 'event', { filter: { surprise: true, large: false, lasting: true, why: 'small' } })] } } },
    })
    const r = await intake()
    assert.equal(asked.length, 1)
    assert.doesNotMatch(asked[0], /\nold\n/, 'a seen item is not asked again')
    assert.match(asked[0], /^\[1\] Federal Register/m)
    assert.deepEqual(r.events, ['ev_1'])
    assert.equal(created[0][1].source, 'Federal Register')
    assert.equal(created[0][0].type, 'policy')
    assert.deepEqual(r.skipped.map(s => [s.key, s.reason]), [['fr|cpi', 'macro data']])
    assert.equal(seen.get('fr|new').verdict, 'event')
})
