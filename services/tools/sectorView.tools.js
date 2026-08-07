/**
 * The house sector view, as a READ tool.
 *
 * UNBOUND — no userId, same as the market brief and for the same reason: a tilt is a BROADCAST. One
 * view serves every reader, it is written without knowing whose book it lands in, and a handler that
 * cannot see a user cannot leak one into it.
 *
 * This is the SHOW half of Axl's job. Reporting what the desk already published is reading, which is
 * Axl's side of the line; authoring or changing a view is Pythia's, and gets a `<route>`.
 */

import { makeToolHandler } from '../agentUtils.js'
import { tiltService }     from '../../api/strategy/tilt.service.js'

const LOG = '[sectorView]'

export const SECTOR_VIEW_TOOL_SPEC = {
    get_sector_view: `The house SECTOR VIEW published by Pythia (the strategy desk): the named market regime, what would break that read, and each sector's stance as an active weight against the benchmark — plus how each stance is doing so far. Call it for "what's our sector view", "which sectors do we like", "what's the house view", "are we overweight tech", "what's the current forecast". READ-ONLY: it reports a view that already exists. It is a broadcast written for everyone and knows NOTHING about this user's book — never connect it to their positions. If the user wants a NEW or CHANGED view, that is Pythia's desk, not this tool.`,
}

const STANCE_WORD = { over: 'overweight', neutral: 'neutral', under: 'underweight' }

/** `+150bp` / `-50bp` / `—`. An absent weight is not a zero. */
const _bp = v => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v}bp`)

/**
 * A published view → LLM-ready prose. Pure — exported for testing.
 *
 * Contribution is stated only when it is KNOWN. A stance we could not price has earned an unknown
 * amount, and writing "0bp" would hand the model a result the desk does not have — the same
 * distinction the grader and the board both protect.
 */
export function formatSectorView(doc) {
    if (!doc) {
        return 'No house sector view has been published yet. Say so plainly — do not invent one, and '
            + 'do not substitute your own read of the sectors. Pythia is the desk that sets it.'
    }
    const rows = Array.isArray(doc.tilts) ? doc.tilts : []
    const line = (r) => {
        const contrib = (r.contribution_bp === null || r.contribution_bp === undefined)
            ? 'not yet priced'
            : `${r.contribution_bp >= 0 ? '+' : ''}${r.contribution_bp}bp so far`
        return `  ${String(r.sector).padEnd(24)} ${String(STANCE_WORD[r.stance] ?? 'no view').padEnd(12)} `
             + `${_bp(r.active_bp).padStart(7)}  ${String(r.horizon ?? '—').padEnd(4)} ${contrib}`
             + (r.rationale ? `\n${' '.repeat(28)}${r.rationale}` : '')
    }

    const out = [`HOUSE SECTOR VIEW (vs ${doc.benchmark ?? 'SPX'}, published ${String(doc.created_at ?? '').slice(0, 10)})`]
    if (doc.regime?.name)   out.push(`Regime: ${doc.regime.name}`)
    if (doc.regime?.thesis) out.push(doc.regime.thesis)
    if (doc.regime?.kill_criteria?.length) {
        out.push('What would break this read:', ...doc.regime.kill_criteria.map(k => `  • ${k}`))
    }
    out.push('', rows.length ? 'Stances (active weight vs the benchmark weight):' : 'This view carries no stances.')
    if (rows.length) out.push(...rows.map(line))

    // A stance is a RELATIVE claim, and a reader who misses that will hear "healthcare goes up".
    out.push('', 'A stance claims the sector BEATS the benchmark, not that it rises — an overweight that '
        + 'fell less than the index worked. Report the view; do not re-argue it or add sectors of your own.')
    if (doc.balanced === false) {
        out.push(`NOTE: these weights net to ${_bp(doc.net_bp)} rather than 0, so the table is not directly allocatable. Say so if you list them.`)
    }
    return out.join('\n')
}

export function makeSectorViewHandlers(deps = {}) {
    const { current = () => tiltService.getCurrentTilt() } = deps

    return {
        get_sector_view: makeToolHandler('get_sector_view',
            async () => formatSectorView(await current()),
            (err) => `Could not read the house sector view: ${err.message}`, LOG),
    }
}
