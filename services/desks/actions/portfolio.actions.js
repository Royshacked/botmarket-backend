// Atlas's commits, run against the SESSION (unified-chat plan phase 8, K2).
//
// The plan and the review proposal are read from Atlas's agentState — never from the client — and handed to the
// SAME service the portfolio routes use (api/portfolio/portfolioCommit.service.js). What each press means is
// Atlas's judgement and lives here; the route and the lock are shared (services/desks/act.js). The action contract
// is mentor.actions.js's; Atlas's own verbs are `accept` and `dismiss` (a proposal, a review).
//
// THE AVOID ASK. A book or an add in an industry Pythia rates AVOID is committed only with the user's yes. The ask
// is the client's (a confirm), the check is the server's: a press without the OK answers `avoid_needs_ok` with the
// names, the client asks, and presses again with `avoidOk` (the symbols the user said yes to) — or, on a proposal,
// with `dropAvoid` (apply the rest without them). One round trip, like `busy` → `force` on the edit route.

import { portfolioCommit as defaultCommit } from '../../../api/portfolio/portfolioCommit.service.js'
import { REBALANCE_REASONS, BOOK_REASONS } from '../../../api/portfolio/portfolioReasons.js'
import { parseCommitArgs, parseStringList } from '../../../api/_shared/parse.util.js'

const bookOf  = (state) => (state?.portfolioId ? String(state.portfolioId) : null)
const editing = (state) => (state?.editing?.kind === 'portfolio' ? String(state.editing.entityId) : null)
const bookName = (plan) => plan?.name ?? plan?.portfolioName ?? null
// The marked accounts in the shape every desk's press sends — the book's legs carry their ids.
const commitArgs = (args = {}) => {
    const { accounts, mainAccountId } = parseCommitArgs(args)
    return { accounts: accounts.map(a => String(a.id)), mainAccountId, avoidOk: parseStringList(args?.avoidOk) }
}

// A change's symbol, for the AVOID ask: an add names it on its spec; a refused add-to carries it from the refusal.
const changeAsset = (c) => c?.item?.asset ?? c?.avoid?.asset ?? null

/** A change with no OK on it anywhere — on the spec (an add) or on the change (an add-to). */
function withoutOk(c) {
    const { avoid_ok: _change, ...rest } = c ?? {}   // eslint-disable-line no-unused-vars -- dropped on purpose
    if (!rest.item || !('avoid_ok' in rest.item)) return rest
    const { avoid_ok: _spec, ...item } = rest.item   // eslint-disable-line no-unused-vars -- dropped on purpose
    return { ...rest, item }
}

/**
 * The AVOID changes on a proposal (`avoid` marked by the agent service, or by a refusal below) against the user's
 * OK. Every OK already on the proposal is dropped first — only the user's yes HERE sets one (phase 8a CR C2: an
 * add-to reads its OK off the change, and nothing used to clear a model-written one there).
 * → `{ ask }` (names still unanswered), or `{ update }` (OKs set, declined ones dropped; null when nothing is left).
 */
export function settleAvoid(update, { avoidOk = [], dropAvoid = false } = {}) {
    const yes = new Set(parseStringList(avoidOk).map(s => s.toUpperCase()))
    const changes = (update?.changes ?? []).map(withoutOk)
    const flagged = changes.filter(c => c.avoid)
    const open = flagged.filter(c => !yes.has(String(changeAsset(c) ?? '').toUpperCase()))
    if (open.length && !dropAvoid) {
        return { ask: open.map(c => ({ asset: changeAsset(c), industry: c.avoid.industry ?? null })) }
    }
    const next = changes
        .filter(c => !open.includes(c))
        .map(c => (!flagged.includes(c) ? c
            : c.action === 'add_item' ? { ...c, item: { ...c.item, avoid_ok: true } } : { ...c, avoid_ok: true }))
    return { update: next.length ? { ...update, changes: next } : null }
}

/** The changes a rebalance refused for an AVOID industry the proposal did not mark (a verdict that turned since). */
export function avoidRefused(update, failed) {
    const refused = (failed ?? []).filter(f => f?.reason === 'avoid_industry' && Array.isArray(f.avoid) && f.avoid.length)
    if (!refused.length) return null
    // A refused change is matched by its action and its holding (an add has no holding yet: its asset).
    const same = (f, c) => f.action === c.action && (f.itemId ? f.itemId === c.itemId : f.asset === c.item?.asset)
    const changes = (update?.changes ?? []).flatMap(c => {
        const f = refused.find(r => same(r, c))
        return f ? [{ ...c, avoid: { asset: f.avoid[0].asset ?? null, industry: f.avoid[0].industry ?? null } }] : []
    })
    return changes.length ? { ...update, changes } : null
}

/** What the client says about an applied proposal — the rebalance's counts, without the service's bookkeeping. */
const rebalanceView = (r) => ({
    applied: r.applied ?? 0, failed: r.failed ?? [], deferredItems: r.deferredItems ?? [], nextOpenMs: r.nextOpenMs ?? null,
    nextReviewAt: r.nextReviewAt ?? null, manualExitPosted: !!r.manualExitPosted, manualEntryPosted: !!r.manualEntryPosted,
})

export function makePortfolioActions({ commit = defaultCommit } = {}) {
    // The review conversation moves onto the book once it is resolved — only when the desk is editing that book.
    const sealBook = (portfolioId, name = null) => ({ kind: 'portfolio', entityIds: [portfolioId], name, onlyIfEditing: true })

    return {
        /** Save Atlas's plan as a new book. */
        async generate({ user, state, args }) {
            const plan = state?.pendingPlan
            if (!plan?.ideas?.length) return { reason: 'nothing_to_commit' }
            if (bookOf(state)) return { reason: 'not_new' }
            const { accounts, mainAccountId, avoidOk } = commitArgs(args)
            const out = await commit.createBook(plan, user._id, { accounts, mainAccountId, avoidOk })
            if (!out.ok) return { reason: out.reason, ...(out.avoid ? { extra: { avoid: out.avoid } } : {}) }
            // Every leg refused: nothing was created, and the plan on the table is the only copy of the work.
            if (!out.ideas.length) return { reason: 'nothing_saved', extra: { failed: out.failed } }

            // The book's document: the mandate the user established with Atlas and the construction thesis. The
            // conversation itself is sealed onto the book (agent_contexts).
            await commit.recordConstruction(out.portfolioId, user._id, { mandate: state.mandate ?? null, thesis: state.thesis ?? null })
            const name = bookName(plan)
            return {
                result: { portfolio: { portfolioId: out.portfolioId, ideas: out.ideas }, failed: out.failed },
                seal:   { kind: 'portfolio', entityIds: [out.portfolioId], name: name ? `the ${name} book` : null },
                after:  null,
            }
        },

        /** Save an edit of an existing book: a re-plan replaces its legs in place; no re-plan pushes the accounts. */
        async update({ user, state, args }) {
            const portfolioId = bookOf(state)
            if (!portfolioId) return { reason: 'nothing_to_commit' }
            const { accounts, mainAccountId, avoidOk } = commitArgs(args)
            const plan = state.pendingPlan?.ideas?.length ? state.pendingPlan : null
            let result
            if (plan) {
                const out = await commit.replacePlan(portfolioId, plan, user._id, { accounts, mainAccountId, avoidOk })
                if (!out.ok) {
                    const extra = out.avoid ? { avoid: out.avoid } : out.live ? { live: out.live } : null
                    return { reason: out.reason, ...(extra ? { extra } : {}) }
                }
                result = { portfolio: { portfolioId, ideas: out.ideas }, left: out.left }
            } else {
                const out = await commit.rebindAccounts(portfolioId, user._id, { accounts, mainAccountId })
                result = { portfolio: { portfolioId }, rebound: out.updated }
            }
            // An edit opened from a review closes it (the clock advances; the card says dismissed, as the panel did).
            if (state.reviewMode === true) await commit.closeReview(portfolioId, user._id)
            return { result, seal: sealBook(portfolioId), after: null }
        },

        /**
         * Accept Atlas's proposal: the changes applied (routed by mode/position in the rebalance service). In a
         * review with no proposal, Accept is accepting the HOLD — the review closes as `reviewed`.
         */
        async accept({ user, state, args }) {
            const portfolioId = bookOf(state)
            if (!portfolioId) return { reason: 'nothing_to_commit' }
            const inReview = state.reviewMode === true
            if (!state.reviewUpdate?.changes?.length) {
                if (!inReview) return { reason: 'nothing_to_commit' }
                const out = await commit.closeReview(portfolioId, user._id, { outcome: 'reviewed' })
                return { result: { portfolio: { portfolioId }, held: true, nextReviewAt: out.nextReviewAt }, seal: sealBook(portfolioId), after: null }
            }

            const settled = settleAvoid(state.reviewUpdate, { avoidOk: args?.avoidOk, dropAvoid: args?.dropAvoid === true })
            if (settled.ask) return { reason: 'avoid_needs_ok', extra: { avoid: settled.ask } }
            if (!settled.update) return { reason: 'nothing_to_commit' }

            // Only a review's Accept closes the review; an edit's changes leave a due review due.
            const out = await commit.acceptRebalance(portfolioId, user._id, settled.update, { closeReview: inReview })
            // What was refused only for an AVOID industry stays on the table, marked, so the next Accept asks about it.
            // Read off `results`: they carry the refusal's `avoid`, which the success shape's `failed` summary drops.
            const retry = avoidRefused(settled.update, (out.results ?? []).filter(r => r && r.ok === false))
            if (!out.ok) {
                return {
                    reason: out.reason, extra: { failed: out.failed ?? null },
                    ...(retry ? { after: { ...state, reviewUpdate: retry } } : {}),
                }
            }
            const result = { portfolio: { portfolioId }, rebalance: rebalanceView(out) }
            // A remaining AVOID change is still work on the book: the conversation is sealed once it is resolved. The
            // review itself is closed — a second Accept must not close it again (phase 8a CR C5).
            if (retry) return { result, after: { ...state, reviewUpdate: retry, reviewMode: false } }
            return { result, seal: sealBook(portfolioId), after: null }
        },

        /** Skip this review: the clock advances, the card says dismissed, the proposal is dropped. */
        async dismiss({ user, state }) {
            const portfolioId = bookOf(state)
            if (!portfolioId || state.reviewMode !== true) return { reason: 'nothing_to_commit' }
            const out = await commit.closeReview(portfolioId, user._id, { outcome: 'dismissed' })
            return { result: { portfolio: { portfolioId }, nextReviewAt: out.nextReviewAt }, seal: sealBook(portfolioId), after: null }
        },

        /** Leave the book without saving — in a review, the clock does NOT advance (the review stays due). */
        async later({ state }) {
            if (!editing(state)) return { reason: 'nothing_to_commit' }
            return { result: {}, after: null }
        },
    }
}

export const portfolioActions = makePortfolioActions()

// Atlas's refusals, in its own words — the portfolio routes' tables.
export const PORTFOLIO_REASONS = { ...REBALANCE_REASONS, ...BOOK_REASONS }
