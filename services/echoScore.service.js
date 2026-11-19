// ECHO, STEP 3 — SCORING (docs/design/echo-pipeline.md; the simulator doc's Step 3).
//
// Every link, six factors, 0–2 each, 0–12 total, "high" at 8 (the doc's defaults); high scores mark the links most
// likely to keep moving after day one. Each factor carries its reason.
//
//   lock-in, supply response, directness   the model, by the doc's definitions;
//   BOTTLENECK   the model's reasoning AND its reading of the company's own supply sentences (echoFilings — the doc's
//                bottleneck language) — evidence `reasoned`, `filings` or `both` (Roy, 2026-11-19: "identifying a
//                bottleneck can come from the LLM's reasoning too");
//   EXPOSURE     the 10-K's stated share where there is one (≥10% → 2, ≥5% → 1); else the model's estimate, labelled,
//                never above 1 (Roy: the link rule is evidence, not a gate — an unnamed link cannot claim full exposure);
//   COVERAGE     counted, not guessed: analysts on the name (FMP) — few → high — and whether it is filed OUTSIDE the
//                origin's sector (the doc's Vertiv, filed as an industrial, not tech).
//
// THE LEDGER (the doc): every scored event touching a company, with direction and score. Conflicting effects net by
// directness and lock-in; when they roughly cancel the name is CONFLICTED ("a conflicted name is a weak trade").

import { callAnthropicStructured } from '../providers/anthropic.provider.js'
import { getGradesConsensus } from '../providers/fmp.provider.js'
import { getDb } from '../providers/mongodb.provider.js'
import { recordUsage } from './tokenUsage.service.js'
import { supplySentences } from './echoFilings.service.js'
import { logger } from './logger.service.js'

const LOG = '[echoScore]'
export const MODEL = 'claude-opus-5-5'
export const EFFORT = 'high'
export const PROMPT_VERSION = 'score-2026-11-19'
export const HIGH = 8
export const FACTORS = Object.freeze(['lockIn', 'supplyResponse', 'bottleneck', 'directness', 'exposure', 'coverage'])
const BOTTLENECK_RELATIONS = new Set(['supplier', 'infrastructure'])
const SENTENCES_PER_LINK = 4
const EVENTS = 'echo_events'

export const SYSTEM = `You score the links of a supply-chain map for an event-driven system. High scores mark the links most likely \
to keep moving after day one — where the market is slow to connect the event to the company.

Score each link on these factors, 0, 1 or 2, each with one sentence of reason:
- lock_in — 2 when the demand change is committed for years (budgets, contracts, capex plans); 0 when it rides on a \
price spike that cures itself (Rheinmetall's defence budgets vs fertilizer in 2022).
- supply_response — 2 when new capacity takes years to build, so the gap persists (tankers: a three-year build); 0 when \
buyers or rivals adjust within a season (farmers cutting fertilizer use).
- bottleneck — 2 when THIS company controls scarce capacity the chain cannot route around (Vertiv's data-centre \
cooling, Catalent's fill-finish lines); 0 when it is one of many interchangeable suppliers. Reason it from what you know \
of the company AND read the sentences from its own recent SEC filings when given: "record backlog", "sold out", "on \
allocation", "capacity constrained" said of its OWN products is evidence it is the bottleneck. Careful: a company \
quoting long lead times from ITS suppliers is downstream of a bottleneck, not one; "short lead times" is the opposite; \
a risk factor ("we may experience shortages") is boilerplate, not evidence. Say which evidence you used: reasoned \
(your knowledge), filings (the sentences), both, or none; quote the sentence that counts, if any.
- directness — 2 when the event hits the company's revenue now and measurably; 0 when the effect is slow, indirect or \
speculative (snacks after GLP-1s: direct; dialysis: slow). Score it the same way for losers; the market check reads \
it the other way for them.
- exposure — 2 when a large share of the company's revenue rides on this link; 0 when it is a small side business \
(Uniper: half its gas from Russia). Give your estimate; a share the company's own filing states will replace it.

Score what the company IS and what the event does to it, not how its stock has moved — you are not given prices.`

export function schema() {
    const f = { type: 'object', properties: { score: { type: 'integer', enum: [0, 1, 2] }, why: { type: 'string' } }, required: ['score', 'why'], additionalProperties: false }
    return {
        type: 'object',
        properties: {
            links: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        ticker: { type: 'string' },
                        lock_in: f, supply_response: f, directness: f, exposure: f,
                        bottleneck: {
                            type: 'object',
                            properties: {
                                score: { type: 'integer', enum: [0, 1, 2] }, why: { type: 'string' },
                                evidence: { type: 'string', enum: ['reasoned', 'filings', 'both', 'none'] },
                                quote: { type: 'string' },
                            },
                            required: ['score', 'why', 'evidence', 'quote'], additionalProperties: false,
                        },
                    },
                    required: ['ticker', 'lock_in', 'supply_response', 'bottleneck', 'directness', 'exposure'],
                    additionalProperties: false,
                },
            },
        },
        required: ['links'],
        additionalProperties: false,
    }
}

/** Coverage, counted: analysts on the name and whether it is filed outside the origin's sector. Pure. */
export function coverageScore(analysts, sector, originSector) {
    const n = Number.isFinite(analysts) ? analysts : null
    const base = n == null ? 1 : n <= 5 ? 2 : n <= 15 ? 1 : 0
    const outside = Boolean(sector && originSector && sector !== originSector)
    const score = Math.min(2, base + (outside && base < 2 ? 1 : 0))
    const count = n == null ? 'analyst count unknown' : `${n} analyst${n === 1 ? '' : 's'}`
    return { score, analysts: n, outside, why: `${count}${outside ? `; filed as ${sector}, outside the origin's ${originSector}` : sector ? `; ${sector}, the origin's own sector` : ''}` }
}

/** Exposure: the filing's stated share where there is one; else the model's estimate, capped at 1. Pure. */
export function exposureScore(filings, model) {
    const s = filings?.share
    if (s?.share != null) {
        const score = s.share >= 0.10 ? 2 : s.share >= 0.05 ? 1 : 0
        const pct = `${s.atLeast ? 'over ' : ''}${Math.round(s.share * 1000) / 10}%`
        return { score, source: 'stated', why: `${pct} of its revenue, stated in its ${s.form ?? 'filing'}${s.date ? ` (${s.date})` : ''}` }
    }
    const est = Math.min(1, model?.score ?? 0)
    return { score: est, source: 'estimated', why: `${model?.why ?? 'no estimate'} (estimated — no share stated in a filing${model?.score === 2 ? '; capped at 1' : ''})` }
}

/** One link's six factors and total. Pure. */
export function combine(link, m, coverage) {
    const factors = {
        lockIn: { score: m.lock_in.score, why: m.lock_in.why },
        supplyResponse: { score: m.supply_response.score, why: m.supply_response.why },
        bottleneck: { score: m.bottleneck.score, why: m.bottleneck.why, evidence: m.bottleneck.evidence, quote: m.bottleneck.quote || null },
        directness: { score: m.directness.score, why: m.directness.why },
        exposure: exposureScore(link.filings, m.exposure),
        coverage,
    }
    const total = FACTORS.reduce((s, k) => s + factors[k].score, 0)
    return { ticker: link.ticker, factors, total, high: total >= HIGH }
}

/** The user message: the event, and every link with its filing evidence and supply sentences. Pure. */
export function promptFor(ev, links, sentences = {}) {
    const way = { up: 'raises', down: 'lowers', mixed: 'moves both ways' }[ev.effect]
    const head = [
        `Event (${ev.date}, ${ev.type.replace('_', ' ')}): ${ev.whatChanged}. Origin: ${ev.origin}${ev.originTickers?.length ? ` (${ev.originTickers.join(', ')})` : ''}; the event ${way} demand there.`,
        `Durability: ${ev.durability.kind.replace(/_/g, ' ')}${ev.durability.why ? ` — ${ev.durability.why}` : ''}.`,
        `Score every link below (${links.length}):`,
    ]
    const body = links.map(l => {
        const f = l.filings ?? {}
        const lines = [`${l.ticker} — ${l.name}: ${l.relation}, layer ${l.layer}, ${l.direction}. ${l.why}`]
        if (f.share) lines.push(`  Its filing states: ${f.share.atLeast ? 'over ' : ''}${Math.round(f.share.share * 1000) / 10}% of its revenue tied to the origin.`)
        else if (f.named === true) lines.push(`  Named in filings (${(f.namedBy ?? []).join(', ')}), no share stated.`)
        else if (f.named === false) lines.push('  Not named in either company\'s filings.')
        for (const s of sentences[l.ticker] ?? []) lines.push(`  Its filing (${s.form} ${s.date}): "${s.text.slice(0, 400)}"`)
        return lines.join('\n')
    })
    return [...head, '', ...body].join('\n')
}

const _deps = {
    call: callAnthropicStructured, record: recordUsage, analysts: getGradesConsensus, supply: supplySentences,
    db: null, sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    async houseLedger() { const { houseLedgerUserId } = await import('../api/user/user.model.js'); return houseLedgerUserId() },
}
export function _setDeps(d) { Object.assign(_deps, d) }

/** The supply sentences of the links where a bottleneck can live (suppliers, infrastructure). → {ticker: [sentence]}. */
export async function supplyEvidence(links, deps = _deps) {
    const out = {}
    for (const l of links.filter(x => BOTTLENECK_RELATIONS.has(x.relation))) {
        const r = await deps.supply(l.ticker)
        out[l.ticker] = (r.sentences ?? []).slice(0, SENTENCES_PER_LINK)
        await deps.sleep(150)
    }
    return out
}

/** Analysts on each name (the sum of FMP's rating counts), null when unread. → {ticker: n}. */
export async function analystCounts(links, deps = _deps) {
    const out = {}
    for (const l of links) {
        const g = await deps.analysts(l.ticker).catch(() => null)
        out[l.ticker] = g?.counts ? Object.values(g.counts).reduce((s, x) => s + (Number(x) || 0), 0) : null
        await deps.sleep(120)
    }
    return out
}

/**
 * THE LEDGER for these tickers: every OTHER scored event touching each, with direction and score, and whether the
 * effects cancel. Netting (the doc): each event weighs ±(directness + lock-in), + for gains; CONFLICTED when both signs
 * are present and the net is under half the largest weight. Pure on its inputs.
 */
export function ledgerOf(ticker, current, others) {
    const all = [current, ...others].filter(Boolean)
    const w = (e) => (e.direction === 'gains' ? 1 : e.direction === 'loses' ? -1 : 0) * ((e.directness ?? 0) + (e.lockIn ?? 0))
    const ws = all.map(w)
    const net = ws.reduce((s, x) => s + x, 0)
    const both = ws.some(x => x > 0) && ws.some(x => x < 0)
    const maxW = Math.max(0, ...ws.map(Math.abs))
    return { ticker, events: others.map(e => ({ id: e.id, origin: e.origin, direction: e.direction, total: e.total })), net, conflicted: both && Math.abs(net) < maxW / 2 }
}

async function otherEvents(tickers, eventId) {
    const docs = await (_deps.db ?? await getDb()).collection(EVENTS)
        .find({ _id: { $ne: eventId }, kind: 'house', status: { $in: ['scored', 'checked', 'watching'] }, 'scores.links.ticker': { $in: tickers } })
        .project({ origin: 1, map: 1, scores: 1 }).limit(200).toArray()
    const by = {}
    for (const d of docs) {
        for (const s of d.scores?.links ?? []) {
            if (!tickers.includes(s.ticker)) continue
            const link = d.map?.links?.find(l => l.ticker === s.ticker)
            ;(by[s.ticker] ??= []).push({ id: d._id, origin: d.origin, direction: link?.direction, total: s.total, directness: s.factors?.directness?.score, lockIn: s.factors?.lockIn?.score })
        }
    }
    return by
}

/**
 * Score one mapped event: the supply sentences and analyst counts read, one model call over every link, the counted
 * factors joined, the ledger. → `{ ok: true, scores }` or `{ ok: false, reason }`.
 */
export async function scoreEvent(ev, map, { userId = null } = {}) {
    const links = map?.links ?? []
    if (!links.length) return { ok: true, scores: { links: [], scoredAt: new Date().toISOString() } }
    const [sentences, analysts] = [await supplyEvidence(links), await analystCounts(links)]
    const payer = userId ?? await _deps.houseLedger().catch(() => null)
    let res
    try {
        res = await _deps.call({ model: MODEL, systemPrompt: SYSTEM, user: promptFor(ev, links, sentences), schema: schema(), effort: EFFORT,
            onUsage: (usage, m) => { if (payer) _deps.record(payer, m, usage, 'echo', userId ? {} : { monitor: true }).catch(() => {}) } })
    } catch (err) {
        logger.error(LOG, 'score call failed:', err.message)
        return { ok: false, reason: 'The model could not be reached — try again.' }
    }
    const got = new Map((res?.data?.links ?? []).map(x => [String(x.ticker).toUpperCase(), x]))
    if (!got.size) return { ok: false, reason: `No scores came back (${res?.stopReason ?? 'no answer'}) — try again.` }
    const scored = []
    for (const l of links) {
        const m = got.get(l.ticker)
        if (!m) continue
        scored.push(combine(l, m, coverageScore(analysts[l.ticker], l.sector, map.originSector)))
    }
    const others = ev.kind === 'user' ? {} : await otherEvents(scored.map(s => s.ticker), ev._id).catch(() => ({}))
    for (const s of scored) {
        const link = links.find(l => l.ticker === s.ticker)
        s.ledger = ledgerOf(s.ticker, { direction: link.direction, directness: s.factors.directness.score, lockIn: s.factors.lockIn.score }, others[s.ticker] ?? [])
        s.supplySentences = (sentences[s.ticker] ?? []).map(({ text, form, date, url, hedged }) => ({ text, form, date, url, hedged }))
    }
    scored.sort((a, b) => b.total - a.total)
    return { ok: true, scores: { model: res.model, promptVersion: PROMPT_VERSION, scoredAt: new Date().toISOString(), high: HIGH, links: scored, unscored: links.filter(l => !got.has(l.ticker)).map(l => l.ticker) } }
}

export const echoScoreService = { scoreEvent, combine, coverageScore, exposureScore, ledgerOf }
