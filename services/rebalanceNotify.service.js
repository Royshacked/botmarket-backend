/**
 * The receipt for an accepted portfolio review.
 *
 * WHY THIS EXISTS. A review that trims a holding, scales into another and edits two theses moved
 * real size at a real venue — and until now it left NO trace a user could find. `add_item` is the
 * only action that surfaces anything (the OrderConfirmDialog); trim / exit / add_to go straight to
 * the broker with no confirm step, and the rebalance path posts a card only for MANUAL books, where
 * the card is an instruction rather than a record. So on a paper or live book the entire feedback
 * was one toast, and closing it left the user with no way to answer "did that actually happen?".
 *
 * This posts that answer: one card, after the fact, naming what moved. It is an ALERT ABOUT a state
 * change and never part of it — everything here has already been written by the time we post, which
 * is why it goes through `postCard` (never throws) and why a failure to deliver is only a log line.
 *
 * Manual legs are EXCLUDED: they already got a Fill card from manualNotify, and a book that mixes
 * the two must not have its manual legs reported twice. If nothing survives that filter there is
 * nothing to say, and no card is posted.
 */

import { postCard } from './notifyCard.js'

const LOG = '[rebalanceNotify]'

// What each action does, in BOTH the tenses this card needs. Keyed by the same action vocabulary
// portfolio_system_prompt.md teaches, so a new verb shows up as `undefined` rather than as a wrong
// word — `_phrase` falls back to the raw action, which is ugly on purpose.
//
// Two forms, because only one of the three buckets happened. "I trimmed AVGO" is a report; a queued
// or refused change has to read "trim AVGO — queued for the open" and "couldn't trim AVGO". Writing
// the past tense into all three produced "couldn't added to EME".
const VERB = {
    update_item: ['updated',  'update'],
    remove_item: ['removed',  'remove'],
    exit_item:   ['exited',   'exit'],
    trim_item:   ['trimmed',  'trim'],
    add_item:    ['opened',   'open'],
    add_to_item: ['added to', 'add to'],
}

/** "trimmed AVGO" (past) / "trim AVGO" (base) — or "a holding" when the asset didn't resolve. */
function _phrase(r, past = true) {
    const forms = VERB[r.action]
    const verb  = forms ? (past ? forms[0] : forms[1]) : r.action
    return r.asset ? `${verb} ${r.asset}` : `${verb} a holding`
}

// Refusals in the user's words. The result carries a machine reason; a card that prints
// `broker_rejected` at somebody is a log line with a bot's name on it. Unknown reasons fall through
// as-is rather than being swallowed — a cause we failed to word still beats no cause.
const REASON_COPY = {
    add_too_small:       'too small to place',
    trim_too_small:      'too small to place',
    no_position:         'no open position',
    not_live:            'not in a position yet',
    already_held_use_add_to_item: 'already held',
    live_use_exit_item:  'already live',
    broker_rejected:     'the venue rejected it',
    broker_cannot_close: "this broker can't close positions",
    queue_failed:        "it couldn't be queued",
    not_found:           'the holding is gone',
    forbidden:           'not yours',
}

/** " (the venue rejected it)" — or nothing, when the refusal came back nameless. */
function _why(r) {
    const raw = r.reason ?? r.error
    return raw ? ` (${REASON_COPY[raw] ?? raw})` : ''
}

/** "AVGO, MU and CRDO" — the app's list voice, not a comma-jammed array. */
function _list(items) {
    if (items.length <= 1) return items[0] ?? ''
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * BUILD the receipt card, or null when there is nothing to report.
 *
 * Split from the posting so the wording — which is the whole substance here — can be asserted
 * without a database or a chat service behind it. Same `_`-prefixed seam the other notify modules
 * expose (`manualNotify._sender`).
 *
 * @param {string} userId
 * @param {object} opts
 * @param {string}  opts.portfolioId
 * @param {?string} opts.portfolioName
 * @param {object[]} opts.results   the per-change results from applyRebalance
 * @returns {object|null}
 */
export function _buildReceipt(userId, { portfolioId, portfolioName = null, results = [] }) {
    if (!userId || !Array.isArray(results)) return null

    // Manual legs already spoke for themselves. A queue write that FAILED is not "queued" — it is a
    // lost decision, and it belongs in the failed bucket, exactly as applyRebalance counts it.
    const mine     = results.filter(r => r && !r.manual)
    const applied  = mine.filter(r => r.ok && !r.deferred)
    const queued   = mine.filter(r => r.deferred && r.ok !== false)
    const failed   = mine.filter(r => !r.ok)
    if (!applied.length && !queued.length && !failed.length) return null

    const book  = portfolioName ? `"${portfolioName}"` : 'your portfolio'
    const parts = []
    if (applied.length) parts.push(`I ${_list(applied.map(r => _phrase(r)))}`)
    // Queued and failed did NOT happen, so both take the base form.
    if (queued.length)  parts.push(`${_list(queued.map(r => _phrase(r, false)))} — queued for the open`)
    if (failed.length) {
        // Name the asset and the reason. This is the half the toast is too small to carry, and the
        // half the user actually needs: a scale-in the venue refused looks identical to one that
        // never happened unless somebody says which.
        parts.push(`couldn't ${_list(failed.map(r => `${_phrase(r, false)}${_why(r)}`))}`)
    }

    return {
        userId,
        content: `Review applied on ${book} — ${parts.join('; ')}.`,
        type:    'portfolio_rebalanced',
        payload: {
            portfolioId,
            portfolioName,
            applied: applied.map(r => ({ action: r.action, itemId: r.itemId ?? null, asset: r.asset ?? null })),
            queued:  queued.map(r  => ({ action: r.action, itemId: r.itemId ?? null, asset: r.asset ?? null, queuedId: r.queuedId ?? null })),
            failed:  failed.map(r  => ({ action: r.action, itemId: r.itemId ?? null, asset: r.asset ?? null, reason: r.reason ?? r.error ?? 'failed' })),
        },
        botId: 'portfolio',
    }
}

/**
 * Post the receipt. Never throws (postCard swallows), and returns null when there was nothing to say.
 *
 * @param {string} userId
 * @param {{ portfolioId: string, portfolioName?: string|null, results?: object[] }} opts
 * @returns {Promise<object|null>}
 */
export async function notifyRebalanceApplied(userId, opts) {
    const card = _buildReceipt(userId, opts ?? {})
    if (!card) return null
    return postCard(card, { tag: 'Rebalance receipt', log: LOG })
}
