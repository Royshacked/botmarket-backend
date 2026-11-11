// MENTOR'S READS — the chain's code half of step 3 (docs/design/argus-rework.md §2, step 3; Roy, 2026-11-11).
//
// Before Mentor builds a trade, Prometheus's read on the name FOR THE HORIZON must be in front of him. Whether it exists,
// and running the missing one, is CODE — never Mentor's call, never a tool he may forget:
//
//   swing / long term   → Prometheus's COVERAGE (it is the 3–6 / 12–24 month target)
//   short term swing    → his CATALYST read (the one This week already runs)
//   intraday / day      → none (a 10:30 move has nothing for him to judge; the day board's catalyst is the read)
//
// A missing read is QUEUED on the research queue (source `mentor`) and the house's run is started — as the HOUSE, not the
// user, the sleeve rule (sleeveSource.service): coverage is a house artifact. It WAITS IN LINE (Roy, 2026-11-11): one
// shared run, no priority, no second lane — Mentor says how many names are ahead. When a run settles (onRunSettled) each
// pending read is checked; a landed one goes to the settle hook (the chain runner's `readSettled`, which hands Mentor
// the read and runs his turn); one still waiting starts the next run if none is going.
//
// A PASS IS AN ANSWER. Coverage passed on (no edge), or a catalyst read with no target, is the read — "against the trade"
// — and is not asked for again: Mentor states it and asks the user once (Roy: the user decides).
//
// ONE PROCESS, IN MEMORY, like the sleeves — but a restart does not lose the hand-off: the session rides on the queue row,
// and `resumePending` (at boot) finds the waiting reads again.

import { coverageService, VIEW_HORIZONS } from '../api/analyst/coverage.service.js'
import { catalystReadService, readFacts } from './catalystRead.service.js'
import { researchQueueService } from './researchQueue.service.js'
import { researchRunService, onRunSettled, getRun } from './researchRun.service.js'
import { bookFacts } from './houseBook.service.js'
import { normalizeBuild, activeName } from './mentorBuild.util.js'
import { logger } from './logger.service.js'

const LOG = '[mentorReads]'
export const SOURCE = 'mentor'

/** The read each horizon needs; a horizon not here needs none. */
export const READ_OF = Object.freeze({ swing: 'coverage', 'long term': 'coverage', 'short term swing': 'catalyst' })
/** Coverage that is the read. Retired and `watchlist` (watched, never rated) are not: they are re-researched (`reinit`). */
const COVERAGE_LIVE = ['active', 'target_hit', 'thesis_broken']
const COVERAGE_STALE = ['retired', 'watchlist']
/** The book a build's horizon reads; and the target horizons each book takes (coverage.service VIEW_HORIZONS). */
const BOOK_OF_HORIZON = Object.freeze({ swing: 'swing', 'long term': 'long_term' })
/** A second-horizon view stands this long; then the name is asked again (two targets, stage 1). */
export const VIEW_FRESH_DAYS = 30
const BUY = new Set(['buy', 'strong_buy'])
/** How long a PASS stands as the answer before it may be asked again. A catalyst read's window is about a week. */
export const PASS_FRESH_DAYS = Object.freeze({ catalyst: 5, coverage: 30 })
const DAY_MS = 86_400_000
/** The queue's reasons that mean "researched, and passed" — an answer. */
const PASS_REASONS = new Set(['no_edge', 'no_read', 'horizon_off_book'])

const _deps = {
    coverage:     (s) => coverageService.getCoverageBySymbol(s),
    liveCatalyst: (s) => catalystReadService.liveRead(s),
    latestCatalyst: (s, o) => catalystReadService.latestRead(s, o),
    listQueue:    (q) => researchQueueService.listQueue(q),
    enqueue:      (row) => researchQueueService.enqueue(row),
    requeue:      (id) => researchQueueService.requeue(id),
    startRun:     (args) => researchRunService.startRun(args),
    getRun:       () => getRun(),
    now:          () => Date.now(),
}
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

/** The read a horizon needs: 'coverage' · 'catalyst' · null. Pure. */
export const readKindFor = (horizon) => READ_OF[String(horizon ?? '').toLowerCase()] ?? null

const _sym = (s) => String(s ?? '').toUpperCase().trim()
const _first = (t, n = 240) => { const s = String(t ?? '').trim(); const m = s.match(/^.{20,400}?[.!?](\s|$)/); return (m ? m[0] : s.slice(0, n)).trim() || null }
const _isCatalystRow = (r) => Boolean(r?.context?.hotlist)

/**
 * The name and horizon Mentor's build is on — from his LEDGER (mentorBuild.util): the active name and its SETTLED
 * horizon, the one the user confirmed (a claimed horizon is a guess, and a full coverage run is too dear to start on one).
 * Null when either is missing, or the horizon needs no read. Pure.
 */
export function readTarget(state) {
    const build = state?.draft?.build
    if (!build) return null
    const name = activeName(normalizeBuild(build))
    const symbol = _sym(name?.asset || state?.active_asset)
    const horizon = name?.settled?.horizon ?? null
    return symbol && readKindFor(horizon) ? { symbol, horizon } : null
}

/** The book a coverage's MAIN target sits in, by its horizon — or null. Pure. */
export function mainBookOf(cov) {
    return Object.keys(VIEW_HORIZONS).find(b => VIEW_HORIZONS[b].includes(cov?.price_target?.horizon)) ?? null
}

/**
 * A second-horizon view as the read → `{ facts, against }`: the view for the build's book first, the main coverage after
 * it as context. Against: the view is not a Buy, or the coverage's thesis is broken. Pure.
 */
export function viewRead(cov, view) {
    const t = view.target ?? {}
    const which = view.book === 'long_term' ? 'long-term' : 'swing'
    const head = `Prometheus's ${which} view: ${String(view.rating ?? 'unrated').replace('_', ' ')}, target ${Number(t.value).toFixed(2)} by ${t.target_date ?? '?'} (a ${t.horizon ?? '?'} target)`
    return {
        facts: [head, view.why ? `why: ${_first(view.why, 300)}` : null, view.kill?.length ? `what breaks it: ${view.kill.slice(0, 2).join('; ')}` : null,
            `his coverage (the main target): ${coverageRead(cov).facts}`].filter(Boolean).join('; '),
        against: !BUY.has(view.rating) || cov.status === 'thesis_broken',
    }
}

/** Coverage → `{ facts, against }`. Against: not a Buy, or its thesis broken / target already hit. Pure. */
export function coverageRead(cov) {
    const status = cov.status === 'thesis_broken' ? 'his thesis is BROKEN' : cov.status === 'target_hit' ? 'the target is already HIT' : null
    const thesis = _first(cov.thesis)
    return {
        facts: [bookFacts(cov).replace(/; researched at the desk$/, ''), status, thesis ? `thesis: ${thesis}` : null].filter(Boolean).join('; '),
        against: !BUY.has(cov.rating) || cov.status === 'thesis_broken' || cov.status === 'target_hit',
    }
}

/** A catalyst read → `{ facts, against }`. A pass (no target) is against: it says why. Pure. */
export function catalystRead(read) {
    if (read.status === 'active') return { facts: readFacts(read) ?? `Prometheus (${read.verdict}): ${_first(read.read) ?? 'read on file'}`, against: false }
    const why = _first(read.read)
    return { facts: `Prometheus (${read.verdict ?? 'unclear'}): no trade — ${String(read.pass_reason ?? 'pass').replace(/_/g, ' ')}${why ? `; ${why}` : ''}`, against: true }
}

/**
 * Where Prometheus's read on `symbol` for `horizon` stands. Never throws: a failed lookup reads as `unknown` (Mentor is
 * told the read could not be checked, and nothing is queued on a guess).
 * → `{ kind: null }` (the horizon needs none) · `{ kind, state: 'ready' | 'passed', facts, against }` ·
 *   `{ kind, state: 'waiting', ahead, running }` · `{ kind, state: 'missing' }` · `{ kind, state: 'unknown' }` ·
 *   `{ kind, state: 'failed', at, rowId? }` — the run claimed it and made nothing (a failed turn or save, a Stop, a
 *   claim a dead process left — CR 2026-11-11), or it vanished from this session's pending reads; not asked again
 *   until FAILED_HOLD_MS has passed. `opts.sessionId` scopes the second kind to the session it happened to (CR: one
 *   user's failure must not silently change another's build).
 */
export async function readFor(symbol, horizon, deps = _deps, { sessionId = null } = {}) {
    const kind = readKindFor(horizon)
    const sym = _sym(symbol)
    if (!kind || !sym) return { kind: null }
    try {
        const since = deps.now() - PASS_FRESH_DAYS[kind] * DAY_MS
        // What a coverage read NEEDS when it is not ready: `new` (no coverage), `view` (the coverage's target is on the
        // other book — two targets, stage 1) or `reinit` (retired / watchlist). It picks the queue rows that answer it.
        let need = null
        if (kind === 'coverage') {
            const book = BOOK_OF_HORIZON[String(horizon).toLowerCase()]
            const cov = await deps.coverage(sym)
            if (cov && COVERAGE_LIVE.includes(cov.status)) {
                if (mainBookOf(cov) === book) return { kind, state: 'ready', ...coverageRead(cov) }
                const v = cov.horizon_views?.[book]
                if (v && deps.now() - Date.parse(v.set_at) < VIEW_FRESH_DAYS * DAY_MS) return { kind, state: 'ready', view: true, ...viewRead(cov, v) }
                need = 'view'
            } else need = cov && COVERAGE_STALE.includes(cov.status) ? 'reinit' : 'new'
        } else {
            const live = await deps.liveCatalyst(sym)
            if (live) return { kind, state: 'ready', ...catalystRead(live) }
            // Only a PASS is an answer that stands (CR 2026-11-11): a read that hit its target, expired or was graded is
            // spent, and the name gets a fresh one.
            const last = await deps.latestCatalyst(sym, { sinceMs: since })
            if (last?.status === 'pass') return { kind, state: 'passed', ...catalystRead(last) }
        }
        const rows = await deps.listQueue({ symbols: [sym], status: ['queued', 'in_research', 'rejected'], limit: 50 })
        if (rows === null) return { kind, state: 'unknown' }
        const book = BOOK_OF_HORIZON[String(horizon).toLowerCase()]
        const answers = (r) => (need === 'view' ? r.context?.view === book : need === 'reinit' ? r.context?.reinit === true : need === 'new' ? !r.context?.view && !r.context?.reinit : true)
        const mine = rows.filter(r => _isCatalystRow(r) === (kind === 'catalyst') && answers(r))
        // A claim that carries a reason was decided against (researchRun leaves a failed turn, a failed save or a Stop
        // `in_research` with its reason), and one untouched past STALE_CLAIM_MS is a dead process's: neither is coming.
        const dead = mine.find(r => r.status === 'in_research' && (r.reason || deps.now() - Date.parse(r.updated_at ?? r.created_at) > STALE_CLAIM_MS))
        if (dead) return { kind, state: 'failed', at: Date.parse(dead.updated_at ?? dead.created_at), rowId: dead.id }
        const waiting = mine.find(r => r.status === 'queued' || r.status === 'in_research')
        if (waiting) return { kind, state: 'waiting', ...(need ? { need } : {}), ...(await _ahead(waiting, deps)) }
        const passed = mine.filter(r => r.status === 'rejected' && PASS_REASONS.has(r.reason) && Date.parse(r.updated_at ?? r.created_at) >= since).pop()
        if (passed) {
            return { kind, state: 'passed', against: true,
                facts: `Prometheus researched ${sym} on ${String(passed.updated_at ?? passed.created_at).slice(0, 10)} and passed — ${String(passed.reason).replace(/_/g, ' ')}; no ${kind === 'coverage' ? 'coverage' : 'catalyst target'}` }
        }
        const failedAt = sessionId ? _failed.get(`${sessionId}|${sym}|${kind}`) : null
        if (failedAt && deps.now() - failedAt < FAILED_HOLD_MS) return { kind, state: 'failed', at: failedAt, ...(need ? { need } : {}) }
        return { kind, state: 'missing', ...(need ? { need } : {}) }
    } catch (err) {
        logger.warn(LOG, 'read check failed', { symbol: sym, horizon, error: err.message })
        return { kind, state: 'unknown' }
    }
}

/** How many names are ahead of a waiting row: what the running run has left, and the queued rows before it. */
async function _ahead(row, deps) {
    const run = deps.getRun()
    const running = run?.status === 'running'
    const inRun = running ? Math.max(0, (run.total ?? 0) - (run.position ?? 0)) : 0
    if (row.status === 'in_research') return { ahead: 0, running: true }
    const queued = await deps.listQueue({ status: 'queued', limit: 1000 }) ?? []
    const before = queued.filter(q => String(q.created_at) < String(row.created_at)).length
    return { ahead: inRun + before, running }
}

// ─── Asking for a read ────────────────────────────────────────────────────────

const _pending = new Map()   // `${sessionId}|${symbol}|${kind}` → { sessionId, userId, symbol, horizon, kind, at }
// A read a run took and made nothing of, for ONE session: `${sessionId}|${symbol}|${kind}` → when. Held a day, so the user who was told "no read — build
// without it?" is not put back in line on the next turn, and the Generate gate (readPending) opens for them. In memory: a
// restart forgets it, and the next turn simply asks again.
const _failed = new Map()
export const FAILED_HOLD_MS = DAY_MS
/** A research claim untouched this long is a dead process's (a name takes ~4 minutes; requeueStale's own limit is longer). */
export const STALE_CLAIM_MS = 45 * 60 * 1000
let _subscribed = false
let _settledHook = null
/** The chain runner's hook: `(pending, read) → Promise<boolean>`. */
export function onReadSettled(fn) { _settledHook = fn }
/** Test seams. */
export function pendingReads() { return [..._pending.values()] }
export function _resetPending() { _pending.clear(); _failed.clear(); _subscribed = false; _settledHook = null; _settleChain = Promise.resolve() }

/**
 * Ask for the read a Mentor build on `symbol` / `horizon` needs, for this session: queue it unless it is already waiting,
 * start the run unless one is going, and remember the session so the read is handed to Mentor when it lands. Never throws.
 * → the read's state after asking (readFor's shape, plus `asked: true` when this call queued it), or `{ kind: null }`.
 */
export async function requestRead({ symbol, horizon, sessionId, userId }, deps = _deps) {
    const kind = readKindFor(horizon)
    const sym = _sym(symbol)
    if (!kind || !sym) return { kind: null }
    const before = await readFor(sym, horizon, deps, { sessionId })
    // A failure is held a day; after it, the name is asked again — its dead claim put back in line, or a new row.
    const retry = before.state === 'failed' && deps.now() - (before.at ?? 0) >= FAILED_HOLD_MS
    if (['ready', 'passed', 'unknown'].includes(before.state) || (before.state === 'failed' && !retry)) return before
    try {
        if (retry && before.rowId) {
            const back = await deps.requeue(before.rowId)
            if (back?.ok === false) { logger.warn(LOG, 'failed read not requeued', { symbol: sym, kind }); return before }
        }
        if (before.state === 'missing' || (retry && !before.rowId)) {
            // The session rides on the row, so a restart can find who was waiting (resumePending).
            const base = { mentor: true, horizon, ...(sessionId ? { sessionId: String(sessionId) } : {}),
                // A covered name's OTHER horizon (a <horizon_view>), or a retired / watchlist coverage re-researched.
                ...(before.need === 'view' ? { view: BOOK_OF_HORIZON[String(horizon).toLowerCase()] } : before.need === 'reinit' ? { reinit: true } : {}) }
            const context = kind === 'catalyst' ? { hotlist: true, requested: true, ...base } : base
            const res = await deps.enqueue({ symbol: sym, source: SOURCE, requestedBy: userId ? String(userId) : 'house', context })
            if (!res?.ok) { logger.warn(LOG, 'read not queued', { symbol: sym, kind, reason: res?.reason ?? null }); return { kind, state: 'unknown' } }
        }
        if (sessionId) _pending.set(`${sessionId}|${sym}|${kind}`, { sessionId, userId: userId ? String(userId) : null, symbol: sym, horizon, kind, at: deps.now() })
        _subscribe(deps)
        // The house runs it (userId null — sleeveSource's rule); a busy run is fine: it waits in line, and the settle
        // listener starts the next run. BY SYMBOL, NOT SOURCE: the row waiting may be another chain's (Pythia's week queued
        // the same name) — the user's read is that row's answer, so it is run, not left for its own chain's next run.
        const started = await deps.startRun({ userId: null, symbols: [sym] })
        if (!started?.ok && started?.reason !== 'already_running') logger.warn(LOG, 'read run not started', { symbol: sym, reason: started?.reason ?? null })
        logger.info(LOG, 'read asked for', { symbol: sym, kind, horizon, started: Boolean(started?.ok) })
    } catch (err) {
        logger.warn(LOG, 'read request failed', { symbol: sym, error: err.message })
        return { kind, state: 'unknown' }
    }
    // `asked`: this call queued it — the one time the chat is told the read is running (not on every turn after).
    if (sessionId) _failed.delete(`${sessionId}|${sym}|${kind}`)
    return { ...(await readFor(sym, horizon, deps, { sessionId })), asked: before.state === 'missing' || retry }
}

function _subscribe(deps) {
    if (_subscribed) return
    _subscribed = true
    // The settled run rides in (CR 2026-11-11): only a run that finished cleanly may start the next — a run that failed
    // on the ACCOUNT (no credit, a bad key) requeues its row, and restarting on it was an endless loop of paid calls;
    // a Stop is the admin's. Passes run ONE AT A TIME (the chain below), or two quick settles hand one read on twice.
    onRunSettled((run) => { settlePending(deps, run).catch(err => logger.warn(LOG, 'settle pass failed', { error: err.message })) })
}

let _settleChain = Promise.resolve()

/**
 * After a run settles: every pending read that landed (ready or passed) goes to the hook and is forgotten, and so does
 * one the run left with nothing (`failed`); if any still wait and no run is going, the next run is started for them.
 * An `unknown` (a failed lookup) is kept for the next settle. Exported for tests.
 */
export function settlePending(deps = _deps, run = { status: 'done' }) {
    const next = _settleChain.then(() => _settleOnce(deps, run))
    _settleChain = next.catch(() => {})
    return next
}

async function _settleOnce(deps, run) {
    const waiting = []
    for (const [key, p] of [..._pending]) {
        const r = await readFor(p.symbol, p.horizon, deps, { sessionId: p.sessionId })
        // A dead claim (a failed turn or save) is told as failed — like a row that vanished, below.
        if (r.state === 'ready' || r.state === 'passed' || r.state === 'failed') {
            _pending.delete(key)
            const taken = await Promise.resolve(_settledHook?.(p, r)).catch(err => { logger.warn(LOG, 'read hand-off failed', { symbol: p.symbol, error: err.message }); return false })
            if (!taken) logger.info(LOG, 'read landed with no session to take it', { symbol: p.symbol, sessionId: p.sessionId })
        } else if (r.state === 'waiting') {
            waiting.push(p.symbol)
        } else if (r.state === 'missing') {
            // Neither answered nor waiting after a run: the run took the row and made nothing of it (it failed to save,
            // or was stopped and cleared). Mentor is told, once, instead of the read waiting forever.
            _pending.delete(key)
            _failed.set(`${p.sessionId}|${p.symbol}|${p.kind}`, deps.now())
            await Promise.resolve(_settledHook?.(p, { kind: r.kind, state: 'failed' })).catch(() => false)
        }
    }
    if (waiting.length && run?.status === 'done' && deps.getRun()?.status !== 'running') {
        await deps.startRun({ userId: null, symbols: [...new Set(waiting)] }).catch(() => null)
    }
}

/**
 * Is the build's read still running (waiting, or about to be asked)? The Generate gate (Roy, 2026-11-11: "fix the rest" —
 * the prompt alone did not hold it): Mentor's readiness goes dark and a Generate press is refused while it is. A read
 * that is in, passed, failed or could not be checked does not hold anything — then it is the user's call. Never throws.
 */
export async function readPending(state, deps = _deps, { sessionId = null } = {}) {
    const t = readTarget(state)
    if (!t) return false
    const r = await readFor(t.symbol, t.horizon, deps, { sessionId })
    return r.state === 'waiting' || r.state === 'missing'
}

/**
 * At boot: the reads Mentor builds were waiting on before a restart, found again from their queue rows (the session rides
 * on the row), so they are handed on when they land — and the run is started for them if none is going. Never throws.
 */
export async function resumePending(deps = _deps) {
    try {
        const rows = await deps.listQueue({ source: SOURCE, status: ['queued', 'in_research'], limit: 500 })
        let n = 0
        for (const r of rows ?? []) {
            const sessionId = r.context?.sessionId
            if (!sessionId) continue
            const kind = _isCatalystRow(r) ? 'catalyst' : 'coverage'
            _pending.set(`${sessionId}|${r.symbol}|${kind}`, { sessionId, userId: r.requestedBy === 'house' ? null : r.requestedBy ?? null,
                symbol: r.symbol, horizon: r.context?.horizon ?? (kind === 'catalyst' ? 'short term swing' : 'swing'), kind, at: deps.now() })
            n++
        }
        if (!n) return { resumed: 0 }
        _subscribe(deps)
        if (deps.getRun()?.status !== 'running') await deps.startRun({ userId: null, symbols: [...new Set([..._pending.values()].map(p => p.symbol))] }).catch(() => null)
        logger.info(LOG, 'pending reads resumed after a restart', { resumed: n })
        return { resumed: n }
    } catch (err) {
        logger.warn(LOG, 'pending reads not resumed', { error: err.message })
        return { resumed: 0 }
    }
}

export const mentorReadsService = { readFor, requestRead, readKindFor, readTarget, readPending, resumePending, onReadSettled }
