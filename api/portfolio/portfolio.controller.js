import { portfolioAgentService } from '../../services/agents/portfolio.agent.service.js'
import { portfolioChatService }  from './portfolioChat.service.js'
import { applyRebalance, snapshotConvictions } from './portfolioRebalance.service.js'
import { invalidatePortfolioState, listPortfolioItems, listPortfolios } from '../../services/portfolioState.service.js'
import { refreshCoverage }        from '../../services/coverageRefresh.service.js'
import { researchQueueService }   from '../../services/researchQueue.service.js'
import { sourceSleeve }           from '../../services/sleeveSource.service.js'
import { logger }                from '../../services/logger.service.js'
import { streamAgentResponse, sseAgentCallbacks }   from '../_shared/sse.util.js'
import { parseIdeaAccounts, parseChatMessages } from '../_shared/parse.util.js'
import { makeGetChatState, makeDeleteChatState } from '../_shared/chatState.util.js'
import { threadService }          from '../../services/thread.service.js'
import { resolvePortfolioReviewCard } from '../chat/chat.service.js'
import { getExperienceLevel } from '../../services/experience.service.js'
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

export async function streamPortfolio(req, res) {
    // `portfolioIdeas` is still SENT by the client and deliberately not read: the book Atlas sees is
    // read from the database (portfolioState), not from the list the client happened to be holding.
    // See _buildPortfolioStateSection — an empty client list is what made Atlas invent item ids.
    const { messages: rawMessages, ideaAccounts, mainAccountId, portfolioId, threadId, model, pipeline } = req.body ?? {}

    const validatedMessages = parseChatMessages(rawMessages)
    if (validatedMessages.error) {
        return res.status(400).json({ error: validatedMessages.error })
    }
    const messages = validatedMessages.messages

    const validatedAccounts = parseIdeaAccounts(ideaAccounts)
    // Starred main account (bank icon) → the reference account Atlas sizes the others against.
    const validatedMainAccountId = mainAccountId != null ? String(mainAccountId) : null

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const isReviewMode = req.body?.reviewMode === true
            const bodyMandate  = (req.body?.mandate && typeof req.body.mandate === 'object') ? req.body.mandate : null
            // Which desk this conversation belongs to, so the badge and the lock can tell an
            // unfinished BUILD from a standalone chat at the same agent. Validated as a string,
            // never trusted as a key — and read by BOTH endings of the turn, so it is resolved once.
            const cleanPipeline = typeof pipeline === 'string' && pipeline.trim() ? pipeline.trim() : null
            // The last phase this turn actually emitted. A stopped turn has no result to read one
            // off, and the substantive floor reads it — so it is tracked as it streams.
            let lastPhase = null

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
                ...sseAgentCallbacks(sendEvent),
                onTicker:    (symbol) => sendEvent('ticker',    { symbol }),
                onPhase:     (phase)  => { lastPhase = phase; sendEvent('phase', { phase }) },
            })

            // Post-stream persistence (mandate/thesis/draft) → service. Only when the client is
            // still listening: what the turn PRODUCED (a mandate, a thesis) is the answer to a turn
            // nobody received, and writing it back would move the build on behalf of a user who
            // stopped it.
            //
            // The CONVERSATION is the exception, and it is the whole of this branch: it is the
            // user's message and the turns before it, not the model's answer, and walking out of a
            // turn is the commonest way to leave a desk unfinished. Dropping it here is what left
            // Atlas with no marker at the hub and no chat after a reload — the same gap the five
            // client-persisted desks had (useChatStream's `onStopped`), one layer down.
            if (signal.aborted) {
                portfolioChatService.persistStoppedTurn({
                    userId: req.user._id, threadId, portfolioId, messages,
                    mandate: statedMandate, phase: lastPhase, pipeline: cleanPipeline,
                })
                return undefined
            }
            portfolioChatService.persistStreamOutcome({
                // statedMandate, not mandate: only what the user established WITH ATLAS is written back.
                userId: req.user._id, portfolioId, threadId, isReviewMode, messages,
                mandate: statedMandate, storedThesis, result,
                pipeline: cleanPipeline,
            })

            // G1: Atlas asked Prometheus to re-research a held name. Fire the async refresh-by-hop
            // (route-and-return) — it runs headless and pings the user when the coverage is rewritten,
            // then they resume the review. Never blocks the response; best-effort.
            //
            // ADMIN-ONLY (2026-09-14). The hop REWRITES house coverage — a revision, which the routes
            // reserve for admins — and its ping lands in Prometheus's feed, which traders cannot see.
            // A trader's Atlas keeps reading the standing coverage; the ask is logged so the desk can
            // see it was made. (The <coverage_request> path below is the trader's route to new
            // research: it queues for an admin instead of writing.)
            if (result.coverageRefresh?.ticker && req.user.role !== 'admin') {
                logger.info(LOG, 'coverage refresh skipped — not an admin', { userId: req.user._id, ticker: result.coverageRefresh.ticker })
            } else if (result.coverageRefresh?.ticker) {
                refreshCoverage({
                    userId:        req.user._id,
                    ticker:        result.coverageRefresh.ticker,
                    question:      result.coverageRefresh.question ?? null,
                    portfolioId:   portfolioId ?? null,
                    portfolioName: portfolioState?.portfolioName ?? null,
                }).catch(err => logger.warn(LOG, 'coverage refresh hop failed', err.message))
            }

            // SLEEVE SOURCING — the autonomous Atlas → Argus → Prometheus → Atlas hop, for ANY role.
            // An empty pool for a sleeve is not the end of the turn any more: each <screen_request>
            // Atlas emitted is screened, queued and researched server-side (sleeveSource), and the
            // user gets an Atlas card when the sleeve is decided. Fire-and-forget; the response is
            // already out. The school rides as `lens`, the sleeve's threadId/portfolioId as the way
            // back. Not admin-gated, unlike the refresh above: this WRITES nothing a user owns — the
            // coverage it produces is house coverage, researched and written AS the house (the run
            // takes no user), exactly as the house scan's.
            for (const sr of result.screenRequests ?? []) {
                sourceSleeve({
                    userId:        req.user._id,
                    threadId:      threadId ?? null,
                    portfolioId:   portfolioId ?? null,
                    portfolioName: portfolioState?.portfolioName ?? null,
                    sector:        sr.sector,
                    industry:      sr.industry ?? null,
                    school:        sr.lens ?? statedMandate?.selection ?? mandate?.selection ?? null,
                    note:          sr.note ?? sr.constraints ?? null,
                }).then(r => { if (!r.ok) logger.info(LOG, 'sleeve not sourced', { sector: sr.sector, reason: r.reason }) })
                  .catch(err => logger.warn(LOG, 'sleeve sourcing failed', err.message))
            }

            // 4th flow: uncovered name the user asked to add. Enqueue for Prometheus — fire-and-forget.
            if (result.coverageRequest?.symbol) {
                researchQueueService.enqueue({
                    symbol:      result.coverageRequest.symbol,
                    source:      'manual',
                    requestedBy: req.user._id,
                }).catch(err => logger.warn(LOG, 'coverage request enqueue failed', err.message))
            }

            return { reply: result.reply, plan: result.plan ?? null, update: result.update ?? null, mandate: result.mandate ?? null, thesis: result.thesis ?? null, phase: result.phase ?? null, ...(result.screenRequests ? { screen_requests: result.screenRequests } : {}), ...(result.coverageRefresh ? { coverage_refresh: result.coverageRefresh } : {}), ...(result.coverageRequest ? { coverage_request: result.coverageRequest } : {}) }
        },
    })
}

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
