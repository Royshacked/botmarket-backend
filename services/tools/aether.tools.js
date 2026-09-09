// Aether desk tools — one, because the desk answers one question.
//
// FOURTEEN TOOLS WERE RETIRED HERE, in two passes. Eleven on 2026-09-09 with the
// channel-FORECASTING stack they read from — exposure elasticities, forecasts,
// calibration, portfolio slots, interference, loss surface, governance budget, decay
// audit, shock predictions, the opportunity feed, per-ticker signals. Their collections
// were archived, empty, or worst of all stale: get_shock_feed was serving Mentor and
// Atlas 170 opportunity cards built on June's channel state by a generator that no
// longer ran.
//
// Then the last three — taxonomy, channel state, regime — with the channels themselves.
// Keeping a nineteen-channel FRED ingest and a weekly state matrix alive to serve three
// descriptive reads was the wrong trade.
//
// WHAT REPLACED THEM. The desk was left with no tools at all and a prompt promising it
// could read "recent event runs, the candidates each produced, why each name is there,
// what its filing said" — a promise nothing could keep, and exactly the drift
// promptToolDrift exists to catch. So the surviving surface is the one the desk is
// actually for: the event candidates.
//
// UNBOUND, like the reads before it: a run is a house-layer broadcast written by the
// Python engine and shared across every user. No userId.

import { makeToolHandler } from '../agentUtils.js'
import { getEventCandidates } from '../../api/aether/aether.service.js'

const LOG = '[aetherTools]'

export const AETHER_TOOL_SPECS = {
    get_event_candidates: `Recent event runs and the companies each named. One run is one named event — a tariff, an export ban, an appropriation — and one candidate is one company it reaches, carrying the mechanism, a citable press fact, whatever its own SEC filings said, how far it has moved against SPY since the event, and when it expires. Call it for "what has Aether found", "why is this name here", "did I miss it", or any question about a specific event or ticker on the list. Takes an optional \`days\` (default 30) and \`includeDropped\` (default false — pass true to see the names a gate rejected and why).`,
}

/**
 * Render runs for the model.
 *
 * ABSENT IS ABSENT. A field the engine did not measure prints as "—", never as a plausible
 * number, because the desk's whole claim is that it identifies rather than forecasts. The
 * previous version of this engine did the opposite and was archived for it.
 */
export function formatEventCandidates(runs) {
    if (!runs?.length) {
        return 'No event runs in the window. Aether names companies when a story breaks, and '
            + 'discovery is started by an admin rather than on a schedule — so an empty list '
            + 'means nothing has been run, not that nothing happened.'
    }

    const pct = v => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
    const out = []

    for (const run of runs) {
        const kind = [run.event_category, run.answer_shape].filter(Boolean).join(' / ')
        out.push(`\n═══ ${run.subject || run.run_id}${kind ? `  [${kind}]` : ''}`
            + `${run.event_date ? `  effective ${run.event_date}` : ''}`)
        if (run.event) out.push(run.event)

        for (const c of run.candidates ?? []) {
            const side = { hurt: 'SHORT', helped: 'LONG', mixed: 'MIXED' }[c.side] ?? '—'
            out.push(`\n  ${c.ticker}  ${side}  tier ${c.tier ?? '—'}  filing: ${c.verdict ?? '—'}`
                + `${c.survived === false ? `  DROPPED (${c.drop_reason || 'no reason recorded'})` : ''}`)
            if (c.mechanism)      out.push(`    Why:      ${c.mechanism}`)
            if (c.press_evidence) out.push(`    Reported: ${c.press_evidence}`)
            // `silent` is information, not a gap — a company visibly exposed in the press
            // and silent in its filings is the interesting case.
            out.push(`    Filing:   ${c.filing_evidence || 'nothing in its filings mentions this'}`)
            if (c.impact_pct_revenue != null) {
                out.push(`    Sized:    ${(c.impact_pct_revenue * 100).toFixed(2)}% of revenue, as disclosed`)
            }
            if (c.move_pct != null) {
                out.push(`    Since:    ${pct(c.move_pct)} raw, ${pct(c.excess_pct)} vs SPY`
                    + `${c.extension != null ? `, ${c.extension.toFixed(1)}σ` : ''}`
                    + `${c.reaction ? `, ${c.reaction}` : ''}`
                    + `${c.price_asof ? ` (as of ${c.price_asof})` : ''}`)
            }
            if (c.expires_at) out.push(`    Expires:  ${c.expires_at}`)
        }
    }
    return out.join('\n')
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export function makeAetherToolHandlers() {
    return {
        get_event_candidates: makeToolHandler('get_event_candidates',
            async ({ days, includeDropped } = {}) => formatEventCandidates(
                await getEventCandidates({
                    days: Math.min(Math.max(Number(days) || 30, 1), 180),
                    includeDropped: includeDropped === true,
                }),
            ),
            (err) => `Could not read the event candidates: ${err.message}`, LOG),
    }
}
