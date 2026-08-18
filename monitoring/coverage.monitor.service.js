// Coverage monitor (P5) — the slow background loop that keeps the Analyst's theses LIVING. Mirrors the
// Hermes/Themis pattern (poll loop + due-selection + a two-tier verdict), but at a research cadence:
// each coverage is re-checked ~daily. It tracks THE GAP (our view vs the Street) via the pure
// classifier in coverage.assess.js — is the Street converging to us (thesis playing out, edge closing)
// or diverging — plus price reaching our target. Material verdicts append a revision + notify; a quiet
// day just refreshes the recorded gap.
//
// TWO TIERS, and the split is about cost:
//   • DETERMINISTIC (every due coverage, every day) — price + consensus → gap → card. Free.
//   • RE-MODEL (rare, gated) — wake Prometheus headless for a full research run, rewriting the PT and
//     the band. Multi-minute and tool-heavy, so coverage.remodel.js decides when it is earned:
//     a dated catalyst landed, the edge changed category, or the quarterly floor expired — under a
//     per-name cooldown and a per-tick cap, held names first.
// Judging the free-text kill_criteria is still the LLM tier's job and still unbuilt.

import { getPriceTargetConsensus } from '../providers/fmp.provider.js'
import { coverageService, COLLECTION } from '../api/analyst/coverage.service.js'
import { classifyGapState, recomputeGap, statusForState, nextCheckAt } from './coverage.assess.js'
import { remodelDecision }        from './coverage.remodel.js'
import { notifyCoverageEvent }    from '../services/coverageNotify.service.js'
import { refreshCoverage }        from '../services/coverageRefresh.service.js'
import { entityRepo }             from '../services/entity/entityRepo.service.js'
import { LIVE_POSITION }          from '../services/entity/vocabulary.js'
import { fetchLastPrice } from './monitorUtils.js'
import { createDueLoop }   from './dueLoop.js'
import { logger }                 from '../services/logger.service.js'

const LOG        = '[coverageMonitor]'
// Tick hourly; each coverage gates itself to ~daily via monitor.next_check_at (research cadence).
const POLL_INTERVAL_MS = 60 * 60 * 1000
const MAX_PER_TICK     = 50
// Re-models are the expensive tier: a hard ceiling per tick so an earnings week can't fire a dozen
// multi-minute research runs at once. Overflow isn't lost — it stays due and lands on a later tick.
const MAX_REMODELS_PER_TICK = 3

// Injectable IO so tests exercise the branching without real price/consensus/DB writes.
const _deps = {
    // The SHARED price read (quote → candle fallback), the same one Hermes and Talos gate on. This
    // used to hand-roll a getQuote() lookup — the LLM-display formatter, which returns a STRING — so
    // the price was silently null on every tick and every thesis broke on its first check.
    getPrice:       (sym) => fetchLastPrice(sym).catch(() => null),
    // The WHOLE distribution {consensus, high, low, median} — the gap is our PT's position within the
    // Street's range, not a percentage off its mean.
    getConsensusPt: (sym) => getPriceTargetConsensus(sym).catch(() => null),
    updateCoverage: coverageService.updateCoverage,
    // The monitor.* subtree is written through its owner too — see coverage.service. This module
    // used to reach past the service into the collection, so the shape of that subtree lived in
    // two files with nothing keeping them in step.
    recordMonitorState: coverageService.recordMonitorState,
    claimRemodel:       coverageService.claimRemodel,
    // The expensive tier — the SAME headless-Prometheus hop Atlas triggers mid-review, reused rather
    // than forked, so a re-model persists and notifies identically however it was asked for.
    remodel: (cov, reason) => refreshCoverage({
        userId:   cov.userId,
        ticker:   cov.symbol,
        question: `Scheduled re-model (${reason}). Re-run the valuation with fresh estimates and restate the variant view.`,
    }),
    // Symbols this user holds RIGHT NOW — they get the scarce re-model slots first, because they are
    // the only ones carrying risk. A failure here degrades to "no priority", never to no re-models.
    getHeldSymbols: async (userId) => {
        try {
            // listByStatus is owner-BLIND (it serves the kind-blind reconciler), so scope it here —
            // otherwise one user's holdings would prioritise another user's research.
            const live = await entityRepo.listByStatus(LIVE_POSITION)
            return new Set((live ?? [])
                .filter(e => e.userId === userId)
                .map(e => String(e.asset ?? '').toUpperCase())
                .filter(Boolean))
        } catch (err) {
            logger.warn(LOG, 'held-symbol lookup failed; re-model priority is flat this tick', err.message)
            return new Set()
        }
    },
    // Post to the Analyst's social-chat feed on a material verdict (P5). Logs too, for the server trail.
    notify: (cov, verdict) => {
        logger.info(LOG, 'coverage event', { symbol: cov.symbol, state: verdict.state, reason: verdict.reason, edge_gone: verdict.edge_gone })
        notifyCoverageEvent(cov, verdict)   // fire-and-forget; never throws
    },
}
export function _setDeps(d) { Object.assign(_deps, d) }

// The wake-up chore lives in dueLoop.js — find what is due, CLAIM it against a lease, check it under
// a timeout. This loop used to hand-roll all three, and had no lease at all: nothing but the poll
// loop's own single-flight flag stopped a second reader picking up a coverage already being checked.
// What stays here is only what makes this the coverage loop.
const _loop = createDueLoop({
    collection: COLLECTION,
    // No `kind` — this collection holds coverage documents and nothing else, and they carry no such
    // field. Passing one would select nothing, every tick, in silence.
    //
    // Everything except a RETIRED name. A thesis keeps living — including one that already hit its
    // target — until the user churns it out of the book; only that decision stops the loop. The rule
    // is NEGATIVE, so it rides `filter` rather than the `statuses` allow-list.
    filter:     { status: { $ne: 'retired' } },
    // Coverage keeps its schedule under `monitor.*`; the entity collection uses `monitor_state.*`.
    statePath:  'monitor',
    limit:      MAX_PER_TICK,
    check:      (cov, nowMs) => _checkCoverage(cov, nowMs, _deps),
    // The re-model budget is the one decision no single check can make — it is spent ACROSS the due
    // set (held names first, then capped), so it belongs after all of them rather than inside any.
    afterTick:  (results) => _runRemodels(
        results.filter(r => r.result?.remodel?.due).map(r => ({ cov: r.entity, reason: r.result.remodel.reason })),
        _deps,
    ),
    intervalMs: POLL_INTERVAL_MS,
    // Not eager: an hourly research loop has no reason to fire on every deploy.
    eager:      false,
    log: LOG, name: 'coverage monitor',
})
export const coverageMonitorService = { start: _loop.start, stop: _loop.stop }

/**
 * Fire the re-models this tick can afford. Held names first — they are the ones carrying risk — then
 * capped. Anything over the cap keeps its due state and is picked up on a later tick, and the drop is
 * LOGGED: a silent truncation would read as "everything was re-modelled" when it wasn't.
 */
export async function _runRemodels(candidates, deps = _deps) {
    const held = new Set()
    for (const userId of new Set(candidates.map(c => c.cov.userId))) {
        for (const s of await deps.getHeldSymbols(userId)) held.add(`${userId}:${s}`)
    }
    const isHeld = c => held.has(`${c.cov.userId}:${String(c.cov.symbol).toUpperCase()}`)

    const ordered = [...candidates].sort((a, b) => (isHeld(b) ? 1 : 0) - (isHeld(a) ? 1 : 0))
    const run = ordered.slice(0, MAX_REMODELS_PER_TICK)
    const deferred = ordered.slice(MAX_REMODELS_PER_TICK)
    if (deferred.length) {
        logger.info(LOG, `re-model cap reached — deferring ${deferred.length} to a later tick: ${deferred.map(c => c.cov.symbol).join(', ')}`)
    }

    for (const { cov, reason } of run) {
        // Stamp BEFORE the run, not after: a re-model takes minutes, and the hourly tick must not
        // start a second one for the same name in the meantime. It also starts the cooldown at the
        // decision, so a run that fails doesn't immediately re-trigger on the next tick.
        // CLAIM before the run, not just stamp. A re-model takes MINUTES, so the stamp has to land
        // first or the next hourly tick starts a second one for the same name — and it also starts
        // the cooldown at the decision, so a run that fails doesn't re-trigger immediately.
        //
        // It is a claim rather than a write because "the next tick" is not the only other caller:
        // the loop's single-flight guard stops a second TICK, nothing stopped a second PROCESS.
        // Compare-and-swap on the value we read means the loser stands down instead of paying for a
        // duplicate multi-phase research run.
        const won = await deps.claimRemodel(cov.id, {
            previousAt: cov.monitor?.last_remodel_at ?? null,
            reason,
        })
        if (!won) {
            logger.info(LOG, `re-model already claimed elsewhere — skipping ${cov.symbol}`)
            continue
        }
        logger.info(LOG, 'RE-MODEL', { symbol: cov.symbol, held: isHeld({ cov }), reason })
        try { await deps.remodel(cov, reason) }
        catch (err) { logger.warn(LOG, `re-model ${cov.symbol} failed:`, err.message) }
    }
}

// Check one coverage: fetch fresh price + consensus → classify the gap → apply. Exported for tests.
export async function _checkCoverage(cov, nowMs, deps = _deps) {
    const [price, street] = await Promise.all([deps.getPrice(cov.symbol), deps.getConsensusPt(cov.symbol)])
    // The classifier compares point-to-point (our PT vs the Street's mean); the stored gap keeps the
    // whole distribution. A bare number is still accepted, so an injected test dep can stay simple.
    const consensusPt = (street && typeof street === 'object') ? street.consensus ?? null : street ?? null
    const verdict = classifyGapState(cov, { price, consensus_pt: consensusPt, nowMs })
    const gap     = recomputeGap(cov.price_target?.value, street) ?? cov.gap ?? null
    const nextAt  = nextCheckAt(cov, verdict.state, nowMs)

    // The expensive-tier decision rides the SAME daily fetch — no extra call to ask "is a re-model
    // earned?". `edge_category` is persisted on every tick precisely so the next one can spot a
    // CHANGE; recording it is what makes that trigger possible at all.
    const remodel = remodelDecision(cov, { street, nowMs, gapState: verdict.state })

    const bookkeeping = {
        $set: {
            'monitor.next_check_at':   nextAt,
            'monitor.last_checked':    new Date(nowMs).toISOString(),
            'monitor.edge_category':   remodel.edge_category,
            'monitor.next_remodel_at': remodel.next_remodel_at,
            // What that date is waiting for ("Q3 earnings" / 'catalyst' / 'quarterly floor'). Stored
            // beside the date rather than re-derived by every reader: the branch that produced it is
            // known here and nowhere else, and a UI re-deriving it would be a second copy of the rule.
            'monitor.next_remodel_reason': remodel.next_remodel_reason,
            // The early-hit ratchet (see `alreadyRecorded`). Written on the material path only —
            // stamping it on the quiet path would be a no-op, since the quiet path for this state is
            // reached only when the stamp already exists.
            ...(verdict.state === 'target_hit_early' ? { 'monitor.early_hit_at': new Date(nowMs).toISOString() } : {}),
        },
        $inc: { 'monitor.checks': 1 },
    }

    // A verdict the doc ALREADY records is not news. Now that a target_hit name keeps being watched
    // (nothing terminal stops the loop any more), a price parked above our PT would otherwise re-fire
    // the same revision and the same card every single day. Consensus states self-limit — each write
    // moves `gap.consensus_pt`, so `diverging` can only fire again on a FURTHER move — but a price
    // comparison has no such ratchet, so it needs this one.
    //
    // An EARLY hit needs its own ratchet rather than sharing the status check: it deliberately leaves
    // the status `active` (coverage.assess.statusForState), so there is no status for the verdict to
    // be read back out of, and its own stamp is what stops it repeating.
    //
    // The stamp is scoped to the TARGET it silenced, not to the name. An early hit triggers a
    // re-model, the re-model writes a fresh (higher) target with a fresh `set_at` — and a stamp left
    // standing from the previous target would then swallow the next early hit in silence, which is the
    // one verdict that must never go unheard twice in a row. A stamp older than the current target has
    // outlived its subject and no longer ratchets anything.
    const earlyStampMs = Date.parse(cov.monitor?.early_hit_at ?? '')
    const targetSetMs  = Date.parse(cov.price_target?.set_at ?? '')
    const earlyAlreadyStamped = Number.isFinite(earlyStampMs)
        && (!Number.isFinite(targetSetMs) || earlyStampMs >= targetSetMs)

    const alreadyRecorded = (verdict.state === 'target_hit'       && cov.status === 'target_hit')
                         || (verdict.state === 'target_hit_early' && earlyAlreadyStamped)

    if (verdict.state === 'stable' || alreadyRecorded) {
        // Quiet day — refresh the recorded gap + bookkeeping directly (no revision, no notify).
        // A quiet DAY is not a quiet QUARTER: the re-model decision still stands, since a catalyst
        // landing or the floor expiring has nothing to do with whether today's tape moved.
        await deps.recordMonitorState(cov.id, { set: { ...bookkeeping.$set, gap }, inc: bookkeeping.$inc })
        return { ...verdict, applied: false, remodel }
    }

    // Material verdict → update the thesis (status + gap + an appended revision) then notify.
    const note  = verdict.reason + (verdict.edge_gone ? ' — edge gone (Street caught up); consider harvest/retire' : '')
    const patch = { gap, revision_kind: verdict.state, revision_note: note }
    const status = statusForState(verdict.state)
    if (status) patch.status = status

    // The write is the source of truth for the card. If the thesis didn't actually move, telling the
    // user it did sends them to a coverage that contradicts the message — so we log and stay quiet.
    // Bookkeeping is skipped too, deliberately: leaving the doc due re-checks it on the next tick
    // rather than swallowing a real verdict for a day over a transient failure.
    const res = await deps.updateCoverage(cov.id, patch, cov.userId)
    if (!res?.ok) {
        logger.warn(LOG, 'thesis update failed — no status change, not notifying', { id: cov.id, symbol: cov.symbol, reason: res?.reason ?? 'unknown' })
        // No re-model either: a doc we could not write is one whose `last_remodel_at` stamp would
        // also fail, and a re-model that can't record itself would repeat every tick.
        return { ...verdict, applied: false }
    }

    // updateCoverage owns the THESIS; this owns the monitor's record of its own work. Both writes
    // now go through coverageService, which is the only module that knows this collection's shape.
    await deps.recordMonitorState(cov.id, { set: bookkeeping.$set, inc: bookkeeping.$inc })
    deps.notify(cov, verdict)
    return { ...verdict, remodel }
}
