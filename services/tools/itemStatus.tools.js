/**
 * `get_item_status` — the MONITORS' view of ONE of the user's items (docs/design/axl-one-voice.md §6, Roy 2026-11-21: "user
 * might ask about his trades or book or awaiting setups — the monitoring agents should be able to give Axl info").
 *
 *   setup  the trade monitor's (Talos) latest reads from the `journal` (what it looked at, its verdict, its own sentence,
 *          what it is waiting for, the next check), the setup's live order state, the fill.
 *   book   the portfolio monitor's state (last checked, what it flagged), the review cadence and when the next is due, a
 *          review waiting on the user, and what the last conversation on the book concluded (its sealed context summary).
 *
 * Read-only, no model call — "check my trade" is answered from the LAST read (Roy, 2026-11-21), at most a candle old.
 * Owner-checked through each item's own service.
 */

import { makeToolHandler } from '../agentUtils.js'
import { setupService } from '../../api/setups/setups.service.js'
import { portfolioChatService } from '../../api/portfolio/portfolioChat.service.js'
import { journalService } from '../journal.service.js'
import { agentContextService } from '../agentContext.service.js'

const LOG = '[itemStatusTool]'
const READS = 5

export const ITEM_STATUS_TOOL_SPEC = {
    get_item_status: `The MONITORS' view of ONE of the user's items, by the id get_watched_items prints ([setup:…] or [book:…]). A setup: the trade monitor's latest reads — what it looked at, its verdict, its own words, what it is WAITING FOR, the next check — and the live order state (awaiting the user's confirm, awaiting the market, filled). A book: what the portfolio monitor last checked and flagged, the review schedule, a review waiting on the user, and what the last review concluded. For "how is my NVDA trade doing?", "why hasn't it entered?", "is my book OK?", "what's waiting for me?". It is the LAST read, not a fresh one — say when it was. Say it as the monitor's, with the time.`,
}

const t = (x) => (x ? new Date(typeof x === 'number' ? x : Date.parse(x)).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : null)
const n = (x) => (Number.isFinite(Number(x)) && x !== null ? String(Number(x)) : null)
const cut = (s, max) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, max) : null)

const ORDER_STATES = {
    awaiting_confirm: 'an entry is waiting for the USER to confirm it',
    awaiting_market: 'an entry is waiting for the market to open',
    awaiting_manual_fill: 'an entry is waiting for the user to place it at their bank and confirm the fill',
}

/** One journal row in words. Pure — exported for testing. */
export function readLine(r) {
    const conds = Array.isArray(r.conditions) && r.conditions.length
        ? ` · checked: ${r.conditions.slice(0, 4).map(c => `${c.met ? '✓' : '✗'} ${cut(c.note ?? c.id, 80)}`).join('; ')}` : ''
    return `  ${t(r.at) ?? '?'} ${r.reason ?? 'read'}${r.rung ? ` (${r.rung})` : ''}${n(r.price) ? ` at ${n(r.price)}` : ''}${r.verdict ? ` — ${r.verdict}` : ''}: ${cut(r.note, 300) ?? ''}${conds}`
        + `${r.warning ? `\n    warning: ${cut(r.warning, 200)}` : ''}${r.armed ? `\n    waiting for: ${cut(typeof r.armed === 'string' ? r.armed : JSON.stringify(r.armed), 200)}` : ''}`
        + `${r.proposal ? `\n    proposed: ${cut(typeof r.proposal === 'string' ? r.proposal : r.proposal.why ?? JSON.stringify(r.proposal), 200)}` : ''}`
}

/** A setup and its monitor's reads → text. Pure — exported for testing. */
export function formatSetupStatus(s, rows = []) {
    const fill = s.position_state?.entry?.fill_price
    return [
        `THE TRADE MONITOR ON ${s.asset ?? '?'} ${s.direction ?? ''} [setup:${s.id}] — status ${s.status ?? '?'}${s.mode ? ` · ${s.mode}` : ''}`,
        s.orderState && ORDER_STATES[s.orderState] ? `  order: ${ORDER_STATES[s.orderState]}` : null,
        n(fill) ? `  filled at ${n(fill)}${s.position_state?.entry?.fill_provisional ? ' (provisional)' : ''}` : null,
        (s.monitor_state?.next_check_at ?? s.next_check_at) ? `  next check: ${t(s.monitor_state?.next_check_at ?? s.next_check_at)}` : null,
        rows.length ? `  its latest reads, newest first:\n${rows.map(readLine).join('\n')}` : '  no read yet — the monitor has not looked at it (a setup not live yet writes one line before it sleeps).',
        '',
        'The LAST read, not a fresh one — say it as the monitor\'s, with its time.',
    ].filter(l => l !== null).join('\n')
}

/** A book, its monitor's state and the last conversation on it → text. Pure — exported for testing. */
export function formatBookStatus(b, context = null) {
    const th = b.themis ?? {}
    const due = Number.isFinite(b.nextReviewAt) && b.nextReviewAt <= Date.now()
    return [
        `THE PORTFOLIO MONITOR ON "${b.portfolioName ?? b.portfolioId}" [book:${b.portfolioId}]`,
        `  reviews: ${b.reviewCadence ?? 'monthly'}${b.lastReviewAt ? ` · last ${t(b.lastReviewAt)}` : ' · never reviewed'}${b.nextReviewAt ? ` · next ${t(b.nextReviewAt)}${due ? ' (DUE)' : ''}` : ''}`,
        b.notifiedAt ? `  a review is WAITING on the user (asked ${t(b.notifiedAt)})` : null,
        th.last_checked ? `  monitor last checked ${t(th.last_checked)}${th.last_event_sig ? ` · it flagged: ${cut(th.last_event_sig, 200)}` : ' · nothing flagged'}` : '  the monitor has not checked it yet',
        context?.summary ? `  what the last conversation on it concluded: ${cut(context.summary, 600)}` : null,
        '',
        'Say it as the portfolio monitor\'s, with the time.',
    ].filter(l => l !== null).join('\n')
}

const _deps = {
    setup: (id, userId) => setupService.getSetup(id, userId),
    reads: (id) => journalService.list(id, { limit: READS }),
    book: (id, userId) => portfolioChatService.getChatState(id, userId),
    context: (args) => agentContextService.load(args),
}

/** @returns {{ get_item_status: Function }} */
export function makeItemStatusHandlers(userId = null, deps = _deps) {
    return {
        get_item_status: makeToolHandler('get_item_status', async ({ kind, id } = {}) => {
            const k = String(kind ?? '').toLowerCase()
            const ref = String(id ?? '').trim()
            if (!ref) return 'id is required — the item id get_watched_items prints'
            if (k === 'setup') {
                const got = await deps.setup(ref, userId)
                if (!got?.ok) return 'No such setup of yours — call get_watched_items for the ids.'
                const rows = await deps.reads(got.doc.id ?? ref).catch(() => [])
                return formatSetupStatus(got.doc, Array.isArray(rows) ? rows : (rows?.rows ?? []))
            }
            if (k === 'book' || k === 'portfolio') {
                const b = await deps.book(ref, userId)
                if (!b) return 'No such book of yours — call get_watched_items for the ids.'
                const ctx = await deps.context({ userId: String(userId), kind: 'portfolio', entityId: ref, agent: 'portfolio' }).catch(() => null)
                return formatBookStatus({ ...b, portfolioId: b.portfolioId ?? ref }, ctx)
            }
            return 'kind must be "setup" or "book"'
        }, (err) => `Could not read the monitor's view: ${err.message}`, LOG),
    }
}
