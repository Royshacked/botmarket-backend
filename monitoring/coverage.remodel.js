// When is a thesis worth RE-MODELLING? (P5, step 3.) PURE, no I/O.
//
// The daily tick (coverage.assess) is free: it re-reads price + consensus and refreshes the recorded
// gap. A re-model is the expensive tier — it wakes Prometheus headless for a full multi-phase research
// run — so it needs a reason, not a schedule. These pure functions decide; coverage.monitor fetches
// the data and calls refreshCoverage.
//
// The framing that makes the triggers obvious: OUR price target is `multiple × forward metric`. It is
// stale when one of those two inputs has been contradicted, and nothing else:
//
//   • a dated CATALYST passed  — earnings printed; the facts the model was built on have changed.
//     Known months ahead, so it schedules rather than polls. The single best trigger there is.
//   • the EDGE changed CATEGORY — our band vs the Street's range moved between contained /
//     variant / contrarian. That is the edge itself changing shape, not the market wobbling.
//   • the FLOOR                — nothing in ~90 days. The quarterly re-model, with a home at last.
//
// Deliberately NOT a trigger: price. Research has no position and therefore no stop; a thesis whose
// price fell is cheaper, not wrong. And not raw consensus-PT drift either — that is the daily card's
// job (validating/diverging), and for a contrarian thesis the Street moving away is the view working.
//
//   • the one apparent exception is an EARLY target hit, which is not really price talking: reaching
//     our own number in a fraction of its horizon contradicts the `multiple × forward metric` model
//     as squarely as a catalyst does, and it fires once (the monitor stamps `monitor.early_hit_at`).
//
// Nor SECTOR ROTATION (asked + declined 2026-07-30). Three reasons, and they stack:
//   • It is the cause, not the effect. Rotation moves neither our PT nor the Street's, so it cannot
//     move the gap. When it genuinely matters the analysts cut numbers, consensus moves, and
//     `diverging` fires on its own — precisely, and a beat later.
//   • It is not name-specific and has no ratchet. Every coverage in the sector would fire the same
//     revision the same day, and unlike consensus (each write moves `gap.consensus_pt`, so a state
//     can only re-fire on a FURTHER move) sector rank has no stored baseline — it would re-ring
//     daily for as long as the group stayed out of favour.
//   • It already has a home, at the right tier. `portfolioReview.computeReviewTriggers` fires Themis
//     on ≥2 sectors rotating. Rotation asks whether the ALLOCATION still fits the regime — Atlas's
//     question. Whether the NAME is worth the number is Prometheus's. Wiring it here would be the
//     wrong desk answering, twice.
//
// CANDIDATE (unbuilt) — the real sector effect that DOES clear the bar above is a de-rating, not a
// rotation: the comp set's multiple compressing and STAYING compressed contradicts the `multiple`
// half of the model outright. Shaped honestly that is trigger #4 = PEER-MULTIPLE COMPRESSION, and it
// belongs in this file (the model is stale) rather than in the daily classifier (the gap moved). It
// needs a baseline multiple persisted at model time — the same trick `monitor.edge_category` uses to
// make change detectable at all — plus a threshold chosen to clear tape noise. Inputs already exist
// (get_stock_peers + get_fundamentals); the cooldown and per-tick cap already bound the spend.

const DAY_MS = 24 * 60 * 60 * 1000

// A re-model is a multi-minute tool-heavy LLM run. These bound the spend; all are tunable.
export const COOLDOWN_DAYS = 14   // never re-model the same name twice inside this window
export const FLOOR_DAYS    = 90   // ...but never leave one un-modelled longer than this

const _num = v => (Number.isFinite(Number(v)) ? Number(v) : null)
// A leg is {value, multiple, forward_metric} after the scenario change; tolerate a bare legacy number.
const _legValue = leg => (leg && typeof leg === 'object' ? _num(leg.value) : _num(leg))

/**
 * Where OUR view sits against the Street's WHOLE range — the honest read of a variant view.
 *
 *   contrarian_bull — our entire band is above their most bullish target
 *   variant_bull    — our base is above their high, but our band still overlaps
 *   contained       — our base sits inside their low–high: someone is already where we are, so the
 *                     "gap vs the mean" is ordinary dispersion, NOT an edge
 *   variant_bear / contrarian_bear — the mirror image
 *
 * Returns null when either side is unknown. Pure.
 */
export function classifyEdge(coverage, street) {
    const base = _num(coverage?.price_target?.value)
    const low  = _num(street?.low)
    const high = _num(street?.high)
    if (base === null || low === null || high === null || high < low) return null

    const bear = _legValue(coverage?.risk_reward?.bear)
    const bull = _legValue(coverage?.risk_reward?.bull)

    if (bear !== null && bear > high) return 'contrarian_bull'
    if (base > high)                  return 'variant_bull'
    if (bull !== null && bull < low)  return 'contrarian_bear'
    if (base < low)                   return 'variant_bear'
    return 'contained'
}

/**
 * The catalyst dates a scheduler may trust: STRICT `YYYY-MM-DD` only, sorted ascending. Pure.
 *
 * Real catalysts arrive mixed — "2026-10-15" next to "2027-Q1", "2027-H1" and "2026-ongoing". The
 * fuzzy ones are prose for the analyst to read; feeding them to a date scheduler would either throw
 * or, worse, silently coerce to some arbitrary instant.
 */
export function parseCatalystDates(catalysts) {
    const out = []
    for (const c of (Array.isArray(catalysts) ? catalysts : [])) {
        const raw = (typeof c === 'string') ? c : c?.date
        if (typeof raw !== 'string') continue
        const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
        if (!m) continue
        const ms = Date.parse(`${m[0]}T00:00:00.000Z`)
        if (Number.isFinite(ms)) out.push(m[0])
    }
    return [...new Set(out)].sort()
}

/** The instant this coverage's model was last built — the anchor every window measures from. */
function _lastModelledMs(coverage) {
    const last = coverage?.monitor?.last_remodel_at ?? coverage?.created_at
    const ms = Date.parse(last ?? '')
    return Number.isFinite(ms) ? ms : null
}

/**
 * Should this coverage be re-modelled now? Pure — the caller supplies fresh `street` and the clock.
 *
 * @returns {{ due:boolean, reason:string|null, edge_category:string|null, next_remodel_at:string|null }}
 *   `edge_category` is always returned (persist it; the change detection reads it back next tick).
 */
export function remodelDecision(coverage, { street = null, nowMs = 0, gapState = null } = {}) {
    const edge = classifyEdge(coverage, street)
    const lastMs = _lastModelledMs(coverage)
    const dates  = parseCatalystDates(coverage?.catalysts)

    // The next dated catalyst still ahead of us — what `next_remodel_at` is scheduled from. A catalyst
    // is actionable the day AFTER it lands, so the print is in the data by the time we re-model.
    const nextFuture = dates.find(d => Date.parse(`${d}T00:00:00.000Z`) + DAY_MS > nowMs) ?? null
    const nextRemodelAt = nextFuture
        ? new Date(Date.parse(`${nextFuture}T00:00:00.000Z`) + DAY_MS).toISOString()
        : (lastMs !== null ? new Date(lastMs + FLOOR_DAYS * DAY_MS).toISOString() : null)

    const quiet = { due: false, reason: null, edge_category: edge, next_remodel_at: nextRemodelAt }

    // The cooldown outranks every trigger. A name in the news can trip several in the same week, and
    // three research runs on one ticker in three days buys nothing the first one didn't.
    if (lastMs !== null && nowMs - lastMs < COOLDOWN_DAYS * DAY_MS) return quiet

    // 0. The target was reached almost immediately (coverage.assess.classifyGapState). The exception
    //    to "price is never a trigger" below, and it isn't really one: the claim isn't that the tape
    //    moved, it's that our own number was reached in a fraction of the time we said it would take,
    //    which contradicts the model directly. Sits UNDER the cooldown like every other trigger, and
    //    the monitor's `early_hit_at` stamp keeps it firing once.
    if (gapState === 'target_hit_early') {
        return { ...quiet, due: true, reason: 'target reached early — the model was too conservative' }
    }

    // 1. A dated catalyst has landed since we last modelled.
    const passed = dates.filter(d => {
        const ms = Date.parse(`${d}T00:00:00.000Z`)
        return ms + DAY_MS <= nowMs && (lastMs === null || ms > lastMs)
    })
    if (passed.length) {
        return { ...quiet, due: true, reason: `catalyst passed: ${passed[passed.length - 1]}` }
    }

    // 2. The edge changed category — the shape of our variant view moved.
    const prev = coverage?.monitor?.edge_category ?? null
    if (edge && prev && edge !== prev) {
        return { ...quiet, due: true, reason: `edge ${prev} → ${edge}` }
    }

    // 3. The quarterly floor.
    if (lastMs !== null && nowMs - lastMs >= FLOOR_DAYS * DAY_MS) {
        return { ...quiet, due: true, reason: `no re-model in ${Math.floor((nowMs - lastMs) / DAY_MS)} days` }
    }

    return quiet
}
