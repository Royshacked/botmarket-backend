import { portfolioDesk }         from '../../services/desks/portfolio.desk.js'
import { portfolioChatService }  from './portfolioChat.service.js'
import { applyRebalance, snapshotConvictions } from './portfolioRebalance.service.js'
import { invalidatePortfolioState, listPortfolioItems, listPortfolios } from '../../services/portfolioState.service.js'
import { logger }                from '../../services/logger.service.js'
import { makeDeskStream }    from '../_shared/deskStream.util.js'
import { makeGetChatState, makeDeleteChatState } from '../_shared/chatState.util.js'
import { threadService }          from '../../services/thread.service.js'
import { resolvePortfolioReviewCard } from '../chat/chat.service.js'
import { adoptBookService }  from './adoptBook.service.js'
import { sendReason }        from '../_shared/reason.util.js'
import { makeHandle }        from '../_shared/handle.util.js'
import { httpError }         from '../../services/httpError.util.js'

const LOG    = '[portfolio:controller]'
const handle = makeHandle(LOG)

// ─── Adopting a book the app didn't build (docs/design/adopted-book.md) ────────
//
// Refusals ride the SHARED reason vocabulary, so an adoption refusal answers with the same status
// codes as the manual confirmations and the entity CRUD. Only the reasons unique to adoption are
// named here.
const _adoptErr = {
    no_holdings:         [400, 'No holdings to adopt'],
    // Not the client's fault and not a server error: the numbers the user gave don't add up, and the
    // grid needs the per-row problems back to say which ones.
    unreconciled:        [409, 'The book does not reconcile — see problems'],
    already_committed:   [409, 'This book has already been adopted'],
    account_failed:      [500, 'Could not open the account'],
    // Another commit of the same draft is mid-flight (a double-clicked button).
    in_progress:         [409, 'This book is already being adopted'],
    // A genuinely partial write: some holdings landed, some didn't. The draft stays open, so the
    // honest answer is "retry", not "failed".
    partial_write:       [409, 'Some holdings could not be written — retry to finish'],
    not_adopted:         [400, 'Not an adopted holding'],
    nothing_to_correct:  [400, 'Nothing to correct'],
    no_position:         [409, 'No position linked to this holding'],
    not_in_position:     [409, 'Holding is not in a position'],
}

// Applying an accepted review. Only the reasons the rebalance itself raises — the per-change
// refusals (not_found, forbidden, no_position, trim_too_small…) are already the shared vocabulary
// and ride back in `failed` so the client can name the ones that fell over.
const _rebalanceErr = {
    missing_portfolioId: [400, 'Missing portfolioId'],
    no_changes:          [400, 'No changes to apply'],
    // 409, not 400: the request is well formed and the book is real — every individual change was
    // refused by the state of what it named. Changing that state (or re-running the review against
    // the book as it now stands) makes the same request valid.
    nothing_applied:     [409, 'None of the proposed changes could be applied'],
}

/**
 * Every adoption handler has the same three moves: read the request, call the one service function,
 * and answer — `ok` shaped by the handler, a refusal on the SHARED reason vocabulary otherwise.
 *
 * Deliberately NOT `makeHandle`. That wrapper forwards a thrown error's message to the global
 * handler, and these seven keep their own fixed sentence ("Failed to adopt the book") — which is the
 * §9 decision about what an error may tell the client, made once, for every route, rather than
 * inherited here by accident.
 *
 * @param {string} name     for the log line
 * @param {string} failMsg  what an UNEXPECTED throw tells the user
 * @param {Function} call   (req) => Promise<result>   — the service call
 * @param {Function} onOk   (result) => body           — the success shape
 * @param {string|null} requireParam  a path param answered 400 before the service is called
 */
function makeAdoptHandler(name, call, onOk, requireParam = null) {
    return handle(name, async (req, res) => {
        if (requireParam && !req.params[requireParam]) throw httpError(400, `Missing ${requireParam}`)
        const result = await call(req)
        if (result.ok) return res.send(onOk(result))
        return sendReason(res, result.reason, {
            overrides:       _adoptErr,
            fallback:        500,
            fallbackMessage: 'Adoption failed',
            // The per-row problems / per-leg failures travel WITH the refusal: the confirm grid
            // has to show the user which line to fix, and a bare 409 can't.
            extra: {
                ...(result.problems ? { problems: result.problems } : {}),
                ...(result.failed   ? { failed:   result.failed }   : {}),
            },
        })
    })
}

export const refreshAdoptionDraft = makeAdoptHandler(
    'refreshAdoptionDraft',
    (req) => {
        const { paste, statedTotal, freeCash, currency, mandate } = req.body ?? {}
        return adoptBookService.refreshDraft({ draftId: req.params.draftId, userId: req.user._id, paste, statedTotal, freeCash, currency, mandate })
    },
    r => ({ draft: r.draft }),
    'draftId',
)

export const createAdoptionDraft = makeAdoptHandler(
    'createAdoptionDraft',
    // `paste` is the raw text; `holdings` is the grid handing back edited cells. Either or both.
    (req) => {
        const { bank, currency, statedTotal, freeCash, holdings, paste, mandate, name } = req.body ?? {}
        return adoptBookService.createDraft({ userId: req.user._id, bank, currency, statedTotal, freeCash, holdings, paste, mandate, name })
    },
    r => ({ draft: r.draft }),
)

export const commitAdoptionDraft = makeAdoptHandler(
    'commitAdoptionDraft',
    (req) => adoptBookService.commitDraft({ draftId: req.params.draftId, userId: req.user._id }),
    r => ({ portfolioId: r.portfolioId, accountId: r.accountId, legs: r.legs }),
    'draftId',
)

export const listAdoptionDrafts = makeAdoptHandler(
    'listAdoptionDrafts',
    (req) => adoptBookService.listDrafts({ userId: req.user._id }),
    r => ({ drafts: r.drafts }),
)

export const discardAdoptionDraft = makeAdoptHandler(
    'discardAdoptionDraft',
    (req) => adoptBookService.discardDraft({ draftId: req.params.draftId, userId: req.user._id }),
    () => ({ ok: true }),
    'draftId',
)

export const correctAdoptedHolding = makeAdoptHandler(
    'correctAdoptedHolding',
    (req) => {
        const { quantity, avgCost } = req.body ?? {}
        return adoptBookService.correctHolding({ id: req.params.id, userId: req.user._id, quantity, avgCost })
    },
    r => ({ quantity: r.quantity, avgCost: r.avgCost }),
)

export const removeAdoptedHolding = makeAdoptHandler(
    'removeAdoptedHolding',
    (req) => adoptBookService.removeHolding({ id: req.params.id, userId: req.user._id }),
    r => ({ asset: r.asset }),
)

// The desk itself is services/desks/portfolio.desk.js, shared with the session turn (unified-chat plan phase 4).
export const streamPortfolio = makeDeskStream(portfolioDesk)

export const savePortfolioChatState = handle('savePortfolioChatState', async (req, res) => {
    const { portfolioId, messages, mandate, thesis, threadId, portfolioName } = req.body ?? {}
    if (!portfolioId || !Array.isArray(messages)) throw httpError(400, 'Missing portfolioId or messages')
    const result = await portfolioChatService.saveChatState(portfolioId, messages, req.user._id, mandate ?? null)
    if (!result.ok) return res.status(500).json({ error: 'Failed to save chat state' })
    // Persist the portfolio thesis captured during construction (portfolioId now exists).
    if (thesis && typeof thesis === 'object') {
        await portfolioChatService.setThesis(portfolioId, req.user._id, thesis, 'construction').catch(() => {})
    }
    // Link the construction draft thread to the now-created portfolio: stamps subjectId,
    // promotes it to 'linked' and clears its TTL so the conversation lives with the book.
    if (threadId) {
        threadService.linkToArtifact({
            threadId, userId: req.user._id,
            subjectType: 'portfolio', subjectId: portfolioId, artifactName: portfolioName ?? null,
        }).catch(err => logger.warn(LOG, 'linkToArtifact failed', err))
    }
    res.json({ ok: true })
})

export const getPortfolioChatState = makeGetChatState({
    service: portfolioChatService,
    keyArgs: (req) => [req.params.portfolioId, req.user._id],
    log: LOG,
})

export const deletePortfolioChatState = makeDeleteChatState({
    service: portfolioChatService,
    keyArgs: (req) => [req.params.portfolioId, req.user._id],
    requireKey: (req) => req.params.portfolioId ? null : 'Missing portfolioId',
    log: LOG,
})

export const getPendingReviews = handle('getPendingReviews', async (req, res) => {
    res.json({ reviews: await portfolioChatService.getPendingReviews(req.user._id) })
})

export const completeReview = handle('completeReview', async (req, res) => {
    const { portfolioId } = req.params
    if (!portfolioId) throw httpError(400, 'Missing portfolioId')

    // Optional cadence change carried on the body (e.g. user switched weekly→monthly).
    const bodyCadence = req.body?.reviewCadence
    if (bodyCadence) {
        await portfolioChatService.setPortfolioLifecycle(portfolioId, req.user._id, { reviewCadence: bodyCadence })
    }

    // Record a conviction-trajectory point, then advance the (cadence-aware) clock.
    await snapshotConvictions(portfolioId, req.user._id)
    const result = await portfolioChatService.completeReview(portfolioId, req.user._id)

    // Flip the Atlas notification card to a resolved state: 'reviewed' (user accepted a
    // hold with no changes) or 'dismissed' (skipped). Defaults to dismissed.
    const outcome = req.body?.outcome === 'reviewed' ? 'reviewed' : 'dismissed'
    await resolvePortfolioReviewCard(req.user._id, portfolioId, {
        nextReviewAt: result?.nextReviewAt ?? null,
        outcome,
    })

    // Review done — drop the snapshot so the next review computes fresh.
    invalidatePortfolioState(portfolioId, req.user._id)

    res.json({ ok: true, nextReviewAt: result?.nextReviewAt ?? null })
})

// The user's books — id, name, holdings count, per-status tallies, symbols, venue modes. The
// portfolio's `GET /`, completing the pair every other kind has had; the derivation already
// existed for the watchlist and is simply reachable now instead of being re-derived client-side
// from the ideas list.
export const getPortfolios = handle('getPortfolios', async (req, res) => {
    res.json({ portfolios: await listPortfolios(req.user._id) })
})

// GET a book's holdings. The portfolio's answer to the `GET /:id` every other kind already has —
// a book is not a document, so its "read one" is the rows carrying its id, owner-scoped in the
// service exactly as makeEntityController's get is.
//
// This exists because opening a book for review used to be seeded from whatever the client's idea
// list happened to hold. When that list was empty (a card click landing before it loaded), Atlas
// was handed a book with no item ids, invented them, and every accepted change came back
// not_found. A desk reads its subject from the database, like every other desk does.
export const getPortfolioItems = handle('getPortfolioItems', async (req, res) => {
    const { portfolioId } = req.params
    if (!portfolioId) throw httpError(400, 'Missing portfolioId')
    const items = await listPortfolioItems(portfolioId, req.user._id)
    // An empty book is not an error — an adopted draft or a deleted book both read as zero rows,
    // and the caller decides what that means. What must never happen is answering 200 with rows
    // the caller can't tell apart from "we didn't look".
    res.json({ items })
})

// Apply an accepted portfolio_update — the confirmed review proposal — to the live book.
export const applyPortfolioRebalance = handle('applyPortfolioRebalance', async (req, res) => {
    const { portfolioId } = req.params
    const { update }      = req.body ?? {}
    if (!portfolioId) throw httpError(400, 'Missing portfolioId')
    if (!update || !Array.isArray(update.changes)) throw httpError(400, 'Missing update.changes')
    const result = await applyRebalance(portfolioId, req.user._id, update)
    // Answer with the reason, on the shared vocabulary, like every other refusal in the app.
    // This used to be a bare 400 carrying the result object, so a book whose ids didn't resolve,
    // one whose holdings were already closed, and one the user doesn't own were the same red
    // banner — and diagnosing which took reading the server log. `results`/`failed` ride along
    // in `extra` so the client can still say WHICH changes fell over.
    if (!result.ok) {
        return sendReason(res, result.reason, {
            overrides: _rebalanceErr,
            fallbackMessage: 'Could not apply the changes',
            extra: { results: result.results ?? null, failed: result.failed ?? null },
        })
    }

    // Flip the Atlas notification card to "Updated · next review <date>".
    await resolvePortfolioReviewCard(req.user._id, portfolioId, {
        nextReviewAt: result.nextReviewAt ?? null,
        outcome: 'updated',
    })
    res.json(result)
})
