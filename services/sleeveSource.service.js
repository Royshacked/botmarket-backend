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
import { config }               from './config.js'
import { normalizeSector }      from './entity/vocabulary.js'

const LOG = '[sleeveSource]'

// Minimum daily volume: below this a name is too illiquid to research meaningfully (the deleted house scan's bar).
const MIN_VOLUME = 500_000
// Names per sleeve. A sleeve needs four to eight PLACEABLE names, and the run passes on some (no
// edge) — twelve is enough pond for that and still under an hour of Prometheus. Not conviction-
// scaled like the house scan: a sleeve is a slot in a book, not a stance with a weight on it.
export const SLEEVE_HITS = 12
// The wider screen when Pythia rates long-term industries in the sector (docs/design/argus-on-pythia.md §3.5): the
// house's names are found INSIDE the same school screen, so every floor (cap, dividend, volume) holds for them too.
// 50 is the screener's own ceiling (fmp.provider _buildScreenQs).
export const HOUSE_POOL = 50

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

// ─── An industry sleeve (docs/design/atlas-industry-sleeves.md, Roy 2026-10-19) ─────────────────────────────────
// A sleeve is one GICS sub-industry, and its names come from the house's OWN GICS table (gics_companies) — not the
// screener, whose industry names are not GICS's ("Software - Application" vs "Application Software"), so a GICS name
// handed to it screened to nothing. The companies the house's assessment names come first, then the rest by market
// cap, over the school's floor; at most SLEEVE_HITS (Roy: max 12). Too few → the sector screen fills in, keeping only
// the names the table puts in THIS sub-industry (a neighbour's names are not this sleeve's).
export const MIN_INDUSTRY_NAMES = 4
const INDUSTRY_POOL = 40

/**
 * One sub-industry's names → `{ symbols, house }`. `rows`: its gics_companies rows (largest first); `named`: the symbols
 * its standing assessment names. A row with no market cap is kept — Prometheus applies the school's real bar. Pure.
 */
export function industryPick(rows, named, school = null, { hits = SLEEVE_HITS } = {}) {
    const floor = (SCHOOL_SCREEN[normalizeSelection(school)] ?? SCHOOL_SCREEN.default).marketCapMoreThan ?? 0
    const syms  = (rows ?? []).filter(r => r?.symbol && !(typeof r.market_cap === 'number' && r.market_cap < floor)).map(r => _sym(r.symbol))
    const house = syms.filter(s => named?.has(s))
    const symbols = [...new Set([...house, ...syms])].slice(0, hits)
    return { symbols, house: house.filter(s => symbols.includes(s)) }
}

/**
 * The names that trade as a live, liquid stock — in order, at most `hits`. The GICS table holds a real company's notes,
 * preferreds and thin OTC lines beside its stock (a payments sleeve picked BSQKZ, Block's notes, 2026-10-19); the
 * screener path has its volume floor, and this is the same floor (MIN_VOLUME). A profile that cannot be read → not
 * taken; NONE readable → the provider is down, and the names go on unchecked (Prometheus still judges each).
 */
async function _tradable(symbols, deps, hits = SLEEVE_HITS) {
    if (!deps.listingFacts) return symbols.slice(0, hits)
    const out = []
    let read = 0
    for (const s of symbols) {
        if (out.length >= hits) break
        let f = null
        try { f = await deps.listingFacts(s) } catch { f = null }
        if (f) read++
        if (f && f.activelyTrading && !f.fund && (f.averageVolume ?? 0) >= MIN_VOLUME) out.push(s)
    }
    if (!read && symbols.length) {
        logger.warn(LOG, 'no listing readable — the industry sleeve goes on unchecked', { names: symbols.length })
        return symbols.slice(0, hits)
    }
    return out
}

/** The industry sleeve's names, with the sector screen's fill when the table is thin. → `{ sub, symbols, house }` or `{ reason }`. */
async function _industrySleeve(code, school, deps) {
    let sub = null
    try { sub = await deps.subIndustry(code) } catch (err) { logger.warn(LOG, 'sub-industry unreadable', err.message) }
    if (!sub?.code) return { reason: 'industry_unknown' }
    let rows = [], named = new Set()
    try { rows = await deps.industryCompanies(sub.code, INDUSTRY_POOL) ?? [] } catch (err) { logger.warn(LOG, 'industry companies unreadable', err.message) }
    try { named = await deps.industryNamed(sub.code) ?? new Set() } catch (err) { logger.warn(LOG, 'industry assessment unreadable — no house names first', err.message) }
    // The whole ordered pool, then only what trades — so a junk line does not cost the sleeve a slot.
    let { symbols, house } = industryPick(rows, named, school, { hits: INDUSTRY_POOL })
    symbols = await _tradable(symbols, deps)
    house = house.filter(s => symbols.includes(s))
    if (symbols.length < MIN_INDUSTRY_NAMES) {
        const sector = normalizeSector(sub.sector)
        if (sector) {
            const screened = await deps.screen(screenFiltersFor(sector, school, { limit: HOUSE_POOL }))
            let industryOf = {}
            try { industryOf = await deps.industryOf(screened) ?? {} } catch (err) { logger.warn(LOG, 'industries unreadable — no fill from the screen', err.message) }
            const fill = screened.filter(s => industryOf[s] === sub.code && !symbols.includes(s))
            symbols = [...symbols, ...fill].slice(0, SLEEVE_HITS)
        }
    }
    return { sub, symbols, house }
}

/**
 * The house's long-term industries FIRST, up to `max` of the `hits`, the rest of the screen after them, in the
 * screen's order. A ceiling, not a quota: a short house list takes what it has. `industryOf` maps a symbol to its
 * GICS sub-industry code; `houseCodes` is the set Pythia rates for long term. Pure → `{ symbols, house }`.
 */
export function houseFirst(screened, industryOf, houseCodes, { hits = SLEEVE_HITS, max = 6, named = null } = {}) {
    const cap = Math.max(0, Math.min(Number(max) || 0, hits))
    // A company the house's assessments NAME counts as a house name wherever it is classified (pythia-names.md §4.3).
    const house = (screened ?? []).filter(s => named?.has(s) || houseCodes?.has(industryOf?.[s])).slice(0, cap)
    const taken = new Set(house)
    const rest = (screened ?? []).filter(s => !taken.has(s)).slice(0, hits - house.length)
    return { symbols: [...house, ...rest], house }
}

/**
 * The sub-industry codes Pythia rates for long term in the sector, and the companies those assessments NAME
 * (pythia-names.md) → `{ codes, named }`; both empty on any failure (the sleeve screens as before).
 * An industry the house rates AVOID on its own can arrive through a long-term theme (listed, marked) — it never goes
 * ahead of the screen in a sleeve (code review 2026-10-13), and neither do its names; they can still come through the screen.
 */
async function _house(sector, deps) {
    const none = { codes: new Set(), named: new Set() }
    if (!deps.houseIndustries) return none
    try {
        const entries = (await deps.houseIndustries(sector) ?? []).filter(e => e?.code && !e.avoid)
        const named = entries.flatMap(e => [...(e.names ?? []), ...(e.themes ?? []).flatMap(t => t.names ?? [])]).map(n => n?.symbol).filter(Boolean)
        return { codes: new Set(entries.map(e => e.code)), named: new Set(named) }
    } catch (err) { logger.warn(LOG, 'house industries unreadable — the sleeve screens without them', err.message); return none }
}

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
    const { userId, threadId = null, sessionId = null, portfolioId = null, portfolioName = null, industryCode = null, note = null } = req ?? {}
    let { sector = null, industry = null } = req ?? {}
    const school = normalizeSelection(req?.school)
    if (!userId)               return { ok: false, reason: 'user_required' }
    if (school === 'passive')  return { ok: false, reason: 'passive' }
    if (!sector && !industryCode) return { ok: false, reason: 'sector_required' }

    let symbols = [], fromHouse = [], code = null
    if (industryCode) {
        // A GICS sub-industry sleeve: the house's own table, the companies it names first (see _industrySleeve).
        const picked = await _industrySleeve(industryCode, school, deps)
        if (picked.reason) return { ok: false, reason: picked.reason }
        ;({ symbols, house: fromHouse } = picked)
        code = picked.sub.code
        sector = picked.sub.sector ?? sector
        industry = picked.sub.name
    } else {
        // Pythia's long-term industries in the sector go first (a preference, not a filter — Roy, 2026-10-13): the screen
        // widens so they can be found inside it, then they take up to half the sleeve and the screen fills the rest.
        const { codes: houseCodes, named } = await _house(sector, deps)
        const wide = houseCodes.size > 0 || named.size > 0
        symbols = await deps.screen(screenFiltersFor(sector, school, { industry, limit: wide ? HOUSE_POOL : SLEEVE_HITS }))
        if (wide && symbols.length) {
            let industryOf = {}
            try { industryOf = await deps.industryOf(symbols) ?? {} }
            catch (err) { logger.warn(LOG, 'industries unreadable — the sleeve takes the screen in its order', err.message) }
            ;({ symbols, house: fromHouse } = houseFirst(symbols, industryOf, houseCodes, { max: deps.houseMax?.() ?? config.sleeveHouseMax, named }))
        }
    }
    if (!symbols.length) {
        logger.info(LOG, 'nothing screened — sleeve not sourced', { sector, school, industry, industryCode: code })
        return { ok: false, reason: 'nothing_screened' }
    }

    let covered
    try { covered = await deps.coveredSymbols() }
    catch (err) { covered = new Set(); logger.warn(LOG, 'coverage book unreadable — queuing every hit, the run will skip the covered ones', err.message) }
    const fresh = symbols.filter(s => !covered.has(s))

    const sleeve = {
        id: `slv_${randomUUID().slice(0, 8)}`,
        userId: String(userId), threadId, portfolioId, portfolioName,
        // A sleeve sourced from the unified chat settles INTO that session's chain (onSleeveSettled), not as a card.
        sessionId: sessionId ? String(sessionId) : null,
        screened:  symbols.length,
        sector, school, industry,
        // Set for an industry sleeve — its GICS code; the card names the industry and counts the house's named companies.
        industryCode: code,
        symbols:     fresh,
        // Which of them came from Pythia's long-term industries — the card says how many.
        house:       fromHouse.filter(s => !covered.has(s)),
        // symbol → 'covered' | 'passed' | 'skipped' | 'failed' | 'unresolved', filled as runs settle
        outcomes:    {},
        alreadyCovered: symbols.length - fresh.length,
        requestedAt: new Date().toISOString(),
        // The run's identity: the house. Null userId → no per-user accounting, no budget degrade, the
        // agent's own default model and audience.
        // A user's sleeve researches ITS names only — not the house queue beside it (code review 2026-10-11: the house
        // scan's rows rode on a user's sleeve request, at the house's cost).
        run: { userId: null, audience: null, model: null, symbols: [...fresh] },
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
    logger.info(LOG, 'sleeve queued', { id: sleeve.id, sector, school, screened: symbols.length, queued, alreadyCovered: sleeve.alreadyCovered, house: sleeve.house.length })

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

// ─── Settling into a session (unified-chat plan phase 5d) ───────────────────────
// A sleeve sourced from a session settles into its chain — Argus's line, then the coverage handed to Atlas —
// instead of a card. The chain runner registers the hook (services/desks/turns.js), so this module never
// imports the chain. The hook answers whether it took the sleeve; if not (no hook, the session is gone), the
// card is posted exactly as for a sleeve from the old path.
let _settledHook = null
export function onSleeveSettled(fn) { _settledHook = fn }

async function _settle(sleeve, deps) {
    state.sleeves = state.sleeves.filter(s => s !== sleeve)
    if (sleeve.sessionId && _settledHook) {
        const taken = await Promise.resolve(_settledHook(sleeve, sleeveOutcome(sleeve))).catch(err => {
            logger.warn(LOG, 'settling into the session failed — posting the card instead', err.message)
            return false
        })
        if (taken) { logger.info(LOG, 'sleeve settled into its session', { id: sleeve.id, sessionId: sleeve.sessionId }); return }
    }
    const card = buildSleeveSourced(sleeve)
    const msg  = await deps.post(card, { tag: 'Sleeve-sourced card', log: LOG })
    logger.info(LOG, 'sleeve settled', { id: sleeve.id, sector: sleeve.sector, covered: card?.payload?.covered?.length ?? 0, of: sleeve.symbols.length, posted: !!msg })
}

const _pub = s => ({ id: s.id, sector: s.sector, industry: s.industry ?? null, industryCode: s.industryCode ?? null, school: s.school, symbols: [...s.symbols], alreadyCovered: s.alreadyCovered, house: [...(s.house ?? [])] })

// ─── The card ───────────────────────────────────────────────────────────────────

const _by = (sleeve, outcome) => sleeve.symbols.filter(s => sleeve.outcomes[s] === outcome)

/**
 * What a settled sleeve came to — ONE reading for the card and for the chain's line. Pure.
 * `skipped` is the run finding the name already covered between the screen and the turn: to the build it
 * is a covered name, so `covered` includes it.
 */
export function sleeveOutcome(sleeve) {
    const written = _by(sleeve, 'covered')
    const skipped = _by(sleeve, 'skipped')
    return {
        written, skipped,
        covered:    [...written, ...skipped],
        passed:     _by(sleeve, 'passed'),
        failed:     _by(sleeve, 'failed'),
        unresolved: _by(sleeve, 'unresolved'),
        screened:   sleeve.screened ?? (sleeve.symbols.length + (sleeve.alreadyCovered ?? 0)),
    }
}

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
    // `skipped` names read as covered to the build; the payload keeps them apart (sleeveOutcome).
    const { written, skipped, covered, passed, failed, unresolved } = sleeveOutcome(sleeve)
    const inBook     = covered.length + (sleeve.alreadyCovered ?? 0)
    const school     = sleeve.school ? ` (${sleeve.school})` : ''
    const house      = (sleeve.house ?? []).filter(s => sleeve.symbols.includes(s))
    // An industry sleeve is named by its industry, and its house names are the ones the house's assessment names.
    const label      = sleeve.industryCode && sleeve.industry ? sleeve.industry : sleeve.sector
    const houseLine  = !house.length ? ''
        : sleeve.industryCode ? ` ${house.length} of the ${sleeve.symbols.length} are named in the house's assessment of the industry.`
        : ` ${house.length} of the ${sleeve.symbols.length} came from the house's long-term industries.`

    let content
    if (!sleeve.symbols.length) {
        content = `${label} sleeve${school}: every name the screen found is already in coverage (${sleeve.alreadyCovered}). Resume the build — Atlas allocates from what is there.`
    } else if (covered.length) {
        const tail = [
            passed.length     ? `${passed.length} passed on (no edge)` : null,
            failed.length     ? `${failed.length} failed to save`       : null,
            unresolved.length ? `${unresolved.length} left the queue unresearched` : null,
        ].filter(Boolean).join(', ')
        content = `${label} sleeve sourced${school}: ${covered.length} of ${sleeve.symbols.length} screened names now in coverage — ${covered.join(', ')}${tail ? `; ${tail}` : ''}. Resume the build and Atlas allocates from coverage.${houseLine}`
    } else {
        content = `${label} sleeve${school}: Prometheus researched ${sleeve.symbols.length} screened names and put none into coverage`
            + (passed.length ? ` (${passed.length} no edge${failed.length ? `, ${failed.length} failed to save` : ''})` : '')
            + `. Resume the build — Atlas will say what the pool holds, or broaden the filter.${houseLine}`
    }

    return {
        userId:  sleeve.userId,
        content,
        type:    'sleeve_sourced',
        payload: {
            kind: 'portfolio', sleeveId: sleeve.id,
            sector: sleeve.sector, industry: sleeve.industry ?? null, industryCode: sleeve.industryCode ?? null, school: sleeve.school ?? null,
            portfolioId: sleeve.portfolioId ?? null, threadId: sleeve.threadId ?? null,
            screened: sleeve.symbols.length, inBook,
            covered: written, skipped, passed, failed, unresolved, house,
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
    // Pythia's long-term industries in the sector (listForBook entries), and each screened symbol's GICS sub-industry
    // (argus-on-pythia.md §3.5).
    async houseIndustries(sector) {
        const { industryAssessmentService } = await import('../api/strategy/industryAssessment.service.js')
        return industryAssessmentService.listForBook('long_term', { sector })
    },
    async industryOf(symbols) {
        const { readCompaniesBySymbol } = await import('../api/strategy/industryData.service.js')
        return Object.fromEntries(Object.entries(await readCompaniesBySymbol(symbols)).map(([s, r]) => [s, r.sub_code]))
    },
    // Whether a listing trades (an industry sleeve's names are checked — see _tradable).
    async listingFacts(symbol) {
        const { getListingFacts } = await import('../providers/fmp.provider.js')
        return getListingFacts(symbol)
    },
    // An industry sleeve's reads (atlas-industry-sleeves.md): the sub-industry, its companies, and the ones the house names.
    async subIndustry(code) {
        const { readSubIndustry } = await import('../api/strategy/industryData.service.js')
        const b = await readSubIndustry(code)
        return b?.sub ? { code: b.sub.code, name: b.sub.name, sector: b.sub.sector ?? null } : null
    },
    async industryCompanies(code, limit) {
        const { readCompanies } = await import('../api/strategy/industryData.service.js')
        return readCompanies('sub_industry', code, { limit })
    },
    // First-order names of a STANDING assessment only — a second-order name sits in another industry, and an expired
    // assessment is due for reassessment. A sleeve is the long-term book: a standing long-term yes keeps its names after
    // the near term expires (pythia-two-verdicts.md; code review 2026-10-31).
    async industryNamed(code) {
        const { industryAssessmentService, longTermYes } = await import('../api/strategy/industryAssessment.service.js')
        const a = await industryAssessmentService.getAssessment(code)
        const now = new Date().toISOString()
        if (!a || (a.expires_at && a.expires_at <= now && !longTermYes(a, now))) return new Set()
        return new Set((a.names ?? []).filter(n => n?.order !== 'second').map(n => _sym(n.symbol)).filter(Boolean))
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
