// ECHO, STEP 4 — THE MARKET CHECK (docs/design/echo-pipeline.md; the simulator doc's Step 4).
//
// "A high score only matters if the price hasn't already moved." For every link, from Day 0: the return vs SPY and vs
// its sector fund at day 1, 5 and 20; VOLUME vs its 20-day average ("heavy volume means the market noticed"); ANALYST
// actions since the event ("once revisions arrive, the link is no longer hidden"). Options implied volatility is the
// doc's fourth measure — left out, no provider on our data (Roy, 2026-11-19; a note for the future).
//
// "Priced in" cannot be measured; it is inferred from how little a link moved against its chain peers and its score.
// The yardstick is LAYER 1 — the peers and customers the market reprices within hours: the median of their moves in
// their own predicted direction.
//
// THE FLAGS (the doc's three), on each link's move SIGNED by its direction (a "loses" link that fell moved +):
//   underreacted winner  direction gains, HIGH score, day-5 move below HALF the layer-1 median (the doc's default) — the
//                        main target;
//   overreacted loser    direction loses, a BIG drop (day-5 at least the layer-1 median, and 10%+ vs SPY), but SLOW or
//                        INDIRECT damage (directness 0–1) — a rebound candidate (DaVita);
//   fully priced         a big move (at least the layer-1 median) that matches the score — skip.
// A loser that has NOT dropped is not flagged: shorting persistent losers is one of the doc's open decisions.
//
// When: at the day-5 close (the doc's underpriced threshold reads day 5); day 20 is measured when it exists, and the
// wave watch (Step 5) re-runs the check on a trigger.

import { getRatingActions } from '../providers/fmp.provider.js'
import { eventReturns, sectorEtf } from './echoReturns.service.js'
import { logger } from './logger.service.js'

const LOG = '[echoCheck]'
export const CHECK_DAY = 5
export const DAYS = [1, 5, 20]
export const BIG_DROP = 0.10
export const NOTICED_VOLUME = 1.5
const LAYER1 = new Set(['peer', 'customer'])

const median = (xs) => {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
    if (!s.length) return null
    const m = s.length >> 1
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const sign = (direction) => (direction === 'gains' ? 1 : direction === 'loses' ? -1 : 0)

/** A link's move through `day`, vs SPY, signed by its direction. Pure. */
export function signedMove(row, direction, day = CHECK_DAY) {
    const x = row?.horizons?.[day]?.xsSpyReaction
    const s = sign(direction)
    return Number.isFinite(x) && s ? x * s : null
}

/**
 * The yardstick: the median day-5 move of the layer-1 links in their own direction; the origin's own (its demand
 * effect, signed) when the map has no priced layer-1 name. Pure.
 */
export function yardstick(links, rows, ev, originRow = null) {
    const moves = links.filter(l => LAYER1.has(l.relation)).map(l => signedMove(rows[l.ticker], l.direction))
    const m = median(moves)
    if (m != null) return { median: m, from: 'layer 1', n: moves.filter(Number.isFinite).length }
    const o = signedMove(originRow, ev.effect === 'up' ? 'gains' : ev.effect === 'down' ? 'loses' : null)
    return { median: o, from: o == null ? null : 'the origin', n: o == null ? 0 : 1 }
}

/** The doc's flag for one link, with why. Pure. → `{ flag, why }`, flag null when none. */
export function flagFor({ direction, total, high, directness, move, yard }) {
    if (move == null) return { flag: null, why: 'no day-5 move to check' }
    if (yard == null || yard <= 0) return { flag: null, why: 'the yardstick did not move with the event — no reaction to have lagged' }
    if (direction === 'gains' && high && move < yard / 2) {
        return { flag: 'underreacted_winner', why: `scored ${total}; moved ${pctS(move)} by day 5, under half the layer-1 median ${pctS(yard)}` }
    }
    // A loser's signed move is its drop: a big one (at least layer 1's, and 10%+ vs SPY) on slow or indirect damage.
    if (direction === 'loses' && move >= yard && move >= BIG_DROP && directness <= 1) {
        return { flag: 'overreacted_loser', why: `fell ${pctS(-move)} vs SPY by day 5 (layer 1 ${pctS(-yard)}), but the damage is slow or indirect (directness ${directness})` }
    }
    if (move >= yard) return { flag: 'fully_priced', why: `moved ${pctS(move)} its way by day 5, at or past the layer-1 median ${pctS(yard)}` }
    return { flag: null, why: `moved ${pctS(move)} by day 5 against a layer-1 median of ${pctS(yard)}` }
}
const pctS = (x) => `${x > 0 ? '+' : ''}${(Math.round(x * 1000) / 10).toFixed(1)}%`

const _deps = { returns: eventReturns, actions: getRatingActions, sleep: (ms) => new Promise(r => setTimeout(r, ms)) }
export function _setDeps(d) { Object.assign(_deps, d) }

/** Analyst actions dated on or after `since` (YYYY-MM-DD). → `{ count, actions }`, count null when unread. */
export async function actionsSince(ticker, since, deps = _deps) {
    try {
        const rows = await deps.actions(ticker)
        const recent = rows.filter(r => String(r.date).slice(0, 10) >= since)
        return { count: recent.length, actions: recent.slice(0, 5).map(r => ({ date: String(r.date).slice(0, 10), by: r.gradingCompany ?? null, action: r.action ?? null, to: r.newGrade ?? null })) }
    } catch { return { count: null, actions: [] } }
}

/**
 * Check one scored event. → `{ ok: true, check }` or `{ ok: false, reason, wait }` (`wait` when the day-5 close is not
 * in yet). The check holds every link's moves, volume, analyst actions and flag; the yardstick; the origin's own row.
 */
export async function checkEvent(ev, map, scores) {
    const links = map?.links ?? []
    const byTicker = new Map((scores?.links ?? []).map(s => [s.ticker, s]))
    const tickers = [...new Set([...(ev.originTickers ?? []), ...links.map(l => l.ticker)])]
    const sectors = Object.fromEntries(links.map(l => [l.ticker, sectorEtf(l.sector)]))
    if (ev.originTickers?.[0]) sectors[ev.originTickers[0]] = sectorEtf(map.originSector)
    let res
    try { res = await _deps.returns(ev, tickers, sectors) } catch (err) {
        logger.warn(LOG, 'returns failed', { event: ev._id, error: err.message })
        return { ok: false, reason: `prices could not be read: ${err.message}` }
    }
    const rows = Object.fromEntries(res.rows.map(r => [r.ticker, r]))
    const originRow = ev.originTickers?.[0] ? rows[ev.originTickers[0]] : null
    const d0 = originRow?.day0 ?? res.rows[0]?.day0
    const i0 = res.sessions.indexOf(d0)
    if (i0 < 0 || i0 + CHECK_DAY - 1 >= res.sessions.length) {
        return { ok: false, wait: true, reason: `the day-${CHECK_DAY} close is not in yet (Day 0 ${d0 ?? '?'})` }
    }
    const yard = yardstick(links, rows, ev, originRow)
    const out = []
    for (const l of links) {
        const r = rows[l.ticker]
        const s = byTicker.get(l.ticker)
        const move = signedMove(r, l.direction)
        const acts = await actionsSince(l.ticker, d0)
        await _deps.sleep(100)
        const vol = r?.volume?.[CHECK_DAY] ?? null
        const flag = flagFor({ direction: l.direction, total: s?.total ?? null, high: Boolean(s?.high), directness: s?.factors?.directness?.score ?? 2, move, yard: yard.median })
        out.push({
            ticker: l.ticker, relation: l.relation, layer: l.layer, direction: l.direction, total: s?.total ?? null,
            moves: Object.fromEntries(DAYS.map(d => [d, { xsSpy: r?.horizons?.[d]?.xsSpyReaction ?? null, xsSector: r?.horizons?.[d]?.xsSectorReaction ?? null }])),
            signedMove: move, gap: r?.gap ?? null,
            volume: { day1: r?.volume?.[1] ?? null, day5: vol },
            analysts: acts,
            // The doc's "the market noticed": heavy volume, or the analysts have written about it.
            noticed: (Number.isFinite(vol) && vol >= NOTICED_VOLUME) || (acts.count ?? 0) > 0,
            ...flag,
            missing: r?.missing ?? ['not measured'],
        })
    }
    const order = { underreacted_winner: 0, overreacted_loser: 1, null: 2, fully_priced: 3 }
    out.sort((a, b) => (order[a.flag] - order[b.flag]) || ((b.total ?? 0) - (a.total ?? 0)))
    return {
        ok: true,
        check: {
            checkedAt: new Date().toISOString(), day0: d0, checkDay: res.sessions[i0 + CHECK_DAY - 1],
            yardstick: yard, origin: originRow ? { ticker: originRow.ticker, moves: Object.fromEntries(DAYS.map(d => [d, originRow.horizons?.[d]?.xsSpyReaction ?? null])) } : null,
            links: out, impliedVolatility: 'not measured — no options data on our plan',
        },
    }
}

export const echoCheckService = { checkEvent, flagFor, yardstick, signedMove }
