import { portfolioAgentService } from '../../services/portfolio.agent.service.js'
import { portfolioChatService }  from './portfolioChat.service.js'
import { applyRebalance, snapshotConvictions } from './portfolioRebalance.service.js'
import { invalidatePortfolioState } from '../../services/portfolioState.service.js'
import { logger }                from '../../services/logger.service.js'
import { resolveModel }          from '../../services/modelRouter.service.js'
import { streamAgentResponse }   from '../_shared/sse.util.js'
import { parseIdeaAccounts, parseChatMessages } from '../_shared/parse.util.js'
import { makeGetChatState, makeDeleteChatState } from '../_shared/chatState.util.js'
import { threadService }          from '../../services/thread.service.js'
import { resolvePortfolioReviewCard } from '../chat/chat.service.js'

const LOG = '[portfolio:controller]'

export async function streamPortfolio(req, res) {
    const { messages, ideaAccounts, portfolioId, portfolioIdeas, threadId, model, reasoningEffort, routingMode, currentPhase } = req.body ?? {}

    const validatedMessages = parseChatMessages(messages)
    if (validatedMessages.error) {
        return res.status(400).json({ error: validatedMessages.error })
    }

    const validatedAccounts = parseIdeaAccounts(ideaAccounts)

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const isReviewMode = req.body?.reviewMode === true
            const bodyMandate  = (req.body?.mandate && typeof req.body.mandate === 'object') ? req.body.mandate : null

            // Pre-stream context load + mandate carry-forward (business logic → service).
            const { portfolioState, lifecycle, mandate, storedThesis } = await portfolioChatService.loadStreamContext({
                userId: req.user._id, portfolioId, threadId, isReviewMode, bodyMandate,
            })

            const lastMessage = messages.at(-1)?.content ?? ''
            const routing = await resolveModel({ routingMode, agent: 'portfolio', phase: currentPhase, model, reasoningEffort, lastMessage })

            const result = await portfolioAgentService.chatStream({
                messages,
                ideaAccounts: validatedAccounts,
                portfolioId:   portfolioId   ?? null,
                portfolioIdeas: Array.isArray(portfolioIdeas) ? portfolioIdeas : [],
                portfolioState,
                isReviewMode,
                lifecycle,
                mandate,
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
            })

            // Post-stream persistence (mandate/thesis/draft) → service. Only when the client is
            // still listening, matching the previous "after finish, if not aborted" gate.
            if (signal.aborted) return undefined
            portfolioChatService.persistStreamOutcome({
                userId: req.user._id, portfolioId, threadId, isReviewMode, messages, mandate, storedThesis, result,
            })

            return { reply: result.reply, plan: result.plan ?? null, update: result.update ?? null, mandate: result.mandate ?? null, thesis: result.thesis ?? null, phase: result.phase ?? null }
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
        const result = await applyRebalance(portfolioId, req.user._id, update, req.user?.isAdmin === true)
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
