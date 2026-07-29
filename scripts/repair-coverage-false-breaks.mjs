// Repair the coverage docs killed by the price-0 bug (2026-07-29). One-shot, idempotent, reversible
// by inspection (every change lands as an appended revision, nothing is overwritten or deleted).
//
//   node scripts/repair-coverage-false-breaks.mjs            # DRY RUN — prints the plan, writes nothing
//   node scripts/repair-coverage-false-breaks.mjs --apply    # writes
//   node scripts/repair-coverage-false-breaks.mjs --apply --include-retired
//
// WHAT WENT WRONG. The coverage monitor read its price through `getQuote`, the LLM-DISPLAY formatter,
// which returns a human-readable string — so `q?.price` was undefined and the fetch yielded null on
// every tick. `coverage.assess`'s local `_num` then turned that null into the NUMBER 0 (Number(null)
// === 0), which sailed past the `price !== null` guard and compared below every bear case ever
// written. Result: "price 0 ≤ bear case N" — every long-rated thesis broken on its FIRST check,
// ~9 minutes after initiation, with a social-chat card for each.
//
// WHY A REPAIR IS SAFE. The verdicts were not judgments that turned out wrong; they were arithmetic on
// a number that was never fetched. And the rule itself is gone: `risk_reward` is a ±15% sensitivity
// band around our multiple (valuation.engine holds EPS constant across bear/base/bull), so for a
// bullish name it routinely sits ABOVE spot — TSM was initiated at ~$404 with a "bear case" of $597.
// classifyGapState no longer produces `thesis_broken` at all; invalidation belongs to the position
// (Themis: revised PT vs entry basis) and to the text kill_criteria (the LLM tier).
//
// WHAT IT DOES. For each coverage whose revision trail contains a price-0 break:
//   • status → `active` (it was never anything else on the evidence)
//   • monitor.next_check_at → null (due now, so the fixed monitor re-reads it on the next tick)
//   • appends ONE `correction` revision recording what happened and what it reverses
// `retired` docs are SKIPPED unless --include-retired: retiring is a user decision, and this script
// does not get to overturn one silently — even one taken on a false signal.

import 'dotenv/config'
import { getDb } from '../providers/mongodb.provider.js'
import { coverageService } from '../api/analyst/coverage.service.js'
import { logger } from '../services/logger.service.js'

const LOG = '[repair:coverage-false-breaks]'
const COLLECTION = 'coverage'

const APPLY           = process.argv.includes('--apply')
const INCLUDE_RETIRED = process.argv.includes('--include-retired')

// The exact fingerprint of the bug: a revision whose note reads "price 0 ≤/≥ <bound>". Matching the
// note (not merely the status) is what keeps this from touching a thesis broken for a real reason.
const FALSE_BREAK_RE = /\bprice 0 [≤≥]/

const NOTE = 'Reverted a false `thesis_broken`: the monitor read its price through the LLM-display '
    + 'formatter, so the fetch returned null and a null read as 0 — "price 0 ≤ bear case" fired on the '
    + 'first check of every covered name. No price was ever compared. The price-vs-band rule has since '
    + 'been removed entirely (risk_reward is a ±15% multiple sensitivity, not an invalidation level).'

async function run() {
    const db = await getDb()
    const all = await db.collection(COLLECTION).find({}).toArray()

    const hits = all.filter(d => (d.revisions || []).some(r => FALSE_BREAK_RE.test(r?.note ?? '')))
    if (!hits.length) {
        logger.info(LOG, 'No coverage carries a price-0 break — nothing to repair.')
        return
    }

    logger.info(LOG, `${hits.length}/${all.length} coverage doc(s) carry a price-0 break.`)
    let repaired = 0, skipped = 0

    for (const d of hits) {
        const bad = (d.revisions || []).find(r => FALSE_BREAK_RE.test(r?.note ?? ''))
        const tag = `${d.symbol} (${d.id})`

        // Already put right by an earlier run — the correction is in the trail. Idempotent.
        if ((d.revisions || []).some(r => r?.kind === 'correction')) {
            logger.info(LOG, `  ${tag}: already corrected — skipping`)
            skipped++
            continue
        }
        if (d.status === 'retired' && !INCLUDE_RETIRED) {
            logger.info(LOG, `  ${tag}: RETIRED by the user — left alone (re-run with --include-retired to revive)`)
            skipped++
            continue
        }

        logger.info(LOG, `  ${tag}: status ${d.status} → active   [false break: "${bad.note}" at ${bad.at}]`)
        if (!APPLY) { repaired++; continue }

        // Through the service, so the correction lands as a proper appended revision with a plan diff
        // — the same path a user edit takes. Never a raw $set over the trail.
        const res = await coverageService.updateCoverage(d.id, {
            status:        'active',
            revision_kind: 'correction',
            revision_note: NOTE,
        }, d.userId)

        if (!res?.ok) {
            logger.error(LOG, `  ${tag}: update FAILED (${res?.reason ?? 'unknown'}) — left untouched`)
            skipped++
            continue
        }
        // Due immediately, so the repaired thesis is re-read on the next tick rather than in 24h.
        // (updateCoverage deliberately never touches monitor.*, so this is a separate write.)
        await db.collection(COLLECTION).updateOne({ id: d.id }, { $set: { 'monitor.next_check_at': null } })
        repaired++
    }

    logger.info(LOG, APPLY
        ? `Done — ${repaired} repaired, ${skipped} skipped.`
        : `DRY RUN — ${repaired} would be repaired, ${skipped} skipped. Re-run with --apply to write.`)
}

run()
    .then(() => process.exit(0))
    .catch(err => { logger.error(LOG, 'Repair failed:', err); process.exit(1) })
