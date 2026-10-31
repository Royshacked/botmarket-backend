// Atlas — builds and reviews a portfolio book against a mandate. Working state: the conversation-long
// fields `{ portfolioId, reviewMode, mandate, adoptDraftId }`; per turn: `{ accounts, mainAccountId,
// threadId, pipeline }`. A built book's mandate, thesis and lifecycle already live server-side
// (portfolio_books) and are read fresh every turn (loadStreamContext).
// One definition for the HTTP desk stream and the session turn (unified-chat plan phase 4).

import { portfolioAgentService } from '../agents/portfolio.agent.service.js'
import { portfolioChatService } from '../../api/portfolio/portfolioChat.service.js'
import { adoptBookService } from '../../api/portfolio/adoptBook.service.js'
import { refreshCoverage } from '../coverageRefresh.service.js'
import { sourceSleeve } from '../sleeveSource.service.js'
import { logger } from '../logger.service.js'
import { portfolioActions, makePortfolioApplyEdit, PORTFOLIO_REASONS } from './actions/portfolio.actions.js'
import { keepMarkers } from './markers.js'

const LOG = '[portfolio:desk]'

/**
 * The working state after a turn: the conversation-long fields carry over; the mandate and thesis the
 * turn stated replace the old ones (a built book also persists them to portfolio_books, as today); the
 * plan or review update on the table is the latest one.
 *
 * `result` null is a FOLD, not a turn (a route landing, a book reopened): everything on the table stays.
 *
 * A proposal is the latest turn's or none. A turn without an update block WITHDRAWS the one before
 * it — Atlas took six trims back in prose on 2026-10-03 and Accept still sent the first turn's block (the panel's
 * rule, kept here now that Accept reads the state). Atlas re-emits a proposal it still stands behind
 * (agentUtils.buildStandingProposalRule). A thesis stated in THE SAME turn rides on the proposal, so accepting it
 * persists it ('accepted-rebalance') — never the thesis carried from an earlier turn.
 */
export function portfolioNextState(prev, result) {
    const turn = result ?? {}
    // The latest turn decides outside a review too (phase 8c CR): an edit's proposal waits on Accept now, so one Atlas
    // took back would otherwise stay on the table — and stand in the way of saving the plan that replaced it.
    const inReview = prev?.reviewMode === true
    const reviewUpdate = result
        ? (result.update?.changes?.length ? { ...result.update, ...(inReview && result.thesis ? { thesis: result.thesis } : {}) } : null)
        : (prev?.reviewUpdate ?? null)
    return {
        portfolioId:  prev?.portfolioId ?? null,
        reviewMode:   prev?.reviewMode === true,
        // A review pass has run since the book opened for review — the surface offers Accept / Dismiss only then
        // (accepting a hold nobody looked at would close the review on nothing). Any Atlas turn in review mode is
        // that pass: the review instruction rides every one (portfolio.agent, isReviewMode).
        reviewed:     prev?.reviewMode === true && (!!result || prev?.reviewed === true),
        // The user already owns this book (Axl's adopt): the surface opens the adopt grid until a draft is staged.
        adopt:        prev?.adopt === true,
        adoptDraftId: prev?.adoptDraftId ?? null,
        mandate:      turn.mandate ?? prev?.mandate ?? null,
        thesis:       turn.thesis ?? prev?.thesis ?? null,
        pendingPlan:  turn.plan ?? prev?.pendingPlan ?? null,
        reviewUpdate,
        // What this turn set off in the background — the surface's notices (plan phase 8, K4). This turn's only;
        // a fold keeps the last turn's.
        notices: result ? {
            screenRequests:  result.screenRequests ?? null,
        } : (prev?.notices ?? { screenRequests: null }),
    }
}

export const portfolioDesk = {
    agent: 'portfolio',
    log:   LOG,
    nextState: portfolioNextState,
    // Unsealed work: a plan or review update on the table, or a book being adopted.
    hasWork: (state) => !!(state?.pendingPlan || state?.reviewUpdate || state?.adoptDraftId),
    // Reopening a book: its id is enough — mandate, thesis and lifecycle are read from portfolio_books.
    // A review card opens it in review mode (`opts.reviewMode`, the edit route).
    // The book's standing thesis comes along for the surface's card (the turn reads its own copy from the database).
    stateFromEntity: (book, opts = {}) => portfolioNextState({
        portfolioId: book?.portfolioId ?? book?.id ?? null, reviewMode: opts.reviewMode === true, thesis: book?.thesis ?? null,
    }, null),
    // A route lands here. The work in progress is kept (an Atlas plan is not thrown away by a second route) — and so
    // are its markers: a book being edited stays the one an update seals onto (phase 8a CR C1).
    // ADOPT (phase 8c CR): Axl's adopt hint opens the adopt grid on a CLEAN table — an adoption is a new book, and its
    // conversation must not parse into the one being edited. Unsaved work (a plan, a proposal) stays, marked `adopt`:
    // the surface asks before putting it aside (`{ adopt: 'start', fresh: true }`). Any OTHER route ends adopt mode —
    // walking away by another door used to leave the next build parsing into the old draft.
    onRouted: (prev, preset) => {
        const kept = portfolioNextState(prev, null)
        if (preset?.adopt !== true) return keepMarkers({ ...kept, adopt: false, adoptDraftId: null }, prev)
        if (kept.pendingPlan || kept.reviewUpdate) return keepMarkers({ ...kept, adopt: true }, prev)
        return { ...portfolioNextState(null, null), adopt: true, adoptDraftId: kept.adoptDraftId }
    },
    // No `parse`: it served the desk's own HTTP /stream route, gone with the panels (8e); a session turn hands the desk
    // its state and input directly (phase 9 cleanup, 2026-10-20). Pythia's and Aether's desks keep theirs.
    run: async ({ user, state, input, signal, emit, common, sessionId = null }) => {
        const { messages } = common
        const { portfolioId = null, reviewMode: isReviewMode = false, mandate: bodyMandate = null, adoptDraftId = null } = state ?? {}
        // Always null since the unified chat (the session desks pass none) — kept only for the sleeve card's field.
        const { threadId = null } = input

        // Pre-stream context load + mandate carry-forward (business logic → service).
        const { portfolioState, lifecycle, mandate, statedMandate, storedThesis, reviewDelta } = await portfolioChatService.loadStreamContext({
            userId: user._id, portfolioId, isReviewMode, bodyMandate,
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
            onPhase:     (phase)  => emit('phase', { phase }),
        })

        // Post-stream persistence (mandate/thesis) → service. Only when the client is still listening: what
        // the turn PRODUCED is the answer to a turn nobody received, and writing it back would move the build
        // on behalf of a user who stopped it. The conversation is the session's — a stopped turn's message is
        // already on it (the old draft-thread write went in phase 9).
        if (signal?.aborted) return null
        portfolioChatService.persistStreamOutcome({
            // statedMandate, not mandate: only what the user established WITH ATLAS is written back.
            userId: user._id, portfolioId, isReviewMode,
            mandate: statedMandate, storedThesis, result,
        })

        // G1: Atlas asked Prometheus to re-research a held name. Fire the async refresh-by-hop
        // (route-and-return) — it runs headless and pings the user when the coverage is rewritten,
        // then they resume the review. Never blocks the response; best-effort.
        //
        // ADMIN-ONLY (2026-09-14). The hop REWRITES house coverage — a revision, which the routes
        // reserve for admins — and its ping lands in Prometheus's feed, which traders cannot see. A
        // trader's Atlas keeps reading the standing coverage; the ask is logged so the desk can see it
        // was made.
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
                // From the unified chat, the sleeve settles into this session's chain (plan phase 5d).
                sessionId,
                portfolioId,
                portfolioName: portfolioState?.portfolioName ?? null,
                sector:        sr.sector,
                industry:      sr.industry ?? null,
                // The sleeve's GICS sub-industry (atlas-industry-sleeves.md) — its names come from the house's GICS table.
                industryCode:  sr.industry_code ?? null,
                school:        sr.lens ?? statedMandate?.selection ?? mandate?.selection ?? null,
                note:          sr.note ?? sr.constraints ?? null,
            }).then(r => { if (!r.ok) logger.info(LOG, 'sleeve not sourced', { sector: sr.sector, reason: r.reason }) })
              .catch(err => logger.warn(LOG, 'sleeve sourcing failed', err.message))
        }

        return result
    },
    // What a discard keeps (act.js): the mandate the user set — the plan built under it goes (phase 8e CR).
    cleanTable: (state) => (state?.mandate ? { ...portfolioNextState(null, null), mandate: state.mandate } : null),
    // The session's commits (plan phase 8, K2) and hand edits (K3: adopt mode) — services/desks/act.js runs them.
    actions: portfolioActions,
    applyEdit: makePortfolioApplyEdit({ clean: () => portfolioNextState(null, null) }),
    reasons: PORTFOLIO_REASONS,
    stateFields: ['plan', 'update', 'mandate', 'thesis', 'screen_requests'],
    done: (result) => ({
        reply: result.reply, plan: result.plan ?? null, update: result.update ?? null, mandate: result.mandate ?? null, thesis: result.thesis ?? null, phase: result.phase ?? null,
        ...(result.screenRequests ? { screen_requests: result.screenRequests } : {}),
        ...(result.coverageRefresh ? { coverage_refresh: result.coverageRefresh } : {}),
    }),
}
