// `open_setup_form` — the desk hands the user the express setup form.
//
// The trade desk's default move is a CONVERSATION: the user brings a name, the agent brings the
// analysis, and the plan is built a turn at a time. This tool exists for the case that is not
// that — the user already has the whole setup written down and wants to enter it, not discuss it.
// Talking them through a plan they have already made is the desk wasting their time politely.
//
// SPLIT THE SAME WAY THE REGISTRY SPLITS EVERYTHING (agentTools.registry.js): the SCHEMA is shared
// mechanism and lives there; the WHEN-clause is the desk's own judgment and is passed in, the way
// `consultDescription` does it. A second desk adopting this tool writes one clause and wires
// nothing — which is the whole point of it not living inside Mentor.
//
// The tool opens a SURFACE, it does not author a plan. It carries the nucleus (ticker, direction,
// horizon, timeframe, lens) and nothing else, because an agent that wants to hand over a drawn
// setup already has a channel for that — its own `<setup>` emit — and two authoring channels for
// one artifact is how they start disagreeing.

import { makeToolHandler } from '../agentUtils.js'
import { normalizeTimeframe, VALID_TIMEFRAMES } from '../timeframe.service.js'
import { TRADE_HORIZONS } from '../entity/vocabulary.js'
import { MODES } from '../analysisModes.js'
import { logger } from '../logger.service.js'

/**
 * The tool's description, assembled from shared mechanism + the desk's own when-clause.
 *
 * @param {string} when  the desk's judgment about when to reach for it — markdown, one paragraph.
 */
export function setupFormDescription(when) {
    return `Open the EXPRESS SETUP FORM in the user's panel — a blank worksheet they type their own plan straight into (entry / stop / targets as price bands, the conditions in their own words, size, horizon, timeframe, direction, lens) and press Generate.

${when}

Pre-fill ONLY what the user has actually said. A field you guess at is one they have to notice and correct, which is slower than leaving it empty. Say one short line alongside the call — that the form is open and what is left for them — and then STOP: do not restate the fields, do not ask the questions the form is already asking, and do not start analysing the name. They came here to type, not to talk. If they ask for your read afterwards, give it then.`
}

/**
 * Build the handler. `onSetupForm` is the per-request surface callback (the desk's controller wires
 * it to an SSE event), exactly as `onChart` is for a rendered chart.
 *
 * A desk that declares the tool without wiring the callback would otherwise have the model tell the
 * user a form is open when nothing happened — so the absence is REPORTED to the model rather than
 * swallowed, and it can say something true instead.
 */
export function makeSetupFormHandler({ log, onSetupForm }) {
    return makeToolHandler(
        'open_setup_form',
        async (input = {}) => {
            const prefill = _cleanPrefill(input)
            const note    = typeof input?.note === 'string' && input.note.trim() ? input.note.trim() : null

            if (typeof onSetupForm !== 'function') {
                return 'The setup form could not be opened — this desk cannot show it right now. Tell the user plainly and offer to build the setup in conversation instead.'
            }
            try {
                onSetupForm({ prefill, note })
            } catch (err) {
                logger.warn(log, 'onSetupForm emit failed:', err.message)
                return 'The setup form could not be opened. Tell the user plainly and offer to build the setup in conversation instead.'
            }

            const filled = Object.entries(prefill).map(([k, v]) => `${k}: ${v}`).join(', ')
            return `The setup form is now open in the user's panel${filled ? `, pre-filled with ${filled}` : ', empty'}. They fill it in themselves and press Generate. Acknowledge in ONE short line and stop — do not restate the fields or start analysing.`
        },
        (err) => `Could not open the setup form: ${err.message}. Offer to build the setup in conversation instead.`,
        log,
    )
}

/**
 * Keep only values that are actually in our vocabulary. The enums are declared in the schema, but a
 * schema is a request rather than a guarantee — and a bad value here is worse than an absent one:
 * it reaches the form as a pre-filled field the user has to spot and undo. Pure.
 */
function _cleanPrefill(input) {
    const out = {}
    const asset = typeof input?.asset === 'string' ? input.asset.toUpperCase().trim() : ''
    if (asset) out.asset = asset

    if (input?.direction === 'long' || input?.direction === 'short') out.direction = input.direction
    if (TRADE_HORIZONS.includes(input?.type)) out.type = input.type
    if (MODES.includes(input?.trade_mode))    out.trade_mode = input.trade_mode

    const tf = normalizeTimeframe(input?.timeframe)
    if (tf && VALID_TIMEFRAMES.has(tf)) out.timeframe = tf

    return out
}
