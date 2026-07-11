import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOrigin, pickCallReasoning, pickPortfolioThesis, computeTradeStats } from '../../services/tradeCapture.service.js'

// buildOrigin freezes "what spawned this trade" onto the trade doc. Four cases:
// idea / call / portfolio / idealess — with `type` derived (call > portfolio > idea).

test('buildOrigin: plain idea → type "idea", callId + portfolio null', () => {
    const o = buildOrigin({ id: 'idea1', groupId: null, userId: 'u1' })
    assert.deepEqual(o, {
        type: 'idea', ideaId: 'idea1', callId: null,
        groupId: null, portfolioId: null, portfolioName: null, allocationRatio: null,
    })
})

test('buildOrigin: Kairos call → type "call", carries callId (the is-a-call flag)', () => {
    const o = buildOrigin({ id: 'idea9', callId: 'call_TSLA_x' })
    assert.equal(o.type, 'call')
    assert.equal(o.ideaId, 'idea9')      // the idea is still the execution vehicle
    assert.equal(o.callId, 'call_TSLA_x')
})

test('buildOrigin: portfolio-linked idea → type "portfolio", carries portfolio fields', () => {
    const o = buildOrigin({ id: 'idea2', portfolioId: 'pf1', portfolioName: 'Macro', allocationRatio: 0.25 })
    assert.equal(o.type, 'portfolio')
    assert.equal(o.portfolioId, 'pf1')
    assert.equal(o.portfolioName, 'Macro')
    assert.equal(o.allocationRatio, 0.25)
    assert.equal(o.callId, null)
})

test('buildOrigin: call precedence — a call inside a portfolio is still typed "call"', () => {
    const o = buildOrigin({ id: 'idea3', callId: 'call_x', portfolioId: 'pf1' })
    assert.equal(o.type, 'call')
    assert.equal(o.portfolioId, 'pf1')   // portfolio linkage still preserved, just not the type
})

test('buildOrigin: idealess (no idea) → all-null origin, type null', () => {
    assert.deepEqual(buildOrigin(), {
        type: null, ideaId: null, callId: null,
        groupId: null, portfolioId: null, portfolioName: null, allocationRatio: null,
    })
    // explicit empty object behaves the same as the default
    assert.deepEqual(buildOrigin({}), buildOrigin())
})

// ── pickCallReasoning: freeze the originating call's thesis onto the trade ──────
test('pickCallReasoning: a call → freezes thesis/bias/entry_zones/patterns', () => {
    const call = {
        thesis: 'reclaim of the 200MA', bias: 'long',
        entry_zones: [{ id: 'ez1', side: 'long', lower: 248, upper: 250 }],
        patterns: [{ id: 'p1', name: 'bull flag', confidence: 0.7 }],
        // fields not part of the reasoning snapshot are ignored
        asset: 'TSLA', monitor_state: { foo: 1 },
    }
    assert.deepEqual(pickCallReasoning(call), {
        thesis: 'reclaim of the 200MA', bias: 'long',
        entry_zones: [{ id: 'ez1', side: 'long', lower: 248, upper: 250 }],
        patterns: [{ id: 'p1', name: 'bull flag', confidence: 0.7 }],
    })
})

test('pickCallReasoning: no call (idea/portfolio trade, or deleted call) → all-null shape', () => {
    const empty = { thesis: null, bias: null, entry_zones: null, patterns: null }
    assert.deepEqual(pickCallReasoning(), empty)
    assert.deepEqual(pickCallReasoning(null), empty)
    // a call missing some reasoning fields still yields the full shape (nulls for gaps)
    assert.deepEqual(pickCallReasoning({ thesis: 'x' }), { thesis: 'x', bias: null, entry_zones: null, patterns: null })
})

// ── pickPortfolioThesis: freeze the book's thesis onto the trade ────────────────
test('pickPortfolioThesis: a thesis → freezes strategy + targetExposures (drops version/meta)', () => {
    const thesis = {
        strategy: 'barbell: quality + convexity', targetExposures: [{ sector: 'tech', weight: 0.4 }],
        version: 3, updatedAt: 123, updatedReason: 'accepted-rebalance',
    }
    assert.deepEqual(pickPortfolioThesis(thesis), {
        strategy: 'barbell: quality + convexity', targetExposures: [{ sector: 'tech', weight: 0.4 }],
    })
})

test('pickPortfolioThesis: no thesis (idea/call trade, or book with none) → null', () => {
    assert.equal(pickPortfolioThesis(), null)
    assert.equal(pickPortfolioThesis(null), null)
    // a thesis missing a field still yields the full shape (null for the gap)
    assert.deepEqual(pickPortfolioThesis({ strategy: 's' }), { strategy: 's', targetExposures: null })
})

// ── computeTradeStats: realized performance folding ────────────────────────────
const cltrade = (over = {}) => ({
    status: 'closed', mode: 'paper', symbol: 'AAPL', origin: { type: 'idea' },
    openedAt: 0, closedAt: 1000, exit: { realizedPnl: 0 }, ...over,
})

test('computeTradeStats: folds wins/losses/breakeven, net, profit factor, expectancy', () => {
    const trades = [
        cltrade({ exit: { realizedPnl: 100 }, closedAt: 2000 }),   // win, dur 2000
        cltrade({ exit: { realizedPnl: 300 }, closedAt: 4000 }),   // win, dur 4000
        cltrade({ exit: { realizedPnl: -200 }, closedAt: 1000 }),  // loss, dur 1000
        cltrade({ exit: { realizedPnl: 0 }, closedAt: 1000 }),     // breakeven
        cltrade({ status: 'open', exit: null }),                   // open — excluded
    ]
    const { overall } = computeTradeStats(trades)
    assert.equal(overall.count, 4)          // 4 closed (open excluded)
    assert.equal(overall.wins, 2)
    assert.equal(overall.losses, 1)
    assert.equal(overall.breakeven, 1)
    assert.equal(overall.netPnl, 200)       // 100+300-200
    assert.equal(overall.grossProfit, 400)
    assert.equal(overall.grossLoss, 200)
    assert.equal(overall.profitFactor, 2)   // 400/200
    assert.equal(overall.winRate, 0.5)      // 2/4 (breakeven in denominator)
    assert.equal(overall.avgWin, 200)       // 400/2
    assert.equal(overall.avgLoss, 200)      // 200/1
    assert.equal(overall.expectancy, 50)    // 200/4
    assert.equal(overall.best, 300)
    assert.equal(overall.worst, -200)
    assert.equal(overall.avgDurationMs, 2000) // (2000+4000+1000+1000)/4
})

test('computeTradeStats: breakdowns by mode / origin / symbol reuse the summarizer', () => {
    const trades = [
        cltrade({ mode: 'paper',  symbol: 'AAPL', origin: { type: 'idea' },      exit: { realizedPnl: 100 } }),
        cltrade({ mode: 'live',   symbol: 'MSFT', origin: { type: 'call' },      exit: { realizedPnl: -50 } }),
        cltrade({ mode: 'manual', symbol: 'AAPL', origin: { type: 'portfolio' }, exit: { realizedPnl: 25 } }),
    ]
    const s = computeTradeStats(trades)
    assert.equal(s.byMode.paper.netPnl, 100)
    assert.equal(s.byMode.live.netPnl, -50)
    assert.equal(s.byMode.manual.netPnl, 25)
    assert.equal(s.byOrigin.call.count, 1)
    assert.equal(s.byOrigin.portfolio.netPnl, 25)
    assert.equal(s.bySymbol.AAPL.count, 2)      // two AAPL trades grouped
    assert.equal(s.bySymbol.AAPL.netPnl, 125)
    assert.equal(s.bySymbol.MSFT.wins, 0)
})

test('computeTradeStats: empty / no-closed → safe zeros and nulls (no divide-by-zero)', () => {
    const { overall } = computeTradeStats([])
    assert.equal(overall.count, 0)
    assert.equal(overall.winRate, 0)
    assert.equal(overall.profitFactor, null)   // grossLoss 0 → null, not Infinity
    assert.equal(overall.avgWin, 0)
    assert.equal(overall.best, null)
    assert.equal(overall.avgDurationMs, null)
    // an all-open set has nothing to summarize
    assert.equal(computeTradeStats([{ status: 'open' }]).overall.count, 0)
})

test('computeTradeStats: origin.type missing → grouped under "unknown"', () => {
    const s = computeTradeStats([cltrade({ origin: null, exit: { realizedPnl: 10 } })])
    assert.equal(s.byOrigin.unknown.count, 1)
})
