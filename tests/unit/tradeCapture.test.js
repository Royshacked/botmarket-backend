import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOrigin, pickCallReasoning, pickPortfolioThesis, computeTradeStats, tradeCaptureService } from '../../services/tradeCapture.service.js'

// buildOrigin freezes "what spawned this trade" onto the trade doc. Four cases:
// idea / call / portfolio / idealess — with `type` derived (call > portfolio > idea).

test('buildOrigin: plain idea → type "idea", callId + portfolio null', () => {
    const o = buildOrigin({ id: 'idea1', groupId: null, userId: 'u1' })
    assert.deepEqual(o, {
        type: 'idea', ideaId: 'idea1', callId: null,
        groupId: null, portfolioId: null, portfolioName: null, allocationRatio: null,
        adopted: false,
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
        adopted: false,
    })
    // explicit empty object behaves the same as the default
    assert.deepEqual(buildOrigin({}), buildOrigin())
})

// An ADOPTED holding is a real position we RECORDED but never DECIDED — the entry was made at a bank
// before we saw the name. It rides as its own flag rather than as a `type`, because it is orthogonal
// to what spawned the trade and widening `type` would re-bucket every existing analytics read.
// Without it the track record credits the app for entries it did not make.
test('buildOrigin: an adopted holding is flagged, and stays typed "portfolio"', () => {
    const o = buildOrigin({ id: 'idea4', portfolioId: 'pf1', adopted: true })
    assert.equal(o.adopted, true)
    assert.equal(o.type, 'portfolio', 'adopted is orthogonal to what spawned the trade')
})

test('buildOrigin: adopted defaults to false, never undefined', () => {
    // A missing flag must read as "we decided this", so an analytics filter on `adopted: false`
    // cannot silently miss every pre-existing row.
    assert.equal(buildOrigin({ id: 'i1' }).adopted, false)
    assert.equal(buildOrigin({ id: 'i1', adopted: 'yes' }).adopted, false, 'only a real boolean counts')
})

// ── pickCallReasoning: freeze the originating call's thesis onto the trade ──────
test('pickCallReasoning: a call → freezes thesis/bias/entry_zones/patterns (an ARCHIVED doc: it keeps its bands)', () => {
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

// ─── Scaled-out trades ────────────────────────────────────────────────────────
// A position unwound in slices used to reach the ledger as ONE exit carrying only the last slice's
// P&L — the partials were never recorded at all. `exits[]` is now the record of how the position
// came apart, and `exit.realizedPnl` accrues the TOTAL, which is where every reader already looks.

const scaled = {
    status: 'closed', openedAt: 0, closedAt: 3_600_000,
    exits: [
        { orderId: 'o1', price: 110, quantity: 40, realizedPnl: 400, reason: 'tp' },
        { orderId: 'o2', price: 120, quantity: 30, realizedPnl: 600, reason: 'tp' },
        { orderId: 'o3', price: 105, quantity: 30, realizedPnl: 150, reason: 'stop' },
    ],
    exit: { price: 105, ts: 3_600_000, reason: 'stop', realizedPnl: 1150 },   // final slice + running total
}

test('a scaled trade counts its TOTAL, not the slice that happened to close it', () => {
    // The regression this exists to prevent: the old shape would have scored this +150 — a marginal
    // win — when the trade actually made 1150 across three exits.
    const s = computeTradeStats([scaled]).overall
    assert.equal(s.netPnl, 1150)
    assert.equal(s.wins, 1)
    assert.equal(s.best, 1150)
})

test('exit still describes the FINAL slice, which is what the row shows', () => {
    // price/ts/reason are the last exit; only realizedPnl is aggregated. The UI renders
    // `entry → exit.price` and `exit.reason`, and both must stay literal.
    assert.equal(scaled.exit.price, scaled.exits.at(-1).price)
    assert.equal(scaled.exit.reason, scaled.exits.at(-1).reason)
    assert.equal(scaled.exit.realizedPnl, scaled.exits.reduce((n, e) => n + e.realizedPnl, 0))
})

test('a trade with no partials is scored exactly as before', () => {
    // Every row already in the collection has one exit and no `exits`. Redefining realizedPnl as
    // "the total" is a no-op for them — one slice summed is that slice — which is why this needed
    // no migration.
    const single = { status: 'closed', openedAt: 0, closedAt: 60_000, exit: { price: 90, realizedPnl: -250 } }
    const s = computeTradeStats([single]).overall
    assert.equal(s.netPnl, -250)
    assert.equal(s.losses, 1)
    assert.equal(s.worst, -250)
})

test('a scaled winner and a plain loser aggregate together', () => {
    const s = computeTradeStats([scaled, { status: 'closed', exit: { realizedPnl: -150 } }]).overall
    assert.equal(s.netPnl, 1000)
    assert.equal(s.grossProfit, 1150)
    assert.equal(s.grossLoss, 150)
    assert.equal(s.count, 2)
})

// Every open row is born with `exit: null`, and Mongo refuses a dotted write inside a null. That failed
// every close and partial from 2026-08-09: the setup closed, the row stayed open. The fake keeps Mongo's rule.
function ledgerWith(row) {
    const matches = (filter) => Object.entries(filter).every(([k, v]) => {
        if (k === 'exits.orderId') return !(row.exits ?? []).some(e => e.orderId === v.$ne)
        return v === null ? row[k] == null : row[k] === v
    })
    const intoExit = (field) => {
        if (field.startsWith('exit.') && row.exit === null) throw new Error(`Cannot create field '${field.slice(5)}' in element {exit: null}`)
    }
    const updateOne = async (filter, update) => {
        if (!matches(filter)) return { matchedCount: 0 }
        for (const field of [...Object.keys(update.$set ?? {}), ...Object.keys(update.$inc ?? {})]) intoExit(field)
        for (const [field, value] of Object.entries(update.$set ?? {})) {
            if (field.startsWith('exit.')) row.exit[field.slice(5)] = value
            else row[field] = value
        }
        for (const [field, value] of Object.entries(update.$inc ?? {})) {
            if (field.startsWith('exit.')) row.exit[field.slice(5)] = (row.exit[field.slice(5)] ?? 0) + value
            else row[field] = (row[field] ?? 0) + value
        }
        for (const [field, value] of Object.entries(update.$push ?? {})) row[field] = [...(row[field] ?? []), value]
        return { matchedCount: 1 }
    }
    return { getDb: async () => ({ collection: () => ({ updateOne }) }) }
}
const openRow = () => ({ accountId: 'a', positionId: 'p', status: 'open', exit: null, commission: 0, spread: 0 })

test('captureClose closes a row born with exit: null', async () => {
    const row = openRow()
    await tradeCaptureService.captureClose({ accountId: 'a', positionId: 'p', orderId: 'o', price: 207.14, quantity: 16, reason: 'tp', pnl: 132.95, at: 5 }, ledgerWith(row))
    assert.equal(row.status, 'closed')
    assert.deepEqual(row.exit, { price: 207.14, ts: 5, reason: 'tp', realizedPnl: 132.95 })
    assert.equal(row.exits.length, 1)
})

test('a partial on a row born with exit: null records, and the close adds to its total', async () => {
    const row = openRow()
    const deps = ledgerWith(row)
    await tradeCaptureService.capturePartial({ accountId: 'a', positionId: 'p', orderId: 'o1', price: 105, quantity: 4, reason: 'tp', pnl: 20, at: 2 }, deps)
    assert.equal(row.status, 'open')
    assert.equal(row.exit.realizedPnl, 20)
    await tradeCaptureService.captureClose({ accountId: 'a', positionId: 'p', orderId: 'o2', price: 110, quantity: 6, reason: 'tp', pnl: 60, at: 3 }, deps)
    assert.equal(row.status, 'closed')
    assert.equal(row.exit.realizedPnl, 80)
    assert.equal(row.exits.length, 2)
})
