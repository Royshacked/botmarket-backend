import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _routeAsPick } from '../../services/agents/scanner.agent.service.js'

test('a pick sent as a route back to the trader is the pick, and the route goes (the drive, 2026-11-18: "I\'d send S")', () => {
    const { pick, routing } = _routeAsPick(null, { route: 'assist', routeSymbol: 's', opening: 'S', edit: null }, "I'd send S: a strong buy.")
    assert.deepEqual(pick, { ticker: 'S', direction: 'long', thesis: '', analysis: "I'd send S: a strong buy." })
    assert.equal(routing.route, null)
    assert.equal(routing.routeSymbol, null)
    assert.equal(routing.opening, null)
})

test('a pick tag AND a route back to the trader: the pick stays, the route goes (the drive, 2026-11-18: BBWI)', () => {
    const real = { ticker: 'BBWI', direction: 'long', thesis: '', analysis: '' }
    const { pick, routing } = _routeAsPick(real, { route: 'assist', routeSymbol: null, opening: 'x' })
    assert.equal(pick, real)
    assert.equal(routing.route, null)
    assert.equal(routing.opening, null)
})

test('a route elsewhere, or a route back with no ticker and no pick, is left as it came', () => {
    const r2 = { route: 'reception', routeSymbol: 'S' }
    assert.deepEqual(_routeAsPick(null, r2), { pick: null, routing: r2 })
    const r3 = { route: 'assist', routeSymbol: null }
    assert.deepEqual(_routeAsPick(null, r3), { pick: null, routing: r3 })
})
