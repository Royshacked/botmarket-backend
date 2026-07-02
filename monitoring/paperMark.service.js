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
 * monitorService / paperFillService. Skips entirely when no positions are open.
 */

import { getDb }        from '../providers/mongodb.provider.js'
import { latestMarkPrice,
         dirSign,
         round2 }       from '../api/broker/paperExecution.service.js'
import { logger }       from '../services/logger.service.js'

const LOG              = '[paperMark.service]'
const POSITIONS        = 'paperPositions'
const POLL_INTERVAL_MS = Number(process.env.PAPER_MARK_INTERVAL_MS) || 5_000

let _timer   = null
let _running = false

export const paperMarkService = { start, stop, _tick }

function start() {
    if (_timer) return
    _timer = setInterval(() => { _tick().catch(err => logger.error(LOG, 'tick error:', err.message)) }, POLL_INTERVAL_MS)
    logger.info(LOG, `Paper mark loop started (every ${POLL_INTERVAL_MS / 1000}s)`)
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null }
}

async function _tick() {
    if (_running) return   // never overlap a slow sweep
    _running = true
    try {
        const db        = await getDb()
        const positions = await db.collection(POSITIONS).find({ status: 'open' }, { projection: { _id: 0 } }).toArray()
        if (!positions.length) return

        // One price per distinct symbol — many positions can share a symbol. Marking
        // prefers a real-time last quote (equities) and falls back to the candle close,
        // which also seeds the shared quote cache for the client poll + fill engine.
        const symbols = [...new Set(positions.map(p => p.symbol))]
        const priceBy = new Map(await Promise.all(symbols.map(async s => [s, await latestMarkPrice(s)])))

        const now  = Date.now()
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
        logger.info(LOG, `Marked ${ops.length}/${positions.length} open paper position(s) across ${symbols.length} symbol(s)`)
    } finally {
        _running = false
    }
}
