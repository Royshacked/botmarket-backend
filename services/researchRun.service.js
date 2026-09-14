// Research run — the whole research queue, researched by Prometheus without anyone at the desk.
//
// The queue is worked one name at a time by hand: Start opens Prometheus on a name, the admin reads
// the stream, presses Initiate, walks back for the next. Thirty names from one publish is thirty of
// those — and each research turn is a four-minute stream, so it is also a tab that has to stay open
// for two hours. This runs the same turn HEADLESSLY on the server, name after name, and writes the
// coverage each one produces, so the admin's part moves to AFTER: read the book, revise what needs
// it (the coverage pencil → Prometheus in update mode).
//
// Every name is still the same agent, the same prompt and the same mandate context Argus stored
// with it (see researchQueue.enqueue) — only the audience changes, from a person watching to no one.
// What the run decides, and the reasons it leaves on the rows:
//
//   · a name the house already covers is SKIPPED (rejected, reason already_covered). Argus screens a
//     sector, not the book; whether the standing thesis needs a look under the new regime is a
//     judgment the pencil exists for, not something to overwrite by machine.
//   · a name Prometheus researched and emitted no <coverage> for is a PASS (rejected, reason
//     no_edge) — "no edge here" is a research outcome, and the row should say it was reached.
//   · a name whose coverage failed to save (an incoherent draft, a Mongo hiccup) stays in_research
//     with the error on the run, so it can be re-opened by hand or picked up by the next run.
//
// ONE run at a time, held in memory. It lives as long as the process does and no longer: the admin
// runs the backend on their own machine today, and a run that dies with it leaves nothing stranded —
// every row is a status in Mongo, the name that was mid-turn is `in_research` and re-openable, and
// starting again simply takes what is still queued. A `research_runs` collection is the day the
// backend outlives the laptop.

import { randomUUID } from 'crypto'
import { researchQueueService } from './researchQueue.service.js'
import { logger } from './logger.service.js'

const LOG = '[researchRun]'

// The singleton. `run` is the live one or the last one — a finished run stays readable until the
// next one replaces it, so the UI can show "done: 22 covered, 4 skipped" after the fact.
const state = { run: null, abort: null }

// Who wants to know when a run settles. The sleeve orchestrator (sleeveSource.service) listens so
// it can tell Atlas its names are researched — and start the next run when the one that just ended
// listed the queue before its names were on it. Called AFTER the run's own bookkeeping, so a listener
// reads the run as the UI will: status set, tallies final.
const _settledListeners = new Set()
export function onRunSettled(fn) { _settledListeners.add(fn); return () => _settledListeners.delete(fn) }

/** What the UI reads. Never the internal object — `abort` and `stop` are not the client's. */
export function getRun() {
    const r = state.run
    if (!r) return null
    const { stop, ...pub } = r   // eslint-disable-line no-unused-vars
    return { ...pub, results: [...pub.results] }
}

/**
 * Start a run over everything currently `queued`. Fire-and-forget: the loop runs on after this
 * returns, and the caller polls getRun (or the queue itself) for progress.
 *
 * `userId` is whose venue and audience the agent researches for — the admin's, since coverage is
 * house-owned but the research turn is still made through a user's tools and level. `model` is
 * passed through untouched: absent, the agent's own default (the same one the desk uses).
 */
export async function startRun({ userId, audience = null, model = null } = {}, deps = _io) {
    if (state.run?.status === 'running') return { ok: false, reason: 'already_running', run: getRun() }

    const queued = await deps.listQueue({ status: 'queued' })
    if (queued === null) return { ok: false, reason: 'queue_unavailable' }   // a failed read, not an empty queue
    if (!queued.length)  return { ok: false, reason: 'nothing_queued' }

    let covered
    try { covered = await deps.coveredSymbols() }
    catch (err) { logger.error(LOG, 'could not read the coverage book — run not started', err); return { ok: false, reason: 'coverage_unavailable' } }
    const run = {
        id:         `run_${randomUUID().slice(0, 8)}`,
        status:     'running',   // running → done | stopped | failed (the account, not a name — see isRunFatal)
        error:      null,        // the sentence behind `failed`
        startedAt:  new Date().toISOString(),
        finishedAt: null,
        total:      queued.length,
        position:   0,           // names decided so far (any outcome)
        current:    null,        // the symbol mid-turn
        covered:    0,
        skipped:    0,
        passed:     0,
        failed:     0,
        results:    [],          // { symbol, outcome, reason? }, in order
        stop:       false,
    }
    state.run   = run
    state.abort = new AbortController()
    logger.info(LOG, 'run starting', { id: run.id, total: run.total, alreadyCovered: queued.filter(q => covered.has(_sym(q.symbol))).length })

    // Clear only OUR controller. A settled-listener may start the next run before this loop's
    // promise resolves (the listener runs inside it), and nulling that run's controller would leave
    // it unstoppable.
    const abort = state.abort
    _loop(run, queued, covered, { userId, audience, model, signal: abort.signal }, deps)
        .catch(err => logger.error(LOG, 'run loop crashed', err))
        .finally(() => { if (state.abort === abort) state.abort = null })

    return { ok: true, run: getRun() }
}

/**
 * Stop after the current name. The turn in flight is aborted too — its row stays `in_research`,
 * which is exactly what a half-finished turn is, and Open on the row picks it up by hand.
 */
export function stopRun() {
    const r = state.run
    if (!r || r.status !== 'running') return { ok: false, reason: 'not_running' }
    r.stop = true
    state.abort?.abort()
    logger.info(LOG, 'run stop requested', { id: r.id, position: r.position, current: r.current })
    return { ok: true, run: getRun() }
}

/**
 * Every claimed name back to `queued`, so the next Start all takes them. Reads the QUEUE, not this
 * run's memory: the names a dead run left `in_research` outlive the process (the first batch run
 * lost its tally to the restart that fixed the account), and a claim with no coverage behind it
 * is the same thing however it got that way — a run that failed, a hand-opened turn lost to a
 * refresh. Skips and passes are decisions and are not touched: they are `rejected`, not claimed.
 *
 * While a run is going, the one name it is mid-turn on is left alone; everything else claimed is
 * fair game (the run only ever holds one).
 */
export async function requeueStalled(deps = _io) {
    const r = state.run
    const except = r?.status === 'running' && r.current ? [r.current] : []
    const res = await deps.requeueInResearch({ except })
    if (!res.ok) return { ok: false, reason: 'queue_unavailable' }
    return { ok: true, requeued: res.requeued }
}

async function _loop(run, queued, covered, { userId, audience, model, signal }, deps) {
    for (const item of queued) {
        if (run.stop) break
        const symbol = _sym(item.symbol)

        if (covered.has(symbol)) {
            await deps.reject(item.id, 'already_covered')
            _settle(run, { symbol, outcome: 'skipped', reason: 'already_covered' })
            run.skipped++
            continue
        }

        run.current = symbol
        await deps.startResearch(item.id)
        try {
            const { coverage } = await deps.research({ item, symbol, opening: researchOpening(item), covered, userId, audience, model, signal })
            if (run.stop) { _settle(run, { symbol, outcome: 'stopped' }); break }   // aborted mid-turn: row stays in_research

            if (!coverage) {
                await deps.reject(item.id, 'no_edge')
                _settle(run, { symbol, outcome: 'passed', reason: 'no_edge' })
                run.passed++
                continue
            }

            const saved = await deps.initiate(coverage)
            if (saved.ok) {
                await deps.markDone(item.id)
                covered.add(symbol)   // a later duplicate row (there should be none) is now a skip
                _settle(run, { symbol, outcome: 'covered', coverageId: saved.doc?.id ?? null })
                run.covered++
            } else if (saved.reason === 'already_covered') {
                // Covered between the run's read of the book and now — by hand, at the desk.
                await deps.reject(item.id, 'already_covered')
                _settle(run, { symbol, outcome: 'skipped', reason: 'already_covered' })
                run.skipped++
            } else {
                // Left in_research on purpose: the research happened, the save did not.
                _settle(run, { symbol, outcome: 'failed', reason: saved.reason ?? 'save_failed', detail: saved.detail ?? null })
                run.failed++
            }
        } catch (err) {
            if (run.stop) { _settle(run, { symbol, outcome: 'stopped' }); break }
            _settle(run, { symbol, outcome: 'failed', reason: _reason(err) })
            run.failed++
            // A refusal that is about the ACCOUNT, not the name — no credit, a bad key, no
            // permission — fails every name after it the same way. The first run hit this at
            // AZN and burned through 22 names in thirty seconds, each "failed" with the same
            // sentence. Stop on the first, and say why on the run.
            if (isRunFatal(err)) {
                run.error = _reason(err)
                logger.error(LOG, `run aborted at ${symbol}: the API refused the account, not the name`, run.error)
                break
            }
            logger.warn(LOG, `research failed: ${symbol} (run continues)`, _reason(err))
        }
    }
    run.current    = null
    run.status     = run.error ? 'failed' : run.stop ? 'stopped' : 'done'
    run.finishedAt = new Date().toISOString()
    logger.info(LOG, `run ${run.status}`, { id: run.id, total: run.total, covered: run.covered, skipped: run.skipped, passed: run.passed, failed: run.failed })
    for (const fn of _settledListeners) {
        try { await fn(getRun()) }
        catch (err) { logger.warn(LOG, 'a run-settled listener threw (run unaffected)', err.message) }
    }
}

/**
 * Would every later name fail the same way? True for the refusals that are about the account —
 * billing (Anthropic answers "credit balance is too low" as a 400 invalid_request_error, so the
 * text is the only tell), authentication and permission. A rate limit is NOT fatal: it clears.
 * Reads the SDK's shape (`status`, `error.error.type`) and falls back to the message, which is
 * what a streamed error arrives as.
 */
export function isRunFatal(err) {
    const status = err?.status ?? err?.statusCode
    if (status === 401 || status === 402 || status === 403) return true
    const type = err?.error?.error?.type ?? err?.error?.type
    if (type === 'authentication_error' || type === 'permission_error') return true
    return /credit balance|billing|api key|authentication/i.test(_reason(err))
}

/** One line for the row and the log. The SDK's message can be the whole JSON body — keep it short. */
function _reason(err) {
    const msg = err?.error?.error?.message ?? err?.error?.message ?? err?.message ?? String(err)
    return String(msg).slice(0, 300)
}

function _settle(run, result) {
    run.results.push(result)
    run.position++
    run.current = null
    logger.info(LOG, result.outcome, { symbol: result.symbol, reason: result.reason ?? null, position: `${run.position}/${run.total}` })
}

const _sym = s => String(s ?? '').toUpperCase().trim()

/**
 * The opening turn — the same sentence the desk sends when the admin presses Start (MainPage's
 * researchOpening), so a name researched by the run and one researched by hand are the same
 * instruction. Two copies because they are two repos; keep them saying the same thing.
 */
export function researchOpening(item) {
    const c = item?.context
    const symbol = _sym(item?.symbol)
    if (!c?.sector) return `Research ${symbol} for coverage.`
    // A SLEEVE candidate (sleeveSource): the mandate that surfaced it is a user's book, not the house
    // view, so the sentence names the sleeve and the selection school Prometheus has to judge it by.
    if (c.sleeve) {
        const school = c.school ? ` under a ${c.school} selection` : ''
        const note   = c.note ? ` (${c.note})` : ''
        return `Research ${symbol} for coverage — a candidate for the ${c.sector} sleeve of a portfolio build${school}${note}.`
    }
    const bp     = Number.isFinite(Number(c.active_bp)) ? ` +${c.active_bp}bp` : ''
    const regime = c.regime ? ` on a “${c.regime}” regime` : ''
    const basis  = c.basis ? ` (basis: ${String(c.basis).replace(/_/g, ' ')})` : ''
    return `Research ${symbol} for coverage — the house is overweight ${c.sector}${bp}${regime}${basis}.`
}

// Default IO — the agent and the coverage book, imported lazily so the unit tests (which inject
// stubs) never load the provider stack.
const _io = {
    listQueue:     (q) => researchQueueService.listQueue(q),
    startResearch: (id) => researchQueueService.startResearch(id),
    markDone:      (id) => researchQueueService.markDone(id),
    reject:        (id, reason) => researchQueueService.reject(id, reason),
    requeueInResearch: (o) => researchQueueService.requeueInResearch(o),

    // `throw`, not the service's default empty list: a book that could not be read would look like
    // an empty book, and the run would spend a four-minute turn on every covered name before the
    // save told it so. Better to not start.
    async coveredSymbols() {
        const { coverageService } = await import('../api/analyst/coverage.service.js')
        const all = await coverageService.getCoverage({ onError: 'throw' })
        return new Set(all.map(d => _sym(d.symbol)))
    },

    // One headless research turn: no messages before it, no stream to anyone. The coverage book
    // rides in chatState as it does at the desk — Prometheus is told which names are taken so it
    // never starts a second thesis by mistake. `existing_coverage` is not set: the run never
    // researches a covered name.
    async research({ opening, covered, userId, audience, model, signal }) {
        const { analystAgentService } = await import('./agents/analyst.agent.service.js')
        return analystAgentService.chatStream({
            messages: [], userPrompt: opening,
            chatState: { coverage_symbols: [...covered] },
            userId, audience, model: model ?? undefined, signal,
        })
    },

    async initiate(coverage) {
        const { coverageService } = await import('../api/analyst/coverage.service.js')
        return coverageService.initiateCoverage(coverage)
    },
}

export const researchRunService = { startRun, stopRun, getRun, requeueStalled }
