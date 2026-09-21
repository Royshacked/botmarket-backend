/**
 * Paper mark-to-market loop.
 *
 * The simulation has no broker push feed, so P&L only moves when something re-prices
 * the open positions. This loop is that heartbeat: every X seconds it fetches a fresh
 * quote for each distinct symbol across ALL open paper positions (deduped — one fetch
 * per symbol, not per position) and stamps `currentPrice` / `pnl` / `markedAt` on each
 * position doc.
 *
 * Two payoffs:
 *  - The client positions poll reads a moving P&L (the adapter falls back to the stored
 *    mark when its own fetch misses — see paper.adapter._toBrokerPosition).
 *  - Fetching here keeps paperExecution's quote cache warm, so the client poll and the
 *    fill engine reuse these quotes instead of each hammering the rate-limited provider.
 *
 * Global (not per-account): one loop sweeps every user's open positions, like
 * paperFillService. Skips entirely when no positions are open.
 *
 * PACED BY A QUOTE BUDGET (2026-09-21). The loop ticks every 3s but a SWEEP — the fetch — only
 * happens when the budget allows: symbols ÷ PAPER_MARK_QUOTE_BUDGET_PER_MIN minutes since the last
 * one, and never more than once a minute outside the US session. 45 symbols every 3s was ~900
 * quotes a minute, 24 hours a day, against a plan that allows a few hundred; the 429s it produced
 * were what starved every other FMP read in the app. The fill loop is untouched — it prices only
 * the symbols with a pending order, and a touch fill needs the 3s.
 */

import { getDb }        from '../providers/mongodb.provider.js'
import { quoteMapForSymbols,
         dirSign }      from '../api/broker/paperExecution.service.js'
import { round2 }       from '../services/number.util.js'
import { logger }       from '../services/logger.service.js'
import { createPollLoop } from './pollLoop.js'
import { partitionByFreshness, retainOnly } from '../services/priceFeed.service.js'
import { POSITIONS } from '../api/broker/paperBroker.service.js'
import { config } from '../services/config.js'
import { isMarketOpen } from '../services/market.service.js'

const LOG              = '[paperMark.service]'
const POLL_INTERVAL_MS = config.paperMarkIntervalMs
const QUOTE_BUDGET_PER_MIN = config.paperMarkQuoteBudgetPerMin
const CLOSED_INTERVAL_MS   = config.paperMarkClosedIntervalMs

const _loop = createPollLoop({ intervalMs: POLL_INTERVAL_MS, tick: _tick, log: LOG, name: 'paper mark' })

export const paperMarkService = { start: _loop.start, stop: _loop.stop, _tick }

/**
 * How long a sweep over `symbolCount` symbols must wait after the last one. The budget is the
 * floor in session; outside it the closed interval is — and neither is ever shorter than the tick.
 * Pure; exported for tests.
 */
export function sweepIntervalMs(symbolCount, open = isMarketOpen()) {
    const byBudget = symbolCount / QUOTE_BUDGET_PER_MIN * 60_000
    return Math.max(open ? POLL_INTERVAL_MS : CLOSED_INTERVAL_MS, byBudget)
}

let _lastSweepAt = 0
/** Whether a sweep over `symbolCount` symbols is due at `now`. Exported for tests; `last` overrides the memory. */
export function sweepDue(symbolCount, { now = Date.now(), open = isMarketOpen(), last = _lastSweepAt } = {}) {
    return now - last >= sweepIntervalMs(symbolCount, open)
}

async function _tick() {
    const db        = await getDb()
    const positions = await db.collection(POSITIONS).find({ status: 'open' }, { projection: { _id: 0 } }).toArray()
    if (!positions.length) return

    // One price per distinct symbol — many positions can share a symbol. Marking prefers a
    // real-time last quote (equities) and falls back to the candle close.
    //
    // Read before fetching. Someone else may have priced this symbol since our last tick — a chart
    // open on it polls every 5s, and every fetch in the app publishes what it paid for — and a mark
    // younger than half our interval is exactly as good as the one we would have gone and bought.
    // The tolerance is HALF the interval, not the whole of it, so this can never be satisfied by
    // its OWN publication from the previous tick and stop refreshing.
    const symbols = [...new Set(positions.map(p => p.symbol))]
    // The budget gate: a tick that is not yet due does nothing — no fetch, no write, no log line.
    const now = Date.now()
    if (!sweepDue(symbols.length, { now })) return
    _lastSweepAt = now
    const { fresh, stale } = partitionByFreshness(symbols, sweepIntervalMs(symbols.length) / 2)
    const fetched = stale.length ? await quoteMapForSymbols(stale) : new Map()   // publishes as it resolves
    const priceBy = new Map([...fresh, ...fetched])

    // Symbols we no longer hold stop being published — the feed should be the size of what is live,
    // not of everything ever marked.
    retainOnly(symbols)

    const ops  = []
    for (const p of positions) {
        const price = priceBy.get(p.symbol)
        if (price == null) continue   // no quote this tick — keep the last stored mark
        const pnl = round2((price - p.avgPrice) * p.qty * dirSign(p.direction))
        ops.push({
            updateOne: {
                filter: { userId: p.userId, positionId: String(p.positionId) },
                update: { $set: { currentPrice: price, pnl, markedAt: now } },
            },
        })
    }

    if (ops.length) await db.collection(POSITIONS).bulkWrite(ops, { ordered: false })
    logger.info(LOG, `Marked ${ops.length}/${positions.length} open paper position(s) across ${priceBy.size} symbol(s)` +
        ` — ${fetched.size} fetched, ${fresh.size} read from the feed`)
}
