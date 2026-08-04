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
 * minosService / paperFillService. Skips entirely when no positions are open.
 */

import { getDb }        from '../providers/mongodb.provider.js'
import { quoteMapForSymbols,
         dirSign,
         round2 }       from '../api/broker/paperExecution.service.js'
import { logger }       from '../services/logger.service.js'
import { createPollLoop } from './monitorUtils.js'
import { partitionByFreshness, retainOnly } from '../services/priceFeed.service.js'

const LOG              = '[paperMark.service]'
const POSITIONS        = 'paperPositions'
const POLL_INTERVAL_MS = Number(process.env.PAPER_MARK_INTERVAL_MS) || 3_000

const _loop = createPollLoop({ intervalMs: POLL_INTERVAL_MS, tick: _tick, log: LOG, name: 'paper mark' })

export const paperMarkService = { start: _loop.start, stop: _loop.stop, _tick }

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
    const { fresh, stale } = partitionByFreshness(symbols, POLL_INTERVAL_MS / 2)
    const fetched = stale.length ? await quoteMapForSymbols(stale) : new Map()   // publishes as it resolves
    const priceBy = new Map([...fresh, ...fetched])

    const now = Date.now()
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
