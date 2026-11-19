import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flagFor, yardstick, signedMove, checkEvent, actionsSince, _setDeps } from '../../services/echoCheck.service.js'

// Echo Step 4 — the market check to the simulator doc (docs/design/echo-pipeline.md).

const row = (ticker, d5, extra = {}) => ({ ticker, day0: '2026-11-13', gap: 0, horizons: { 1: { xsSpyReaction: d5 / 2 }, 5: { xsSpyReaction: d5 }, 20: { xsSpyReaction: null } }, volume: { 1: 1.2, 5: 0.9 }, missing: [], ...extra })

test('a move is signed by the direction: a "loses" link that fell moved its way', () => {
    assert.equal(signedMove(row('X', -0.04), 'loses'), 0.04)
    assert.equal(signedMove(row('X', -0.04), 'gains'), -0.04)
    assert.equal(signedMove(row('X', -0.04), 'unclear'), null)
})

test('the yardstick is layer 1 in its own direction; the origin when layer 1 is unpriced', () => {
    const links = [{ ticker: 'A', relation: 'peer', direction: 'loses' }, { ticker: 'B', relation: 'customer', direction: 'loses' }, { ticker: 'S', relation: 'supplier', direction: 'loses' }]
    assert.deepEqual(yardstick(links, { A: row('A', -0.04), B: row('B', -0.02), S: row('S', -0.5) }, { effect: 'down' }), { median: 0.03, from: 'layer 1', n: 2 })
    const y = yardstick([links[2]], {}, { effect: 'down' }, row('CSCO', -0.059))
    assert.equal(y.from, 'the origin'); assert.ok(Math.abs(y.median - 0.059) < 1e-12)
})

test("the doc's three flags", () => {
    const yard = 0.06
    assert.equal(flagFor({ direction: 'gains', total: 9, high: true, directness: 2, move: 0.01, yard }).flag, 'underreacted_winner', 'the Vertiv: high score, under half of layer 1')
    assert.equal(flagFor({ direction: 'gains', total: 6, high: false, directness: 2, move: 0.01, yard }).flag, null, 'a small move is no flag without the score')
    assert.equal(flagFor({ direction: 'loses', total: 5, high: false, directness: 0, move: 0.15, yard }).flag, 'overreacted_loser', 'the DaVita: a hard drop on slow damage')
    assert.equal(flagFor({ direction: 'loses', total: 5, high: false, directness: 2, move: 0.15, yard }).flag, 'fully_priced', 'direct damage: the drop is earned')
    assert.equal(flagFor({ direction: 'loses', total: 5, high: false, directness: 0, move: 0.07, yard }).flag, 'fully_priced', 'under 10%: not a big drop')
    assert.equal(flagFor({ direction: 'gains', total: 9, high: true, directness: 2, move: 0.08, yard }).flag, 'fully_priced')
    assert.equal(flagFor({ direction: 'gains', total: 9, high: true, directness: 2, move: 0.01, yard: -0.02 }).flag, null, 'layer 1 went the other way — nothing to lag')
    assert.match(flagFor({ direction: 'gains', total: 9, high: true, directness: 2, move: 0.01, yard }).why, /scored 9; moved \+1\.0% by day 5, under half the layer-1 median \+6\.0%/)
})

test('analyst actions since Day 0', async () => {
    const r = await actionsSince('FN', '2026-11-13', { actions: async () => [{ date: '2026-11-14', gradingCompany: 'B', action: 'downgrade', newGrade: 'Hold' }, { date: '2026-11-01' }] })
    assert.equal(r.count, 1)
    assert.deepEqual(r.actions[0], { date: '2026-11-14', by: 'B', action: 'downgrade', to: 'Hold' })
    assert.equal((await actionsSince('FN', '2026-11-13', { actions: async () => { throw new Error('x') } })).count, null)
})

const EV = { _id: 'ev', date: '2026-11-12', timing: 'after_close', effect: 'down', originTickers: ['CSCO'] }
const SESSIONS = ['2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']

test('checkEvent: waits for the day-5 close; then every link measured and flagged, flags first', async () => {
    _setDeps({ sleep: async () => {}, actions: async () => [], returns: async () => ({ sessions: SESSIONS.slice(0, 4), rows: [row('CSCO', -0.06)] }) })
    const map = { originSector: 'Technology', links: [
        { ticker: 'ANET', relation: 'peer', direction: 'loses', sector: 'Technology' }, { ticker: 'HPE', relation: 'peer', direction: 'loses', sector: 'Technology' },
        { ticker: 'VRT', relation: 'infrastructure', direction: 'gains', sector: 'Industrials' }] }
    const wait = await checkEvent(EV, map, { links: [] })
    assert.equal(wait.wait, true)
    _setDeps({ returns: async (ev, tickers, sectors) => {
        assert.equal(sectors.VRT, 'XLI'); assert.equal(sectors.CSCO, 'XLK')
        return { sessions: SESSIONS, rows: [row('CSCO', -0.06), row('ANET', -0.05), row('HPE', -0.03), row('VRT', 0.005)] }
    } })
    const r = await checkEvent(EV, map, { links: [{ ticker: 'VRT', total: 9, high: true, factors: { directness: { score: 2 } } }] })
    assert.equal(r.ok, true)
    assert.equal(r.check.checkDay, '2026-11-19')
    assert.ok(Math.abs(r.check.yardstick.median - 0.04) < 1e-12)
    assert.equal(r.check.links[0].ticker, 'VRT')
    assert.equal(r.check.links[0].flag, 'underreacted_winner')
    assert.equal(r.check.links[0].noticed, false)
    assert.match(r.check.impliedVolatility, /not measured/)
})
