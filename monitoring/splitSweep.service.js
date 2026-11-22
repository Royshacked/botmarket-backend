// THE SPLIT SWEEP (2026-11-22) — open trades through a stock split. Hourly: the split calendar (corporateActions — the
// same cached read the coverage monitor asks) against the names anything is open on — an idea, a holding, a setup, a
// paper / manual position or order — and every split among them handed to tradeSplit.restateOpenTrades. Each row is
// restated once (its own `split_through`), so a tick that finds nothing new writes nothing.
//
// Kind-blind and mode-blind on purpose, like the reconciler: a live stop must be restated while the user stands in paper.

import { getDb } from '../providers/mongodb.provider.js'
import { ENTITIES } from '../services/entity/entityCollection.js'
import { COLLECTION as TRADES } from '../services/tradeCapture.service.js'
import { POSITIONS, ORDERS } from '../api/broker/paperBroker.service.js'
import { corporateActionsService } from '../services/corporateActions.service.js'
import { restateOpenTrades, restatePaperPosition, restatePaperOrder, restateLedgerRow, OPEN_STATUSES, TRADE_KIND_QUERY, splitDayMs } from '../services/tradeSplit.service.js'
import { appendJournal } from '../services/journal.service.js'
import { notifySplitRestated } from '../services/tradeNotify.service.js'
import { dropCandleCache } from '../services/price.service.js'
import { executionReconciler } from './execution.reconciler.js'
import { createPollLoop } from './pollLoop.js'
import { logger } from '../services/logger.service.js'

const LOG = '[splitSweep]'
const INTERVAL_MS = 60 * 60 * 1000

/** Not yet restated for a split on `date` — the guard every write rides. */
const notThrough = (date) => ({ $or: [{ split_through: { $exists: false } }, { split_through: { $lt: date } }] })

/** Restate every row matching `filter` once, each by its own `key` (positionId / orderId / tradeId) under the guard. → n. */
async function _restateRows(coll, key, filter, date, fn) {
    const rows = await coll.find({ ...filter, ...notThrough(date) }).toArray()
    let n = 0
    for (const row of rows) {
        if (row[key] == null) continue
        const res = await coll.updateOne({ [key]: row[key], ...notThrough(date) }, { $set: { ...fn(row), split_through: date } })
        if (res.matchedCount === 1) n++
    }
    return n
}

const _io = {
    db: () => getDb(),
    splits: () => corporateActionsService.recentSplits(),
    notify: (trade, split, summary) => notifySplitRestated(trade, split, summary),
}
/** Test seam. */
export function _setSplitSweepIO(io) { Object.assign(_io, io) }

/** The IO restateOpenTrades runs on, over one db handle. */
export function _tradeIO(db) {
    const entities = db.collection(ENTITIES)
    return {
        findTrades: (symbol, beforeMs, date) => entities.find({
            kind: { $in: TRADE_KIND_QUERY }, asset: symbol, status: { $in: OPEN_STATUSES }, savedAt: { $lt: beforeMs }, ...notThrough(date),
        }).project({ _id: 0 }).toArray(),
        claimTrade: async (id, date, set) => (await entities.updateOne({ id, ...notThrough(date) }, { $set: { ...set, split_through: date } })).matchedCount === 1,
        journal: (id, entry) => appendJournal(id, entry, db),
        restateVenue: async (symbol, beforeMs, split) => ({
            positions: await _restateRows(db.collection(POSITIONS), 'positionId', { symbol, status: 'open', openedAt: { $lt: beforeMs } }, split.date, row => restatePaperPosition(row, split.ratio, beforeMs)),
            orders:    await _restateRows(db.collection(ORDERS), 'orderId', { symbol, status: 'working', createdAt: { $lt: beforeMs } }, split.date, row => restatePaperOrder(row, split.ratio)),
        }),
        restateLedger: (symbol, beforeMs, split) => _restateRows(db.collection(TRADES), 'tradeId', { symbol, status: 'open', 'entry.ts': { $lt: beforeMs } }, split.date, row => restateLedgerRow(row, split.ratio)),
        reconcileLive: (trade) => executionReconciler.reconcileSplit(trade),
        notify: (trade, split, summary) => _io.notify(trade, split, summary),
        dropCandles: (symbol) => dropCandleCache(symbol),
    }
}

/**
 * CATCH UP BEFORE AN EDIT (code review, 2026-11-22). A level written after a split but before the sweep has restated the
 * trade would be divided AGAIN by the sweep — the trade's `savedAt` still says pre-split. So every path that writes a
 * trade's levels (a setup redraw or patch, an idea edit, a manage verb) asks this first: a split the trade has not been
 * through is restated NOW (the whole name, as the sweep would), and the edit then lands on post-split numbers with
 * `split_through` set. → `{ doc, splits }` — the fresh trade (null when none) and the splits just applied (a caller holding
 * an in-memory proposal restates it with them). Never throws: a failed check is `{ doc: null, splits: [] }`.
 */
export async function ensureRestated(id) {
    try {
        const db = await _io.db()
        const entities = db.collection(ENTITIES)
        const doc = id ? await entities.findOne({ id }, { projection: { _id: 0 } }) : null
        if (!doc?.asset || !OPEN_STATUSES.includes(doc.status)) return { doc, splits: [] }
        const due = (await corporateActionsService.splitsSince(String(doc.asset).toUpperCase(), doc.split_through ?? null))
            .filter(s => splitDayMs(s.date) > Number(doc.savedAt ?? 0))
        if (!due.length) return { doc, splits: [] }
        const io = _tradeIO(db)
        for (const split of due) await restateOpenTrades(split, io)
        const fresh = await entities.findOne({ id }, { projection: { _id: 0 } })
        const applied = due.filter(s => (fresh?.split_through ?? '') >= s.date)
        if (applied.length) logger.info(LOG, `caught up before an edit: ${doc.asset}`, { id, splits: applied.map(s => s.date) })
        return { doc: fresh ?? doc, splits: applied }
    } catch (err) {
        logger.warn(LOG, `split catch-up for ${id} failed`, err.message)
        return { doc: null, splits: [] }
    }
}

/** One sweep → `{ splits, restated: [{ symbol, date, trades, venue, ledger }] }`. */
export async function _tick() {
    const splits = await _io.splits()
    if (!splits.length) return { splits: 0, restated: [] }
    const db = await _io.db()
    const syms = [...new Set(splits.map(s => s.symbol))]
    // Only the names something is open on — one query each side, not one per split. A find with a projection, NOT
    // `distinct`: the client runs the Stable API strictly (apiStrict), and `distinct` is not in API Version 1 — every
    // tick failed on it on its first run (2026-11-22).
    const names = (coll, field, filter) => db.collection(coll).find(filter).project({ _id: 0, [field]: 1 }).toArray().then(rows => rows.map(r => r[field]))
    const [ents, pos, ords] = await Promise.all([
        names(ENTITIES, 'asset', { asset: { $in: syms }, kind: { $in: TRADE_KIND_QUERY }, status: { $in: OPEN_STATUSES } }),
        names(POSITIONS, 'symbol', { symbol: { $in: syms }, status: 'open' }),
        names(ORDERS, 'symbol', { symbol: { $in: syms }, status: 'working' }),
    ])
    const open = new Set([...ents, ...pos, ...ords].filter(Boolean).map(s => String(s).toUpperCase()))
    const io = _tradeIO(db)
    const restated = []
    for (const split of splits.filter(s => open.has(s.symbol))) {
        const res = await restateOpenTrades(split, io)
        const did = res.trades.length + (res.venue?.positions ?? 0) + (res.venue?.orders ?? 0) + (res.ledger ?? 0)
        if (did) {
            logger.info(LOG, `${split.symbol} ${split.numerator}-for-${split.denominator} (${split.date}) restated`, { trades: res.trades.length, venue: res.venue, ledger: res.ledger })
            restated.push({ symbol: split.symbol, date: split.date, ...res })
        }
    }
    return { splits: splits.length, restated }
}

const _loop = createPollLoop({ intervalMs: INTERVAL_MS, tick: _tick, eager: true, log: LOG, name: 'split sweep' })
export const splitSweepService = { start: _loop.start, stop: _loop.stop, _tick }
