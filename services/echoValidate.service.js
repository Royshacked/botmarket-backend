// ECHO, STEP 7 — VALIDATION (docs/design/echo-pipeline.md; the simulator doc's Step 7).
//
// "The system has an edge only if its flagged links beat a fair baseline across many events." Every checked event is
// graded at 5, 20, 60 and 120 sessions FROM THE DAY-5 CLOSE (the flag reads through day 5, so no grade sees what the
// flag saw), on the excess over SPY SIGNED by each link's direction (a "loses" link that falls scores +):
//   flagged      the underreacted winners and overreacted losers;
//   unflagged    the other directional links of the same map — the doc's second baseline;
//   stand-ins    for each flagged link, five random companies from its SECTOR and SIZE BAND (half to twice its market
//                cap, FMP's screener), never on the map, drawn the same way every time for the event — the doc's first
//                baseline. Signed as the link is.
// The report (the doc): per horizon the distribution — mean, median, share up 20%+, share down 10%+ — not just the
// average; the flagged against the stand-ins and against the unflagged; and EACH FACTOR ALONE (Step 3's six: links
// scoring 2 against links scoring 0 on it) — "keep the ones that separate winners from the rest; drop the rest".
// Walk-forward reweighting needs events to tune on: the report says how many there are.

import { fmpGet } from '../providers/fmp.price.provider.js'
import { eventReturns } from './echoReturns.service.js'
import { echoEventsService } from './echoEvents.service.js'
import { FACTORS } from './echoScore.service.js'
import { logger } from './logger.service.js'

const LOG = '[echoValidate]'
export const GRADE_HORIZONS = [5, 20, 60, 120]
export const STAND_INS = 5
export const WALK_FORWARD_MIN = 30
const FLAGS = new Set(['underreacted_winner', 'overreacted_loser'])

/** A string's 32-bit FNV-1a hash — the seed of an event's stand-in draw. Pure. */
export function hash(s) {
    let h = 0x811c9dc5
    for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0 }
    return h
}

/** `n` of `pool` picked the same way every time for `seed` (a seeded shuffle). Pure. */
export function draw(pool, n, seed) {
    let x = hash(seed) || 1
    const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296 }
    const a = [...pool].sort()
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
    return a.slice(0, n)
}

const sign = (d) => (d === 'gains' ? 1 : d === 'loses' ? -1 : 0)
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

/** The doc's distribution of a set of returns. Pure. */
export function stats(xs) {
    const v = xs.filter(Number.isFinite)
    if (!v.length) return { n: 0, mean: null, median: null, up20: null, down10: null }
    return { n: v.length, mean: mean(v), median: median(v), up20: v.filter(x => x >= 0.2).length / v.length, down10: v.filter(x => x <= -0.1).length / v.length }
}

const _deps = {
    returns: eventReturns, events: echoEventsService,
    screen: (q) => fmpGet(`/company-screener?${q}`, { label: 'FMP screener (Echo stand-ins)' }),
    now: () => new Date(),
}
export function _setDeps(d) { Object.assign(_deps, d) }

/** Five same-sector, same-size companies for a link, off the map, the same draw every time. → [ticker]. */
export async function standInsFor(ev, link, exclude, cache = new Map()) {
    if (!link.sector || !Number.isFinite(link.marketCap)) return []
    const lo = Math.round(link.marketCap / 2), hi = Math.round(link.marketCap * 2)
    const q = new URLSearchParams({ sector: link.sector, marketCapMoreThan: String(lo), marketCapLowerThan: String(hi), isActivelyTrading: 'true', isEtf: 'false', isFund: 'false', exchange: 'NASDAQ,NYSE', limit: '400' }).toString()
    if (!cache.has(q)) cache.set(q, await _deps.screen(q).catch(() => []))
    const pool = (cache.get(q) ?? []).map(r => r.symbol).filter(s => s && !exclude.has(s) && !/[.-]/.test(s))
    return draw(pool, STAND_INS, `${ev._id}|${link.ticker}`)
}

/** The horizons due: graded from the day-5 close, h sessions on, not graded yet. Pure. */
export function dueHorizons(ev, sessions) {
    const i = sessions.indexOf(ev.check?.checkDay)
    if (i < 0) return []
    return GRADE_HORIZONS.filter(h => !ev.grades?.[h] && i + h < sessions.length)
}

/**
 * Grade one checked event at the horizons that are due. → `{ graded: [h], grades }` (grades merged onto the event).
 * Never throws.
 */
export async function gradeEvent(ev) {
    try {
        const check = ev.check
        if (!check?.checkDay) return { graded: [], grades: ev.grades ?? {} }
        const links = check.links.filter(l => sign(l.direction))
        const flagged = links.filter(l => FLAGS.has(l.flag))
        const mapLinks = new Map((ev.map?.links ?? []).map(l => [l.ticker, l]))
        const exclude = new Set([...(ev.originTickers ?? []), ...mapLinks.keys()])
        const cache = new Map()
        const stands = {}
        for (const l of flagged) stands[l.ticker] = await standInsFor(ev, mapLinks.get(l.ticker) ?? l, exclude, cache)
        // The grading window opens at the day-5 close: an "after the close" event on that day makes it the base.
        const from = { _id: ev._id, date: check.checkDay, timing: 'after_close' }
        const tickers = [...new Set([...links.map(l => l.ticker), ...Object.values(stands).flat()])]
        const { sessions, rows } = await _deps.returns(from, tickers, {})
        const byT = Object.fromEntries(rows.map(r => [r.ticker, r]))
        const allSessions = [check.checkDay, ...sessions.filter(d => d > check.checkDay)]
        const due = dueHorizons(ev, allSessions)
        const grades = { ...(ev.grades ?? {}) }
        const at = (t, h, s) => { const x = byT[t]?.horizons?.[h]?.xsSpyReaction; return Number.isFinite(x) ? x * s : null }
        for (const h of due) {
            const row = (l) => ({ ticker: l.ticker, group: FLAGS.has(l.flag) ? 'flagged' : 'unflagged', flag: l.flag ?? null, signed: at(l.ticker, h, sign(l.direction)) })
            const rowsH = links.map(row)
            const standIns = Object.fromEntries(flagged.map(l => [l.ticker, stands[l.ticker].map(s => ({ ticker: s, signed: at(s, h, sign(l.direction)) }))]))
            const f = rowsH.filter(r => r.group === 'flagged').map(r => r.signed).filter(Number.isFinite)
            const u = rowsH.filter(r => r.group === 'unflagged').map(r => r.signed).filter(Number.isFinite)
            const s = Object.values(standIns).flat().map(x => x.signed).filter(Number.isFinite)
            grades[h] = {
                at: _deps.now().toISOString(), rows: rowsH, standIns,
                vsStandIns: f.length && s.length ? mean(f) - mean(s) : null,
                vsUnflagged: f.length && u.length ? mean(f) - mean(u) : null,
            }
        }
        if (due.length) await _deps.events.advance(ev._id, ev.status, { grades, gradedAt: _deps.now().toISOString() })
        return { graded: due, grades }
    } catch (err) {
        logger.warn(LOG, 'grading failed', { event: ev._id, error: err.message })
        return { graded: [], grades: ev.grades ?? {} }
    }
}

/**
 * The doc's report over every graded event. → per horizon: the flagged's distribution, the per-event spreads against
 * the stand-ins and the unflagged; each factor alone (2 vs 0); and whether walk-forward has events enough. Pure.
 */
export function report(events) {
    const out = { events: events.length, horizons: {}, factors: {}, walkForward: null }
    for (const h of GRADE_HORIZONS) {
        const graded = events.filter(e => e.grades?.[h])
        const flaggedAll = graded.flatMap(e => e.grades[h].rows.filter(r => r.group === 'flagged').map(r => r.signed))
        out.horizons[h] = {
            events: graded.length,
            flagged: stats(flaggedAll),
            vsStandIns: stats(graded.map(e => e.grades[h].vsStandIns)),
            vsUnflagged: stats(graded.map(e => e.grades[h].vsUnflagged)),
        }
        // EACH FACTOR ALONE: every directional link's signed return, by its score on the factor.
        out.factors[h] = Object.fromEntries(FACTORS.map(k => {
            const by = { 0: [], 2: [] }
            for (const e of graded) {
                const sc = new Map((e.scores?.links ?? []).map(s => [s.ticker, s.factors?.[k]?.score]))
                for (const r of e.grades[h].rows) { const v = sc.get(r.ticker); if ((v === 0 || v === 2) && Number.isFinite(r.signed)) by[v].push(r.signed) }
            }
            const hi = stats(by[2]), lo = stats(by[0])
            return [k, { high: hi, low: lo, separates: hi.n && lo.n ? hi.mean - lo.mean : null }]
        }))
    }
    const at120 = out.horizons[120].events
    out.walkForward = at120 >= WALK_FORWARD_MIN
        ? { ready: true, note: `${at120} events graded at 120 sessions — enough to tune on the earlier half and test on the later` }
        : { ready: false, note: `${at120} of ${WALK_FORWARD_MIN} events graded at 120 sessions — no reweighting yet` }
    return out
}

export const echoValidateService = { gradeEvent, report, standInsFor, dueHorizons, stats }
