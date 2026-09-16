// Sleeve sourcing — the autonomous Atlas → Argus → Prometheus → Atlas hop.
//
// Atlas builds a book from house coverage and nothing else (the Phase 4 hard rule). When a sleeve's
// filter — sector + selection school — finds the pool empty, this is what fills it: the sector is
// SCREENED (the FMP screener, with the school as a coarse filter), the hits are QUEUED for research
// with the sleeve as their reason, the research run is STARTED if it is not already going, and
// when the run has decided every name of the sleeve the requesting user gets an Atlas card: resume
// the build, the pool has what it has. Nobody at a desk in between — that is the whole point.
// Before 2026-09-14 the same hop drew a "send to Argus" button and stopped; the user walked three
// desks by hand, and a trader (who cannot write coverage) could not finish the walk at all.
//
// WHAT IS SHARED AND WHAT IS OWNED. The screen is the SAME mechanism the house scan uses (the FMP
// screener over a sector), the queue is the same queue, the run is the same run and writes coverage
// the same way — house-owned, no user on it. What this module owns is the JUDGMENT of a sleeve: the
// school → screen mapping, how many names a sleeve is worth, and when a sleeve counts as sourced.
//
// THE SCHOOL FILTER IS A PROXY, and says so. FMP's screener whitelist (fmp.provider SCREEN_PARAMS) has
// no valuation, quality or growth predicate, so no screen can apply a school's real bar — that is
// Prometheus's job, and the research run applies it when it writes coverage (or passes, no_edge).
// What the screen CAN do is not waste Prometheus's four minutes a name on the obviously wrong pond:
// no micro-caps under a quality-value mandate, no non-payers under an income one.
//
// THE RESEARCH RUNS AS THE HOUSE, NOT AS THE REQUESTER. The run takes a userId for whose venue and
// whose budget a turn is made under; here it is null, the same identity the coverage monitor's
// re-model uses. Two reasons, both about what coverage IS: it is a house artifact, so the model that
// writes it must not depend on who asked — a trader past their monthly ceiling is degraded to the
// cheap model (agentUtils), and a thesis every book builds from must not be researched on it; and
// an hour of Prometheus is the house's spend, not the price of asking Atlas a question.
//
// ONE PROCESS, IN MEMORY, like the run it drives. A sleeve that is pending when the process dies is
// lost as a card, not as work: its rows are in the queue and the next run researches them; only the
// "resume the build" ping is gone, and the user's next Atlas turn reads the coverage anyway.

import { randomUUID }           from 'crypto'
import { researchQueueService } from './researchQueue.service.js'
import { researchRunService, onRunSettled } from './researchRun.service.js'
import { normalizeSelection }   from './investorSchools.js'
import { cardActions }          from '../api/chat/chat.service.js'
import { postCard }             from './notifyCard.js'
import { logger }               from './logger.service.js'

const LOG = '[sleeveSource]'

// Minimum daily volume: below this a name is too illiquid to research meaningfully (houseScan's bar).
const MIN_VOLUME = 500_000
// Names per sleeve. A sleeve needs four to eight PLACEABLE names, and the run passes on some (no
// edge) — twelve is enough pond for that and still under an hour of Prometheus. Not conviction-
// scaled like the house scan: a sleeve is a slot in a book, not a stance with a weight on it.
export const SLEEVE_HITS = 12

/**
 * The school as a screen. Coarse on purpose — see the header. `default` is the pond for a mandate
 * with no selection school set; `passive` has no entry because a passive sleeve never screens
 * (investorSchools SELECTION_RULES): it takes a broad ETF that should already be in coverage.
 */
export const SCHOOL_SCREEN = Object.freeze({
    // Established businesses — the value half cannot be screened, Prometheus applies it.
    'quality-value':     { marketCapMoreThan: 2_000_000_000 },
    // Room to be small, not micro: durability is evidenced over years, which a $200M name has not had.
    'growth-durability': { marketCapMoreThan: 1_000_000_000 },
    // Pays, and is big enough for the payout to have a history. FMP's dividend filter is the last
    // annual dividend per share in dollars, not a yield — so this is "pays at all", nothing finer.
    income:              { marketCapMoreThan: 2_000_000_000, dividendMoreThan: 0.5 },
    default:             { marketCapMoreThan: 1_000_000_000 },
})

/** The screener call for one sleeve. Pure. `industry` narrows inside the sector when Atlas held a view. */
export function screenFiltersFor(sector, school = null, { industry = null, limit = SLEEVE_HITS } = {}) {
    const lens = normalizeSelection(school)
    return {
        sector,
        ...(industry ? { industry } : {}),
        ...(SCHOOL_SCREEN[lens] ?? SCHOOL_SCREEN.default),
        volumeMoreThan: MIN_VOLUME,
        isEtf:          'false',
        limit,
    }
}

// ─── The pending sleeves ────────────────────────────────────────────────────────

// Sleeves waiting on the run, oldest first. A sleeve leaves when every one of its names has an
// outcome (or the queue no longer holds any of them) and its card has been posted.
const state = { sleeves: [], subscribed: false }

/** What a caller or a test may read. Never the internal object. */
export function pendingSleeves() {
    return state.sleeves.map(s => ({ ...s, symbols: [...s.symbols], outcomes: { ...s.outcomes } }))
}

/** Test seam — the process-level list, and the one-time run subscription that goes with it. */
export function _resetSleeves() { state.sleeves = []; state.subscribed = false }

const _sym = s => String(s ?? '').toUpperCase().trim()

/**
 * Source one sleeve: screen → queue → run → (later) card. Never throws; the caller is a stream
 * handler that has already answered the user.
 *
 * `userId` is who asked and who gets the card; `threadId`/`portfolioId` are where the build lives so
 * the card can reopen it. The research itself runs as the house (see the header).
 *
 * → { ok:true, sleeve } once the names are queued and the run is going or will be; or
 *   { ok:false, reason } — 'passive' (never screens), 'sector_required', 'nothing_screened' (the pond
 *   was empty or the screener failed), 'all_covered' (every hit is already in the book — the card is
 *   posted at once, since there is nothing to wait for), 'queue_unavailable'.
 */
export async function sourceSleeve(req, deps = _io) {
    const { userId, threadId = null, portfolioId = null, portfolioName = null, sector, industry = null, note = null } = req ?? {}
    const school = normalizeSelection(req?.school)
    if (!userId)               return { ok: false, reason: 'user_required' }
    if (school === 'passive')  return { ok: false, reason: 'passive' }
    if (!sector)               return { ok: false, reason: 'sector_required' }

    const symbols = await deps.screen(screenFiltersFor(sector, school, { industry }))
    if (!symbols.length) {
        logger.info(LOG, 'nothing screened — sleeve not sourced', { sector, school, industry })
        return { ok: false, reason: 'nothing_screened' }
    }

    let covered
    try { covered = await deps.coveredSymbols() }
    catch (err) { covered = new Set(); logger.warn(LOG, 'coverage book unreadable — queuing every hit, the run will skip the covered ones', err.message) }
    const fresh = symbols.filter(s => !covered.has(s))

    const sleeve = {
        id: `slv_${randomUUID().slice(0, 8)}`,
        userId: String(userId), threadId, portfolioId, portfolioName,
        sector, school, industry,
        symbols:     fresh,
        // symbol → 'covered' | 'passed' | 'skipped' | 'failed' | 'unresolved', filled as runs settle
        outcomes:    {},
        alreadyCovered: symbols.length - fresh.length,
        requestedAt: new Date().toISOString(),
        // The run's identity: the house. Null userId → no per-user accounting, no budget degrade, the
        // agent's own default model and audience.
        run: { userId: null, audience: null, model: null },
    }

    if (!fresh.length) {
        // The pool was not empty after all — every screened name is in the book. Atlas's filter
        // (sector + school) was narrower than the book; the card says so and the user resumes.
        logger.info(LOG, 'every screened name is already covered — telling Atlas now', { sector, school, screened: symbols.length })
        await _settle(sleeve, deps)
        return { ok: false, reason: 'all_covered', sleeve: _pub(sleeve) }
    }

    let queued = 0
    for (const symbol of fresh) {
        const res = await deps.enqueue({
            symbol, source: 'argus', requestedBy: sleeve.userId,
            // The mandate travels WITH the name (researchQueue.enqueue): Prometheus reads the sleeve
            // and the school off the row, and the run's opening sentence is built from them.
            context: { sector, school, industry, note, sleeve: { id: sleeve.id, userId: sleeve.userId, threadId, portfolioId } },
        })
        if (res.ok) queued++
        // A duplicate is a name another sleeve (or the house scan) already queued — it is still ours to
        // wait for, under the reason it was FIRST queued with. Not ok at all → the run will never see
        // it; drop it from the sleeve so it cannot hold the card hostage.
        else sleeve.symbols = sleeve.symbols.filter(s => s !== symbol)
    }
    if (!sleeve.symbols.length) return { ok: false, reason: 'queue_unavailable' }

    state.sleeves.push(sleeve)
    _subscribe(deps)
    logger.info(LOG, 'sleeve queued', { id: sleeve.id, sector, school, screened: symbols.length, queued, alreadyCovered: sleeve.alreadyCovered })

    await _kick(sleeve, deps)
    return { ok: true, sleeve: _pub(sleeve) }
}

/** Start the run for a sleeve, or note that one is already going and will settle it. */
async function _kick(sleeve, deps) {
    const res = await deps.startRun(sleeve.run)
    if (res.ok) { logger.info(LOG, 'research run started for sleeve', { sleeve: sleeve.id, run: res.run?.id }); return }
    if (res.reason === 'already_running') { logger.info(LOG, 'a run is already going — the sleeve waits for it', { sleeve: sleeve.id }); return }
    // nothing_queued: our rows are gone (rejected by hand, or researched by a run that beat us to
    // the read). Settle on what the queue says rather than wait for a run that will never come.
    if (res.reason === 'nothing_queued') { await _reconcile(sleeve, deps); return }
    logger.warn(LOG, 'research run could not start — the sleeve waits for the next Start', { sleeve: sleeve.id, reason: res.reason })
}

function _subscribe(deps) {
    if (state.subscribed) return
    state.subscribed = true
    deps.onRunSettled(run => _onRunSettled(run, deps))
}

/**
 * A run ended. Absorb its outcomes into every pending sleeve, settle the ones with nothing left to
 * wait for, and — when the run ended cleanly but a sleeve still has names in the queue (it listed
 * the queue before they were on it) — start the next run. A run the admin STOPPED, or one that
 * failed on the account, is not restarted from here: that decision was theirs, and the sleeve waits
 * for the next Start like any queued name.
 */
async function _onRunSettled(run, deps = _io) {
    if (!state.sleeves.length) return
    const results = new Map((run?.results ?? []).map(r => [_sym(r.symbol), r.outcome]))
    for (const sleeve of [...state.sleeves]) {
        for (const symbol of sleeve.symbols) {
            const outcome = results.get(symbol)
            if (outcome && outcome !== 'stopped') sleeve.outcomes[symbol] = outcome
        }
        if (_remaining(sleeve).length === 0) { await _settle(sleeve, deps); continue }
        if (run?.status === 'done') await _kick(sleeve, deps)
        else logger.info(LOG, `run ${run?.status} with sleeve names still queued — waiting for the next Start`, { sleeve: sleeve.id, remaining: _remaining(sleeve).length })
    }
}

const _remaining = sleeve => sleeve.symbols.filter(s => !sleeve.outcomes[s])

/**
 * Nothing is queued but the sleeve still has names without an outcome: they were decided outside a
 * run this process saw (rejected by hand, researched at the desk). Read the queue, close them as
 * `unresolved`, and settle — a card that never comes is worse than one that says "check the book".
 */
async function _reconcile(sleeve, deps) {
    const rows = await deps.listQueue({ status: ['queued', 'in_research'] })
    if (rows === null) { logger.warn(LOG, 'queue unreadable — sleeve waits', { sleeve: sleeve.id }); return }
    const held = new Set(rows.map(r => _sym(r.symbol)))
    for (const s of _remaining(sleeve)) if (!held.has(s)) sleeve.outcomes[s] = 'unresolved'
    if (_remaining(sleeve).length === 0) await _settle(sleeve, deps)
}

async function _settle(sleeve, deps) {
    state.sleeves = state.sleeves.filter(s => s !== sleeve)
    const card = buildSleeveSourced(sleeve)
    const msg  = await deps.post(card, { tag: 'Sleeve-sourced card', log: LOG })
    logger.info(LOG, 'sleeve settled', { id: sleeve.id, sector: sleeve.sector, covered: card?.payload?.covered?.length ?? 0, of: sleeve.symbols.length, posted: !!msg })
}

const _pub = s => ({ id: s.id, sector: s.sector, school: s.school, symbols: [...s.symbols], alreadyCovered: s.alreadyCovered })

// ─── The card ───────────────────────────────────────────────────────────────────

const _by = (sleeve, outcome) => sleeve.symbols.filter(s => sleeve.outcomes[s] === outcome)

/**
 * Atlas's "sleeve sourced" card for the user who asked. Pure → { userId, content, type, payload,
 * botId, actions, visibility, forUserId } or null with no user.
 *
 * Copy leads with what Atlas can now DO — how many of the sleeve's names are in coverage — because
 * that is the number the build turns on. Names that passed (no edge) are said, not hidden: "twelve
 * screened, two covered" reads as a failure unless the reader knows ten were judged and declined.
 */
export function buildSleeveSourced(sleeve) {
    if (!sleeve?.userId || !sleeve?.sector) return null
    // `skipped` is the run finding the name already covered — by hand, between the screen and the
    // turn. To the build it is a covered name, so it reads as one; the payload keeps them apart.
    const written    = _by(sleeve, 'covered')
    const skipped    = _by(sleeve, 'skipped')
    const covered    = [...written, ...skipped]
    const passed     = _by(sleeve, 'passed')
    const failed     = _by(sleeve, 'failed')
    const unresolved = _by(sleeve, 'unresolved')
    const inBook     = covered.length + (sleeve.alreadyCovered ?? 0)
    const school     = sleeve.school ? ` (${sleeve.school})` : ''

    let content
    if (!sleeve.symbols.length) {
        content = `${sleeve.sector} sleeve${school}: every name the screen found is already in coverage (${sleeve.alreadyCovered}). Resume the build — Atlas allocates from what is there.`
    } else if (covered.length) {
        const tail = [
            passed.length     ? `${passed.length} passed on (no edge)` : null,
            failed.length     ? `${failed.length} failed to save`       : null,
            unresolved.length ? `${unresolved.length} left the queue unresearched` : null,
        ].filter(Boolean).join(', ')
        content = `${sleeve.sector} sleeve sourced${school}: ${covered.length} of ${sleeve.symbols.length} screened names now in coverage — ${covered.join(', ')}${tail ? `; ${tail}` : ''}. Resume the build and Atlas allocates from coverage.`
    } else {
        content = `${sleeve.sector} sleeve${school}: Prometheus researched ${sleeve.symbols.length} screened names and put none into coverage`
            + (passed.length ? ` (${passed.length} no edge${failed.length ? `, ${failed.length} failed to save` : ''})` : '')
            + `. Resume the build — Atlas will say what the pool holds, or broaden the filter.`
    }

    return {
        userId:  sleeve.userId,
        content,
        type:    'sleeve_sourced',
        payload: {
            kind: 'portfolio', sleeveId: sleeve.id,
            sector: sleeve.sector, school: sleeve.school ?? null,
            portfolioId: sleeve.portfolioId ?? null, threadId: sleeve.threadId ?? null,
            screened: sleeve.symbols.length, inBook,
            covered: written, skipped, passed, failed, unresolved,
        },
        botId:      'portfolio',
        actions:    cardActions('Resume build'),
        // The build is this user's; nobody else's feed should carry it.
        visibility: 'own',
        forUserId:  sleeve.userId,
    }
}

// ─── IO ─────────────────────────────────────────────────────────────────────────
// The screener is imported lazily so the unit tests (which inject stubs) never load the provider
// stack. Everything else is the same service the house scan and the admin's Start use.
const _io = {
    async screen(filters) {
        try {
            const { screenCandidatesRaw } = await import('../providers/fmp.provider.js')
            const rows = await screenCandidatesRaw(filters)
            return [...new Set(rows.map(r => _sym(r.symbol)).filter(Boolean))]
        } catch (err) {
            logger.warn(LOG, `sector screen failed: ${filters?.sector}`, err.message)
            return []
        }
    },
    async coveredSymbols() {
        const { coverageService } = await import('../api/analyst/coverage.service.js')
        return new Set(await coverageService.listSymbols({ onError: 'throw' }))
    },
    enqueue:      (args) => researchQueueService.enqueue(args),
    listQueue:    (q)    => researchQueueService.listQueue(q),
    startRun:     (args) => researchRunService.startRun(args),
    onRunSettled: (fn)   => onRunSettled(fn),
    post:         (card, ctx) => postCard(card, ctx),
}

export const sleeveSourceService = { sourceSleeve, pendingSleeves }
