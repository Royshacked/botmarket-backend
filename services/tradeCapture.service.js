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
import { ENTITIES }     from './entity/entityCollection.js'

const COLLECTION = 'trades'
const LOG        = '[tradeCapture]'

export const tradeCaptureService = { captureOpen, captureOpenBare, captureClose, listTrades, tradeStats }

/**
 * Indexes for the analytics ledger. Best-effort (logs + continues), created once at
 * startup — mirrors ensureIdeaIndexes. Keyed to the real access paths:
 *   • (accountId, positionId) UNIQUE — the identity/idempotency key every capture upserts
 *     on; also enforces the one-doc-per-position invariant.
 *   • (userId, openedAt desc)  — the listTrades read + newest-first sort.
 *   • (userId, origin.portfolioId) / (userId, origin.callId) — the analytics slice dims.
 */
export async function ensureTradeIndexes() {
    try {
        const db = await getDb()
        const col = db.collection(COLLECTION)
        await col.createIndex({ userId: 1, openedAt: -1 })
        await col.createIndex({ userId: 1, 'origin.portfolioId': 1 })
        await col.createIndex({ userId: 1, 'origin.callId': 1 })
        // Unique identity key — created last so a legacy duplicate can't block the read
        // indexes above; a collision surfaces as the warning below (capture upserts on this
        // pair, so duplicates shouldn't exist in the first place).
        await col.createIndex({ accountId: 1, positionId: 1 }, { unique: true })
    } catch (err) {
        logger.warn(LOG, 'ensureTradeIndexes failed:', err.message)
    }
}

/** paper → 'paper', manual (broker-less real money) → 'manual', everything else → 'live'. */
const modeOf = broker => (broker === 'paper' ? 'paper' : broker === 'manual' ? 'manual' : 'live')

/**
 * The origin block — what spawned this trade, frozen at fill. `ideaId` is the execution
 * vehicle (almost always set; null only for idealess capture). `callId != null` is the
 * canonical "this is a Kairos call" flag. `type` is derived, call taking precedence over
 * portfolio over plain idea. Pure — no `idea` (idealess) yields the all-null origin.
 * @param {object} [idea] the persisted idea doc (omit for idealess capture)
 */
export function buildOrigin(idea = {}) {
    const ideaId      = idea.id ?? null
    const callId      = idea.callId ?? null
    const portfolioId = idea.portfolioId ?? null
    const type = ideaId == null    ? null
        : callId != null      ? 'call'
        : portfolioId != null ? 'portfolio'
        : 'idea'
    return {
        type,
        ideaId,
        callId,
        groupId:         idea.groupId ?? null,
        portfolioId,
        portfolioName:   idea.portfolioName ?? null,
        allocationRatio: idea.allocationRatio ?? null,
    }
}

/**
 * The originating Kairos call's reasoning, frozen onto a call-origin trade's snapshot —
 * the `notes` string alone loses the thesis/bias/zones/patterns the call was built on.
 * Always returns the four keys (null when absent) so analytics can read them uniformly.
 * Pure — a null/absent call (idea trade, or a deleted call) yields the all-null shape.
 * @param {object|null} [call] the kairos_calls doc (thesis/bias/entry_zones/patterns)
 */
export function pickCallReasoning(call = null) {
    return {
        thesis:      call?.thesis      ?? null,
        bias:        call?.bias        ?? null,
        entry_zones: call?.entry_zones ?? null,
        patterns:    call?.patterns    ?? null,
    }
}

/**
 * The portfolio's thesis (strategy + target exposures), frozen onto a portfolio-origin
 * trade's snapshot — the trade stores portfolio *pointers* (id/name), but the thesis text
 * lives only in `portfolio_chats` and gets rewritten over the book's life. Pure — a
 * null/absent thesis (idea/call trade, or a book with no thesis) yields null.
 * @param {object|null} [thesis] the `portfolio_chats.thesis` sub-doc
 */
export function pickPortfolioThesis(thesis = null) {
    if (!thesis) return null
    return {
        strategy:        thesis.strategy        ?? null,
        targetExposures: thesis.targetExposures ?? null,
    }
}

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
        // Pass the trade's own accountId so a multi-account broker (paper) snapshots the
        // account the fill landed on, not its default.
        let accountSnapshot = null
        try {
            const acct = broker ? await brokerService.getAccount(broker, idea.userId, accountId) : null
            if (acct) accountSnapshot = { equity: acct.equity, cashBalance: acct.balance, currency: acct.currency }
        } catch { /* non-fatal */ }

        // Best-effort: freeze the originating Kairos call's reasoning for call-origin trades.
        // Read straight from the collection (no service import) to keep capture decoupled.
        let call = null
        if (idea.callId) {
            try {
                call = await db.collection(ENTITIES).findOne(
                    { id: idea.callId },
                    { projection: { thesis: 1, bias: 1, entry_zones: 1, patterns: 1, _id: 0 } },
                )
            } catch { /* non-fatal */ }
        }

        // Best-effort: freeze the book's thesis for portfolio-origin trades — the trade holds
        // portfolio pointers, but the thesis text lives in portfolio_chats and gets rewritten.
        let portfolioThesis = null
        if (idea.portfolioId) {
            try {
                const pdoc = await db.collection('portfolio_chats').findOne(
                    { portfolioId: idea.portfolioId, userId: idea.userId },
                    { projection: { thesis: 1, _id: 0 } },
                )
                portfolioThesis = pickPortfolioThesis(pdoc?.thesis)
            } catch { /* non-fatal */ }
        }

        const now = Date.now()
        await db.collection(COLLECTION).updateOne(
            { accountId, positionId },
            {
                $setOnInsert: {
                    tradeId:    randomUUID(),
                    origin:     buildOrigin(idea),
                    userId:     idea.userId ?? null,
                    mode:       modeOf(broker),
                    broker, accountId, positionId,
                    symbol:     idea.asset,
                    asset_class: idea.asset_class ?? null,
                    direction:  exec.direction ?? idea.direction ?? null,
                    quantity,
                    entry:      { price: exec.price ?? null, ts: exec.at ?? now },
                    commission: exec.commission ?? 0,   // entry-fill cost; captureClose $inc-adds the exit fill
                    spread:     exec.spread ?? 0,        // → round-trip total once closed
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
                        // Call-origin reasoning (null for idea/portfolio trades). See pickCallReasoning.
                        ...pickCallReasoning(call),
                        // Portfolio-origin thesis (null for idea/call trades). See pickPortfolioThesis.
                        portfolioThesis,
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
                    origin:     buildOrigin(),          // idealess → all-null origin (type: null)
                    userId:     String(exec.userId),
                    mode:       modeOf(exec.broker),
                    broker:     exec.broker ?? null, accountId, positionId,
                    symbol:     exec.symbol ?? null,
                    asset_class: null,
                    direction:  exec.direction ?? null,
                    quantity:   exec.quantity ?? null,
                    entry:      { price: exec.price ?? null, ts: exec.at ?? now },
                    commission: exec.commission ?? 0,
                    spread:     exec.spread ?? 0,
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
 * Exit-fill commission/spread are $inc-accumulated onto the entry-fill costs stored at
 * open, so `commission`/`spread` become the round-trip total.
 * @param {{ accountId, positionId, price?, reason?, pnl?, commission?, spread?, at? }} opts
 */
async function captureClose({ accountId, positionId, price, reason, pnl, commission, spread, at }) {
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
                $inc: { commission: commission ?? 0, spread: spread ?? 0 },
            },
        )
        if (res.matchedCount) logger.info(LOG, `Captured CLOSE trade — pos ${positionId} (reason=${reason ?? '·'}, pnl=${pnl ?? '·'})`)
    } catch (err) {
        logger.error(LOG, `captureClose failed (pos ${positionId}): ${err.message}`)
    }
}

/**
 * Read trades for a user, newest first. All filters optional; omitting `mode` returns
 * every mode (paper + live + manual) — the unified analytics read.
 * @param {{ mode?: 'paper'|'live'|'manual', status?: 'open'|'closed', symbol?: string,
 *   originType?: 'idea'|'call'|'portfolio', portfolioId?: string, callId?: string,
 *   accountId?: string, fromMs?: number, toMs?: number, limit?: number }} [filter]
 */
async function listTrades(userId, filter = {}) {
    const db = await getDb()
    const q  = { userId }
    if (filter.mode)        q.mode        = filter.mode
    if (filter.status)      q.status      = filter.status
    if (filter.symbol)      q.symbol      = filter.symbol
    if (filter.originType)  q['origin.type']        = filter.originType
    if (filter.portfolioId) q['origin.portfolioId'] = filter.portfolioId
    if (filter.callId)      q['origin.callId']      = filter.callId
    if (filter.accountId)   q.accountId   = String(filter.accountId)
    if (filter.fromMs != null || filter.toMs != null) {
        q.openedAt = {}
        if (filter.fromMs != null) q.openedAt.$gte = Number(filter.fromMs)
        if (filter.toMs   != null) q.openedAt.$lte = Number(filter.toMs)
    }
    return db.collection(COLLECTION)
        .find(q, { projection: { _id: 0 } })
        .sort({ openedAt: -1 })
        .limit(filter.limit ?? 500)
        .toArray()
}

/**
 * Realized-performance statistics for a user's CLOSED trades matching `filter` (same shape
 * as listTrades, minus status). Fetches then folds via the pure computeTradeStats. Uses a
 * high cap so a full history aggregates in one call.
 */
async function tradeStats(userId, filter = {}) {
    const trades = await listTrades(userId, { ...filter, status: 'closed', limit: filter.limit ?? 10000 })
    return computeTradeStats(trades)
}

const _round = (n, d = 2) => { const f = 10 ** d; return Math.round((Number(n) || 0) * f) / f }

/**
 * Core realized-P&L summary over a set of trades — only closed trades with a P&L count.
 * Nothing computed is stored on the trade; this derives it all from `exit.realizedPnl` +
 * timestamps. winRate/expectancy use total closed count as the denominator (breakeven
 * trades included). Pure.
 */
function _summarize(trades) {
    const closed = (trades ?? []).filter(t => t?.status === 'closed')
    let wins = 0, losses = 0, breakeven = 0, grossProfit = 0, grossLoss = 0
    let best = null, worst = null, durSum = 0, durN = 0
    for (const t of closed) {
        const pnl = Number(t.exit?.realizedPnl) || 0
        if (pnl > 0)      { wins++;   grossProfit += pnl }
        else if (pnl < 0) { losses++; grossLoss   += -pnl }
        else              { breakeven++ }
        best  = best  == null ? pnl : Math.max(best, pnl)
        worst = worst == null ? pnl : Math.min(worst, pnl)
        if (t.openedAt != null && t.closedAt != null) { durSum += (t.closedAt - t.openedAt); durN++ }
    }
    const count  = closed.length
    const netPnl = grossProfit - grossLoss
    return {
        count, wins, losses, breakeven,
        winRate:       count ? _round(wins / count, 4) : 0,
        netPnl:        _round(netPnl),
        grossProfit:   _round(grossProfit),
        grossLoss:     _round(grossLoss),
        profitFactor:  grossLoss > 0 ? _round(grossProfit / grossLoss, 4) : null,
        avgWin:        wins   ? _round(grossProfit / wins)   : 0,
        avgLoss:       losses ? _round(grossLoss / losses)   : 0,
        expectancy:    count  ? _round(netPnl / count)       : 0,
        avgDurationMs: durN   ? Math.round(durSum / durN)    : null,
        best:  best  == null ? null : _round(best),
        worst: worst == null ? null : _round(worst),
    }
}

function _groupBy(trades, keyFn) {
    const groups = {}
    for (const t of trades) (groups[keyFn(t) ?? 'unknown'] ??= []).push(t)
    const out = {}
    for (const k of Object.keys(groups)) out[k] = _summarize(groups[k])
    return out
}

/**
 * Fold a set of trades into an overall summary plus by-mode / by-origin / by-symbol
 * breakdowns (each group reuses the same summarizer). Only closed trades contribute.
 * Pure — exported for unit testing and for callers that already hold the trades.
 * @param {object[]} [trades]
 */
export function computeTradeStats(trades = []) {
    const closed = (trades ?? []).filter(t => t?.status === 'closed')
    return {
        overall:  _summarize(closed),
        byMode:   _groupBy(closed, t => t.mode),
        byOrigin: _groupBy(closed, t => t.origin?.type),
        bySymbol: _groupBy(closed, t => t.symbol),
    }
}
