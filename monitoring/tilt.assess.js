// The strategy desk's grading + wake logic. PURE, no I/O — the monitor fetches, these decide.
//
// A sector tilt is the one forecast in this app that grades by ARITHMETIC rather than judgment:
// a stance is an active weight against a benchmark, so what it earned is
// `active weight × relative return`, which is standard attribution. Nothing here is an opinion,
// which is exactly why it belongs in a pure module the monitor merely feeds.
//
// TWO TIERS, mirroring coverage:
//   • cheap + daily — re-price each open stance, update its contribution, mature the ones whose
//     window closed. Free, and it is what makes performance current rather than discovered at review.
//   • expensive     — wake Pythia to re-author. Gated by `reviewDecision` below.

import { windowProgress } from '../services/forecastClock.js'
import { toNum } from '../services/format.util.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** The monthly cadence — never leave the house view un-reviewed longer than this. */
export const REVIEW_FLOOR_DAYS = 30
/** ...but never re-author twice inside this, however noisy the week. Outranks every trigger. */
export const COOLDOWN_DAYS = 7

/**
 * A PRICE, or null. Only a positive finite number is a price: a missing quote and a zero are both
 * the ABSENCE of information, never evidence that a sector went to nothing. Reading them as 0 is
 * what fired `thesis_broken` across every covered name at once on the coverage side, and here it
 * would silently book a catastrophic contribution against a stance that simply had no data.
 */
const _price = v => {
    const n = Number(v)
    return (Number.isFinite(n) && n > 0) ? n : null
}

const _round2 = x => Math.round(x * 100) / 100

// A number, or null — strictly; see format.util.toNum. The distinction is load-bearing here: an
// unpriced stance must score as "unknown", never as "earned nothing".
const _num = toNum

/**
 * A stance's relative return over its own window, in PERCENT. Pure → null when either leg is
 * unpriceable.
 *
 * Relative is the whole point: a tilt claims the sector beats the benchmark, not that it rises. An
 * overweight that fell 8% while the index fell 12% WORKED, and only this subtraction can say so.
 */
export function relativeReturnPct({ sectorStart, sectorNow, benchStart, benchNow } = {}) {
    const s0 = _price(sectorStart), s1 = _price(sectorNow)
    const b0 = _price(benchStart),  b1 = _price(benchNow)
    if (s0 === null || s1 === null || b0 === null || b1 === null) return null
    return _round2(((s1 - s0) / s0 - (b1 - b0) / b0) * 100)
}

/**
 * What a stance earned, in basis points of portfolio return. Pure → null when either input is
 * unknown, NEVER 0: "we don't know" and "it contributed nothing" are different facts, and only one
 * of them should ever be shown to someone judging the desk.
 *
 * `active_bp` is basis points of weight (150 = +1.5%); `relPct` is the relative return in percent.
 * 150bp × 3% = 4.5bp of contribution.
 */
export function contributionBp(activeBp, relPct) {
    const w = _num(activeBp), r = _num(relPct)
    if (w === null || r === null) return null
    return _round2(w * r / 100)
}

/**
 * Re-grade one stance from fresh prices → `{ ...row, contribution_bp, state }`. Pure, never mutates.
 *
 * A row MATURES when its own window closes — per row, because a monthly review typically reaffirms
 * most sectors and only re-authors a couple. Maturing is what closes the call and makes it scoreable;
 * an open row keeps accruing.
 *
 * A row whose window can't be measured (no clock, no dates) stays `open` rather than being guessed
 * either way — the same abstain the forecast clock hands back.
 */
export function gradeRow(row, { sectorNow, benchNow } = {}, nowMs = 0) {
    // The baseline comes off the ROW, frozen when the stance was authored — never re-fetched. See
    // `base_px` in tilt.service: deep history is unavailable here, and an immutable baseline also
    // means a data revision cannot silently re-score a call that is already closed.
    const relPct = relativeReturnPct({
        sectorStart: row?.base_px, sectorNow,
        benchStart:  row?.base_bench_px, benchNow,
    })
    const progress = windowProgress({ set_at: row?.set_at, ends_at: row?.review_date }, nowMs)
    const matured  = progress !== null && progress >= 1
    return {
        ...row,
        // Keep the last known figure rather than overwriting it with null on a bad data day — a
        // sector we could not price today did not stop having earned what it earned yesterday.
        contribution_bp: contributionBp(row?.active_bp, relPct) ?? row?.contribution_bp ?? null,
        state: matured ? 'matured' : (row?.state === 'matured' ? 'matured' : 'open'),
    }
}

/** Total contribution across graded stances, in bp. Pure — unpriced rows are skipped, not zeroed. */
export function totalContributionBp(rows = []) {
    const known = (Array.isArray(rows) ? rows : []).map(r => _num(r?.contribution_bp)).filter(n => n !== null)
    return known.length ? _round2(known.reduce((a, b) => a + b, 0)) : null
}

/** Stances whose window has closed and which the desk now owes a verdict on. Pure. */
export function maturedRows(rows = [], nowMs = 0) {
    return (Array.isArray(rows) ? rows : []).filter(r => {
        const p = windowProgress({ set_at: r?.set_at, ends_at: r?.review_date }, nowMs)
        return p !== null && p >= 1
    })
}

/**
 * What actually MOVED between two published views → `[{ sector, from, to, from_bp, to_bp }]`. Pure.
 *
 * Reaffirming is the common case — a monthly review typically restates nine sectors and re-authors
 * two — so a diff is what separates news from noise. A row whose stance and weight are both
 * unchanged is not reported, however many times it has been re-published.
 *
 * A sector appearing for the first time reads as `from: null`; one that drops out reads as
 * `to: null`, because withdrawing a stance is itself a change worth telling someone about.
 */
export function diffStances(prev, next) {
    const byKey = rows => new Map((Array.isArray(rows) ? rows : []).map(r => [r?.sector, r]).filter(([s]) => s))
    const a = byKey(prev?.tilts), b = byKey(next?.tilts)
    const out = []
    for (const sector of new Set([...a.keys(), ...b.keys()])) {
        const was = a.get(sector), now = b.get(sector)
        const fromBp = _num(was?.active_bp), toBp = _num(now?.active_bp)
        if ((was?.stance ?? null) === (now?.stance ?? null) && fromBp === toBp) continue
        out.push({
            sector,
            from: was?.stance ?? null, to: now?.stance ?? null,
            from_bp: fromBp, to_bp: toBp,
        })
    }
    return out.sort((x, y) => x.sector.localeCompare(y.sector))
}

/**
 * Should Pythia be woken to re-author the house view? Pure — the caller supplies the clock and the
 * macro calendar.
 *
 * DELIBERATELY NOT A TRIGGER: today's sector move. A tilt is a 3–12 month call and the tape moving
 * against it for a week is the position being early, not wrong — the same reason price is not a
 * re-model trigger on the coverage side. What earns a re-author is the view's own basis being
 * contradicted, or its own clock running out.
 *
 * NOT EVALUATED HERE EITHER: the regime's free-text `kill_criteria`. Judging prose is the LLM tier's
 * job, exactly as it still is for coverage — this function speaks only for what can be decided
 * deterministically, and pretending otherwise would put a fake verdict in a pure module.
 *
 * @returns {{ due:boolean, reason:string|null, next_review_at:string|null }}
 */
export function reviewDecision(doc, { nowMs = 0, catalystDates = [] } = {}) {
    const lastMs = Date.parse(doc?.updated_at ?? doc?.created_at ?? '')
    const anchor = Number.isFinite(lastMs) ? lastMs : null
    const nextReviewAt = anchor !== null ? new Date(anchor + REVIEW_FLOOR_DAYS * DAY_MS).toISOString() : null
    const quiet = { due: false, reason: null, next_review_at: nextReviewAt }

    if (doc?.status && doc.status !== 'active') return quiet   // a retired view is not re-authored

    // The cooldown outranks every trigger below. A single macro week can trip several of them, and
    // three re-authorings in three days buy nothing the first one didn't.
    if (anchor !== null && nowMs - anchor < COOLDOWN_DAYS * DAY_MS) return quiet

    // 1. A stance came due. The desk owes a verdict on it, and a matured row left in place is a call
    //    nobody ever graded — the failure this whole clock exists to prevent.
    const due = maturedRows(doc?.tilts, nowMs)
    if (due.length) {
        return { ...quiet, due: true, reason: `stance matured: ${due.map(r => r.sector).join(', ')}` }
    }

    // 2. A dated macro catalyst has landed since we last published. Actionable the day AFTER it
    //    lands, so the print is in the data by the time Pythia reads it.
    const passed = (Array.isArray(catalystDates) ? catalystDates : [])
        .map(d => Date.parse(`${d}T00:00:00.000Z`))
        .filter(ms => Number.isFinite(ms) && ms + DAY_MS <= nowMs && (anchor === null || ms > anchor))
        .sort((a, b) => a - b)
    if (passed.length) {
        return { ...quiet, due: true, reason: `macro catalyst passed: ${new Date(passed.at(-1)).toISOString().slice(0, 10)}` }
    }

    // 3. The monthly floor.
    if (anchor !== null && nowMs - anchor >= REVIEW_FLOOR_DAYS * DAY_MS) {
        return { ...quiet, due: true, reason: `no review in ${Math.floor((nowMs - anchor) / DAY_MS)} days` }
    }

    return quiet
}
