// Repair the coverage docs whose RATING contradicts their own PRICE TARGET — the theses authored
// before the coherence gate landed (92ac95a, 2026-08-03). One-shot, idempotent, reversible by
// inspection (every change lands as an appended revision, nothing is overwritten or deleted).
//
//   node scripts/repair-coverage-incoherent-ratings.mjs            # DRY RUN — prints the plan, writes nothing
//   node scripts/repair-coverage-incoherent-ratings.mjs --apply    # writes
//
// WHAT WENT WRONG. A rating is a claim about the PRICE; the gap is a claim about the STREET. Nothing
// in the research pipeline compared the two until this gate, so a thesis could be rated off its
// distance from the consensus while its own target sat on the opposite side of spot. ZTS was
// initiated `sell` with a target of 85.15 against a stock at 77.29 — our own number was 11% of
// UPSIDE — because the target was 16% under the Street. That is a view on the consensus, not on the
// stock. The daily monitor then read the bearish target as reached (classifyGapState: bearish +
// price <= PT) and stamped `target_hit` 26 minutes after initiation, and again on every tick since.
//
// WHY A REPAIR IS SAFE, AND WHY `hold`. The gate (coverage.service.ratingCoherence) refuses these on
// the way IN, but it is a write-time refusal, not a healer: docs authored before it existed are
// grandfathered, and the monitor's own status patches are deliberately ungated, so the bad verdict
// re-fires daily. The repair takes the CONSERVATIVE side of the contradiction: demote the rating to
// `hold` and KEEP the price target. The target is the number the valuation model actually produced
// and the research stands behind; the rating is the leg that was inferred from the wrong comparison.
// Re-rating to the other direction would be authoring a NEW view, which is Prometheus's job, not a
// migration's. `hold` claims no direction, so the gate abstains on it and the monitor can no longer
// produce a target_hit at all — one change closes both.
//
// WHAT IT DOES. For each coverage whose (rating, price_target, spot) is incoherent:
//   • rating → `hold` (price_target, thesis, risk_reward, gap all untouched)
//   • status `target_hit` → `active`, but ONLY that one: reaching a target we never coherently
//     claimed is not a fact about the thesis. Any other status is left exactly as it is.
//   • monitor.next_check_at → null (due now, so the monitor re-reads it on the next tick)
//   • appends ONE `correction` revision recording what it reverses
// `retired` docs are SKIPPED: retiring is a user decision and this script does not overturn one.
//
// IDEMPOTENT BY CONSTRUCTION — the incoherence check IS the selector, and a repaired doc rates
// `hold`, on which the check abstains. A second run finds nothing.
//
// NO PRICE, NO REPAIR. When spot can't be fetched the gate abstains and so does this: market data
// being unreachable must never be the reason research gets rewritten.

import 'dotenv/config'
import { getDb } from '../providers/mongodb.provider.js'
import { coverageService, ratingCoherence } from '../api/analyst/coverage.service.js'
import { fetchLastPrice } from '../monitoring/monitorUtils.js'
import { logger } from '../services/logger.service.js'

const LOG = '[repair:coverage-incoherent-ratings]'
const COLLECTION = 'coverage'

const APPLY = process.argv.includes('--apply')

const DIRECTIONAL = new Set(['strong_buy', 'buy', 'sell', 'strong_sell'])

const note = (rating, pt, px, detail) =>
    `Corrected an incoherent rating: this thesis was rated \`${rating}\` with a price target of ${pt} `
    + `while the stock traded at ${px} — the rating was taken from our distance to the Street's `
    + `consensus, which is a view on the consensus and not on the stock. The target is kept (it is what `
    + `the valuation model produced); the rating is demoted to \`hold\`, which claims no direction. `
    + `Authored before the coherence gate existed (92ac95a). Gate detail: ${detail}`

async function run() {
    const db = await getDb()
    const all = await db.collection(COLLECTION).find({}).toArray()

    let repaired = 0, skipped = 0, checked = 0

    for (const d of all) {
        const tag = `${d.symbol} (${d.id})`
        const pt = d?.price_target?.value

        // The gate's own abstentions, mirrored — no direction claimed, or no target to contradict.
        if (!DIRECTIONAL.has(d.rating) || !Number.isFinite(Number(pt))) continue
        if (d.status === 'retired') { logger.info(LOG, `  ${tag}: retired by the user — left alone`); continue }

        checked++
        let px = null
        try { px = await fetchLastPrice(d.symbol) } catch { /* abstain below */ }
        if (px === null) {
            logger.warn(LOG, `  ${tag}: no price — ABSTAINING (re-run when market data resolves)`)
            skipped++
            continue
        }

        const coherent = ratingCoherence({ rating: d.rating, price_target: d.price_target, price: px })
        if (coherent.ok) continue

        logger.info(LOG, `  ${tag}: rating ${d.rating} → hold   [pt ${pt} vs px ${px}]`
            + (d.status === 'target_hit' ? '   + status target_hit → active' : ''))
        if (!APPLY) { repaired++; continue }

        // Through the service, so the correction lands as a proper appended revision with a plan diff
        // — the same path a user edit takes. Never a raw $set over the trail. The patch carries
        // `rating`, so it is itself gated: `hold` abstains, and a future non-abstaining value could
        // not sneak through this script either.
        const patch = {
            rating:        'hold',
            revision_kind: 'correction',
            revision_note: note(d.rating, pt, px, coherent.detail),
        }
        if (d.status === 'target_hit') patch.status = 'active'

        const res = await coverageService.updateCoverage(d.id, patch, d.userId)
        if (!res?.ok) {
            logger.error(LOG, `  ${tag}: update FAILED (${res?.reason ?? 'unknown'}) — left untouched`)
            skipped++
            continue
        }
        // Due immediately, so the corrected thesis is re-read on the next tick rather than in 24h.
        // (updateCoverage deliberately never touches monitor.*, so this is a separate write.)
        await db.collection(COLLECTION).updateOne({ id: d.id }, { $set: { 'monitor.next_check_at': null } })
        repaired++
    }

    if (!repaired && !skipped) {
        logger.info(LOG, `No incoherent rating among ${checked} directional coverage doc(s) — nothing to repair.`)
        return
    }
    logger.info(LOG, APPLY
        ? `Done — ${repaired} repaired, ${skipped} skipped, ${checked} checked.`
        : `DRY RUN — ${repaired} would be repaired, ${skipped} skipped, ${checked} checked. Re-run with --apply to write.`)
}

run()
    .then(() => process.exit(0))
    .catch(err => { logger.error(LOG, 'Repair failed:', err); process.exit(1) })
