import { getCandles }          from '../providers/ohlcv.provider.js'
import { extractLeaves }       from '../services/conditionTree.service.js'
import { logger }              from '../services/logger.service.js'
import { sessionStartMs }      from '../services/market.service.js'

const LOG        = '[monitorUtils]'
const CANDLE_COUNT = 300

// ─── Candle fetching ──────────────────────────────────────────────────────────

export async function fetchCandles(id, asset, tf, count = CANDLE_COUNT) {
    let candles
    try {
        candles = await getCandles(asset, tf, count)
    } catch (err) {
        logger.error(LOG, `Candle fetch error for ${asset}/${tf}:`, err.message)
        return null
    }
    if (!candles || candles.length < 5) {
        logger.warn(LOG, `Skipping idea ${id} — insufficient candles for ${asset}/${tf}`)
        return null
    }
    return candles
}

export async function buildSymbolMap(id, defaultSymbol, defaultCandles, timeframe, crossSymbols) {
    const map = { [defaultSymbol]: defaultCandles }
    for (const sym of crossSymbols) {
        if (sym === defaultSymbol) continue
        const c = await fetchCandles(id, sym, timeframe)
        if (c) {
            map[sym] = c
        } else {
            logger.warn(LOG, `[${id}] Cross-asset candles unavailable for ${sym}/${timeframe}`)
        }
    }
    return map
}

// ─── Session context (cumulative volume + VWAP) ────────────────────────────────

export function hasCumulativeVolume(tree, flat) {
    const leaves = extractLeaves(tree)
    const all    = leaves.length ? leaves : (Array.isArray(flat) ? flat : [])
    return all.some(l => l && typeof l === 'object' && l.type === 'volume' && l.mode === 'cumulative')
}

export function hasVwap(tree, flat) {
    const leaves = extractLeaves(tree)
    const all    = leaves.length ? leaves : (Array.isArray(flat) ? flat : [])
    return all.some(l => {
        const text = typeof l === 'string' ? l : l?.condition
        return typeof text === 'string' && /vwap/i.test(text)
    })
}

export async function buildVolumeCtx(id, asset, assetClass, tree, flat) {
    const needsCumulative = hasCumulativeVolume(tree, flat)
    const needsVwap       = hasVwap(tree, flat)
    if (!needsCumulative && !needsVwap) return null

    const start = sessionStartMs(asset, assetClass)

    if (!needsCumulative) return { sessionStartMs: start, minuteCandles: {} }

    const minutesSince = Math.ceil((Date.now() - start) / 60_000)
    const count        = Math.min(1500, Math.max(5, minutesSince + 5))
    const minute       = await fetchCandles(id, asset, '1min', count)
    if (!minute) {
        logger.warn(LOG, `[${id}] cumulative-volume: no 1-min candles for ${asset} — leaf will read false this tick`)
        return { sessionStartMs: start, minuteCandles: {} }
    }
    return { sessionStartMs: start, minuteCandles: { [asset]: minute } }
}

// ─── Candle timestamp normalisation ───────────────────────────────────────────

// Candle timestamps arrive in seconds from some sources (Massive/Yahoo divide by
// 1000) while floors/sessions are ms epochs. Normalise to ms, tolerating either
// unit in case a source changes. Shared by the structured/touch/volume evaluators.
export const candleMs = t => (t < 1e12 ? t * 1000 : t)

// ─── LLM yes/no parsing ────────────────────────────────────────────────────────

// Standard lenient parse of an LLM yes/no reply: trim, upper-case, first char 'Y'.
// Shared by the news/indicator/chart evaluators so "YES", "Yes.", "yes" all pass.
export const parseYesNo = raw => String(raw ?? '').trim().toUpperCase().startsWith('Y')

// ─── Logging ──────────────────────────────────────────────────────────────────

export function logCheck(id, asset, status, tf, candles) {
    const lastCandle = candles[candles.length - 1]
    const close = lastCandle?.c ?? '?'
    logger.info(LOG, `──── Check ${id} | ${asset} | status=${status} | tf=${tf} | close=${close}`)
}

// ─── Quantity math ────────────────────────────────────────────────────────────

export const round = n => Math.round((Number(n) || 0) * 10000) / 10000

export function remainingForAccount(idea, accountId) {
    const acct     = String(accountId)
    const slot     = (idea.brokerOrders ?? []).find(b => String(b.accountId) === acct)
    const entryQty = Number(slot?.quantity) || 0
    const closed   = (idea.exitOrders ?? [])
        .filter(o => o.status === 'filled' && String(o.accountId) === acct)
        .reduce((s, o) => s + (Number(o.quantity) || 0), 0)
    return Math.max(0, round(entryQty - closed))
}

// ─── Timeframe resolution ─────────────────────────────────────────────────────

import { firstLeaf } from '../services/conditionTree.service.js'

export function resolvePhaseTimeframe(idea, phase, fallback) {
    const tree = idea[`${phase}_condition_tree`]
    if (tree) {
        const leaf = firstLeaf(tree)
        if (leaf?.timeframe) return leaf.timeframe
    }
    return idea[`${phase}_conditions`]?.[0]?.timeframe
        ?? idea[`${phase}_timeframe`]
        ?? fallback()
}

export const resolveEntryTimeframe = idea => resolvePhaseTimeframe(idea, 'entry', () => idea.timeframe ?? 'day')
export const resolveStopTimeframe  = idea => resolvePhaseTimeframe(idea, 'stop',  () => resolveEntryTimeframe(idea))
export const resolveTpTimeframe    = idea => resolvePhaseTimeframe(idea, 'tp',    () => resolveEntryTimeframe(idea))

// ─── Condition state persistence ──────────────────────────────────────────────

export async function persistConditionStates(db, idea, phase, results, collection) {
    if (!Array.isArray(results) || results.length === 0) return
    const prev = idea.conditionStates?.[phase] ?? {}
    const next = { ...prev }
    for (const r of results) {
        if (!r?.key) continue
        if (r.pass) next[r.key] = r.at ?? Date.now()
        else delete next[r.key]
    }
    if (JSON.stringify(next) === JSON.stringify(prev)) return
    await db.collection(collection).updateOne({ id: idea.id }, { $set: { [`conditionStates.${phase}`]: next } })
    idea.conditionStates = { ...(idea.conditionStates ?? {}), [phase]: next }
}
