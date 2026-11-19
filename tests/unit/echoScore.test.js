import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coverageScore, exposureScore, combine, ledgerOf, promptFor, scoreEvent, SYSTEM, HIGH, _setDeps } from '../../services/echoScore.service.js'
import { frame } from '../../services/echoEvents.service.js'

// Echo Step 3 — scoring to the simulator doc (docs/design/echo-pipeline.md).

test("the doc's six factors and its examples are the model's instructions", () => {
    for (const w of ['lock_in', 'supply_response', 'bottleneck', 'directness', 'exposure', 'Vertiv', 'Catalent', 'Uniper', 'downstream of a bottleneck', 'boilerplate']) assert.ok(SYSTEM.includes(w), w)
    assert.equal(HIGH, 8)
})

test('coverage, counted: few analysts and filed outside the theme score high (the Vertiv case)', () => {
    assert.deepEqual(coverageScore(4, 'Technology', 'Technology'), { score: 2, analysts: 4, outside: false, why: "4 analysts; Technology, the origin's own sector" })
    assert.equal(coverageScore(14, 'Industrials', 'Technology').score, 2, '14 analysts, but an industrial in a tech chain')
    assert.equal(coverageScore(14, 'Technology', 'Technology').score, 1)
    assert.equal(coverageScore(40, 'Technology', 'Technology').score, 0)
    assert.equal(coverageScore(null, null, 'Technology').score, 1, 'unread: the middle')
})

test('exposure: a stated share scores; an estimate never above 1 (evidence, not a gate)', () => {
    assert.deepEqual(exposureScore({ share: { share: 0.199, form: '10-K', date: '2026-08-18' } }, { score: 1, why: 'x' }),
        { score: 2, source: 'stated', why: '19.9% of its revenue, stated in its 10-K (2026-08-18)' })
    assert.equal(exposureScore({ share: { share: 0.07, atLeast: false, form: '10-K' } }, { score: 2, why: 'x' }).score, 1)
    const est = exposureScore({ named: false }, { score: 2, why: 'Cisco is its largest customer' })
    assert.equal(est.score, 1)
    assert.equal(est.source, 'estimated')
    assert.match(est.why, /estimated — no share stated in a filing; capped at 1/)
})

const M = (s = {}) => ({ ticker: 'FN', lock_in: { score: 1, why: 'l' }, supply_response: { score: 2, why: 's' },
    bottleneck: { score: 2, why: 'b', evidence: 'both', quote: 'record backlog' }, directness: { score: 2, why: 'd' }, exposure: { score: 1, why: 'e' }, ...s })

test('combine: six factors, a total, high at 8', () => {
    const c = combine({ ticker: 'FN', filings: { share: { share: 0.199, form: '10-K' } } }, M(), { score: 1, why: 'c' })
    assert.equal(c.total, 1 + 2 + 2 + 2 + 2 + 1)
    assert.equal(c.high, true)
    assert.equal(c.factors.bottleneck.evidence, 'both')
    assert.equal(combine({ ticker: 'X' }, M({ supply_response: { score: 0, why: '' }, bottleneck: { score: 0, why: '', evidence: 'none', quote: '' } }), { score: 0, why: '' }).high, false)
})

test('the ledger: effects that cancel make a conflicted name; one-sided ones do not', () => {
    const now = { direction: 'gains', directness: 2, lockIn: 1 }
    assert.equal(ledgerOf('WMT', now, [{ id: 'glp1', origin: 'Novo', direction: 'loses', directness: 2, lockIn: 1, total: 8 }]).conflicted, true, 'Walmart: sells GLP-1s, smaller baskets')
    assert.equal(ledgerOf('WMT', now, [{ id: 'x', direction: 'loses', directness: 0, lockIn: 1, total: 3 }]).conflicted, false, 'the direct effect dominates')
    assert.equal(ledgerOf('WMT', now, []).conflicted, false)
})

const EV = { _id: 'ev_1', kind: 'house', ...frame({ what_changed: 'Cisco guided down', origin: 'Cisco Systems, Inc.', tickers: ['CSCO'], effect: 'down',
    durability: { kind: 'price_spike', why: 'one quarter' }, date: '2026-11-12' }).event }

test('the prompt carries the filing evidence and the supply sentences, never prices', () => {
    const p = promptFor(EV, [{ ticker: 'FN', name: 'Fabrinet', relation: 'supplier', layer: 2, direction: 'loses', why: 'optics', filings: { share: { share: 0.199 } } },
        { ticker: 'JBL', name: 'Jabil', relation: 'supplier', layer: 2, direction: 'loses', why: 'EMS', filings: { named: false } }],
    { FN: [{ form: '10-Q', date: '2026-11-03', text: 'We have experienced increased lead times.' }] })
    assert.match(p, /Its filing states: 19\.9% of its revenue tied to the origin/)
    assert.match(p, /Not named in either company's filings/)
    assert.match(p, /Its filing \(10-Q 2026-11-03\): "We have experienced increased lead times\."/)
    assert.doesNotMatch(p, /\breturns?\b|vs SPY|stock (rose|fell)|Day 0/i, 'no market reaction — the event size is not passed either')
})

test('scoreEvent: sentences for suppliers only, the counted factors joined, sorted by total', async () => {
    const supplyAsked = []
    _setDeps({
        sleep: async () => {}, houseLedger: async () => 'house', record: async () => {},
        supply: async (t) => { supplyAsked.push(t); return { sentences: [{ text: 'Record backlog.', form: '8-K', date: '2026-02-11', url: 'u', hedged: false }] } },
        analysts: async (t) => ({ counts: t === 'FN' ? { buy: 3, hold: 1 } : { buy: 30 } }),
        db: { collection: () => ({ find: () => ({ project: () => ({ limit: () => ({ toArray: async () => [] }) }) }) }) },
        call: async () => ({ model: 'claude-opus-5-5', stopReason: 'end_turn', data: { links: [M({ ticker: 'ANET', bottleneck: { score: 0, why: '', evidence: 'none', quote: '' } }), M()] } }),
    })
    const map = { originSector: 'Technology', links: [
        { ticker: 'ANET', name: 'Arista', relation: 'peer', layer: 1, direction: 'loses', why: 'peer', sector: 'Technology', filings: { named: true } },
        { ticker: 'FN', name: 'Fabrinet', relation: 'supplier', layer: 2, direction: 'loses', why: 'optics', sector: 'Technology', filings: { share: { share: 0.199, form: '10-K' } } },
        { ticker: 'GONE', name: 'Unscored', relation: 'supplier', layer: 2, direction: 'loses', why: 'x', sector: null, filings: {} }] }
    const r = await scoreEvent(EV, map)
    assert.equal(r.ok, true)
    assert.deepEqual(supplyAsked, ['FN', 'GONE'], 'a peer is no bottleneck to read for')
    assert.deepEqual(r.scores.links.map(s => [s.ticker, s.total]), [['FN', 11], ['ANET', 6]])
    assert.equal(r.scores.links[0].factors.coverage.analysts, 4)
    assert.equal(r.scores.links[0].factors.exposure.source, 'stated')
    assert.equal(r.scores.links[0].supplySentences[0].text, 'Record backlog.')
    assert.deepEqual(r.scores.unscored, ['GONE'])
})
