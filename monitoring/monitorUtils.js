import { getCandles }          from '../providers/ohlcv.provider.js'
import { extractLeaves }       from '../services/conditionTree.service.js'
import { logger }              from '../services/logger.service.js'
import { sessionStartMs }      from '../services/market.service.js'
import { brokerService }       from '../api/broker/broker.service.js'
import { normSymbol }          from '../services/brokerSymbol.service.js'
import { entityRepo }          from '../services/entity/entityRepo.service.js'

const LOG        = '[monitorUtils]'
const CANDLE_COUNT = 300

// ─── Candle fetching ──────────────────────────────────────────────────────────

export async function fetchCandles(id, asset, tf, count = CANDLE_COUNT, ctx = null) {
    let candles
    try {
        candles = await _sourceCandles(asset, tf, count, ctx)
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

// Resolve candles for one symbol. For the idea's PRIMARY instrument on an ohlcv-capable
// broker (cTrader/IBKR), fetch the broker's own candles and shift them into the authored
// (real) price space by the idea's basis offset — so an index-future idea is monitored in
// cTrader prices without touching its (real-priced) condition text. Everything else —
// cross-asset legs, paper, no broker — uses the app feed (Massive/Yahoo).
async function _sourceCandles(symbol, tf, count, ctx) {
    if (ctx?.useBroker && ctx.brokerSymbol && normSymbol(symbol) === normSymbol(ctx.asset)) {
        try {
            const bars = await brokerService.getCandles(ctx.broker, ctx.brokerSymbol, tf, count, ctx.userId)
            if (bars && bars.length) return shiftCandles(bars, ctx.offset)
            logger.warn(LOG, `[${ctx.broker}] no candles for ${ctx.brokerSymbol}/${tf} — app feed`)
        } catch (err) {
            logger.warn(LOG, `[${ctx.broker}] candle fetch failed for ${ctx.brokerSymbol}/${tf}: ${err.message} — app feed`)
        }
    }
    return getCandles(symbol, tf, count)
}

// Shift OHLC by −offset to bring broker-space candles into the authored (real) space.
// offset = cashIndex − future (e.g. −227 for NQ), so `− offset` moves US100 up into NQ
// space. Volume/timestamp untouched. No-op when offset is 0 (every non-index case).
function shiftCandles(bars, offset) {
    const off = Number(offset) || 0
    if (!off) return bars
    return bars.map(b => ({ ...b, o: b.o - off, h: b.h - off, l: b.l - off, c: b.c - off }))
}

/**
 * Candle-source context for an idea: instructs fetchCandles to pull the PRIMARY instrument
 * from the broker (shifted into authored space) when the broker serves candles, else the
 * app feed. Returns null for paper / no-broker / non-ohlcv brokers → app feed. Sync (broker
 * capabilities are static), so it's cheap to build per call site.
 * @returns {{ asset,broker,userId,brokerSymbol,offset:number,useBroker:true } | null}
 */
export function brokerCandleCtx(idea) {
    const broker = idea?.broker
    if (!broker || !idea.brokerSymbol) return null
    let ohlcv = false
    try { ohlcv = !!brokerService.capabilities(broker)?.ohlcv } catch { /* unknown broker → app feed */ }
    if (!ohlcv) return null
    return {
        asset:        idea.asset,
        broker,
        userId:       idea.userId,
        brokerSymbol: idea.brokerSymbol,
        offset:       Number(idea.basisOffset) || 0,
        useBroker:    true,
    }
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

export async function buildVolumeCtx(id, asset, assetClass, tree, flat, ctx = null) {
    const needsCumulative = hasCumulativeVolume(tree, flat)
    const needsVwap       = hasVwap(tree, flat)
    if (!needsCumulative && !needsVwap) return null

    const start = sessionStartMs(asset, assetClass)

    if (!needsCumulative) return { sessionStartMs: start, minuteCandles: {} }

    const minutesSince = Math.ceil((Date.now() - start) / 60_000)
    const count        = Math.min(1500, Math.max(5, minutesSince + 5))
    const minute       = await fetchCandles(id, asset, '1min', count, ctx)
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

// ─── Poll loop ─────────────────────────────────────────────────────────────────

// A single-flight interval loop shared by the background monitors. start() runs `tick`
// every intervalMs — and once immediately when `eager` — but skips a tick while the
// previous one is still running (the re-entrancy guard every monitor hand-rolled); stop()
// halts it. `tick` is just the loop body: it does NO timer/running bookkeeping, and its
// throws are caught + logged so one bad tick can't wedge the loop or leak an unhandled
// rejection. Returns { start, stop }.
export function createPollLoop({ intervalMs, tick, eager = false, log = '[pollLoop]', name = 'tick' }) {
    let timer   = null
    let running = false

    async function run() {
        if (running) { logger.warn(log, `previous ${name} still running — skipping`); return }
        running = true
        try { await tick() }
        catch (err) { logger.error(log, `${name} failed:`, err.message) }
        finally { running = false }
    }

    return {
        start() {
            if (timer) return
            logger.info(log, `${name} loop starting`)
            if (eager) run()
            timer = setInterval(run, intervalMs)
        },
        stop() {
            if (!timer) return
            clearInterval(timer)
            timer = null
            logger.info(log, `${name} loop stopped`)
        },
    }
}

// ─── Timeout guard ─────────────────────────────────────────────────────────────

// Race a promise against a timeout so a single hung IO call (LLM/vision/price fetch)
// can't wedge a poll loop forever — without it, an unbounded await keeps `_running`
// true and every later tick skips. The underlying promise is left to settle on its
// own (best-effort, not cancellable); the caller just stops waiting. Pure — shared by
// the Minos and Hermes monitors.
export function withTimeout(promise, ms) {
    let t
    const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`check timed out after ${ms}ms`)), ms) })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

// ─── JSON extraction ───────────────────────────────────────────────────────────

// Walk from the first '{' to its matching '}' and JSON.parse that slice — avoids greedy
// cross-match bugs when the LLM wraps the object in explanatory prose containing braces.
// Throws on no-JSON / unclosed (callers catch and retry). Shared by monitor.claude + Hermes.
export function extractFirstJSON(text) {
    const start = text.indexOf('{')
    if (start === -1) throw new Error(`no JSON in response — ${String(text).slice(0, 120)}`)
    let depth = 0
    for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1))
    }
    throw new Error('unclosed JSON object in response')
}

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

// `db`/`collection` are vestigial (kept so existing monitor callers need no change); the write
// now funnels through the kind-blind entityRepo. See ENTITY_MODEL.md P1b.
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
    await entityRepo.patch(idea.id, { [`conditionStates.${phase}`]: next })
    idea.conditionStates = { ...(idea.conditionStates ?? {}), [phase]: next }
}
