import { test } from 'node:test'
import assert from 'node:assert/strict'
import { watched, expiry, sessionsBetween, findTriggers, watchEvent, markFollowUp, BACKSTOP_SESSIONS, _setDeps } from '../../services/echoWatch.service.js'

// Echo Step 5 — the wave watch and expiry (docs/design/echo-pipeline.md; the simulator doc's Step 5).

const flagged = (ticker, extra = {}) => ({ ticker, flag: 'underreacted_winner', analysts: { count: 0 }, moves: { 20: { xsSector: 0.01 } }, ...extra })
const EV = (o = {}) => ({ _id: 'e', kind: 'house', date: '2026-01-05', origin: 'Cisco Systems, Inc.', originTickers: ['CSCO'], terms: ['Cisco'],
    durability: { kind: 'policy_follow_through' }, map: { links: [] },
    scores: { links: [{ ticker: 'VRT', high: true }, { ticker: 'ANET', high: false }] },
    check: { day0: '2026-01-06', checkDay: '2026-01-12', links: [flagged('FN'), { ticker: 'HPE', flag: 'fully_priced' }] }, ...o })

test('the watch follows the flagged and high-scoring names', () => {
    assert.deepEqual(watched(EV()), ['FN', 'VRT'])
})

test("expiry: the doc's three, then the backstop by durability", () => {
    assert.equal(expiry(EV({ triggers: [{ resolves: true, at: '2026-02-01T00:00:00Z' }] }), '2026-02-02').reason, 'resolved — a follow-up resolved the driver')
    assert.match(expiry(EV({ check: { day0: '2026-01-06', links: [flagged('FN', { analysts: { count: 3 } })] } }), '2026-01-20').reason, /^absorbed/)
    assert.match(expiry(EV(), '2026-03-20').reason, /^normalised/, '~50 sessions quiet, within 3% of the sector')
    assert.equal(expiry(EV({ check: { day0: '2026-01-06', links: [flagged('FN', { moves: { 20: { xsSector: 0.08 } } })] } }), '2026-03-20').expired, false, 'still moving')
    assert.match(expiry(EV({ durability: { kind: 'price_spike' }, check: { day0: '2026-01-06', links: [] } }), '2026-04-15').reason, /^backstop — a price spike lives at most 63 sessions/)
    assert.equal(expiry(EV({ check: { day0: '2026-01-06', links: [] } }), '2026-04-15').expired, false, 'a policy lives a year')
    assert.equal(BACKSTOP_SESSIONS.multi_year_commitment, 756)
    assert.ok(Math.abs(sessionsBetween('2026-01-01', '2027-01-01') - 252) <= 1)
})

test('triggers: a watched name reported, or filed naming the origin, since the last watch', async () => {
    _setDeps({ sleep: async () => {},
        calendar: async () => [{ symbol: 'VRT', date: '2026-02-10', epsActual: 1, epsEstimated: 0.9 }, { symbol: 'XOM', date: '2026-02-10', epsActual: 1 }],
        namedIn: async (t) => (t === 'FN' ? { named: true, filings: [{ form: '8-K', date: '2026-02-11', url: 'u' }], excerpt: 'Cisco expanded its order.' } : { named: false, filings: [] }) })
    const t = await findTriggers(EV(), '2026-01-12', '2026-02-12')
    assert.deepEqual(t.map(x => [x.kind, x.ticker]), [['earnings', 'VRT'], ['filing', 'FN']])
    assert.match(t[1].what, /FN's 8-K names Cisco Systems, Inc\.: "Cisco expanded its order\."/)
})

test('watchEvent: a trigger re-runs Steps 3 and 4 once a day; expiry moves the status', async () => {
    const writes = [], runs = []
    _setDeps({
        now: () => new Date('2026-02-12T12:00:00Z'), sleep: async () => {},
        calendar: async () => [{ symbol: 'VRT', date: '2026-02-10', epsActual: 1 }], namedIn: async () => ({ named: false, filings: [] }),
        score: async () => { runs.push('score'); return { ok: true, scores: { links: [] } } },
        check: async () => { runs.push('check'); return { ok: true, check: { day0: '2026-01-06', links: [] } } },
        events: { advance: async (id, status, patch) => { writes.push([status, patch]) } },
    })
    const r = await watchEvent(EV())
    assert.deepEqual([r.triggers, r.rescored, r.expired], [1, true, false])
    assert.deepEqual(runs, ['score', 'check'])
    assert.ok(writes[0][1].triggers[0].rescoredAt)
    runs.length = 0
    await watchEvent(EV({ triggers: [{ kind: 'earnings', at: '2026-02-12T00:00:00Z' }], rescoredAt: '2026-02-12T08:00:00Z', watchedAt: '2026-02-12T08:00:00Z' }))
    assert.deepEqual(runs, [], 'rescored four hours ago — not again today')
    await watchEvent(EV({ durability: { kind: 'price_spike' }, date: '2025-06-01', check: { day0: '2025-06-02', links: [] }, rescoredAt: '2026-02-12T11:00:00Z' }))
    assert.equal(writes.at(-1)[0], 'expired')
    assert.match(writes.at(-1)[1].expiredBecause, /^backstop/)
})

test('markFollowUp: the trigger on the parent, resolving or not; an expired parent is left alone', async () => {
    const writes = []
    _setDeps({ now: () => new Date('2026-02-01T00:00:00Z'), events: {
        get: async (id) => (id === 'p' ? { _id: 'p', status: 'watching', triggers: [] } : { _id: 'x', status: 'expired' }),
        advance: async (id, status, patch) => { writes.push([id, status, patch]) } } })
    assert.equal(await markFollowUp('p', { _id: 'c', date: '2026-02-01', whatChanged: 'Germany passed a €100B fund' }, false), true)
    assert.deepEqual(writes[0][2].triggers[0], { kind: 'follow_up', eventId: 'c', date: '2026-02-01', what: 'Germany passed a €100B fund', resolves: false, at: '2026-02-01T00:00:00.000Z' })
    assert.equal(await markFollowUp('x', { _id: 'c' }), false)
})
