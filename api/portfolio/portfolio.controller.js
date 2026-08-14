import { portfolioAgentService } from '../../services/agents/portfolio.agent.service.js'
import { portfolioChatService }  from './portfolioChat.service.js'
import { applyRebalance, snapshotConvictions } from './portfolioRebalance.service.js'
import { invalidatePortfolioState, listPortfolioItems, listPortfolios } from '../../services/portfolioState.service.js'
import { refreshCoverage }        from '../../services/coverageRefresh.service.js'
import { logger }                from '../../services/logger.service.js'
import { streamAgentResponse }   from '../_shared/sse.util.js'
import { parseIdeaAccounts, parseChatMessages } from '../_shared/parse.util.js'
import { makeGetChatState, makeDeleteChatState } from '../_shared/chatState.util.js'
import { threadService }          from '../../services/thread.service.js'
import { resolvePortfolioReviewCard } from '../chat/chat.service.js'
import { getExperienceLevel } from '../../services/experience.service.js'
import { adoptBookService }  from './adoptBook.service.js'
import { sendReason }        from '../_shared/reason.util.js'

const LOG = '[portfolio:controller]'

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

function _sendAdopt(res, result, onOk) {
    if (result.ok) return res.send(onOk(result))
    return sendReason(res, result.reason, {
        overrides:       _adoptErr,
        fallback:        500,
        fallbackMessage: 'Adoption failed',
        // The per-row problems / per-leg failures travel WITH the refusal: the confirm grid has to
        // show the user which line to fix, and a bare 409 can't.
        extra: {
            ...(result.problems ? { problems: result.problems } : {}),
            ...(result.failed   ? { failed:   result.failed }   : {}),
        },
    })
}

export async function refreshAdoptionDraft(req, res) {
    try {
        const { draftId } = req.params
        if (!draftId) return res.status(400).send({ error: 'Missing draftId' })
        const { paste, statedTotal, freeCash, currency, mandate } = req.body ?? {}
        const result = await adoptBookService.refreshDraft({
            draftId, userId: req.user._id, paste, statedTotal, freeCash, currency, mandate,
        })
        _sendAdopt(res, result, r => ({ draft: r.draft }))
    } catch (err) {
        logger.error(LOG, 'refreshAdoptionDraft failed', err)
        res.status(500).send({ error: 'Failed to update the staged book' })
    }
}

export async function createAdoptionDraft(req, res) {
    try {
        // `paste` is the raw text; `holdings` is the grid handing back edited cells. Either or both.
        const { bank, currency, statedTotal, freeCash, holdings, paste, mandate, name } = req.body ?? {}
        const result = await adoptBookService.createDraft({
            userId: req.user._id, bank, currency, statedTotal, freeCash, holdings, paste, mandate, name,
        })
        _sendAdopt(res, result, r => ({ draft: r.draft }))
    } catch (err) {
        logger.error(LOG, 'createAdoptionDraft failed', err)
        res.status(500).send({ error: 'Failed to stage the adoption' })
    }
}

export async function commitAdoptionDraft(req, res) {
    try {
        const { draftId } = req.params
        if (!draftId) return res.status(400).send({ error: 'Missing draftId' })
        const result = await adoptBookService.commitDraft({ draftId, userId: req.user._id })
        _sendAdopt(res, result, r => ({ portfolioId: r.portfolioId, accountId: r.accountId, legs: r.legs }))
    } catch (err) {
        logger.error(LOG, 'commitAdoptionDraft failed', err)
        res.status(500).send({ error: 'Failed to adopt the book' })
    }
}

export async function listAdoptionDrafts(req, res) {
    try {
        const result = await adoptBookService.listDrafts({ userId: req.user._id })
        _sendAdopt(res, result, r => ({ drafts: r.drafts }))
    } catch (err) {
        logger.error(LOG, 'listAdoptionDrafts failed', err)
        res.status(500).send({ error: 'Failed to list staged books' })
    }
}

export async function discardAdoptionDraft(req, res) {
    try {
        const { draftId } = req.params
        if (!draftId) return res.status(400).send({ error: 'Missing draftId' })
        const result = await adoptBookService.discardDraft({ draftId, userId: req.user._id })
        _sendAdopt(res, result, () => ({ ok: true }))
    } catch (err) {
        logger.error(LOG, 'discardAdoptionDraft failed', err)
        res.status(500).send({ error: 'Failed to discard the staged book' })
    }
}

export async function correctAdoptedHolding(req, res) {
    try {
        const { id } = req.params
        const { quantity, avgCost } = req.body ?? {}
        const result = await adoptBookService.correctHolding({ id, userId: req.user._id, quantity, avgCost })
        _sendAdopt(res, result, r => ({ quantity: r.quantity, avgCost: r.avgCost }))
    } catch (err) {
        logger.error(LOG, 'correctAdoptedHolding failed', err)
        res.status(500).send({ error: 'Failed to correct the holding' })
    }
}

export async function removeAdoptedHolding(req, res) {
    try {
        const { id } = req.params
        const result = await adoptBookService.removeHolding({ id, userId: req.user._id })
        _sendAdopt(res, result, r => ({ asset: r.asset }))
    } catch (err) {
        logger.error(LOG, 'removeAdoptedHolding failed', err)
        res.status(500).send({ error: 'Failed to remove the holding' })
    }
}

export async function streamPortfolio(req, res) {
    const { messages, ideaAccounts, mainAccountId, portfolioId, portfolioIdeas, threadId, model, pipeline } = req.body ?? {}

    const validatedMessages = parseChatMessages(messages)
    if (validatedMessages.error) {
        return res.status(400).json({ error: validatedMessages.error })
    }

    const validatedAccounts = parseIdeaAccounts(ideaAccounts)
    // Starred main account (bank icon) → the reference account Atlas sizes the others against.
    const validatedMainAccountId = mainAccountId != null ? String(mainAccountId) : null

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const isReviewMode = req.body?.reviewMode === true
            const bodyMandate  = (req.body?.mandate && typeof req.body.mandate === 'object') ? req.body.mandate : null

            // Pre-stream context load + mandate carry-forward (business logic → service).
            const { portfolioState, lifecycle, mandate, statedMandate, storedThesis, reviewDelta } = await portfolioChatService.loadStreamContext({
                userId: req.user._id, portfolioId, threadId, isReviewMode, bodyMandate,
            })

            const lastMessage = messages.at(-1)?.content ?? ''

            // ADOPT MODE. The client says which staged book this conversation is about, and the raw text
            // of the turn is parsed HERE — deterministically, before the model sees it — so a pasted
            // book becomes rows without the model ever reading a number (holdingsParse.util). Refreshing
            // rather than re-staging keeps one draft per adoption, so corrections land on the same book.
            const adoptDraft = req.body?.adoptDraftId
                ? await adoptBookService.refreshDraft({
                    draftId: String(req.body.adoptDraftId), userId: req.user._id, paste: String(lastMessage ?? ''),
                }).then(r => r.draft ?? null).catch(() => null)
                : null

            const result = await portfolioAgentService.chatStream({
                messages,
                ideaAccounts: validatedAccounts,
                mainAccountId: validatedMainAccountId,
                portfolioId:   portfolioId   ?? null,
                portfolioIdeas: Array.isArray(portfolioIdeas) ? portfolioIdeas : [],
                portfolioState,
                isReviewMode,
                reviewDelta,
                lifecycle,
                mandate,
                audience: await getExperienceLevel(req.user._id),
                thesis: storedThesis,
                adoptDraft,
                model,
                userId:   req.user._id,
                signal:   signal,
                onToken:     (text)   => sendEvent('token',     { text }),
                onTicker:    (symbol) => sendEvent('ticker',    { symbol }),
                onPhase:     (phase)  => sendEvent('phase',     { phase }),
                onToolStart: (tool)   => sendEvent('status',    { tool }),
                onReasoning: (text)   => sendEvent('reasoning', { text }),
                onChart:     (chart)  => sendEvent('chart',     chart),
            })

            // Post-stream persistence (mandate/thesis/draft) → service. Only when the client is
            // still listening, matching the previous "after finish, if not aborted" gate.
            if (signal.aborted) return undefined
            portfolioChatService.persistStreamOutcome({
                // statedMandate, not mandate: only what the user established WITH ATLAS is written back.
                userId: req.user._id, portfolioId, threadId, isReviewMode, messages,
                mandate: statedMandate, storedThesis, result,
                // Which desk this conversation belongs to, so the badge and the lock can tell an
                // unfinished BUILD from a standalone chat at the same agent.
                pipeline: typeof pipeline === 'string' && pipeline.trim() ? pipeline.trim() : null,
            })

            // G1: Atlas asked Prometheus to re-research a held name. Fire the async refresh-by-hop
            // (route-and-return) — it runs headless and pings the user when the coverage is rewritten,
            // then they resume the review. Never blocks the response; best-effort.
            if (result.coverageRefresh?.ticker) {
                refreshCoverage({
                    userId:        req.user._id,
                    ticker:        result.coverageRefresh.ticker,
                    question:      result.coverageRefresh.question ?? null,
                    portfolioId:   portfolioId ?? null,
                    portfolioName: portfolioState?.portfolioName ?? null,
                }).catch(err => logger.warn(LOG, 'coverage refresh hop failed', err.message))
            }

            return { reply: result.reply, plan: result.plan ?? null, update: result.update ?? null, mandate: result.mandate ?? null, thesis: result.thesis ?? null, phase: result.phase ?? null, ...(result.screenRequests ? { screen_requests: result.screenRequests } : {}), ...(result.coverageRefresh ? { coverage_refresh: result.coverageRefresh } : {}) }
        },
    })
}

export async function savePortfolioChatState(req, res) {
    try {
        const { portfolioId, messages, mandate, thesis, threadId, portfolioName } = req.body ?? {}
        if (!portfolioId || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Missing portfolioId or messages' })
        }
        const result = await portfolioChatService.saveChatState(portfolioId, messages, req.user._id, mandate ?? null)
        if (!result.ok) return res.status(500).json({ error: 'Failed to save' })
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
    } catch (err) {
        logger.error(LOG, 'savePortfolioChatState failed', err)
        res.status(500).json({ error: 'Failed to save chat state' })
    }
}

export const getPortfolioChatState = makeGetChatState({
    service: portfolioChatService,
    keyArgs: (req) => [req.params.portfolioId, req.user._id],
    logger, log: LOG, failMsg: 'getPortfolioChatState failed',
})

export const deletePortfolioChatState = makeDeleteChatState({
    service: portfolioChatService,
    keyArgs: (req) => [req.params.portfolioId, req.user._id],
    requireKey: (req) => req.params.portfolioId ? null : 'Missing portfolioId',
    logger, log: LOG, failMsg: 'deletePortfolioChatState failed',
})

export async function getPendingReviews(req, res) {
    try {
        const reviews = await portfolioChatService.getPendingReviews(req.user._id)
        res.json({ reviews })
    } catch (err) {
        logger.error(LOG, 'getPendingReviews failed', err)
        res.status(500).json({ error: 'Failed to get pending reviews' })
    }
}

export async function completeReview(req, res) {
    try {
        const { portfolioId } = req.params
        if (!portfolioId) return res.status(400).json({ error: 'Missing portfolioId' })

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
    } catch (err) {
        logger.error(LOG, 'completeReview failed', err)
        res.status(500).json({ error: 'Failed to complete review' })
    }
}

// Apply an accepted portfolio_update (the confirmed review proposal) to the live book.
// The user's books — id, name, holdings count, per-status tallies, symbols, venue modes. The
// portfolio's `GET /` , completing the pair every other kind has had; the derivation already
// existed for the watchlist and is simply reachable now instead of being re-derived client-side
// from the ideas list.
export async function getPortfolios(req, res) {
    try {
        res.json({ portfolios: await listPortfolios(req.user._id) })
    } catch (err) {
        logger.error(LOG, 'getPortfolios failed', err)
        res.status(500).json({ error: 'Failed to load portfolios' })
    }
}

// GET a book's holdings. The portfolio's answer to the `GET /:id` every other kind already has —
// a book is not a document, so its "read one" is the rows carrying its id, owner-scoped in the
// service exactly as makeEntityController's get is.
//
// This exists because opening a book for review used to be seeded from whatever the client's idea
// list happened to hold. When that list was empty (a card click landing before it loaded), Atlas
// was handed a book with no item ids, invented them, and every accepted change came back
// not_found. A desk reads its subject from the database, like every other desk does.
export async function getPortfolioItems(req, res) {
    try {
        const { portfolioId } = req.params
        if (!portfolioId) return res.status(400).json({ error: 'Missing portfolioId' })
        const items = await listPortfolioItems(portfolioId, req.user._id)
        // An empty book is not an error — an adopted draft or a deleted book both read as zero rows,
        // and the caller decides what that means. What must never happen is answering 200 with rows
        // the caller can't tell apart from "we didn't look".
        res.json({ items })
    } catch (err) {
        logger.error(LOG, 'getPortfolioItems failed', err)
        res.status(500).json({ error: 'Failed to load portfolio holdings' })
    }
}

export async function applyPortfolioRebalance(req, res) {
    try {
        const { portfolioId } = req.params
        const { update }      = req.body ?? {}
        if (!portfolioId) return res.status(400).json({ error: 'Missing portfolioId' })
        if (!update || !Array.isArray(update.changes)) {
            return res.status(400).json({ error: 'Missing update.changes' })
        }
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
    } catch (err) {
        logger.error(LOG, 'applyPortfolioRebalance failed', err)
        res.status(500).json({ error: 'Failed to apply rebalance' })
    }
}
