// Atlas — builds and reviews a portfolio book against a mandate. Working state: the conversation-long
// fields `{ portfolioId, reviewMode, mandate, adoptDraftId }`; per turn: `{ accounts, mainAccountId,
// threadId, pipeline }`. A built book's mandate, thesis and lifecycle already live server-side
// (portfolio_books) and are read fresh every turn (loadStreamContext).
// One definition for the HTTP desk stream and the session turn (unified-chat plan phase 4).

import { portfolioAgentService } from '../agents/portfolio.agent.service.js'
import { portfolioChatService } from '../../api/portfolio/portfolioChat.service.js'
import { adoptBookService } from '../../api/portfolio/adoptBook.service.js'
import { parseIdeaAccounts } from '../../api/_shared/parse.util.js'
import { refreshCoverage } from '../coverageRefresh.service.js'
import { researchQueueService } from '../researchQueue.service.js'
import { sourceSleeve } from '../sleeveSource.service.js'
import { logger } from '../logger.service.js'

const LOG = '[portfolio:desk]'

const _str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * The working state after a turn: the conversation-long fields carry over; the mandate and thesis the
 * turn stated replace the old ones (a built book also persists them to portfolio_books, as today); the
 * plan or review update on the table is the latest one.
 */
export function portfolioNextState(prev, result) {
    return {
        portfolioId:  prev?.portfolioId ?? null,
        reviewMode:   prev?.reviewMode === true,
        adoptDraftId: prev?.adoptDraftId ?? null,
        mandate:      result.mandate ?? prev?.mandate ?? null,
        thesis:       result.thesis ?? prev?.thesis ?? null,
        pendingPlan:  result.plan ?? prev?.pendingPlan ?? null,
        reviewUpdate: result.update ?? prev?.reviewUpdate ?? null,
    }
}

export const portfolioDesk = {
    agent: 'portfolio',
    log:   LOG,
    nextState: portfolioNextState,
    // `portfolioIdeas` is still SENT by the client and deliberately not read: the book Atlas sees is
    // read from the database (portfolioState), not from the list the client happened to be holding.
    // See _buildPortfolioStateSection — an empty client list is what made Atlas invent item ids.
    //
    // Atlas's accounts arrive as `ideaAccounts`, not the shared `accounts` (the client's field name for
    // this desk). Read here until the unified client sends one shape (unified-chat plan phase 7).
    parse: (body, turn) => ({
        state: {
            portfolioId:  body.portfolioId ?? null,
            reviewMode:   body.reviewMode === true,
            mandate:      body.mandate && typeof body.mandate === 'object' ? body.mandate : null,
            adoptDraftId: body.adoptDraftId ? String(body.adoptDraftId) : null,
        },
        input: {
            accounts:      parseIdeaAccounts(body.ideaAccounts),
            mainAccountId: turn.mainAccountId,
            threadId:      body.threadId ?? null,
            // Which desk this conversation belongs to, so the badge and the lock can tell an unfinished
            // BUILD from a standalone chat at the same agent. Validated as a string, never trusted as a key.
            pipeline:      _str(body.pipeline),
        },
    }),
    run: async ({ user, state, input, signal, emit, common }) => {
        const { messages } = common
        const { portfolioId = null, reviewMode: isReviewMode = false, mandate: bodyMandate = null, adoptDraftId = null } = state ?? {}
        const { threadId = null, pipeline: cleanPipeline = null } = input
        // The last phase this turn actually emitted. A stopped turn has no result to read one off, and
        // the substantive floor reads it — so it is tracked as it streams.
        let lastPhase = null

        // Pre-stream context load + mandate carry-forward (business logic → service).
        const { portfolioState, lifecycle, mandate, statedMandate, storedThesis, reviewDelta } = await portfolioChatService.loadStreamContext({
            userId: user._id, portfolioId, threadId, isReviewMode, bodyMandate,
        })

        const lastMessage = messages.at(-1)?.content ?? ''

        // ADOPT MODE. The client says which staged book this conversation is about, and the raw text of
        // the turn is parsed HERE — deterministically, before the model sees it — so a pasted book
        // becomes rows without the model ever reading a number (holdingsParse.util). Refreshing rather
        // than re-staging keeps one draft per adoption, so corrections land on the same book.
        const adoptDraft = adoptDraftId
            ? await adoptBookService.refreshDraft({
                draftId: adoptDraftId, userId: user._id, paste: String(lastMessage ?? ''),
            }).then(r => r.draft ?? null).catch(() => null)
            : null

        const result = await portfolioAgentService.chatStream({
            ...common,
            ideaAccounts:  input.accounts ?? [],
            // Starred main account (bank icon) → the reference account Atlas sizes the others against.
            mainAccountId: input.mainAccountId ?? null,
            portfolioId,
            portfolioState,
            isReviewMode,
            reviewDelta,
            lifecycle,
            mandate,
            thesis: storedThesis,
            adoptDraft,
            onTicker:    (symbol) => emit('ticker', { symbol }),
            onPhase:     (phase)  => { lastPhase = phase; emit('phase', { phase }) },
        })

        // Post-stream persistence (mandate/thesis/draft) → service. Only when the client is still
        // listening: what the turn PRODUCED (a mandate, a thesis) is the answer to a turn nobody
        // received, and writing it back would move the build on behalf of a user who stopped it.
        //
        // The CONVERSATION is the exception, and it is the whole of this branch: it is the user's
        // message and the turns before it, not the model's answer, and walking out of a turn is the
        // commonest way to leave a desk unfinished.
        if (signal.aborted) {
            portfolioChatService.persistStoppedTurn({
                userId: user._id, threadId, portfolioId, messages,
                mandate: statedMandate, phase: lastPhase, pipeline: cleanPipeline,
            })
            return null
        }
        portfolioChatService.persistStreamOutcome({
            // statedMandate, not mandate: only what the user established WITH ATLAS is written back.
            userId: user._id, portfolioId, threadId, isReviewMode, messages,
            mandate: statedMandate, storedThesis, result,
            pipeline: cleanPipeline,
        })

        // G1: Atlas asked Prometheus to re-research a held name. Fire the async refresh-by-hop
        // (route-and-return) — it runs headless and pings the user when the coverage is rewritten,
        // then they resume the review. Never blocks the response; best-effort.
        //
        // ADMIN-ONLY (2026-09-14). The hop REWRITES house coverage — a revision, which the routes
        // reserve for admins — and its ping lands in Prometheus's feed, which traders cannot see. A
        // trader's Atlas keeps reading the standing coverage; the ask is logged so the desk can see it
        // was made. (The <coverage_request> path below is the trader's route to new research: it queues
        // for an admin instead of writing.)
        if (result.coverageRefresh?.ticker && user.role !== 'admin') {
            logger.info(LOG, 'coverage refresh skipped — not an admin', { userId: user._id, ticker: result.coverageRefresh.ticker })
        } else if (result.coverageRefresh?.ticker) {
            refreshCoverage({
                userId:        user._id,
                ticker:        result.coverageRefresh.ticker,
                question:      result.coverageRefresh.question ?? null,
                portfolioId,
                portfolioName: portfolioState?.portfolioName ?? null,
            }).catch(err => logger.warn(LOG, 'coverage refresh hop failed', err.message))
        }

        // SLEEVE SOURCING — the autonomous Atlas → Argus → Prometheus → Atlas hop, for ANY role. An
        // empty pool for a sleeve is not the end of the turn any more: each <screen_request> Atlas
        // emitted is screened, queued and researched server-side (sleeveSource), and the user gets an
        // Atlas card when the sleeve is decided. Fire-and-forget; the response is already out. Not
        // admin-gated, unlike the refresh above: this WRITES nothing a user owns — the coverage it
        // produces is house coverage, researched and written AS the house.
        for (const sr of result.screenRequests ?? []) {
            sourceSleeve({
                userId:        user._id,
                threadId,
                portfolioId,
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
                requestedBy: user._id,
            }).catch(err => logger.warn(LOG, 'coverage request enqueue failed', err.message))
        }

        return result
    },
    done: (result) => ({
        reply: result.reply, plan: result.plan ?? null, update: result.update ?? null, mandate: result.mandate ?? null, thesis: result.thesis ?? null, phase: result.phase ?? null,
        ...(result.screenRequests ? { screen_requests: result.screenRequests } : {}),
        ...(result.coverageRefresh ? { coverage_refresh: result.coverageRefresh } : {}),
        ...(result.coverageRequest ? { coverage_request: result.coverageRequest } : {}),
    }),
}
