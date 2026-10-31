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
//   · a name whose row is no longer `queued` when the run reaches it is SKIPPED too (reason
//     not_queued, the row untouched) — someone opened it by hand, or another run claimed it.
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
import { openingTurn } from './agentUtils.js'
import { calcCost } from './tokenUsage.service.js'
import { normalizeHorizon } from './forecastClock.js'

const LOG = '[researchRun]'

// The singleton. `run` is the live one or the last one — a finished run stays readable until the
// next one replaces it, so the UI can show "done: 22 covered, 4 skipped" after the fact.
//
// `starting` covers the gap between "is one running?" and `state.run = run`: startRun reads the
// queue and the coverage book first, and two Starts pressed together both passed the running check
// during those reads, both became `state.run`, and both loops walked the same queue. Set
// synchronously before the first await, cleared on every way out.
const state = { run: null, abort: null, starting: false }

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
export async function startRun({ userId, audience = null, model = null, symbols = null, maxUsd = null, source = null } = {}, deps = _io) {
    if (state.run?.status === 'running' || state.starting) return { ok: false, reason: 'already_running', run: getRun() }
    state.starting = true

    let queued, covered, liveReads = new Set()
    try {
        // `symbols`: a run for these names only (a sleeve's, the house week's) — read BY them, not filtered out of the
        // queue's first page, where a backlog of older rows hid them (code review 2026-10-23); without it, the whole
        // queue (the admin's Start).
        queued = await deps.listQueue(Array.isArray(symbols) ? { status: 'queued', symbols: symbols.map(_sym), limit: 1000 } : { status: 'queued' })
        if (queued === null) return { ok: false, reason: 'queue_unavailable' }   // a failed read, not an empty queue
        if (Array.isArray(symbols)) {
            const want = new Set(symbols.map(_sym))
            queued = queued.filter(q => want.has(_sym(q.symbol)))
        }
        // `source`: one chain's rows only (horizon-chains.md §4) — a symbol can wait for a catalyst read AND for coverage,
        // and the Hotlist's run must not spend its day's budget on Pythia's row for the same name, or the reverse.
        if (source) queued = queued.filter(q => q.source === source)
        if (!queued.length)  return { ok: false, reason: 'nothing_queued' }

        try { covered = await deps.coveredSymbols() }
        catch (err) { logger.error(LOG, 'could not read the coverage book — run not started', err); return { ok: false, reason: 'coverage_unavailable' } }
        // A Hotlist row is a CATALYST read (horizon-chains.md §3): what skips it is a live read on the name, not coverage.
        if (queued.some(isCatalystItem)) liveReads = await Promise.resolve(deps.liveCatalystSymbols?.()).catch(() => null) ?? new Set()
    } finally {
        state.starting = false
    }
    const run = {
        id:         `run_${randomUUID().slice(0, 8)}`,
        status:     'running',   // running → done | stopped | failed (the account, not a name — see isRunFatal)
        source:     source ?? null,   // the chain whose run this is (null: the admin's Start, every source)
        error:      null,        // the sentence behind `failed`
        startedAt:  new Date().toISOString(),
        finishedAt: null,
        total:      queued.length,
        position:   0,           // names decided so far (any outcome)
        current:    null,        // the symbol mid-turn
        covered:    0,
        read:       0,           // catalyst reads stored (horizon-chains.md §3)
        skipped:    0,
        passed:     0,
        failed:     0,
        cost_usd:   0,           // the run's spend so far, summed from the names' (house-research-chain.md step 1)
        max_usd:    Number.isFinite(Number(maxUsd)) && maxUsd !== null ? Number(maxUsd) : null,   // a budget: no new name once spent
        budget_hit: false,
        results:    [],          // { symbol, outcome, reason?, cost_usd }, in order
        stop:       false,
    }
    state.run   = run
    state.abort = new AbortController()
    logger.info(LOG, 'run starting', { id: run.id, total: run.total, alreadyCovered: queued.filter(q => covered.has(_sym(q.symbol))).length })

    // Clear only OUR controller. A settled-listener may start the next run before this loop's
    // promise resolves (the listener runs inside it), and nulling that run's controller would leave
    // it unstoppable.
    const abort = state.abort
    _loop(run, queued, covered, { userId, audience, model, signal: abort.signal, liveReads }, deps)
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

async function _loop(run, queued, covered, { userId, audience, model, signal, liveReads = new Set() }, deps) {
    for (const item of queued) {
        if (run.stop) break
        // A BUDGET (the house week's, house-research-chain.md step 5): no new name once it is spent. The names left are
        // still `queued`, and the next run takes them.
        if (run.max_usd != null && run.cost_usd >= run.max_usd) { run.budget_hit = true; break }
        const symbol = _sym(item.symbol)
        const catalyst = isCatalystItem(item)

        // Coverage skips a covered name; a catalyst read skips a name with a LIVE read — a covered name still gets one
        // (a catalyst read never blocks or replaces coverage).
        if (catalyst ? liveReads.has(symbol) : covered.has(symbol)) {
            const reason = catalyst ? 'live_read' : 'already_covered'
            await deps.reject(item.id, reason)
            _settle(run, { symbol, outcome: 'skipped', reason })
            run.skipped++
            continue
        }

        // CLAIM the row, and read the answer. startResearch only moves queued → in_research, so a
        // refusal means the row is no longer ours to research: an admin opened it by hand between the
        // queue read and now, or another process took it. Researching it anyway paid for a four-minute
        // turn whose save could only answer already_covered — and a guard whose result nobody reads is
        // a guard in name only.
        const claim = await deps.startResearch(item.id)
        if (!claim?.ok) {
            _settle(run, { symbol, outcome: 'skipped', reason: 'not_queued' })
            run.skipped++
            continue
        }
        run.current = symbol
        // What THIS name's turn cost (house-research-chain.md step 1): every model call it makes, the desk's own and
        // its consults. A house run (no user) has no ledger of its own, so its spend is booked to the house ledger
        // here; a user's run is already booked by the turn itself, and booking it again would count it twice.
        const meter = { cost: 0 }
        const ledger = userId ? null : await Promise.resolve(deps.houseLedger?.()).catch(() => null)
        const onSpend = (usage, usedModel) => {
            meter.cost += deps.costOf(usedModel, usage) || 0
            if (ledger) Promise.resolve(deps.book(ledger, usedModel, usage)).catch(() => {})
        }
        const priced = () => _cost(meter.cost)
        // EVERY turn leaves its cost on the row, added to what earlier turns on it cost — the house budget reads the
        // rows (houseResearch) — and a claim the turn does not close keeps a reason, so the pick-up leaves it to the
        // admin instead of buying it again every tick (code review 2026-10-23).
        let costLeft = false   // the turn's cost goes on the row ONCE, however many paths touch it after
        const leave = (extra = {}) => {
            const addCost = costLeft ? 0 : priced()
            costLeft = true
            return Promise.resolve(deps.annotate?.(item.id, { addCost, ...extra })).catch(() => null)
        }
        try {
            const result = await deps.research({ item, symbol, opening: researchOpening(item), covered, userId, audience, model, signal, onSpend,
                mode: catalyst ? 'catalyst' : null })
            const { coverage } = result ?? {}
            if (run.stop) { await leave({ reason: 'stopped' }); _settle(run, { symbol, outcome: 'stopped', cost_usd: priced() }); break }   // aborted mid-turn: row stays in_research
            await leave()

            if (catalyst) {
                // The catalyst read (horizon-chains.md §3) goes to its own collection; a read with no target (contradicted,
                // unsized) is stored too — as a pass — so the day's record says the name was looked at.
                const parsed = result?.catalyst ?? null
                if (!parsed) {
                    await deps.reject(item.id, 'no_read')
                    _settle(run, { symbol, outcome: 'passed', reason: 'no_read', cost_usd: priced() })
                    run.passed++
                    continue
                }
                const saved = await deps.saveCatalyst(parsed, { symbol, source: item.source ?? 'hotlist', context: item.context ?? null })
                if (saved?.ok) {
                    await deps.markDone(item.id)
                    liveReads.add(symbol)
                    const live = saved.doc?.status === 'active'
                    _settle(run, { symbol, outcome: live ? 'read' : 'passed', reason: live ? null : saved.doc?.pass_reason ?? saved.doc?.verdict ?? 'pass', readId: saved.doc?.id ?? null, cost_usd: priced() })
                    if (live) run.read++
                    else run.passed++
                } else if (saved?.reason === 'live_read') {
                    await deps.reject(item.id, 'live_read')
                    _settle(run, { symbol, outcome: 'skipped', reason: 'live_read', cost_usd: priced() })
                    run.skipped++
                } else {
                    await leave({ reason: saved?.reason ?? 'save_failed', detail: saved?.detail ?? null })
                    _settle(run, { symbol, outcome: 'failed', reason: saved?.reason ?? 'save_failed', cost_usd: priced() })
                    run.failed++
                }
                continue
            }

            if (!coverage) {
                await deps.reject(item.id, 'no_edge')
                _settle(run, { symbol, outcome: 'passed', reason: 'no_edge', cost_usd: priced() })
                run.passed++
                continue
            }

            // A name Pythia's verdict sent is graded on HER book's horizon (house-research-chain.md step 5): a swing
            // name with a two-year target answers a question nobody asked. Rejected with the reason, not retried.
            const offBook = offBookHorizon(item, coverage)
            if (offBook) {
                await deps.reject(item.id, 'horizon_off_book', { detail: offBook })
                _settle(run, { symbol, outcome: 'passed', reason: 'horizon_off_book', detail: offBook, cost_usd: priced() })
                run.passed++
                continue
            }

            const saved = await deps.initiate(coverage)
            if (saved.ok) {
                await deps.markDone(item.id)
                covered.add(symbol)   // a later duplicate row (there should be none) is now a skip
                _settle(run, { symbol, outcome: 'covered', coverageId: saved.doc?.id ?? null, cost_usd: priced() })
                run.covered++
            } else if (saved.reason === 'already_covered') {
                // Covered between the run's read of the book and now — by hand, at the desk.
                await deps.reject(item.id, 'already_covered')
                _settle(run, { symbol, outcome: 'skipped', reason: 'already_covered', cost_usd: priced() })
                run.skipped++
            } else {
                // Left in_research on purpose: the research happened, the save did not. The reason on the row is what
                // keeps the pick-up from paying for it again.
                await leave({ reason: saved.reason ?? 'save_failed', detail: saved.detail ?? null })
                _settle(run, { symbol, outcome: 'failed', reason: saved.reason ?? 'save_failed', detail: saved.detail ?? null, cost_usd: priced() })
                run.failed++
            }
        } catch (err) {
            if (run.stop) { await leave({ reason: 'stopped' }); _settle(run, { symbol, outcome: 'stopped', cost_usd: priced() }); break }
            const fatal = isRunFatal(err)
            // A refusal about the ACCOUNT says nothing about the name: back in line, so the run after the top-up reads
            // it. Left claimed with a reason, the pick-up never would — every refused run stranded one name, for good
            // (2026-10-28: an empty OpenRouter balance, 60 names stuck on prod).
            if (fatal) { await leave(); await Promise.resolve(deps.requeue?.(item.id)).catch(() => null) }
            else await leave({ reason: 'failed', detail: _reason(err) })
            _settle(run, { symbol, outcome: 'failed', reason: _reason(err), cost_usd: priced() })
            run.failed++
            // A refusal that is about the ACCOUNT, not the name — no credit, a bad key, no
            // permission — fails every name after it the same way. The first run hit this at
            // AZN and burned through 22 names in thirty seconds, each "failed" with the same
            // sentence. Stop on the first, and say why on the run.
            if (fatal) {
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
    logger.info(LOG, `run ${run.status}`, { id: run.id, total: run.total, covered: run.covered, read: run.read, skipped: run.skipped, passed: run.passed, failed: run.failed, cost_usd: run.cost_usd })
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
    // "requires more credits": OpenRouter's no-balance sentence (a 402 too, but a streamed error may carry only the text).
    return /credit balance|requires more credits|billing|api key|authentication/i.test(_reason(err))
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
    if (result.cost_usd) run.cost_usd = _cost(run.cost_usd + result.cost_usd)
    logger.info(LOG, result.outcome, { symbol: result.symbol, reason: result.reason ?? null, cost_usd: result.cost_usd ?? 0, position: `${run.position}/${run.total}` })
}

const _cost = usd => Number((Number(usd) || 0).toFixed(4))

const _sym = s => String(s ?? '').toUpperCase().trim()

/** A queue row the Hotlist sent — researched as a catalyst read, saved beside coverage (horizon-chains.md §3-§4). Pure. */
export function isCatalystItem(item) {
    return Boolean(item?.context?.hotlist)
}

/** The price-target horizons each of Pythia's books may be graded on (coverage's own five, analyst_system_prompt.md). */
export const BOOK_PT_HORIZONS = Object.freeze({ swing: ['3m', '6m'], long_term: ['12m', '18m', '24m'] })

/**
 * Why a Pythia name's coverage is off its book's horizon, or null. Only a Pythia row with a known book is held. The
 * horizon is read the way the SAVE will store it (forecastClock.normalizeHorizon: a missing or unknown one is 12m), so
 * what is judged is what would be graded (code review 2026-10-23). Pure.
 */
export function offBookHorizon(item, coverage) {
    const allowed = item?.context?.pythia ? BOOK_PT_HORIZONS[item.context.verdict] : null
    if (!allowed) return null
    const pt = coverage?.price_target
    const h = normalizeHorizon(pt && typeof pt === 'object' ? pt.horizon : undefined)
    return allowed.includes(h) ? null : `price target horizon ${h} — ${item.context.verdict} takes ${allowed.join('/')}`
}

/**
 * The opening turn — the same sentence the desk sends when the admin presses Start (MainPage's
 * researchOpening), so a name researched by the run and one researched by hand are the same
 * instruction. Two copies because they are two repos; keep them saying the same thing.
 */
export function researchOpening(item) {
    const c = item?.context
    const symbol = _sym(item?.symbol)
    // From the HOTLIST (horizon-chains.md §4): Argus's "this week" pick — a CATALYST READ, not coverage. The board's facts
    // and his reason travel; the mode block (analyst_mode_catalyst.md) says what to do with them.
    if (isCatalystItem(item)) {
        const facts = c.facts ? ` The board: ${c.facts}.` : ''
        // A read a user asked for (`requested`) on a name Argus did not pick says so, rather than nothing. The overnight
        // board's names (`rule`, 2026-10-25) were listed by the run-up rule — no one picked them, and it says so.
        const argus = c.why ? ` Argus picked it: ${c.why}${c.caution ? ` What would make it wrong: ${c.caution}` : ''}`
            : c.rule ? ` The run-up rule listed it — a report about six sessions out, the last three beat; no one picked it.${c.requested ? ' A user asked for this read now.' : ''}`
                : c.requested ? ' Argus did not pick it; a user asked for this read.' : ''
        // A rule name asks the rule's two questions (docs/design/runup-reads.md §2), and when the trade opens — the board's
        // day, often the session after the read (a Saturday read for Monday's board).
        if (c.rule) return `Catalyst read on ${symbol} — the Hotlist's run-up rule listed it THIS WEEK, bought at the ${c.day ?? 'next'} open.${facts}${argus} Two questions: (a) were its last reports good enough to go into the run-up, and (b) is the report itself worth holding through, or out before it?`
        return `Catalyst read on ${symbol} — the Hotlist graded it THIS WEEK (2–10 days) on ${c.day ?? 'today'}.${facts}${argus} Is the catalyst real, what is it worth, how much is still open, and what can break it inside the window?`
    }
    // From the HOUSE SCAN (step 7): Pythia's verdict on the industry or theme sent it — the thesis and risks travel,
    // and "priced in" is Prometheus's question, name by name (pythia-assessment.md §10).
    if (c?.pythia) {
        const book  = { swing: 'FOR SWING', long_term: 'FOR LONG TERM' }[c.verdict] ?? String(c.verdict ?? '').toUpperCase()
        const where = c.kind === 'theme' ? `the theme ${c.subject}${c.link ? ` (via ${c.link})` : ''}` : `its industry, ${c.subject}`
        const risks = c.risks?.length ? ` Risks it named: ${c.risks.join('; ')}.` : ''
        const thesis = c.thesis ? `: ${c.thesis}` : '.'
        // Filter 1's reason, and the horizon the book is graded on (house-research-chain.md steps 4-5).
        const argus = c.argus?.why ? ` Argus chose it from the industry: ${c.argus.why}${c.argus.caution ? ` What would make it wrong: ${c.argus.caution}` : ''}` : ''
        const pt = BOOK_PT_HORIZONS[c.verdict] ? ` Set the price target on a ${BOOK_PT_HORIZONS[c.verdict].join(' or ')} horizon — ${book} is graded there.` : ''
        const tail = `${argus}${pt}`
        // NAMED by the assessment (pythia-names.md): it may sit in another industry (second order), so the opening says
        // whose assessment named it and why, not "its industry".
        if (c.named_why) {
            const of = c.kind === 'theme' ? `the theme ${c.subject}` : c.subject
            return `Research ${symbol} for coverage — Pythia's ${book} assessment of ${of}${c.horizon ? ` (${c.horizon})` : ''} names it: ${c.named_why}. Her case${thesis}${risks} Judge whether ${symbol} is already priced for it.${tail}`
        }
        return `Research ${symbol} for coverage — Pythia rates ${where} ${book}${c.horizon ? ` (${c.horizon})` : ''}${thesis}${risks} Judge whether ${symbol} is already priced for it.${tail}`
    }
    if (!c?.sector) return `Research ${symbol} for coverage.`
    // A SLEEVE candidate (sleeveSource): the mandate that surfaced it is a user's book, not the house
    // view, so the sentence names the sleeve and the selection school Prometheus has to judge it by.
    if (c.sleeve) {
        const school = c.school ? ` under a ${c.school} selection` : ''
        const note   = c.note ? ` (${c.note})` : ''
        return `Research ${symbol} for coverage — a candidate for the ${c.sector} sleeve of a portfolio build${school}${note}.`
    }
    return `Research ${symbol} for coverage.`
}

// Default IO — the agent and the coverage book, imported lazily so the unit tests (which inject
// stubs) never load the provider stack.
const _io = {
    listQueue:     (q) => researchQueueService.listQueue(q),
    startResearch: (id) => researchQueueService.startResearch(id),
    markDone:      (id, extra) => researchQueueService.markDone(id, extra),
    reject:        (id, reason, extra) => researchQueueService.reject(id, reason, extra),
    annotate:      (id, o) => researchQueueService.annotate(id, o),
    requeue:       (id) => researchQueueService.requeue(id),

    // The spend of one name (house-research-chain.md step 1). A house run books to the first admin's ledger, like
    // Pythia's week, under its own key and as monitor spend: inside the admin's total, outside their chat ceiling.
    costOf:        (model, usage) => calcCost(model, usage),
    async houseLedger() {
        const { houseLedgerUserId } = await import('../api/user/user.model.js')
        return houseLedgerUserId()
    },
    async book(userId, model, usage) {
        const { recordUsage } = await import('./tokenUsage.service.js')
        return recordUsage(userId, model, usage, 'researchRun', { monitor: true })
    },

    // `throw`, not the service's default empty list: a book that could not be read would look like
    // an empty book, and the run would spend a four-minute turn on every covered name before the
    // save told it so. Better to not start.
    async coveredSymbols() {
        const { coverageService } = await import('../api/analyst/coverage.service.js')
        return new Set(await coverageService.listSymbols({ onError: 'throw' }))
    },

    // One headless research turn: no messages before it, no stream to anyone. The coverage book
    // rides in chatState as it does at the desk — Prometheus is told which names are taken so it
    // never starts a second thesis by mistake. `existing_coverage` is not set: the run never
    // researches a covered name.
    async research({ opening, covered, userId, audience, model, signal, onSpend, mode = null }) {
        const { analystAgentService } = await import('./agents/analyst.agent.service.js')
        return analystAgentService.chatStream({
            messages: openingTurn(opening),
            // A catalyst read is not coverage: the book's names are not its business (horizon-chains.md §3).
            chatState: mode ? {} : { coverage_symbols: [...covered] },
            userId, audience, model: model ?? undefined, signal, onSpend, ...(mode ? { mode } : {}),
        })
    },

    // The catalyst reads (horizon-chains.md §3): their own collection, beside coverage.
    async saveCatalyst(parsed, opts) {
        const { catalystReadService } = await import('./catalystRead.service.js')
        return catalystReadService.saveRead(parsed, opts)
    },
    async liveCatalystSymbols() {
        const { catalystReadService } = await import('./catalystRead.service.js')
        return catalystReadService.liveSymbols()
    },

    async initiate(coverage) {
        const { coverageService } = await import('../api/analyst/coverage.service.js')
        return coverageService.initiateCoverage(coverage)
    },
}

export const researchRunService = { startRun, stopRun, getRun }
