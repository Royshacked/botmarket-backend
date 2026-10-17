// What saving a book DOES — one service for the HTTP routes and Atlas's session actions (unified-chat plan phase
// 8, K2), so the button in the drawer and the route behind the old panel can never commit two different ways.
//
//   createBook       a new book from Atlas's plan (POST /trade-ideas/batch) — the AVOID ask, then the batch
//   replacePlan      a re-plan of an existing book, in place (was MainPage.handleUpdatePlan) — save first, then
//                    retire the old legs, refused while a leg is live
//   rebindAccounts   no re-plan, but the accounts changed (was planAccountRebind on the client)
//   closeReview      the review clock advances and the card resolves (POST /portfolio/:id/complete-review)
//   acceptRebalance  a review's changes applied and the card resolves (POST /portfolio/:id/rebalance)
//
// Refusals answer `{ ok:false, reason }` on the shared vocabulary; the callers judge what to say.

import { ideaService as defaultIdeas } from '../trade-ideas/tradeIdeas.service.js'
import { avoidNames, avoidOkCovers } from '../../services/industryLimits.service.js'
import { listPortfolioItems, invalidatePortfolioState } from '../../services/portfolioState.service.js'
import { portfolioChatService } from './portfolioChat.service.js'
import { applyRebalance, snapshotConvictions } from './portfolioRebalance.service.js'
import { resolvePortfolioReviewCard } from '../chat/chat.service.js'

// A leg with a broker position cannot be deleted, so a book holding one cannot be re-planned in place.
const LIVE = ['long', 'short']
// An order has been placed (pending confirm or in position): the accounts it routes by are no longer the plan's.
const POST_ORDER = ['hit', 'long', 'short']

// What a rebalance refusal means — the route's and Atlas's session action's.
export const REBALANCE_REASONS = {
    missing_portfolioId: [400, 'Missing portfolioId'],
    no_changes:          [400, 'No changes to apply'],
    // 409, not 400: the request is well formed and the book is real — every individual change was
    // refused by the state of what it named. Changing that state (or re-running the review against
    // the book as it now stands) makes the same request valid.
    nothing_applied:     [409, 'None of the proposed changes could be applied'],
}

const _ids = (list) => (Array.isArray(list) ? list.filter(a => typeof a === 'string' && a) : [])

export function makePortfolioCommit({
    ideas = defaultIdeas, avoid = avoidNames, items = listPortfolioItems, chat = portfolioChatService,
    rebalance = applyRebalance, snapshot = snapshotConvictions, resolveCard = resolvePortfolioReviewCard,
    invalidate = invalidatePortfolioState,
} = {}) {

    /**
     * A book holding a name in an industry Pythia rates AVOID is saved only with the user's explicit OK (step 7,
     * Roy 2026-10-11) — checked from the symbols, never from the plan's own `limits`, which the client carries.
     * @returns {Promise<{ ok:false, reason:'avoid_needs_ok', avoid:object[] } | { ok:true, ideas:object[], failed:object[], portfolioId:string }>}
     */
    async function createBook(plan, userId, { accounts = [], mainAccountId = null, portfolioId = null, avoidOk = [] } = {}) {
        if (!plan?.ideas?.length) return { ok: false, reason: 'no_ideas' }
        const names = await avoid(plan.ideas.map(i => i.asset))
        // The OK names the symbols the user said yes to — a name turned AVOID after they were asked is not covered.
        if (names.length && !avoidOkCovers(names, avoidOk)) return { ok: false, reason: 'avoid_needs_ok', avoid: names }
        // Construction stays LENIENT about a failed leg (`failed`): the book is a proposal the user is about to
        // review, where a missing line is visible and fixable. Adoption reads the same field and refuses.
        const out = await ideas.saveBatchIdeas(plan, userId, { accounts: _ids(accounts), mainAccountId, portfolioId })
        if (!out.ok) return { ok: false, reason: 'save_failed' }
        return { ok: true, ideas: out.ideas, failed: out.failed ?? [], portfolioId: out.portfolioId }
    }

    /**
     * Replace a book's plan in place, keeping its portfolioId. SAVE FIRST, then delete the old legs (code review
     * 2026-10-11): a save the server refuses used to land after the delete and leave the book empty. Every
     * delete is settled and the leftovers SAID — one failed delete used to leave old and new together, silently.
     * @returns {Promise<{ ok:false, reason:string, live?:number, avoid?:object[] } | { ok:true, ideas:object[], left:object[] }>}
     */
    async function replacePlan(portfolioId, plan, userId, opts = {}) {
        const existing = await items(portfolioId, userId)
        const live = existing.filter(i => LIVE.includes(i.status))
        if (live.length) return { ok: false, reason: 'book_live', live: live.length }
        const saved = await createBook(plan, userId, { ...opts, portfolioId })
        if (!saved.ok) return saved
        // Each delete settles to "gone or not" — a throw and a refusal are the same leftover.
        const gone = await Promise.all(existing.map(i => ideas.deleteIdea(i.id, userId).then(r => r?.ok !== false, () => false)))
        const left = existing.filter((_, k) => !gone[k])
        return { ok: true, ideas: saved.ideas, left: left.map(i => ({ id: i.id, asset: i.asset ?? null })) }
    }

    /**
     * No re-plan, but the account selection may have changed while editing: push it onto the legs that can still
     * take it. A leg with an order placed keeps the accounts it routes by — writing over a live holding's broker
     * id is how an exit lands nowhere. Nothing marked → nothing pushed (an empty selection never wipes a book).
     */
    async function rebindAccounts(portfolioId, userId, { accounts = [], mainAccountId = null } = {}) {
        const ids = _ids(accounts)
        if (!ids.length) return { ok: true, updated: 0 }
        const targets = (await items(portfolioId, userId)).filter(i => !POST_ORDER.includes(i.status))
        const main = ids.includes(mainAccountId) ? mainAccountId : null
        for (const i of targets) await ideas.updateIdea(i.id, { accounts: ids, mainAccountId: main }, userId)
        return { ok: true, updated: targets.length }
    }

    /**
     * The review is done without changes: a conviction point is recorded, the (cadence-aware) clock advances, and
     * the Atlas card flips — `reviewed` (the user accepted a hold) or `dismissed` (skipped).
     */
    async function closeReview(portfolioId, userId, { outcome = 'dismissed', reviewCadence = null } = {}) {
        if (reviewCadence) await chat.setPortfolioLifecycle(portfolioId, userId, { reviewCadence })
        await snapshot(portfolioId, userId)
        const result = await chat.completeReview(portfolioId, userId)
        const nextReviewAt = result?.nextReviewAt ?? null
        await resolveCard(userId, portfolioId, { nextReviewAt, outcome: outcome === 'reviewed' ? 'reviewed' : 'dismissed' })
        // Review done — drop the snapshot so the next review computes fresh.
        invalidate(portfolioId, userId)
        return { ok: true, nextReviewAt }
    }

    /** A review's changes applied (routed by mode/position in the rebalance service); the card says "Updated". */
    async function acceptRebalance(portfolioId, userId, update) {
        const result = await rebalance(portfolioId, userId, update)
        if (!result.ok) return result
        await resolveCard(userId, portfolioId, { nextReviewAt: result.nextReviewAt ?? null, outcome: 'updated' })
        return result
    }

    return { createBook, replacePlan, rebindAccounts, closeReview, acceptRebalance }
}

export const portfolioCommit = makePortfolioCommit()
