/**
 * A COMPANY, as Axl reads it (docs/design/axl-one-voice.md §2–§4, Roy 2026-11-21): the house's work on it — the analyst's
 * coverage, Proteus's measured profile (how the stock moves, docs/design/proteus-v2.md), the events the event analyst mapped that reach it — each with a
 * verdict CODE decides (never the model), and the background work a missing or invalid coverage needs, started here.
 *
 *   coverage    none → initiate (the research queue + run, as mentorReads.requestRead) · withdrawn / stale → re-model
 *               (the monitor's claimRemodel, then refreshCoverage) · valid → read as is. A "ready" line goes to the
 *               session that asked when the work lands.
 *   technicals  the stored profile's swing and long-term scales, or built now (code only, one daily fetch, seconds) —
 *               stockProfile.profileFor. The day scale is Mentor's (a day trade); a company question is not one.
 *   events      echoEvents.eventsFor — the house's mapped events and the user's own whose map links the name.
 *
 * Shared mechanism, one home each: the queue, the run, the claim, the re-model and the profile are the existing services;
 * this only decides WHEN and says it. Built as a factory so the tests run it with stand-ins.
 */

import { coverageService } from '../api/analyst/coverage.service.js'
import { researchQueueService } from './researchQueue.service.js'
import { startRun, onRunSettled } from './researchRun.service.js'
import { refreshCoverage } from './coverageRefresh.service.js'
import { profileFor } from './stockProfile.service.js'
import { profileBrief } from './stockProfile.format.js'
import { eventsFor } from './echoEvents.service.js'
import { sessionService } from './session.service.js'
import { remodelDecision, VERDICT_COOLDOWN_DAYS } from '../monitoring/coverage.remodel.js'
import { logger } from './logger.service.js'

const LOG = '[companyView]'
const DAY_MS = 24 * 60 * 60 * 1000
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/

// ─── The coverage verdict (§3) — pure ──────────────────────────────────────────────────────────────────────────────────

const _ms = (x) => { const n = Date.parse(x ?? ''); return Number.isFinite(n) ? n : null }

/**
 * none · withdrawn · stale · valid — and whether a background run is called for (`rerun`).
 *   none       no document, or retired / only watched (`reinit` then: the document exists, the run re-researches it)
 *   withdrawn  the latest revision is a re-model PASS newer than the target ("I withdraw the prior target") — the headline
 *              is not the analyst's view. Re-run only past the monitor's verdict cooldown: a pass is the answer until then
 *              (NVDA passed twice on a price-data mismatch; re-running it on every question would pay for the same pass).
 *   stale      a re-model is due by the MONITOR's own rule (remodelDecision — a catalyst passed, a verdict to revise, the
 *              quarterly floor), so the chat and the monitor agree on "due". The Street's edge is the monitor's (no
 *              fetch here).
 */
export function coverageVerdict(c, nowMs = Date.now()) {
    if (!c) return { state: 'none', rerun: true, reinit: false }
    if (c.status === 'retired' || c.status === 'watchlist') return { state: 'none', rerun: true, reinit: true }
    const last = Array.isArray(c.revisions) ? c.revisions[0] : null
    const passAt = last?.kind === 'remodel_pass' ? _ms(last.at) : null
    const setAt = _ms(c.price_target?.set_at)
    if (passAt !== null && (setAt === null || passAt > setAt)) {
        return { state: 'withdrawn', at: last.at, note: last.note ?? null, rerun: nowMs - passAt >= VERDICT_COOLDOWN_DAYS * DAY_MS }
    }
    const d = remodelDecision(c, { nowMs })
    if (d.due) return { state: 'stale', reason: d.reason, rerun: true }
    return { state: 'valid', rerun: false }
}

// ─── What Axl reads — pure ─────────────────────────────────────────────────────────────────────────────────────────────

const fmtPct = (x) => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${Math.round(x * 10) / 10}%` : null)
const fmtPrice = (x) => (Number.isFinite(Number(x)) && x !== null ? Number(x).toFixed(2) : null)
const day = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null)
const caseLine = (c) => (c && typeof c === 'object' ? [fmtPrice(c.price ?? c.value ?? c.target), c.note ?? c.why ?? c.thesis ?? null].filter(Boolean).join(' — ') : (c ?? null))

/** The coverage document, as the analyst wrote it. Pure — exported for testing. */
export function formatCoverage(c) {
    const pt = c.price_target ?? {}
    const rr = c.risk_reward ?? {}
    return [
        `  ${c.symbol}${c.industry ? ` (${c.industry})` : ''} · status ${c.status ?? '?'} · last revised ${day(c.updated_at) ?? 'unknown'}`,
        `  rating: ${String(c.rating ?? 'none').replace('_', ' ')}`,
        fmtPrice(pt.value) ? `  our price target: ${fmtPrice(pt.value)}${pt.set_at ? ` (set ${day(pt.set_at)})` : ''}${pt.target_date ? ` by ${day(pt.target_date)}` : ''}${pt.horizon ? ` (${pt.horizon})` : ''}${pt.basis ? ` — ${String(pt.basis).slice(0, 240)}` : ''}` : '  our price target: none standing',
        c.gap && Number.isFinite(c.gap.pct) ? `  against the Street: ${fmtPct(c.gap.pct)} vs consensus ${fmtPrice(c.gap.consensus_pt) ?? '?'}` : null,
        c.conviction?.level ? `  conviction: ${c.conviction.level}${c.conviction.rationale ? ` — ${String(c.conviction.rationale).slice(0, 300)}` : ''}` : null,
        c.thesis ? `  thesis: ${String(c.thesis).slice(0, 900)}` : null,
        ...['bear', 'base', 'bull'].map(k => (rr[k] ? `  ${k} case: ${String(caseLine(rr[k])).slice(0, 240)}` : null)),
        ...(Array.isArray(c.catalysts) && c.catalysts.length ? ['  catalysts:', ...c.catalysts.slice(0, 4).map(k => `    ${k.date ?? ''} ${String(k.note ?? '').slice(0, 200)}`)] : []),
        ...(Array.isArray(c.kill_criteria) && c.kill_criteria.length ? ['  kill criteria:', ...c.kill_criteria.slice(0, 5).map(k => `    - ${String(k).slice(0, 200)}`)] : []),
        ...(Array.isArray(c.revisions) && c.revisions.length ? ['  latest revisions:', ...c.revisions.slice(0, 3).map(r => `    ${day(r.at)} ${r.kind ?? ''}: ${String(r.note ?? '').slice(0, 300)}`)] : []),
    ].filter(l => l !== null).join('\n')
}

const VERDICT_WORDS = {
    valid:     'VALID — the analyst\'s current view.',
    stale:     'STALE — a re-model is due',
    withdrawn: 'WITHDRAWN — the analyst could not stand behind a target on his latest re-model; the headline rating and target below are NOT his current view.',
}

/** The view → the text Axl reads. Pure — exported for testing. */
export function formatCompanyView(v) {
    const cov = v.coverage
    const covBlock = !cov.doc
        ? `THE ANALYST'S COVERAGE: none.${cov.building ? ' The analyst is building it now, in the background (a few minutes) — say so; a line comes to this chat when it is ready.' : cov.error ? ` (${cov.error})` : ''}`
        : [
            `THE ANALYST'S COVERAGE: ${VERDICT_WORDS[cov.verdict.state] ?? cov.verdict.state}${cov.verdict.state === 'stale' ? ` (${cov.verdict.reason})` : ''}`,
            cov.verdict.state === 'withdrawn' ? `  withdrawn ${day(cov.verdict.at)}: ${String(cov.verdict.note ?? '').slice(0, 400)}` : null,
            cov.building ? '  It is being re-modelled now, in the background — say so; a line comes to this chat when it lands. Until then the record below is the LAST view, dated.' : null,
            cov.verdict.state === 'withdrawn' && !cov.verdict.rerun && !cov.building ? `  Not re-run: the pass is under ${VERDICT_COOLDOWN_DAYS} days old — it is the answer until then.` : null,
            formatCoverage(cov.doc),
        ].filter(Boolean).join('\n')
    const tech = v.technicals.profile
        ? `OUR TECHNICAL PROFILE (measured from the candles, ${day(v.technicals.profile.built?.swing) ?? 'recent'}):\n${profileBrief(v.technicals.profile, { scales: TECH_SCALES })}`
        : `OUR TECHNICAL PROFILE: not available${v.technicals.error ? ` (${v.technicals.error})` : ''}.`
    const ev = v.events.length
        ? `EVENTS WE MAPPED THAT REACH ${v.symbol} (the event analyst's):\n${v.events.map(e => `  ${e.date ?? '?'} ${e.origin ?? ''} — ${String(e.whatChanged ?? '').slice(0, 160)} → ${v.symbol} ${e.link?.direction ?? 'reached'}${e.link?.relation ? ` as ${e.link.relation}` : ''}${e.link?.why ? `: ${String(e.link.why).slice(0, 200)}` : ''}${e.score != null ? ` · score ${e.score}` : ''}${e.flag ? ` · ${e.flag}` : ''}${e.kind === 'user' ? ' · the user\'s own event' : ''}`).join('\n')}`
        : `EVENTS WE MAPPED THAT REACH ${v.symbol}: none.`
    return [
        `THE HOUSE'S WORK ON ${v.symbol} — say each part as the house's (the analyst's / our technical read / an event we mapped), dated; your own reading (news, web, knowledge) as yours, never blurred into it.`,
        covBlock, tech, ev,
    ].join('\n\n')
}

/** The scales a company question reads (proteus-v2 §5): a swing and long term. */
const TECH_SCALES = ['short', 'swing', 'long']   // v2: the short term swing too (one daily fetch for all three)

// ─── The service ───────────────────────────────────────────────────────────────────────────────────────────────────────

const _deps = {
    coverageOf: (s) => coverageService.getCoverageBySymbol(s),
    claimRemodel: (id, opts) => coverageService.claimRemodel(id, opts),
    refresh: (args) => refreshCoverage(args),
    enqueue: (args) => researchQueueService.enqueue(args),
    waiting: (s) => researchQueueService.listQueue({ status: ['queued', 'in_research'], symbols: [s] }),
    startRun: (args) => startRun(args),
    onRunSettled,
    profile: (s) => profileFor(s, { scales: TECH_SCALES }),
    events: (s, userId) => eventsFor(s, { userId }),
    say: ({ sessionId, userId, content }) => sessionService.append({ sessionId, userId, message: { agent: 'axl', role: 'assistant', content } }),
    now: () => Date.now(),
}

export function makeCompanyView(deps = {}) {
    const d = { ..._deps, ...deps }
    const remodelling = new Set()        // symbols this process is re-modelling — "being re-modelled" until it lands
    const asked = new Map()              // symbol → [{ sessionId, userId }] — who gets the "ready" line for a NEW coverage
    let subscribed = false

    const tell = (who, content) => Promise.all(who.filter(w => w.sessionId).map(w => d.say({ ...w, content }).catch(err => logger.warn(LOG, 'ready line not posted', err.message))))
    const headline = (c) => `${String(c.rating ?? 'unrated').replace('_', ' ')}${fmtPrice(c.price_target?.value) ? `, target ${fmtPrice(c.price_target.value)}` : ''}`

    // A run settled: each name asked for that now has coverage gets its line; one no longer in line and still uncovered failed.
    async function settled(run = null) {
        // Why a name came back uncovered, from the run's own result for it (Roy, 2026-11-21: "could not build coverage this
        // time" said nothing — TSLA's was the model failing, recorded as a pass).
        const why = (sym) => {
            const r = [...(run?.results ?? [])].reverse().find(x => x?.symbol === sym)
            if (!r) return ''
            if (r.reason === 'no_edge') return ' — he researched it and passed: no edge he could stand behind at this price. Ask me and I can say what the news and the numbers show.'
            if (r.reason === 'model_failed') return ' — the research turn failed twice (the model wrote nothing usable), not a judgment on the stock. Ask again and it is queued once more.'
            if (r.reason === 'horizon_off_book') return ' — his view did not fit the horizon it was asked for.'
            return r.reason ? ` (${String(r.reason).replace(/_/g, ' ')}).` : ''
        }
        for (const [sym, who] of [...asked]) {
            const c = await d.coverageOf(sym).catch(() => null)
            if (c && c.status !== 'retired' && c.status !== 'watchlist') {
                asked.delete(sym)
                await tell(who, `The analyst's coverage on ${sym} is ready — ${headline(c)}. Ask me about it.`)
                continue
            }
            const rows = await d.waiting(sym).catch(() => null)
            if (Array.isArray(rows) && !rows.length) {
                asked.delete(sym)
                await tell(who, `The analyst could not build coverage on ${sym} this time${why(sym) || '.'}`)
            }
        }
    }

    function initiate({ sym, reinit, userId, sessionId }) {
        const who = asked.get(sym) ?? []
        if (sessionId && !who.some(w => w.sessionId === sessionId)) who.push({ sessionId, userId })
        asked.set(sym, who)
        if (!subscribed) { subscribed = true; d.onRunSettled((run) => { settled(run).catch(err => logger.warn(LOG, 'settle failed', err.message)) }) }
        return Promise.resolve(d.enqueue({ symbol: sym, source: 'axl', requestedBy: userId ? String(userId) : 'house', context: { axl: true, ...(reinit ? { reinit: true } : {}) } }))
            .then(async (q) => {
                if (!q?.ok) { logger.warn(LOG, 'coverage not queued', { symbol: sym, reason: q?.reason ?? null }); return false }
                // The house runs it (userId null); a run already going takes it in line, and its settle starts the next.
                const started = await d.startRun({ userId: null, symbols: [sym] })
                if (!started?.ok && started?.reason !== 'already_running') logger.warn(LOG, 'coverage run not started', { symbol: sym, reason: started?.reason ?? null })
                logger.info(LOG, 'coverage asked for', { symbol: sym, duplicate: !!q.duplicate, reinit })
                return true
            })
    }

    // CLAIM first — the monitor's compare-and-swap: two users asking, or the monitor's tick, run ONE re-model of a name.
    async function remodel({ cov, reason, userId, sessionId }) {
        const won = await d.claimRemodel(cov.id, { previousAt: cov.monitor?.last_remodel_at ?? null, reason: `asked in chat — ${reason}` })
        // Lost: another re-model of the name holds the claim (the monitor, another user) — it IS being re-modelled; its
        // line goes to whoever asked for it, not here.
        if (!won) return true
        remodelling.add(cov.symbol)
        // Fire and forget: minutes. The house's run (userId null — the monitor's rule: its card goes to the admins).
        Promise.resolve(d.refresh({ userId: null, ticker: cov.symbol, trigger: 'axl' }))
            .then(async (r) => {
                const who = [{ sessionId, userId }]
                if (r?.ok) {
                    const c = await d.coverageOf(cov.symbol).catch(() => null)
                    await tell(who, `The analyst re-modelled ${cov.symbol}${c ? ` — ${headline(c)}` : ''}. Ask me about it.`)
                } else if (r?.reason === 'pass') {
                    await tell(who, `The analyst re-modelled ${cov.symbol} and still cannot stand behind a target: ${String(r.pass ?? '').slice(0, 300)}`)
                } else {
                    await tell(who, `The analyst's re-model of ${cov.symbol} did not finish this time — the last view stands.`)
                }
            })
            .catch(err => logger.warn(LOG, 're-model failed', { symbol: cov.symbol, error: err.message }))
            .finally(() => remodelling.delete(cov.symbol))
        return true
    }

    /**
     * The house's work on one company, and the background work it needs, started. Never throws: a part that cannot be read
     * says so. `kick: false` reads only (tests, a list).
     */
    async function view({ symbol, userId = null, sessionId = null, kick = true }) {
        const sym = String(symbol ?? '').trim().toUpperCase()
        if (!SYMBOL.test(sym)) return { symbol: sym, invalid: true }
        const [covDoc, profile, events] = await Promise.all([
            d.coverageOf(sym).catch(err => ({ _error: err.message })),
            Promise.resolve().then(() => d.profile(sym)).catch(err => ({ _error: err.message })),
            Promise.resolve().then(() => d.events(sym, userId)).catch(() => []),
        ])
        const coverage = { doc: null, verdict: null, building: false, error: null }
        if (covDoc?._error) coverage.error = `could not read the coverage: ${covDoc._error}`
        else {
            const verdict = coverageVerdict(covDoc, d.now())
            coverage.verdict = verdict
            coverage.doc = verdict.state === 'none' ? null : covDoc
            coverage.building = remodelling.has(sym)
            if (kick && verdict.rerun && !coverage.building) {
                if (verdict.state === 'none') coverage.building = await initiate({ sym, reinit: verdict.reinit, userId, sessionId }).catch(err => { logger.warn(LOG, 'initiate failed', err.message); return false })
                else coverage.building = await remodel({ cov: covDoc, reason: verdict.state === 'withdrawn' ? 'the target was withdrawn' : verdict.reason, userId, sessionId }).catch(err => { logger.warn(LOG, 're-model claim failed', err.message); return false })
            }
        }
        return {
            symbol: sym, coverage,
            technicals: profile?._error ? { profile: null, error: profile._error } : { profile: profile ?? null, error: null },
            events: Array.isArray(events) ? events : [],
        }
    }

    return { view }
}

export const companyView = makeCompanyView()
