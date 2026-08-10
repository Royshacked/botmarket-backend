import { portfolioAgentService } from '../../services/agents/portfolio.agent.service.js'
import { portfolioChatService }  from './portfolioChat.service.js'
import { applyRebalance, snapshotConvictions } from './portfolioRebalance.service.js'
import { invalidatePortfolioState } from '../../services/portfolioState.service.js'
import { refreshCoverage }        from '../../services/coverageRefresh.service.js'
import { logger }                from '../../services/logger.service.js'
import { resolveModel }          from '../../services/modelRouter.service.js'
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

export async function createAdoptionDraft(req, res) {
    try {
        const { bank, currency, statedTotal, freeCash, holdings, mandate, name } = req.body ?? {}
        const result = await adoptBookService.createDraft({
            userId: req.user._id, bank, currency, statedTotal, freeCash, holdings, mandate, name,
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
    const { messages, ideaAccounts, mainAccountId, portfolioId, portfolioIdeas, threadId, model, reasoningEffort, routingMode, currentPhase } = req.body ?? {}

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
            const routing = await resolveModel({ routingMode, agent: 'portfolio', phase: currentPhase, model, reasoningEffort, lastMessage })

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
                model:           routing.model,
                reasoningEffort: routing.reasoningEffort,
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
export async function applyPortfolioRebalance(req, res) {
    try {
        const { portfolioId } = req.params
        const { update }      = req.body ?? {}
        if (!portfolioId) return res.status(400).json({ error: 'Missing portfolioId' })
        if (!update || !Array.isArray(update.changes)) {
            return res.status(400).json({ error: 'Missing update.changes' })
        }
        const result = await applyRebalance(portfolioId, req.user._id, update)
        if (!result.ok) return res.status(400).json(result)

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
