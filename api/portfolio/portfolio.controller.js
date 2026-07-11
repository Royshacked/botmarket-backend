import { portfolioAgentService } from '../../services/portfolio.agent.service.js'
import { portfolioChatService }  from './portfolioChat.service.js'
import { applyRebalance, snapshotConvictions } from './portfolioRebalance.service.js'
import { getPortfolioStateCached, invalidatePortfolioState } from '../../services/portfolioState.service.js'
import { logger }                from '../../services/logger.service.js'
import { resolveModel }          from '../../services/modelRouter.service.js'
import { startSseStream }        from '../_shared/sse.util.js'
import { parseIdeaAccounts, parseChatMessages } from '../_shared/parse.util.js'
import { makeGetChatState, makeDeleteChatState } from '../_shared/chatState.util.js'
import { threadService }          from '../../services/thread.service.js'
import { isSubstantive }          from '../../services/thread.util.js'
import { resolvePortfolioReviewCard } from '../chat/chat.service.js'

const LOG = '[portfolio:controller]'

export async function streamPortfolio(req, res) {
    const { messages, ideaAccounts, portfolioId, portfolioIdeas, threadId, model, reasoningEffort, routingMode, currentPhase } = req.body ?? {}

    const validatedMessages = parseChatMessages(messages)
    if (validatedMessages.error) {
        return res.status(400).json({ error: validatedMessages.error })
    }

    const validatedAccounts = parseIdeaAccounts(ideaAccounts)

    const { sendEvent, signal, finish } = startSseStream(req, res)

    try {
        const isReviewMode = req.body?.reviewMode === true

        // Fetch portfolio state (review mode only) and lifecycle (any mode with a
        // portfolioId) in parallel — both feed the agent's dynamic context.
        const [portfolioState, lifecycle, storedMandate, storedThesis] = await Promise.all([
            (isReviewMode && portfolioId)
                ? getPortfolioStateCached(portfolioId, req.user._id).catch(() => null)
                : Promise.resolve(null),
            portfolioId
                ? portfolioChatService.getPortfolioLifecycle(portfolioId, req.user._id).catch(() => null)
                : Promise.resolve(null),
            portfolioId
                ? portfolioChatService.getMandate(portfolioId, req.user._id).catch(() => null)
                : Promise.resolve(null),
            portfolioId
                ? portfolioChatService.getThesis(portfolioId, req.user._id).catch(() => null)
                : Promise.resolve(null),
        ])

        // Carry the mandate forward across turns. During first-time construction there's
        // no portfolioId yet, so the conversation is persisted to a DRAFT thread keyed by
        // threadId — that draft's mandate is the durable fallback (survives a reload; the
        // client re-send is now belt-and-suspenders, not the only source of truth). The
        // fresh body mandate wins; then the draft; then the stored one (edit/review).
        const draftThread = (!portfolioId && threadId)
            ? await threadService.getThread({ threadId, userId: req.user._id }).catch(() => null)
            : null

        const bodyMandate = (req.body?.mandate && typeof req.body.mandate === 'object') ? req.body.mandate : null
        const mandate = bodyMandate ?? draftThread?.mandate ?? storedMandate

        const lastMessage = messages.at(-1)?.content ?? ''
        const routing = await resolveModel({ routingMode, agent: 'portfolio', phase: currentPhase, model, reasoningEffort, lastMessage })

        const result = await portfolioAgentService.chatStream({
            messages,
            ideaAccounts: validatedAccounts,
            portfolioId:   portfolioId   ?? null,
            portfolioIdeas: Array.isArray(portfolioIdeas) ? portfolioIdeas : [],
            portfolioState,
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

        finish()
        if (!signal.aborted) {
            if (result.mandate && portfolioId) {
                portfolioChatService.setMandate(portfolioId, req.user._id, result.mandate)
                    .then(r => { if (!r.ok) logger.warn(LOG, 'setMandate returned not-ok, mandate may not be persisted') })
                    .catch(err => logger.warn(LOG, 'setMandate unexpected error', err))
            }
            // Persist a captured portfolio thesis on construction/edit only. In REVIEW
            // mode a thesis change is a PROPOSAL — it persists only when the user confirms
            // the rebalance (applyRebalance stamps reason 'accepted-rebalance'), preserving
            // the rewrite-only-on-accept rule (never auto-synced to drift). For first-time
            // construction portfolioId is null — the thesis rides 'done' and is persisted
            // with the chat state.
            if (result.thesis && portfolioId && !isReviewMode) {
                portfolioChatService.setThesis(portfolioId, req.user._id, result.thesis, storedThesis ? 'mandate-edit' : 'construction')
                    .catch(err => logger.warn(LOG, 'setThesis unexpected error', err))
            }
            // Construction only: once the agent has emitted a mandate (portfolio's
            // substantive floor), persist/refresh the conversation as a draft thread so it
            // survives a stop-before-generate. Full conversation incl. this reply; the
            // thread service TTL-manages + LRU-caps drafts. Linked on generate (savePortfolioChatState).
            const knownMandate = result.mandate ?? mandate
            if (!portfolioId && threadId && isSubstantive({ agent: 'portfolio', phase: result.phase, mandateReady: !!knownMandate })) {
                const draftMessages = [...messages, { role: 'assistant', content: result.reply }]
                threadService.saveDraft({
                    threadId, userId: req.user._id, agent: 'portfolio',
                    messages: draftMessages, phase: result.phase ?? null,
                    subjectType: 'portfolio', mandate: knownMandate ?? null,
                }).catch(err => logger.warn(LOG, 'construction saveDraft failed', err))
            }
            sendEvent('done', { reply: result.reply, plan: result.plan ?? null, update: result.update ?? null, mandate: result.mandate ?? null, thesis: result.thesis ?? null, phase: result.phase ?? null })
            res.end()
        }
    } catch (err) {
        finish()
        if (signal.aborted) return   // client gone — nothing to send
        logger.error(LOG, 'Portfolio stream failed', err)
        sendEvent('error', { message: 'Streaming failed' })
        res.end()
    }
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
