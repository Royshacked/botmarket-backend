/**
 * Trade capture.
 *
 * Append-only trade history, written from the reconciler so it captures BOTH paper and
 * live trades through one hook (they both flow through execution.reconciler). Each
 * record is a point-in-time snapshot of the idea AS AUTHORED at fill — never a
 * reference to the mutable idea doc — so later edits can't corrupt history and a future
 * backtest inherits no lookahead bias.
 *
 * This is the durable long-term asset (analytics, backtesting, scanner/ML signal,
 * funder reporting). All functions are best-effort: capture must NEVER throw into the
 * reconciler's hot path.
 *
 * Collection: trades. One doc per (accountId, positionId); opened on entry, patched on
 * close. Differentiated by `mode: 'paper' | 'live'`.
 *
 * See docs/architecture/paper-trading-simulation.md (Phase 4).
 */

import { randomUUID }   from 'crypto'
import { getDb }        from '../providers/mongodb.provider.js'
import { brokerService } from '../api/broker/broker.service.js'
import { logger }       from './logger.service.js'

const COLLECTION = 'trades'
const LOG        = '[tradeCapture]'

export const tradeCaptureService = { captureOpen, captureOpenBare, captureClose, listTrades }

/** paper broker → 'paper' mode, everything else → 'live'. */
const modeOf = broker => (broker === 'paper' ? 'paper' : 'live')

/**
 * Record a trade opening. Idempotent on (accountId, positionId): the first open wins,
 * re-delivered position.opened events are ignored. Freezes the idea's authored entry/
 * exit/invalidation as a point-in-time snapshot.
 * @param {object} idea  the (already-stamped) idea doc
 * @param {import('../api/broker/adapters/broker.interface.js').BrokerExecution} exec
 */
async function captureOpen(idea, exec) {
    try {
        if (exec?.positionId == null || exec?.accountId == null) return
        const db        = await getDb()
        const accountId = String(exec.accountId)
        const positionId = String(exec.positionId)
        const broker    = exec.broker ?? idea.broker ?? null
        const slot      = (idea.brokerOrders ?? []).find(b => String(b.accountId) === accountId)
        const quantity  = exec.quantity ?? slot?.quantity ?? idea.quantity ?? null

        // Best-effort account snapshot — uniform for paper & live via the broker layer.
        let accountSnapshot = null
        try {
            const acct = broker ? await brokerService.getAccount(broker, idea.userId) : null
            if (acct) accountSnapshot = { equity: acct.equity, cashBalance: acct.balance, currency: acct.currency }
        } catch { /* non-fatal */ }

        const now = Date.now()
        await db.collection(COLLECTION).updateOne(
            { accountId, positionId },
            {
                $setOnInsert: {
                    tradeId:    randomUUID(),
                    ideaId:     idea.id,
                    groupId:    idea.groupId ?? null,
                    userId:     idea.userId ?? null,
                    portfolioId:   idea.portfolioId   ?? null,
                    portfolioName: idea.portfolioName ?? null,
                    allocationRatio: idea.allocationRatio ?? null,
                    mode:       modeOf(broker),
                    broker, accountId, positionId,
                    symbol:     idea.asset,
                    asset_class: idea.asset_class ?? null,
                    direction:  exec.direction ?? idea.direction ?? null,
                    quantity,
                    entry:      { price: exec.price ?? null, ts: exec.at ?? now },
                    // Point-in-time snapshot — frozen as authored at fill.
                    snapshot: {
                        entry_condition_tree: idea.entry_condition_tree ?? null,
                        stop_condition_tree:  idea.stop_condition_tree  ?? null,
                        tp_condition_tree:    idea.tp_condition_tree    ?? null,
                        entry_conditions:     idea.entry_conditions ?? null,
                        stop_conditions:      idea.stop_conditions  ?? null,
                        tp_conditions:        idea.tp_conditions    ?? null,
                        entry_timeframe:      idea.entry_timeframe ?? null,
                        stop_timeframe:       idea.stop_timeframe  ?? null,
                        tp_timeframe:         idea.tp_timeframe    ?? null,
                        invalidation:         idea.invalidation ?? null,
                        notes:                idea.notes ?? null,
                        conviction:           idea.conviction ?? null,
                    },
                    accountSnapshot,
                    exit:       null,
                    status:     'open',
                    openedAt:   exec.at ?? now,
                },
            },
            { upsert: true },
        )
        logger.info(LOG, `Captured OPEN ${modeOf(broker)} trade — ${idea.asset} ${exec.direction ?? idea.direction} pos ${positionId} @ ${exec.price ?? '?'}`)
    } catch (err) {
        logger.error(LOG, `captureOpen failed (pos ${exec?.positionId}): ${err.message}`)
    }
}

/**
 * Record a trade opening WITHOUT an idea (idealess fallback) — for a paper position
 * that isn't backed by a linked active idea, so it still shows in trade history. Built
 * from the execution event alone; no idea snapshot. Idempotent on (accountId, positionId),
 * so it never conflicts with the idea-based captureOpen (that path returns first when an
 * idea matches — the two are mutually exclusive per position).
 * @param {import('../api/broker/adapters/broker.interface.js').BrokerExecution} exec
 */
async function captureOpenBare(exec) {
    try {
        if (exec?.positionId == null || exec?.accountId == null || exec?.userId == null) return
        const db         = await getDb()
        const accountId  = String(exec.accountId)
        const positionId = String(exec.positionId)
        const now        = Date.now()
        await db.collection(COLLECTION).updateOne(
            { accountId, positionId },
            {
                $setOnInsert: {
                    tradeId:    randomUUID(),
                    ideaId:     null,
                    groupId:    null,
                    userId:     String(exec.userId),
                    portfolioId: null, portfolioName: null, allocationRatio: null,
                    mode:       modeOf(exec.broker),
                    broker:     exec.broker ?? null, accountId, positionId,
                    symbol:     exec.symbol ?? null,
                    asset_class: null,
                    direction:  exec.direction ?? null,
                    quantity:   exec.quantity ?? null,
                    entry:      { price: exec.price ?? null, ts: exec.at ?? now },
                    snapshot:   null,
                    accountSnapshot: null,
                    exit:       null,
                    status:     'open',
                    openedAt:   exec.at ?? now,
                },
            },
            { upsert: true },
        )
        logger.info(LOG, `Captured OPEN ${modeOf(exec.broker)} trade (idealess) — ${exec.symbol} ${exec.direction} pos ${positionId} @ ${exec.price ?? '?'}`)
    } catch (err) {
        logger.error(LOG, `captureOpenBare failed (pos ${exec?.positionId}): ${err.message}`)
    }
}

/**
 * Patch the open trade for a closed position to closed, with the exit + realized P&L.
 * @param {{ accountId, positionId, price?, reason?, pnl?, at? }} opts
 */
async function captureClose({ accountId, positionId, price, reason, pnl, at }) {
    try {
        if (positionId == null || accountId == null) return
        const db  = await getDb()
        const now = at ?? Date.now()
        const res = await db.collection(COLLECTION).updateOne(
            { accountId: String(accountId), positionId: String(positionId), status: 'open' },
            {
                $set: {
                    status:   'closed',
                    closedAt: now,
                    exit:     { price: price ?? null, ts: now, reason: reason ?? null, realizedPnl: pnl ?? null },
                },
            },
        )
        if (res.matchedCount) logger.info(LOG, `Captured CLOSE trade — pos ${positionId} (reason=${reason ?? '·'}, pnl=${pnl ?? '·'})`)
    } catch (err) {
        logger.error(LOG, `captureClose failed (pos ${positionId}): ${err.message}`)
    }
}

/**
 * Read trades for a user, newest first.
 * @param {{ mode?: 'paper'|'live', status?: 'open'|'closed', portfolioId?: string, limit?: number }} [filter]
 */
async function listTrades(userId, filter = {}) {
    const db = await getDb()
    const q  = { userId }
    if (filter.mode)        q.mode        = filter.mode
    if (filter.status)      q.status      = filter.status
    if (filter.portfolioId) q.portfolioId = filter.portfolioId
    return db.collection(COLLECTION)
        .find(q, { projection: { _id: 0 } })
        .sort({ openedAt: -1 })
        .limit(filter.limit ?? 500)
        .toArray()
}
