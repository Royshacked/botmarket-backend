// ECHO, STEP 1 — EVENT INTAKE (docs/design/echo-pipeline.md; the simulator doc's Step 1).
//
// The target is news that shifts demand or supply ALONG A CHAIN, not news about the market. Sources, structured first
// (the doc's order), every one free:
//
//   earnings   demand shocks — the universe's earnings prints (FMP calendar) whose Day 0 moved the stock 5%+ vs SPY (the
//              doc's default event size); timing inferred from the gap (the engine's rule: FMP has the date, not the hour)
//   8-K        capacity deals and material agreements — items 1.01 / 2.01 of the universe's 8-Ks (EDGAR)
//   policy     the Federal Register's rules and presidential documents on tariffs, export controls, sanctions, subsidies
//   defense    the Defense Department's daily contract awards, $500M and up
//   clinical   phase-3 results posted on ClinicalTrials.gov; FDA original approvals (openFDA)
//   news       FMP's general news — the fallback the doc names, for geopolitical and supply shocks
//
// Every candidate goes to ONE triage call per batch (a cheaper model; many items a day): is it an event by the doc's
// filter — a SURPRISE, LARGE relative to the companies it touches, MORE THAN A ONE-OFF — and if so, its Step 1 fields
// (type, origin, tickers, what changed — the news, never the stock's move — size, timing, durability with its reason,
// effect at the origin). The doc's skip list is said to it: macro data, analyst upgrades and targets, opinion, rumours,
// "why X moved" recaps. An event that passes is stored for the house (echoEvents) and the pipeline maps it.
//
// Not wired: earnings call transcripts (FMP 402 — Roy: SEC filings instead, which Step 3 reads); the FDA advisory
// calendar (an HTML page, no feed).

import { callAnthropicStructured } from '../providers/anthropic.provider.js'
import { readCalendarWindow, fetchStockNews } from '../providers/fmp.provider.js'
import { fmpGet } from '../providers/fmp.price.provider.js'
import { get8kFilings, filingText } from '../providers/sec.provider.js'
import { getJson } from './http.util.js'
import { getDb } from '../providers/mongodb.provider.js'
import { recordUsage } from './tokenUsage.service.js'
import { fetchBars, unfinishedSession } from './echoReturns.service.js'
import { echoEventsService, TYPES, DURABILITIES, EFFECTS, TIMINGS } from './echoEvents.service.js'
import { UNIVERSE, UNIVERSE_TICKERS } from './echoUniverse.js'
import { markFollowUp } from './echoWatch.service.js'
import { logger } from './logger.service.js'

const LOG = '[echoIntake]'
export const TRIAGE_MODEL = 'claude-sonnet-5-5'
export const TRIAGE_EFFORT = 'medium'
export const SEEN = 'echo_intake'
export const EVENT_SIZE = 0.05
export const DEFENSE_MIN_USD = 500e6
export const POLICY_TERMS = ['tariff', 'export controls', 'sanctions', 'subsidy', 'critical minerals']
const BATCH = 20
const LOOKBACK_DAYS = 3
const TEXT_MAX = 1500

const day = (d) => new Date(d).toISOString().slice(0, 10)
const daysAgo = (now, n) => day(new Date(now).getTime() - n * 86_400_000)
const clip = (s, n = TEXT_MAX) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/**
 * The engine's timing rule (event_rules.py): a report before the open shows in that day's gap, one after the close in
 * the next day's; the larger EXCESS gap (over SPY's) decides. → `{ timing, day0 }` or null when the bars are not in.
 * Pure.
 */
export function inferTiming(bars, spy, date) {
    const sessions = Object.keys(spy).sort()
    const i = sessions.findIndex(d => d >= date)
    if (i < 1 || i + 1 >= sessions.length) return null
    const gap = (b, d, prev) => (b[d]?.open && b[prev]?.close ? b[d].open / b[prev].close - 1 : null)
    const xs = (d, prev) => { const a = gap(bars, d, prev), s = gap(spy, d, prev); return a == null || s == null ? null : a - s }
    const same = sessions[i] === date ? xs(sessions[i], sessions[i - 1]) : null
    const next = sessions[i] === date ? xs(sessions[i + 1], sessions[i]) : xs(sessions[i], sessions[i - 1])
    if (same != null && (next == null || Math.abs(same) >= Math.abs(next))) return { timing: 'before_open', day0: sessions[i], base: sessions[i - 1] }
    const d0 = sessions[i] === date ? sessions[i + 1] : sessions[i]
    const base = sessions[sessions.indexOf(d0) - 1]
    return { timing: 'after_close', day0: d0, base }
}

/** Day 0's close over the last close before, minus SPY's. Pure. */
export function dayZeroMove(bars, spy, t) {
    const r = (b) => (b[t.day0]?.close && b[t.base]?.close ? b[t.day0].close / b[t.base].close - 1 : null)
    const a = r(bars), s = r(spy)
    return a == null || s == null ? null : a - s
}

const _deps = {
    calendar: readCalendarWindow, bars: fetchBars, stockNews: fetchStockNews, eightKs: get8kFilings, text: filingText,
    // A generic client name: only EDGAR asks for a contact (the SEC provider sends its own); no one else gets one.
    fmp: fmpGet, http: (url, o = {}) => getJson(url, { headers: { 'User-Agent': 'ar2trade-echo-intake' }, timeoutMs: 20000, ...o }),
    call: callAnthropicStructured, record: recordUsage, events: echoEventsService, followUp: markFollowUp, db: null, now: () => new Date(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    async houseLedger() { const { houseLedgerUserId } = await import('../api/user/user.model.js'); return houseLedgerUserId() },
}
export function _setDeps(d) { Object.assign(_deps, d) }

// ── the sources: each → candidates `{ key, source, date, title, text, url, tickers, hint }` ─────────────────────────

/** The universe's earnings prints with a Day 0 of 5%+ vs SPY. A print whose Day 0 is not closed yet waits (`pending`). */
export async function earnings(now = _deps.now()) {
    const rows = await _deps.calendar(daysAgo(now, LOOKBACK_DAYS + 2), day(now))
    const prints = (rows ?? []).filter(r => UNIVERSE[r.symbol] && r.epsActual != null)
    if (!prints.length) return { candidates: [], pending: [] }
    const from = daysAgo(now, LOOKBACK_DAYS + 12)
    const open = unfinishedSession(now)
    const strip = (b) => Object.fromEntries(Object.entries(b).filter(([d]) => d !== open))
    const spy = strip(await _deps.bars('SPY', from, day(now)))
    const candidates = [], pending = []
    for (const r of prints) {
        let bars
        try { bars = strip(await _deps.bars(r.symbol, from, day(now))) } catch { continue }
        const t = inferTiming(bars, spy, r.date)
        if (!t) { pending.push(r.symbol); continue }
        const move = dayZeroMove(bars, spy, t)
        if (move == null || Math.abs(move) < EVENT_SIZE) continue
        const news = await _deps.stockNews({ symbols: [r.symbol], from: r.date, to: day(now), limit: 4 }).catch(() => [])
        candidates.push({
            key: `earnings|${r.symbol}|${r.date}`, source: 'earnings', date: r.date, tickers: [r.symbol], timing: t.timing,
            title: `${UNIVERSE[r.symbol]} (${r.symbol}) reported on ${r.date}`,
            text: clip([
                `EPS ${r.epsActual} vs ${r.epsEstimated ?? '?'} est; revenue ${r.revenueActual ?? '?'} vs ${r.revenueEstimated ?? '?'} est.`,
                `Day 0 (${t.day0}) moved ${(move * 100).toFixed(1)}% vs SPY — the size test, not the news.`,
                ...news.slice(0, 4).map(n => `Headline (${String(n.publishedDate).slice(0, 10)}): ${n.title}. ${clip(n.text, 200)}`),
            ].join(' ')),
            url: null, hint: 'demand_shock', size: `Day 0 ${(move * 100).toFixed(1)}% vs SPY; EPS ${r.epsActual} vs ${r.epsEstimated ?? '?'} est`,
        })
        await _deps.sleep(150)
    }
    return { candidates, pending }
}

/** The universe's 8-Ks with item 1.01 (material agreement) or 2.01 (acquisition) — the doc's capacity deals. */
export async function eightKs(now = _deps.now()) {
    const since = daysAgo(now, LOOKBACK_DAYS)
    const out = []
    for (const t of UNIVERSE_TICKERS) {
        let r
        try { r = await _deps.eightKs(t, { since }) } catch { continue }
        for (const f of r?.filings ?? []) {
            const items = String(f.items).split(',').map(s => s.trim())
            if (!items.some(i => i === '1.01' || i === '2.01') || !f.url) continue
            let text = ''
            try {
                const full = await _deps.text(f.url)
                const at = full.search(/Item\s+(1\.01|2\.01)/i)
                text = clip(full.slice(Math.max(0, at), at + 3000))
            } catch { /* the filing stands on its items */ }
            out.push({ key: `8k|${f.url}`, source: '8-K', date: f.day, tickers: [t], title: `${UNIVERSE[t]} (${t}) 8-K items ${f.items}`, text, url: f.url, hint: 'capacity_deal' })
        }
        await _deps.sleep(120)
    }
    return out
}

/** The Federal Register's rules and presidential documents on the doc's policy terms (`days` back; the situation network reads a week). */
export async function policy(now = _deps.now(), { days = LOOKBACK_DAYS } = {}) {
    const out = [], seen = new Set()
    for (const term of POLICY_TERMS) {
        const p = new URLSearchParams({ 'conditions[publication_date][gte]': daysAgo(now, days), 'conditions[term]': term, per_page: '20', order: 'newest' })
        for (const t of ['RULE', 'PRESDOCU']) p.append('conditions[type][]', t)
        let j
        try { j = await _deps.http(`https://www.federalregister.gov/api/v1/documents.json?${p}`) } catch { continue }
        for (const d of j?.results ?? []) {
            if (seen.has(d.document_number)) continue
            seen.add(d.document_number)
            out.push({ key: `fr|${d.document_number}`, source: 'Federal Register', date: d.publication_date, tickers: [],
                title: d.title, text: clip(`${d.type}. ${(d.agencies ?? []).map(a => a.name).join(', ')}. ${d.abstract ?? ''}`), url: d.html_url, hint: 'policy' })
        }
    }
    return out
}

/**
 * The Defense Department's contract announcements: each award of $500M or more. The page sets each award in its own
 * paragraph (the live 2026-11-19 pass: split by sentences, an award came out as the page's boilerplate). Pure.
 */
export function awardsIn(html, min = DEFENSE_MIN_USD) {
    return String(html ?? '').split(/<\/p>/i)
        .map(p => p.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/g, '&').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim())
        .filter(p => /\b(is|was|has been) (awarded|being awarded)|\bawarded\b/i.test(p))
        .map(p => ({ p, usd: Math.max(0, ...[...p.matchAll(/\$([\d,]{7,})/g)].map(m => Number(m[1].replace(/,/g, '')))) }))
        .filter(x => x.usd >= min)
        .map(x => ({ text: clip(x.p, 1200), usd: x.usd }))
}

export async function defense(now = _deps.now()) {
    let rss
    try { rss = await _deps.http('https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=400&Site=945&max=5', { as: 'text' }) } catch { return [] }
    const since = daysAgo(now, LOOKBACK_DAYS)
    const out = []
    for (const m of String(rss).matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>/g)) {
        const date = day(new Date(m[3]))
        if (date < since) continue
        let page
        try { page = await _deps.http(m[2].trim(), { as: 'text' }) } catch { continue }
        awardsIn(page).forEach((a, i) => out.push({ key: `dod|${m[2].trim()}|${i}`, source: 'Defense contracts', date, tickers: [],
            title: `Defense award of $${(a.usd / 1e9).toFixed(2)}B (${date})`, text: a.text, url: m[2].trim(), hint: 'policy' }))
    }
    return out
}

/** Phase-3 results first posted on ClinicalTrials.gov, and FDA original approvals. */
export async function clinical(now = _deps.now()) {
    const out = []
    const since = daysAgo(now, LOOKBACK_DAYS)
    try {
        const p = new URLSearchParams({ 'filter.advanced': `AREA[ResultsFirstPostDate]RANGE[${since},MAX] AND AREA[Phase]PHASE3`, pageSize: '30',
            fields: 'NCTId,BriefTitle,LeadSponsorName,LeadSponsorClass,ResultsFirstPostDate,Condition,InterventionName' })
        const j = await _deps.http(`https://clinicaltrials.gov/api/v2/studies?${p}`)
        for (const s of j?.studies ?? []) {
            const ps = s.protocolSection ?? {}
            if (ps.sponsorCollaboratorsModule?.leadSponsor?.class !== 'INDUSTRY') continue
            const id = ps.identificationModule?.nctId
            const posted = ps.statusModule?.resultsFirstPostDateStruct?.date ?? since
            out.push({ key: `ct|${id}`, source: 'ClinicalTrials.gov', date: posted, tickers: [],
                title: `${ps.sponsorCollaboratorsModule?.leadSponsor?.name}: ${ps.identificationModule?.briefTitle}`,
                text: clip(`Phase 3 results posted. Conditions: ${(ps.conditionsModule?.conditions ?? []).join(', ')}. Interventions: ${(ps.armsInterventionsModule?.interventions ?? []).map(x => x.name).join(', ')}.`),
                url: `https://clinicaltrials.gov/study/${id}`, hint: 'clinical' })
        }
    } catch (err) { logger.warn(LOG, 'ClinicalTrials.gov failed', { error: err.message }) }
    try {
        const from = since.replace(/-/g, ''), to = day(now).replace(/-/g, '')
        const j = await _deps.http(`https://api.fda.gov/drug/drugsfda.json?search=submissions.submission_type:ORIG+AND+submissions.submission_status:AP+AND+submissions.submission_status_date:[${from}+TO+${to}]&limit=30`)
        for (const r of j?.results ?? []) {
            const prod = r.products?.[0] ?? {}
            // The APPROVAL's date, not the pass's (CR 2026-11-19: dated today, Day 0 came up to three days after the news).
            const sub = (r.submissions ?? []).filter(s => s.submission_type === 'ORIG' && s.submission_status === 'AP').map(s => String(s.submission_status_date ?? '')).sort().at(-1)
            const approved = /^\d{8}$/.test(sub ?? '') ? `${sub.slice(0, 4)}-${sub.slice(4, 6)}-${sub.slice(6, 8)}` : null
            if (!approved) continue
            out.push({ key: `fda|${r.application_number}`, source: 'FDA approval', date: approved, tickers: [],
                title: `FDA approved ${prod.brand_name ?? '?'} (${r.sponsor_name})`,
                text: clip(`Original approval. Active ingredients: ${(prod.active_ingredients ?? []).map(a => a.name).join(', ')}. Route: ${prod.route ?? '?'}.`),
                url: null, hint: 'clinical' })
        }
    } catch (err) { logger.warn(LOG, 'openFDA failed', { error: err.message }) }
    return out
}

/**
 * FMP's general news — the doc's fallback, for geopolitical and supply shocks. Echo reads one page of the last day; the
 * situation network's weekly build (services/situation/news.js) reads `days` back over `pages` pages.
 */
export async function news(now = _deps.now(), { days = 1, pages = 1 } = {}) {
    let rows = []
    for (let page = 0; page < pages; page++) {
        let got
        try { got = await _deps.fmp(`/news/general-latest?page=${page}&limit=60`, { label: 'FMP general news' }) } catch { if (page === 0) return []; break }
        if (!Array.isArray(got) || !got.length) break
        rows = rows.concat(got)
    }
    const since = daysAgo(now, days)
    return rows.filter(r => String(r.publishedDate).slice(0, 10) >= since).map(r => ({
        key: `news|${r.url ?? r.title}`, source: 'news', date: String(r.publishedDate).slice(0, 10), tickers: [],
        title: r.title, text: clip(r.text, 600), url: r.url ?? null, hint: null,
    }))
}

// ── the triage ───────────────────────────────────────────────────────────────────────────────────────────────────

export const SYSTEM = `You are the intake of an event-driven system that maps how news travels along SUPPLY CHAINS to companies the \
market is slow to connect. You read candidate items and decide which are EVENTS.

The target is news that shifts DEMAND or SUPPLY along a chain — not news about the market in general.
An item becomes an event only if it is ALL THREE:
- a SURPRISE versus expectations (a dated launch everyone knew of is not; a guide far above estimates is);
- LARGE relative to the companies it touches (a $2B contract to a $20B company is; a routine order is not);
- MORE THAN A ONE-OFF (a capex plan, a budget, a sanction regime, a drug class shift — not a single quiet quarter).

A FUNDING EVENT — an IPO, a mega-raise, debt raised for capex — by a company with a big supply chain is a DEMAND SHOCK for \
what the money buys: the origin is that company, the effect UP for its inputs (an AI lab's raise buys compute — chips, \
memory, networking, power, cooling, cloud capacity). Judge its SIZE against what it funds (a raise of tens of billions \
committed to compute is large for the whole chain) and its SURPRISE by the size and terms, not by whether the listing \
was expected; durability follows the money (committed to capacity contracts or a capex plan → multi_year_commitment).

SKIP: macro data (inflation, jobs, rates — it moves everything at once rather than along a chain); analyst upgrades \
and price targets; opinion pieces and rumours; "why stock X moved" recaps; routine filings (a credit agreement, a \
director change); anything with no company or country whose demand or supply it changes.

For an event, record it as it was known at the time:
- type: demand_shock, supply_shock, policy, clinical, geopolitical, capacity_deal or confirmation (a third party \
confirming an effect already under way).
- origin: the company or country the event hits directly; tickers: its US tickers (empty for a country or a demand).
- terms: what OTHER companies' filings call the origin (e.g. "NVIDIA", "Novo Nordisk", "GLP-1").
- what_changed: one sentence — THE NEWS (the guide, the rule, the result), never how the stock moved.
- size: guide vs consensus, budget amount, share of supply affected — as a sentence.
- effect: what the event does to demand AT THE ORIGIN — up, down or mixed.
- timing: before_open, during_session or after_close (US Eastern), as the item says or implies; after_close when unknown.
- durability, the most important field: price_spike (cures itself through demand destruction), \
policy_follow_through, drug_class_shift, or multi_year_commitment (a locked-in budget or capex plan) — with the reason.
- filter: surprise, large, lasting — true/false each — and one sentence why.
- follow_up_of: when the item follows up one of the ACTIVE EVENTS listed (policy follow-through, a third party \
confirming the effect, new results in the same drug class, a mapped company's report that mentions it), that event's \
id; else "". The biggest moves often come on the follow-up, so judge a follow-up's size against the original's chain.
- resolves: true only when the item resolves the active event's driver — supply caught up, the commitment was spent or \
reversed, a newer event replaced it.
Say verdict "skip" with the reason for anything that is not an event.`

export function triageSchema() {
    return {
        type: 'object',
        properties: {
            decisions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        key: { type: 'string' }, verdict: { type: 'string', enum: ['event', 'skip'] }, skip_reason: { type: 'string' },
                        type: { type: 'string', enum: [...TYPES] }, origin: { type: 'string' }, tickers: { type: 'array', items: { type: 'string' } },
                        terms: { type: 'array', items: { type: 'string' } }, what_changed: { type: 'string' }, size: { type: 'string' },
                        effect: { type: 'string', enum: [...EFFECTS] }, timing: { type: 'string', enum: [...TIMINGS] },
                        durability: { type: 'object', properties: { kind: { type: 'string', enum: [...DURABILITIES] }, why: { type: 'string' } }, required: ['kind', 'why'], additionalProperties: false },
                        filter: { type: 'object', properties: { surprise: { type: 'boolean' }, large: { type: 'boolean' }, lasting: { type: 'boolean' }, why: { type: 'string' } }, required: ['surprise', 'large', 'lasting', 'why'], additionalProperties: false },
                        follow_up_of: { type: 'string' }, resolves: { type: 'boolean' },
                    },
                    required: ['key', 'verdict', 'skip_reason', 'type', 'origin', 'tickers', 'terms', 'what_changed', 'size', 'effect', 'timing', 'durability', 'filter', 'follow_up_of', 'resolves'],
                    additionalProperties: false,
                },
            },
        },
        required: ['decisions'],
        additionalProperties: false,
    }
}

/**
 * The triage's user message: the candidates NUMBERED 1..n — the model answers each by its number (a key is a URL, and
 * a model shortens a long one: the 2026-11-19 live pass got 34 of 86 back). Pure.
 */
export function triagePrompt(cands, today, active = []) {
    const head = [`Today is ${today}.`]
    if (active.length) {
        head.push(`ACTIVE EVENTS (a follow-up names one by its id):\n${active.map(e => `- ${e._id}: ${e.date} ${e.origin} — ${e.whatChanged}`).join('\n')}`)
    }
    return [...head, `Decide each item (${cands.length}) — answer every one, its key being its number:`, '',
        ...cands.map((c, i) => `[${i + 1}] ${c.source}${c.hint ? ` (likely ${c.hint.replace('_', ' ')})` : ''}, ${c.date}${c.tickers?.length ? `, ${c.tickers.join('/')}` : ''}\n${c.title}\n${c.text}`)].join('\n\n')
}

/** One batch through the triage model. → the decisions by the candidate's key. */
async function triage(cands, payer, active = []) {
    const res = await _deps.call({ model: TRIAGE_MODEL, systemPrompt: SYSTEM, user: triagePrompt(cands, day(_deps.now()), active), schema: triageSchema(), effort: TRIAGE_EFFORT,
        onUsage: (usage, m) => { if (payer) _deps.record(payer, m, usage, 'echo', { monitor: true }).catch(() => {}) } })
    const out = new Map()
    for (const d of res?.data?.decisions ?? []) {
        const c = cands[Number(String(d.key).replace(/\D/g, '')) - 1]
        if (c) out.set(c.key, d)
    }
    return out
}

const seenColl = async () => (_deps.db ?? await getDb()).collection(SEEN)

/**
 * A USER's event, judged as the intake judges any item (Roy, 2026-11-19: "Echo decides if the user's event is worth it —
 * if it is, it treats it as a regular event"): the same triage, the same filter. → `{ event: true, framed }` — the
 * record IN THE TRIAGE'S OWN WORDS (the house's prompts never carry a user's text) — or `{ event: false, reason }`.
 * A failed triage is `{ event: false }`: the user's event stays theirs.
 */
export async function judge(framed, { userId = null } = {}) {
    const c = {
        key: 'chat', source: 'a user in chat', date: framed.date, tickers: framed.originTickers ?? [], hint: framed.type, timing: framed.timing,
        title: `${framed.origin}${framed.originTickers?.length ? ` (${framed.originTickers.join('/')})` : ''}: ${framed.whatChanged}`,
        text: clip([framed.size ? `Size: ${framed.size}.` : null, `Durability as framed: ${String(framed.durability?.kind).replace(/_/g, ' ')}${framed.durability?.why ? ` — ${framed.durability.why}` : ''}.`,
            `Effect at the origin: ${framed.effect}.`].filter(Boolean).join(' ')),
    }
    let decided
    try { decided = await triage([c], userId ?? await _deps.houseLedger().catch(() => null)) } catch (err) {
        logger.warn(LOG, 'judging a user event failed', { error: err.message })
        return { event: false, reason: 'the filter could not be run just now' }
    }
    const d = decided.get('chat')
    if (!d || d.verdict !== 'event') return { event: false, reason: d?.skip_reason || 'not an event by the filter' }
    const f = _deps.events.frame({ ...d, tickers: d.tickers?.length ? d.tickers : c.tickers, date: framed.date, timing: framed.timing ?? d.timing, sources: ['a user in chat'] }, framed.date)
    if (!f.ok) return { event: false, reason: f.reason }
    if (!_deps.events.passesFilter(f.event)) return { event: false, reason: d.filter?.why || 'not a surprise, large and more than a one-off' }
    return { event: true, framed: f.event }
}

/**
 * One intake pass: every source, the new candidates triaged, the events that pass the filter stored for the house.
 * → `{ candidates, triaged, events: [ids], skipped, pending }`. A source that fails costs only itself. Never throws.
 */
export async function intake() {
    const now = _deps.now()
    const found = []
    let pending = []
    const sources = [
        ['earnings', async () => { const r = await earnings(now); pending = r.pending; return r.candidates }],
        ['8-K', () => eightKs(now)], ['policy', () => policy(now)], ['defense', () => defense(now)], ['clinical', () => clinical(now)], ['news', () => news(now)],
    ]
    for (const [name, fn] of sources) {
        try { found.push(...await fn()) } catch (err) { logger.warn(LOG, `source ${name} failed`, { error: err.message }) }
    }
    const col = await seenColl()
    const seen = new Set((await col.find({ _id: { $in: found.map(c => c.key) } }, { projection: { _id: 1 } }).toArray()).map(d => d._id))
    const fresh = [...new Map(found.filter(c => !seen.has(c.key)).map(c => [c.key, c])).values()]
    const payer = await _deps.houseLedger().catch(() => null)
    // The events a new item may follow up (Step 5's wave watch): the house's under way.
    const active = (await _deps.events.list({ status: ['mapped', 'scored', 'watching'], limit: 40 }).catch(() => [])).filter(e => e.kind === 'house')
    const activeIds = new Set(active.map(e => e._id))
    const events = [], skipped = []
    for (let i = 0; i < fresh.length; i += BATCH) {
        const batch = fresh.slice(i, i + BATCH)
        let decided
        try { decided = await triage(batch, payer, active) } catch (err) {
            logger.warn(LOG, 'triage failed — the batch waits for the next pass', { error: err.message })
            continue
        }
        for (const c of batch) {
            const d = decided.get(c.key)
            if (!d) continue          // not answered: asked again next pass
            let eventId = null
            const parentId = activeIds.has(d.follow_up_of) ? d.follow_up_of : null
            if (d.verdict === 'event') {
                const f = _deps.events.frame({ ...d, follow_up_of: parentId, tickers: d.tickers?.length ? d.tickers : c.tickers, date: c.date, timing: c.timing ?? d.timing, size: c.size ?? d.size, sources: [c.url ?? c.title] }, day(now))
                if (f.ok && _deps.events.passesFilter(f.event)) {
                    const dup = await _deps.events.findSame(f.event).catch(() => null)
                    if (!dup) eventId = (await _deps.events.create(f.event, { source: c.source }))._id
                } else if (!f.ok) logger.warn(LOG, 'an event did not frame', { key: c.key, reason: f.reason })
            }
            // A follow-up marks the event it follows — even one too small to be an event of its own, and above all one
            // that RESOLVES the driver (Step 5's expiry).
            // Only an item that is an EVENT by the filter may resolve one (CR 2026-11-19: a single news line saying "resolved"
            // must not expire a house event); a smaller follow-up still marks it, as a trigger.
            if (parentId && (eventId || d.verdict === 'event')) {
                await _deps.followUp(parentId, { _id: eventId, date: c.date, whatChanged: d.what_changed }, Boolean(d.resolves && eventId)).catch(() => {})
            }
            if (!eventId) skipped.push({ key: c.key, reason: d.verdict === 'skip' ? d.skip_reason : 'did not pass the filter (surprise, large, lasting)' })
            else events.push(eventId)
            await col.updateOne({ _id: c.key }, { $set: { at: now.toISOString(), source: c.source, verdict: eventId ? 'event' : 'skip', eventId, reason: d.skip_reason || d.filter?.why || null } }, { upsert: true })
        }
    }
    logger.info(LOG, 'intake', { candidates: found.length, fresh: fresh.length, events: events.length, pending: pending.length })
    return { candidates: found.length, triaged: fresh.length, events, skipped, pending }
}

export const echoIntakeService = { intake, judge, earnings, eightKs, policy, defense, clinical, news, inferTiming, awardsIn }
