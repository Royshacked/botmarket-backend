// OPEN TRADES THROUGH A STOCK SPLIT (Roy, 2026-11-22: "do open trade restatement"; answers: RESTATE + FLAG, and on a live
// venue RE-READ THE BROKER). The coverage side is coverage.service applySplit; this is the execution tier's — every idea,
// holding (portfolio_item) and Mentor setup still open on the name, the paper / manual venue's positions and orders, and
// the open `trades` ledger rows.
//
// A split changes no value: every per-share PRICE set before it ÷ the ratio, every share QUANTITY × it (8-for-1: ÷8 / ×8;
// a 1-for-20 reverse split: ×20 / ÷20). The two real cases on 2026-11-22: SNDK 8-for-1 (a paper long, 5 @ 1428 against a
// ~$80 quote, a fake −$6.7k) and SLQT 1-for-20 (a paper holding, 90 @ $0.37 against $5, a fake +$418).
//
// What code can restate, it does, once (`split_through`, a conditional write): the structured levels and sizes, and the
// one condition text the app writes itself ("price touches <level>", condition.parser's machine shape). What it cannot —
// a level inside free text an LLM reads (a Mentor condition, a trigger, an idea's "closes below 1400") — it FLAGS: the
// user's card lists them, and a setup's Talos memo is told the split so every read knows the levels moved.
//
// The arithmetic is corporateActions' (perShare); the decision of what an open trade holds is here. Pure, except
// restateOpenTrades at the bottom (IO injected).

import { perShare, splitEffect, etMidnightMs } from './corporateActions.service.js'
import { PAST_ENTRY, PRE_ENTRY } from './entity/vocabulary.js'
import { logger } from './logger.service.js'

const LOG = '[tradeSplit]'
/** The statuses an open trade can be in — before entry (levels still waiting) and past it. */
export const OPEN_STATUSES = Object.freeze([...PRE_ENTRY, ...PAST_ENTRY])
/** The entity kinds that carry a trade. */
export const TRADE_KINDS = Object.freeze(['idea', 'portfolio_item', 'setup'])
/** What a query matches them by — with `null`: an idea saved before `kind` existed is still an idea (tradeIdeas IDEA_CRUD_KINDS). */
export const TRADE_KIND_QUERY = Object.freeze([...TRADE_KINDS, null])

const TOUCH = /^\s*price\s+touches\s+(-?\d+(?:\.\d+)?)\s*$/i
const _isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v))

/** A share count after a split (× the ratio; kept to 6 places — a reverse split can leave a fraction). Pure. */
export function moreShares(q, ratio) {
    if (!_isNum(q) || !(ratio > 0)) return q
    return Math.round(Number(q) * ratio * 1e6) / 1e6
}

/** The ET start of a split day, in ms — what "opened / saved before the split" is measured against. Pure. */
export const splitDayMs = (date) => etMidnightMs(date)

/**
 * One condition TEXT through a split → `{ text, free }`. The app's own shape ("price touches N") is rewritten; any other
 * text that names a number is left as it is and marked `free` — a level code must not guess at. Pure.
 */
export function restateConditionText(text, ratio) {
    if (typeof text !== 'string') return { text, free: false }
    const m = text.match(TOUCH)
    if (m) return { text: `price touches ${perShare(Number(m[1]), ratio)}`, free: false }
    return { text, free: /\d/.test(text) }
}

function _leaf(leaf, ratio, flags) {
    if (!leaf || typeof leaf !== 'object') return leaf
    const out = { ...leaf }
    for (const key of ['condition', 'text']) {
        if (typeof leaf[key] !== 'string') continue
        const r = restateConditionText(leaf[key], ratio)
        out[key] = r.text
        if (r.free) flags.push(leaf[key])
    }
    if (_isNum(leaf.quantity)) out.quantity = moreShares(leaf.quantity, ratio)
    if (Array.isArray(leaf.children)) out.children = leaf.children.map(c => _leaf(c, ratio, flags))
    return out
}

const _list = (arr, fn) => (Array.isArray(arr) ? arr.map(fn) : arr)

/** A price-bearing leg — `{price, about, quantity, conditions[], trigger}` (setups) or `{level, quantity}` (native exits). */
function _leg(leg, ratio, flags) {
    if (!leg || typeof leg !== 'object') return leg
    const out = { ...leg }
    for (const k of ['price', 'about', 'level']) if (_isNum(leg[k])) out[k] = perShare(leg[k], ratio)
    if (_isNum(leg.quantity)) out.quantity = moreShares(leg.quantity, ratio)
    if (Array.isArray(leg.conditions)) out.conditions = leg.conditions.map(c => _leaf(c, ratio, flags))
    if (typeof leg.trigger === 'string' && /\d/.test(leg.trigger)) flags.push(leg.trigger)
    return out
}

function _range(r, ratio) {
    if (!r || typeof r !== 'object') return r
    const out = { ...r }
    for (const k of ['lower', 'upper', 'approach']) if (_isNum(r[k])) out[k] = perShare(r[k], ratio)
    return out
}

function _scenario(s, ratio, flags) {
    if (!s || typeof s !== 'object') return s
    const out = { ...s }
    for (const k of ['entry_legs', 'stop_legs', 'target_legs']) out[k] = _list(s[k], l => _leg(l, ratio, flags))
    if (_isNum(s.quantity)) out.quantity = moreShares(s.quantity, ratio)
    if (s.validity) out.validity = _range(s.validity, ratio)
    for (const k of ['arm_close', 'arm_floor']) if (_isNum(s[k])) out[k] = perShare(s[k], ratio)
    if (Array.isArray(s.conditions)) out.conditions = s.conditions.map(c => _leaf(c, ratio, flags))
    return out
}

/**
 * Everything an open trade holds per share, restated → `{ set, flags }`: `set` the `$set` (whole subdocuments, so arrays
 * stay whole), `flags` the free-text conditions that still name a pre-split number. Ideas and holdings (their levels,
 * sizes, condition trees, exits and the coverage target frozen at entry) and setups (scenarios, the flat projection the
 * executor reads, Talos's guards, the position's fill, stop and targets, a pending manage proposal, Mentor's worksheet).
 * A ratio (R, rr, weights) and money are not per-share. Pure.
 */
export function restateTrade(doc, ratio) {
    const set = {}, flags = []
    const tree = (t) => (t ? _leaf(t, ratio, flags) : t)
    const leaves = (arr) => _list(arr, c => _leaf(c, ratio, flags))
    const price = (path, v) => { if (_isNum(v)) set[path] = perShare(v, ratio) }
    const qty = (path, v) => { if (_isNum(v)) set[path] = moreShares(v, ratio) }

    qty('quantity', doc.quantity)
    price('entryTriggerPrice', doc.entryTriggerPrice)
    for (const k of ['entry_condition_tree', 'stop_condition_tree', 'tp_condition_tree', 'stopMonitorTree', 'tpMonitorTree']) {
        if (doc[k]) set[k] = tree(doc[k])
    }
    for (const k of ['entry_conditions', 'stop_conditions', 'tp_conditions']) if (Array.isArray(doc[k])) set[k] = leaves(doc[k])
    if (Array.isArray(doc.additional_entries) && doc.additional_entries.length) {
        set.additional_entries = doc.additional_entries.map(a => ({
            ...a,
            ...(a.condition_tree ? { condition_tree: tree(a.condition_tree) } : {}),
            ...(Array.isArray(a.conditions) ? { conditions: leaves(a.conditions) } : {}),
            ...(_isNum(a.quantity) ? { quantity: moreShares(a.quantity, ratio) } : {}),
        }))
    }
    if (doc.invalidation?.range) set['invalidation.range'] = _range(doc.invalidation.range, ratio)
    if (Array.isArray(doc.pendingOrder?.plan)) set['pendingOrder.plan'] = doc.pendingOrder.plan.map(p => ({ ...p, ...(_isNum(p.quantity) ? { quantity: moreShares(p.quantity, ratio) } : {}) }))
    if (Array.isArray(doc.brokerOrders) && doc.brokerOrders.length) set.brokerOrders = doc.brokerOrders.map(b => ({ ...b, ...(_isNum(b.quantity) ? { quantity: moreShares(b.quantity, ratio) } : {}) }))
    if (doc.nativeExit) set.nativeExit = { stop: _list(doc.nativeExit.stop ?? [], l => _leg(l, ratio, flags)), tp: _list(doc.nativeExit.tp ?? [], l => _leg(l, ratio, flags)) }
    if (Array.isArray(doc.exitOrders) && doc.exitOrders.length) {
        set.exitOrders = doc.exitOrders.map(o => ({ ...o, ...(_isNum(o.price) ? { price: perShare(o.price, ratio) } : {}), ...(_isNum(o.quantity) ? { quantity: moreShares(o.quantity, ratio) } : {}) }))
    }
    price('research_basis.coveragePt', doc.research_basis?.coveragePt)
    qty('pendingTrimQty', doc.pendingTrimQty)
    qty('pendingAddQty', doc.pendingAddQty)

    // ── a Mentor setup ──
    if (Array.isArray(doc.scenarios)) set.scenarios = doc.scenarios.map(s => _scenario(s, ratio, flags))
    for (const k of ['entry_legs', 'stop_legs', 'target_legs']) if (Array.isArray(doc[k])) set[k] = doc[k].map(l => _leg(l, ratio, flags))
    if (doc.validity) set.validity = _range(doc.validity, ratio)
    if (Array.isArray(doc.conditions)) set.conditions = leaves(doc.conditions)
    if (Array.isArray(doc.alternatives)) set.alternatives = doc.alternatives.map(a => (_isNum(a?.price) ? { ...a, price: perShare(a.price, ratio) } : a))
    if (typeof doc.thesis === 'string' && /\d/.test(doc.thesis) && doc.kind === 'setup') flags.push('the thesis')
    const ms = doc.monitor_state
    if (Array.isArray(ms?.guards)) set['monitor_state.guards'] = ms.guards.map(g => (_isNum(g?.price) ? { ...g, price: perShare(g.price, ratio) } : g))
    price('monitor_state.woke_on.price', ms?.woke_on?.price)
    price('monitor_state.last_assessment.price', ms?.last_assessment?.price)
    const ps = doc.position_state
    if (ps?.entry) {
        const e = ps.entry
        set['position_state.entry'] = {
            ...e,
            ...(Array.isArray(e.legs) ? { legs: e.legs.map(l => _leg(l, ratio, flags)) } : {}),
            ...(_isNum(e.fill_price) ? { fill_price: perShare(e.fill_price, ratio) } : {}),
            ...(_isNum(e.size) ? { size: moreShares(e.size, ratio) } : {}),
            ...(_isNum(e.intended) ? { intended: perShare(e.intended, ratio) } : {}),
        }
    }
    price('position_state.stop.initial', ps?.stop?.initial)
    price('position_state.stop.current', ps?.stop?.current)
    if (Array.isArray(ps?.targets)) set['position_state.targets'] = ps.targets.map(t => _leg(t, ratio, flags))
    if (Array.isArray(ps?.taken)) set['position_state.taken'] = ps.taken.map(t => (_isNum(t?.size) ? { ...t, size: moreShares(t.size, ratio) } : t))
    const prop = ps?.pending_action?.proposal
    price('position_state.pending_action.proposal.stop', prop?.stop)
    qty('position_state.pending_action.proposal.quantity', prop?.quantity)
    const draft = doc.chat_state?.draft
    if (draft) {
        for (const k of ['entry_legs', 'stop_legs', 'target_legs']) if (Array.isArray(draft[k])) set[`chat_state.draft.${k}`] = draft[k].map(l => _leg(l, ratio, [] /* a copy — its flags are the scenario's */))
        qty('chat_state.draft.quantity', draft.quantity)
    }
    return { set, flags: [...new Set(flags)] }
}

/**
 * A paper / manual venue POSITION through a split → its `$set` (size × ratio, average ÷ ratio, P&L on the mark). A mark
 * taken before the split day (`beforeMs`) is a pre-split price too. Pure.
 */
export function restatePaperPosition(pos, ratio, beforeMs = null) {
    const qty = moreShares(pos.qty, ratio), avg = perShare(pos.avgPrice, ratio)
    const set = { qty, avgPrice: avg }
    if (beforeMs != null && Number(pos.markedAt) < beforeMs && _isNum(pos.currentPrice)) set.currentPrice = perShare(pos.currentPrice, ratio)
    const cur = Number(set.currentPrice ?? pos.currentPrice)
    if (cur > 0 && _isNum(qty) && _isNum(avg)) set.pnl = Math.round((cur - avg) * qty * (pos.direction === 'short' ? -1 : 1) * 100) / 100
    return set
}

/** A resting paper / manual ORDER through a split → its `$set`. Pure. */
export function restatePaperOrder(order, ratio) {
    const set = {}
    if (_isNum(order.triggerPrice)) set.triggerPrice = perShare(order.triggerPrice, ratio)
    if (_isNum(order.qty)) set.qty = moreShares(order.qty, ratio)
    return set
}

/** An open `trades` ledger row through a split. Pure. */
export function restateLedgerRow(row, ratio) {
    const set = {}
    if (_isNum(row.quantity)) set.quantity = moreShares(row.quantity, ratio)
    if (_isNum(row.entry?.price)) set['entry.price'] = perShare(row.entry.price, ratio)
    return set
}

/**
 * A manage PROPOSAL held in memory (a card's, or one queued off-hours in `pending_actions`) through the splits its trade
 * was just caught up on (splitSweep.ensureRestated) — its stop ÷, its share quantity ×; a percentage stays. Only a split
 * AFTER the proposal was made (`madeAtMs`): one made on post-split candles is post-split already. No time known → it is
 * taken as pre-split (it rode a trade that had not been through the split). Pure.
 */
export function restateProposal(proposal, splits = [], madeAtMs = null) {
    if (!proposal || typeof proposal !== 'object' || !splits.length) return proposal
    const out = { ...proposal }
    for (const s of splits) {
        if (Number.isFinite(madeAtMs) && madeAtMs >= splitDayMs(s.date)) continue
        for (const k of ['stop', 'new_stop', 'level', 'price']) if (_isNum(out[k])) out[k] = perShare(out[k], s.ratio)
        if (_isNum(out.quantity)) out.quantity = moreShares(out.quantity, s.ratio)
    }
    return out
}

/** The words of a split — "8-for-1", "1-for-20". Pure. */
export const splitWords = (split) => `${split.numerator}-for-${split.denominator}`

/** What Talos is told on a setup — one line ahead of its own memo, so every read knows the levels moved. Pure. */
export function memoWithSplit(memo, split) {
    const line = `[${split.date}] ${split.symbol ?? ''} split ${splitWords(split)}: every level and size of this setup was restated (${splitEffect(split.ratio)}). Candles before ${split.date} are split-adjusted; any price written in a condition or this memo before then is pre-split — ${splitEffect(split.ratio).split(',')[0]} to read it.`
    return memo ? `${line}\n${memo}` : line
}

/**
 * RESTATE every open trade on a split's name (the split sweep, splitSweep.service). Each step is idempotent on its own
 * stamp (`split_through` on the entity / the venue row / the ledger row) and none blocks the next. `io`:
 *   findTrades(symbol, beforeMs)   open trade entities on the name saved before the split
 *   claimTrade(id, date, set)      the conditional write (only while split_through < date) → true when it won
 *   journal(id, entry)             the trade's journal line
 *   restateVenue(symbol, beforeMs, split)  paper / manual positions + orders → { positions, orders }
 *   restateLedger(symbol, beforeMs, split) open trades rows → n
 *   reconcileLive(trade, split)    a LIVE trade: re-read the broker, fix our exits there → { notes[] }
 *   notify(trade, split, summary)  the user's card
 *   dropCandles(symbol)            the in-process candle cache (pre-split bars must not merge with adjusted ones)
 * → `{ trades, venue, ledger }`. Never throws.
 */
export async function restateOpenTrades(split, io) {
    const out = { trades: [], venue: null, ledger: 0 }
    const beforeMs = splitDayMs(split.date)
    try { io.dropCandles?.(split.symbol) } catch { /* a cache */ }
    try { out.venue = await io.restateVenue(split.symbol, beforeMs, split) } catch (err) { logger.warn(LOG, `venue restate ${split.symbol} failed`, err.message) }
    try { out.ledger = await io.restateLedger(split.symbol, beforeMs, split) } catch (err) { logger.warn(LOG, `ledger restate ${split.symbol} failed`, err.message) }
    let trades = []
    try { trades = await io.findTrades(split.symbol, beforeMs, split.date) } catch (err) { logger.warn(LOG, `open trades on ${split.symbol} not read`, err.message); return out }
    for (const trade of trades) {
        try {
            const { set, flags } = restateTrade(trade, split.ratio)
            if (trade.kind === 'setup') set['monitor_state.memo'] = memoWithSplit(trade.monitor_state?.memo, split)
            const won = await io.claimTrade(trade.id, split.date, set)
            if (!won) continue
            const restated = withSet(trade, set)
            const live = trade.mode === 'live' ? await io.reconcileLive(restated, split).catch(err => ({ notes: [`the broker could not be read (${err.message}) — check its orders`] })) : { notes: [] }
            const summary = { before: _sizeAt(trade), after: _sizeAt(restated), flags, notes: live?.notes ?? [] }
            await io.journal?.(trade.id, { reason: 'split_restated', note: `${splitWords(split)} split on ${split.date}: ${splitEffect(split.ratio)}`, flags })
            await io.notify?.(trade, split, summary)
            out.trades.push({ id: trade.id, kind: trade.kind, mode: trade.mode ?? null, flags: flags.length, notes: summary.notes })
            logger.info(LOG, `restated ${trade.kind} ${trade.id} for ${split.symbol} ${splitWords(split)}`, { flags: flags.length })
        } catch (err) {
            logger.warn(LOG, `restate of ${trade.kind} ${trade.id} failed`, err.message)
        }
    }
    return out
}

/** A doc with a `$set` (dotted paths) applied, as Mongo would — the copy the broker step and the card read. Pure. */
export function withSet(doc, set) {
    const out = structuredClone(doc)
    for (const [path, v] of Object.entries(set)) {
        const keys = path.split('.')
        let o = out
        for (const k of keys.slice(0, -1)) o = (o[k] && typeof o[k] === 'object') ? o[k] : (o[k] = {})
        o[keys.at(-1)] = v
    }
    return out
}

function _sizeAt(t) {
    const stop = t.position_state?.stop?.current ?? t.exitOrders?.find(o => o.leg === 'stop' && o.status === 'working')?.price ?? t.nativeExit?.stop?.[0]?.level ?? t.stop_legs?.[0]?.price ?? null
    return { quantity: t.quantity ?? t.position_state?.entry?.size ?? null, entry: t.entryTriggerPrice ?? t.position_state?.entry?.fill_price ?? t.entry_legs?.[0]?.price ?? null, stop }
}
