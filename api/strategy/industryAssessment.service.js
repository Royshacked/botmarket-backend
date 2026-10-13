// Pythia's assessment of an industry — is it interesting to trade, to invest in, to watch, or to avoid
// (docs/design/pythia-assessment.md, Roy's design of 2026-10-10).
//
// Pythia ASSESSES, it does not forecast: the research of 2026-10-08..10 (industry-screener.md §5) found no
// way to forecast which industries lead. So an assessment is a judgment from five inputs — news and
// events, price action, where the money goes, the regime, geopolitics — and the code holds it to
// guardrails: it must name what caused the move, the second-order effects, its risks and what would change
// its mind; and the FACTS it may not argue with — how far the price has moved, the hype flag — are
// attached here, from the engine's numbers, never taken from the agent.
//
// One house document per subject in `industry_assessment` (no owner — a broadcast, like industry_view),
// written through the house artifact repo so every change appends a revision. Every published verdict is
// also logged as a CALL (pythiaCalls.service.js) and graded later — the only honest test of a judgment.

import { getDb } from '../../providers/mongodb.provider.js'
import { makeHouseArtifactRepo } from '../../services/houseArtifact.repo.js'
import { newRevision, diffFields } from '../../services/revisionTrail.js'
import { logger } from '../../services/logger.service.js'
import { plainCitations } from '../../services/agentUtils.js'
import { themeService } from './theme.service.js'
import { normalizeSector } from '../../services/entity/vocabulary.js'

const LOG = '[industryAssessment]'
export const COLLECTION = 'industry_assessment'

/**
 * The verdict words and what the board says for each (Roy, 2026-10-11 — they were interesting_trade /
 * interesting_invest / watch / avoid from 2026-10-10). The verdict says WHICH book the industry is for.
 */
export const VERDICTS = Object.freeze({
    swing:     'For swing',
    long_term: 'For long term',
    watch:     'Watch',
    avoid:     'Avoid',
    no_case:   'No case',
})
/**
 * WATCH is a live question with a near test (Roy, 2026-10-11): it names the date that decides it (`decides_by`),
 * no more than this many days out. A quiet industry with nothing moving it and no near test is NO CASE — the
 * first full week had 122 of 165 on `watch`, 88 of them barely moving, which buried the few with a test days away.
 */
export const WATCH_MAX_DAYS = 42
/**
 * No case is re-checked on a fixed clock, not the horizon the model happened to write (code review 2026-10-11: 14
 * days on `weeks`, 91 on `years`). Four weeks; the weekly change scan brings it back sooner when anything moves.
 */
export const NO_CASE_EXPIRY_DAYS = 28
/** The words before 2026-10-11, read as today's — a block from an old thread, a document not yet migrated. */
export const LEGACY_VERDICTS = Object.freeze({ interesting_trade: 'swing', interesting_invest: 'long_term' })
export const HORIZONS = Object.freeze(['weeks', 'months', 'years'])
/** The horizons each book allows: a swing is weeks to months, a long-term holding is years. Others take any. */
const VERDICT_HORIZONS = Object.freeze({ swing: ['weeks', 'months'], long_term: ['years'] })
export const CONFIDENCE = Object.freeze(['low', 'medium', 'high'])
/** The five inputs (design §4), each with a line of evidence. */
export const INPUTS = Object.freeze(['news', 'price', 'money', 'regime', 'geopolitics'])
/** The two the desk can always read today; the rest may say they are not built yet. */
const REQUIRED_INPUTS = ['news', 'price']
/**
 * What caused the move (design §4.2). `none` is a FINDING — the desk looked and nothing nameable moved it (the
 * hype pattern only when the price has run: the board says so only with the hype flag on). `unverified` is NOT: the research could not be done (a search refused, a source down),
 * so the cause is unknown. Kept apart so a failed search never reads as a hype finding (first live run,
 * 2026-10-10: GNews at its daily limit, and the desk wrote `none`).
 */
export const CAUSES = Object.freeze(['news', 'money', 'regime', 'geopolitics', 'none', 'unverified'])
/** An assessment goes stale; it is reassessed by then (design §6 `expires_at`). */
export const EXPIRY_DAYS = Object.freeze({ weeks: 14, months: 42, years: 91 })

/**
 * The base rates attached by CODE (design §5.2), with the research behind each. Only the ones measured
 * in production are attached; the rest are listed as not measured yet so the board does not imply them.
 * The texts are shown to users, so they carry no doc references — the hype rate's source is
 * industry-screener.md §5.5.3 (Ken French's 49 industries, 1928–2024).
 */
export const BASE_RATES = Object.freeze({
    // Measured on value-weighted industries of every company of its time; the live flag reads equal-weighted
    // baskets of today's companies, which run hotter — so it is stated as a risk flag, not a probability for
    // THIS industry (code review 2026-10-11).
    hype: 'Up 100%+ in two years and 100%+ above the market. Of 98 such run-ups across US industries since 1928, 22% fell 40%+ within 24 months (base rate 9%), and the median one trailed the market by 10.6% over the next two years. A risk flag, not a probability: it reads the industry\'s companies weighted by size, as that history was (value-weighted), but only today\'s companies, the ones that survived.',
})
export const NOT_MEASURED = Object.freeze(['value_trap', 'customer_demand', 'momentum_at_turns'])
/**
 * The COMPANIES an assessment names (docs/design/pythia-names.md; Roy, 2026-10-13): the ones the evidence points at,
 * each with why. Optional, at most this many. Whether a name is first order (inside the subject) or second order
 * (elsewhere) is worked out by code from gics_companies, never taken from the model.
 */
export const NAMES_MAX = 6

const _io = {
    db: () => getDb(),
    // Each symbol's GICS classification (industryData.readCompaniesBySymbol). Imported lazily: industryData imports
    // from this module, so a static import back would be a cycle.
    companies: async (symbols) => (await import('./industryData.service.js')).readCompaniesBySymbol(symbols),
}
// The repo reads the same seam, so a test's fake database sees the revision write too.
const _repo = makeHouseArtifactRepo({ collection: COLLECTION, getDb: () => _io.db() })
/** Test seam. */
export function _setAssessmentIO(io) { Object.assign(_io, io) }

// Search citations are stored as their label (agentUtils.plainCitations — shared with the themes).
const _str = (v, max = 900) => (typeof v === 'string' && v.trim() ? plainCitations(v.trim()).slice(0, max) : null)
const _list = (v, max = 6) => (Array.isArray(v) ? v.map(x => _str(x, 300)).filter(Boolean).slice(0, max) : [])
const _num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A ticker as gics_companies spells it: upper case, a share class with a dash (BRK.B → BRK-B). Pure. */
export function normalizeSymbol(v) {
    return typeof v === 'string' ? v.trim().toUpperCase().replace(/\./g, '-') : ''
}

/**
 * The `names` list's SHAPE (pythia-names.md §3) → `{ names: [{ symbol, why }], dropped: [{ symbol, reason }] }`. A bad
 * name is DROPPED with its reason, never a refusal — the research was paid for. Pure; the universe check is
 * resolveNames, at publish.
 */
export function checkNames(raw) {
    const names = [], dropped = [], seen = new Set()
    for (const n of Array.isArray(raw) ? raw : []) {
        const symbol = normalizeSymbol(n?.symbol)
        const why = _str(n?.why, 200)
        if (!/^[A-Z][A-Z0-9-]{0,9}$/.test(symbol)) { dropped.push({ symbol: symbol || String(n?.symbol ?? ''), reason: 'not a ticker' }); continue }
        if (seen.has(symbol)) continue
        seen.add(symbol)
        if (!why) { dropped.push({ symbol, reason: 'no why — the evidence that points at it' }); continue }
        if (names.length >= NAMES_MAX) { dropped.push({ symbol, reason: `over the limit of ${NAMES_MAX}` }); continue }
        names.push({ symbol, why })
    }
    return { names, dropped }
}

/**
 * The names against our universe (pythia-names.md §3). `known` is readCompaniesBySymbol's map; `inside` the subject's
 * sub-industry codes (the industry, or the theme's links). A name the universe does not hold is dropped (foreign, under
 * $300M, a typo — Roy: Argus and Prometheus can neither price nor classify it); the rest are FIRST order when their
 * sub-industry is inside the subject, SECOND order otherwise. Pure → `{ names, dropped }`.
 */
export function resolveNames(names, known, inside) {
    const out = [], dropped = []
    for (const n of names ?? []) {
        const c = known?.[n.symbol]
        if (!c?.sub_code) { dropped.push({ symbol: n.symbol, reason: 'not in our universe (US, $300M+)' }); continue }
        out.push({ symbol: n.symbol, why: n.why, order: inside.has(c.sub_code) ? 'first' : 'second', sub_code: c.sub_code, industry: c.sub_industry ?? null })
    }
    return { names: out, dropped }
}

/**
 * One <industry_assessment> block, checked → `{ ok, assessment, gaps }` or `{ ok:false, detail }`. Pure.
 *
 * Refused when it lacks what makes it a judgment rather than a story: a verdict, a horizon, a thesis, the
 * news and price evidence, what caused the move, the second-order view, a risk, and what would change it.
 * The inputs beyond news and price (money, regime, geopolitics) may be absent — whatever the desk leaves out is
 * stored as a gap, so the board shows what the verdict was NOT based on (only regime has no measured input yet). Facts the agent sends (moves, flags) are
 * ignored: the code attaches them.
 */
export function checkAssessment(block, { expect = null, now = new Date().toISOString() } = {}) {
    if (!block || typeof block !== 'object') return { ok: false, detail: 'no block' }
    // The subject: an industry (8-digit GICS code) or a theme (its th_ id, theme.service) — step 3. When the
    // caller knows which it asked for (`expect`), that field is read and the other ignored: on a theme turn the
    // model sometimes adds a direct link's `industry` too, and the block was then refused as an industry after
    // a paid run (code review 2026-10-11).
    const industry = expect === 'theme' ? null : _str(block.industry, 16)
    const theme = expect === 'industry' || industry ? null : _str(block.theme, 60)
    if (theme ? !/^th_[a-z0-9_]+$/.test(theme) : (!industry || !/^\d{8}$/.test(industry))) {
        return { ok: false, detail: 'industry must be the 8-digit GICS code — or, for a theme, theme its th_ id' }
    }
    const code = industry ?? theme
    const problems = []
    const said = _str(block.verdict, 40)
    const verdict = LEGACY_VERDICTS[said] ?? said
    if (!verdict || !VERDICTS[verdict]) problems.push(`verdict must be one of ${Object.keys(VERDICTS).join('/')}`)
    let horizon = _str(block.horizon, 20)
    if (!horizon || !HORIZONS.includes(horizon)) problems.push(`horizon must be one of ${HORIZONS.join('/')}`)
    // The verdict names the book, so it decides the horizon where they disagree — a "swing" over years is a
    // long-term call mislabelled, and refusing it would throw away a paid run over a word.
    else if (VERDICT_HORIZONS[verdict] && !VERDICT_HORIZONS[verdict].includes(horizon)) horizon = verdict === 'swing' ? 'months' : 'years'
    const thesis = _str(block.thesis)
    if (!thesis) problems.push('thesis is missing')

    const ev = block.evidence && typeof block.evidence === 'object' ? block.evidence : {}
    const evidence = {}, gaps = []
    for (const k of INPUTS) {
        const text = _str(typeof ev[k] === 'object' && ev[k] ? ev[k].text : ev[k], 700)
        if (text) evidence[k] = text
        else if (REQUIRED_INPUTS.includes(k)) problems.push(`evidence.${k} is missing`)
        else gaps.push(k)
    }
    const c = block.cause && typeof block.cause === 'object' ? block.cause : {}
    const causeKind = _str(c.kind, 20)
    const causeText = _str(c.text, 500)
    if (!causeKind || !CAUSES.includes(causeKind)) problems.push(`cause.kind must be one of ${CAUSES.join('/')}`)
    if (!causeText) problems.push('cause.text is missing — say what moved it, or why nothing nameable did')
    const secondOrder = _str(block.second_order, 600)
    if (!secondOrder) problems.push('second_order is missing — who benefits or pays up and down the chain')
    const risks = _list(block.risks)
    if (!risks.length) problems.push('risks: name at least one')
    const changeIf = _list(block.change_view_if)
    if (!changeIf.length) problems.push('change_view_if: name at least one checkable condition')
    const confidence = _str(block.confidence, 10)
    if (!confidence || !CONFIDENCE.includes(confidence)) problems.push(`confidence must be one of ${CONFIDENCE.join('/')}`)
    if (problems.length) return { ok: false, detail: `${code}: ${problems.join('; ')}` }
    // A watch stands only with its deciding date inside WATCH_MAX_DAYS; without one it IS no case, and is published
    // as such (not refused — the research was paid for), with the reason kept.
    let finalVerdict = verdict
    let decidesBy = null, watchDowngraded = null, question = null
    if (verdict === 'watch') {
        // Earnings season puts a dated report inside six weeks for nearly every industry (2026-10-11: a quiet
        // Apparel Retail passed as "watch, decides by TJX's report"), so the date alone is no test. A watch also
        // needs something that moved it (cause not `none`) and the SPECIFIC open question the dated event answers.
        question = _str(block.question, 300)
        if (causeKind === 'none') watchDowngraded = 'nothing nameable moved it — no live question'
        // Could not check the news: there is no confirmed live question either (code review 2026-10-11).
        else if (causeKind === 'unverified') watchDowngraded = 'the news could not be checked — no confirmed live question'
        else if (!question) watchDowngraded = 'no open question named'
        if (watchDowngraded) finalVerdict = 'no_case'
    }
    if (verdict === 'watch' && !watchDowngraded) {
        const d = _str(block.decides_by, 10)
        // Whole calendar days from today's date to the deciding date: today is 0, six weeks on is 42.
        // A real calendar date only: Date.parse rolls 2026-02-30 over to March 2, so the string must round-trip.
        const ms = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : NaN
        const real = Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d
        const days = real ? (ms - Date.parse(`${String(now).slice(0, 10)}T00:00:00Z`)) / 86_400_000 : NaN
        if (days >= 0 && days <= WATCH_MAX_DAYS) decidesBy = d
        else {
            finalVerdict = 'no_case'
            watchDowngraded = !d ? 'no decides_by date' : !Number.isFinite(days) ? `decides_by ${d} is not a date` : days < 0 ? `decides_by ${d} has passed` : `decides_by ${d} is more than ${WATCH_MAX_DAYS} days out`
        }
    }
    const named = checkNames(block.names)
    return {
        ok: true, gaps, names_dropped: named.dropped,
        assessment: {
            names: named.names,
            code: industry, theme, verdict: finalVerdict, horizon, thesis, evidence, cause: { kind: causeKind, text: causeText },
            second_order: secondOrder, risks, change_view_if: changeIf, confidence,
            confidence_reason: _str(block.confidence_reason, 300),
            decides_by: decidesBy, question: finalVerdict === 'watch' ? question : null,
            ...(watchDowngraded ? { watch_downgraded: watchDowngraded } : {}),
        },
    }
}

/**
 * The facts attached by code from the engine's screen row for the industry (industry_timing) → `{ moved,
 * base_rates, not_measured }`. Pure. `moved` is how far the price has gone (design §4.2); a base rate is
 * attached only when it APPLIES.
 */
export function factsFor(row) {
    const r = row?.raw ?? {}
    const ex = (a, b) => (_num(a) != null && _num(b) != null ? a - b : null)
    const moved = row ? {
        asof: row.asof ?? null, basket: row.basket_name ?? null,
        ret_12m: _num(r.ret_12m), spy_12m: _num(r.spy_12m), excess_12m: ex(r.ret_12m, r.spy_12m),
        ret_24m: _num(r.ret_24m), spy_24m: _num(r.spy_24m), excess_24m: ex(r.ret_24m, r.spy_24m),
        rel_1m: _num(r.rel_1m), rel_3m: _num(r.rel_3m),
        ext_50: _num(r.ext_50), ext_percentile: _num(r.ext_percentile),
        // By SIZE (the engine's size-weighted line, 2026-10-11): what the hype flag reads. The equal-weight
        // numbers above let a few small names multiplying stand for the industry.
        ret_12m_vw: _num(r.ret_12m_vw), ret_24m_vw: _num(r.ret_24m_vw), excess_24m_vw: ex(r.ret_24m_vw, r.spy_24m_vw),
        hype: typeof r.hype === 'boolean' ? r.hype : null,
        hype_basis: r.hype_basis ?? null,
    } : null
    const base_rates = moved?.hype ? [{ key: 'hype', text: BASE_RATES.hype }] : []
    return { moved, base_rates, not_measured: [...NOT_MEASURED] }
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. Pure. */
export function ordinal(n) {
    const t = n % 100
    if (t >= 11 && t <= 13) return `${n}th`
    return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`
}

const _pct = (v, d = 0) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : 'n/a')

/**
 * The facts as the agent reads them (the `get_industry_moves` tool). Pure. `regime` is the engine's
 * market regime for the same run (green / yellow / red from the S&P's trend and volatility).
 */
export function formatFacts(row, regime = null) {
    const { moved, base_rates, not_measured } = factsFor(row)
    if (!moved) return 'No price measurements for this industry yet — the engine price run has not covered it.'
    const pctile = moved.ext_percentile != null ? `${ordinal(Math.round(moved.ext_percentile * 100))} percentile of its own two years` : 'percentile n/a'
    // A sub-industry with too few liquid names is priced on its PARENT's basket, which its siblings share
    // (2026-10-11: 11 baskets cover ~29 sub-industries). Said in words, or the desk reads Metals & Mining's move
    // as Copper's own.
    const shared = moved.basket && row?.name && moved.basket !== row.name
        ? [`  These moves are ${moved.basket}'s as a whole (too few ${row.name} names to price on their own) — not ${row.name}'s alone. Say so, and lean on the news and the money for what is specific to it.`]
        : []
    return [
        `HOW FAR IT HAS MOVED (engine run ${moved.asof}; equal-weight basket: ${moved.basket ?? 'its own'}):`,
        ...shared,
        `  12 months ${_pct(moved.ret_12m)} vs SPY ${_pct(moved.spy_12m)} → ${_pct(moved.excess_12m)} over the market`,
        `  24 months ${_pct(moved.ret_24m)} vs SPY ${_pct(moved.spy_24m)} → ${_pct(moved.excess_24m)} over the market`,
        ...(moved.ret_24m_vw != null ? [`  BY SIZE (the big companies count for more — what the hype flag reads): 12 months ${_pct(moved.ret_12m_vw)}, 24 months ${_pct(moved.ret_24m_vw)} → ${_pct(moved.excess_24m_vw)} over the market. Where it differs from the equal-weight line, a few smaller names drove the average.`] : []),
        `  last 1 / 3 months vs the S&P: ${_pct(moved.rel_1m, 1)} / ${_pct(moved.rel_3m, 1)}`,
        `  stretched: ${_pct(moved.ext_50, 1)} above its 50-day — ${pctile}`,
        `HYPE FLAG: ${moved.hype == null ? 'n/a (needs two years and SPY)' : moved.hype ? 'YES' : 'no'}`,
        ...base_rates.map(b => `BASE RATE (attached to your assessment by code): ${b.text}`),
        `NOT MEASURED YET (say nothing about them as if measured): ${not_measured.join(', ')}`,
        `MARKET REGIME (S&P trend and volatility): ${String(regime?.regime ?? 'n/a').toUpperCase()}`,
    ].join('\n')
}

/**
 * A THEME's facts, attached by code (step 3): how far each linked industry has moved and where its
 * companies put money, link by link in value-chain order. `rows` maps a sub-industry code to its screen
 * row, `money` to its money facts (industryData.moneyFacts). The hype flag is the theme's when a DIRECT
 * (order-1) link carries it. Pure → `{ moved, base_rates, not_measured, money }`.
 */
export function themeFacts(theme, rows = new Map(), money = new Map()) {
    const links = (theme?.links ?? []).map(l => {
        const m = factsFor(rows.get(l.code)).moved
        return {
            code: l.code, name: l.name, order: l.order,
            ...(m ? { ret_12m: m.ret_12m, excess_12m: m.excess_12m, ret_24m: m.ret_24m, excess_24m: m.excess_24m,
                // By size, beside the equal-weight move: the hype chip on a link reads these (code review 2026-10-11).
                ret_24m_vw: m.ret_24m_vw, excess_24m_vw: m.excess_24m_vw, rel_1m: m.rel_1m,
                ext_percentile: m.ext_percentile, hype: m.hype, hype_basis: m.hype_basis, asof: m.asof } : {}),
        }
    })
    const direct = links.filter(l => l.order === 1)
    const hype = direct.some(l => l.hype === true) ? true : direct.some(l => l.hype === false) ? false : null
    return {
        moved: { kind: 'theme', hype, links },
        base_rates: hype ? [{ key: 'hype', text: BASE_RATES.hype }] : [],
        not_measured: [...NOT_MEASURED],
        money: { kind: 'theme', links: (theme?.links ?? []).map(l => ({ code: l.code, name: l.name, order: l.order, ...(money.get(l.code) ?? {}) })) },
    }
}

const _plusDays = (iso, days) => new Date(Date.parse(iso) + days * 86_400_000).toISOString()

/** Once, at boot (server.js), like every other collection's ensure*Indexes. */
export async function ensureIndustryAssessmentIndexes() {
    const db = await _io.db()
    await db.collection(COLLECTION).createIndex({ id: 1 }, { unique: true })
    await db.collection(COLLECTION).createIndex({ 'subject.code': 1 })
}

const _id = (code) => `ia_ind_${code}`
const _themeDocId = (themeId) => `ia_${themeId}`

/**
 * Publish an assessment: checked, the code's facts attached, written with a revision, and logged as a call.
 * For an INDUSTRY: `sub` is its metrics node (industryData.readSubIndustry().sub), `row` its latest screen
 * row (screenerData.readTimingRow), `money` the money facts of the node that answers it
 * (industryData.moneyFacts), `flows` its insiders, funds and government (industryData.flowFacts, step 8),
 * `structure` the standing industry_view grades. For a THEME (step 3): `theme` is
 * the approved theme and `facts` its themeFacts; `basket` the symbols its call is graded on.
 * → `{ ok, doc, changed, call }` or `{ ok:false, reason, detail }`.
 */
async function publishAssessment(block, { sub = null, row = null, money = null, flows = null, geopolitics = null, theme = null, facts: given = null, basket = null,
    structure = null, recordCall = null, now = new Date().toISOString(), source = 'chat', trigger = null } = {}) {
    const checked = checkAssessment(block, { expect: theme ? 'theme' : sub ? 'industry' : null, now })
    if (!checked.ok) return { ok: false, reason: 'bad_assessment', detail: checked.detail }
    const a = checked.assessment
    let id, subject
    if (a.theme) {
        if (!theme || theme.id !== a.theme) return { ok: false, reason: 'unknown_theme', detail: `no theme ${a.theme}` }
        if (theme.status !== 'approved') return { ok: false, reason: 'unknown_theme', detail: `${theme.name} is not approved — a proposed theme is not assessed` }
        id = _themeDocId(theme.id)
        subject = { kind: 'theme', id: theme.id, name: theme.name, sector: null }
    } else {
        if (!sub || sub.code !== a.code) return { ok: false, reason: 'unknown_industry', detail: `no measured sub-industry ${a.code}` }
        id = _id(a.code)
        subject = { kind: 'industry', code: sub.code, name: sub.name, sector: sub.sector ?? null }
    }
    const db = await _io.db()
    await db.collection(COLLECTION).updateOne({ id },
        { $setOnInsert: { subject, revisions: [], created_at: now } }, { upsert: true })
    const cur = await db.collection(COLLECTION).findOne({ id })
    const facts = a.theme ? (given ?? themeFacts(theme)) : { ...factsFor(row), money }
    // The names against our universe. A failed read publishes the assessment without them, saying why.
    let names = [], namesDropped = [...(checked.names_dropped ?? [])]
    if (a.names?.length) {
        const inside = new Set(a.theme ? (theme.links ?? []).map(l => l.code) : [sub.code])
        try {
            const r = resolveNames(a.names, await _io.companies(a.names.map(n => n.symbol)), inside)
            names = r.names
            namesDropped = [...namesDropped, ...r.dropped]
        } catch (err) {
            logger.warn(LOG, 'names not checked — published without them', { code: a.code ?? a.theme, error: err.message })
            namesDropped = [...namesDropped, ...a.names.map(n => ({ symbol: n.symbol, reason: 'could not be checked' }))]
        }
    }
    const set = {
        subject, verdict: a.verdict, horizon: a.horizon, thesis: a.thesis, evidence: a.evidence, gaps: checked.gaps,
        cause: a.cause, second_order: a.second_order, risks: a.risks, change_view_if: a.change_view_if,
        names, names_dropped: namesDropped.length ? namesDropped : null,
        decides_by: a.decides_by ?? null, question: a.question ?? null, watch_downgraded: a.watch_downgraded ?? null,
        confidence: a.confidence, confidence_reason: a.confidence_reason,
        moved: facts.moved, base_rates: facts.base_rates, not_measured: facts.not_measured,
        // Companies' own money (§4.3) — facts from the engine's metrics node, like the moves (industryData.moneyFacts).
        money: facts.money ?? null,
        // The rest of the money (step 8: insiders, funds, government — pythia-money-flows.md), industries only.
        flows: a.theme ? null : (flows ?? null),
        // Geopolitics (step 4: the GPR reading and the mapped risks touching it — pythia-geopolitics.md), industries only.
        geopolitics: a.theme ? null : (geopolitics ?? null),
        structure, assessed_at: now, expires_at: _plusDays(now, a.verdict === 'no_case' ? NO_CASE_EXPIRY_DAYS : EXPIRY_DAYS[a.horizon]), source, updated_at: now,
        // Why this run happened, when the weekly change scan asked for it (changeScan reasons); null otherwise.
        trigger: Array.isArray(trigger) && trigger.length ? trigger.map(r => ({ key: r.key, text: r.text ?? r.key, detail: r.detail ?? null })) : null,
    }
    const fields = ['verdict', 'horizon', 'confidence']
    // The stored verdict read in today's words: a document still saying interesting_trade is not a "change" to swing.
    const was = { ...cur, verdict: LEGACY_VERDICTS[cur?.verdict] ?? cur?.verdict }
    const changed = diffFields(Object.fromEntries(fields.map(f => [f, was?.[f] ?? null])), a, fields)
    await _repo.revise(id, set, newRevision({ kind: cur?.verdict ? 'reassessment' : 'assessment', note: a.thesis, changed, at: now }))
    const doc = await db.collection(COLLECTION).findOne({ id }, { projection: { _id: 0 } })
    let call = null
    if (recordCall) {
        try { call = await recordCall(doc, { now, basket }) }
        catch (err) { logger.warn(LOG, 'call not logged (the assessment is published)', { code: a.code, error: err.message }) }
    }
    return { ok: true, doc, changed, call }
}

async function getAssessment(code) {
    const db = await _io.db()
    return db.collection(COLLECTION).findOne({ id: _id(code) }, { projection: { _id: 0 } })
}

async function getThemeAssessment(themeId) {
    const db = await _io.db()
    return db.collection(COLLECTION).findOne({ id: _themeDocId(themeId) }, { projection: { _id: 0 } })
}

/**
 * The standing verdict per sub-industry code, light — for the desks that act on it (pythia-assessment.md §10:
 * Atlas's limits and review, Axl). → Map(code → { verdict, horizon, hype, decides_by, question }). An EXPIRED verdict
 * is left out: it is due for reassessment, and must not keep gating saves meanwhile (code review 2026-10-11). Only the
 * fields the callers read — every Atlas tool call, plan, review and save pays for this read.
 */
async function verdictsForCodes(codes, { now = new Date().toISOString() } = {}) {
    const list = [...new Set((codes ?? []).filter(Boolean))]
    if (!list.length) return new Map()
    const db = await _io.db()
    const rows = await db.collection(COLLECTION).find({ 'subject.kind': 'industry', 'subject.code': { $in: list } },
        { projection: { _id: 0, 'subject.code': 1, verdict: 1, horizon: 1, 'moved.hype': 1, decides_by: 1, question: 1, expires_at: 1 } }).toArray()
    return new Map(rows.filter(r => !r.expires_at || r.expires_at > now).map(r => [r.subject.code, {
        verdict: LEGACY_VERDICTS[r.verdict] ?? r.verdict, horizon: r.horizon ?? null, hype: r.moved?.hype === true,
        decides_by: r.decides_by ?? null, question: r.question ?? null,
    }]))
}

async function listAssessments() {
    const db = await _io.db()
    return db.collection(COLLECTION).find({}, { projection: { _id: 0, revisions: 0 } }).sort({ 'subject.sector': 1, 'subject.name': 1 }).toArray()
}

/**
 * What a CLOSED row on the Assessed board shows (docs/design/assessment-light-list.md §2.1): the name, the verdict and
 * its horizon or deciding date, the thesis line, the "news not checked", hype and stale chips, and `assessed_at` —
 * the key an opened row's detail is cached on. The rest (evidence, money, flows, risks…) is fetched when a row opens:
 * the whole list was 780 KB for 166 assessments, these rows 107. Mongo's projection keeps the read light; the shaping
 * keeps the contract. Pure.
 */
export const ROW_PROJECTION = Object.freeze({
    _id: 0, id: 1, subject: 1, verdict: 1, horizon: 1, decides_by: 1, thesis: 1,
    'cause.kind': 1, 'moved.hype': 1, expires_at: 1, assessed_at: 1,
})
export function assessmentRow(a) {
    return {
        id: a.id ?? null, subject: a.subject ?? null, verdict: a.verdict ?? null, horizon: a.horizon ?? null,
        decides_by: a.decides_by ?? null, thesis: a.thesis ?? null,
        cause: a.cause?.kind ? { kind: a.cause.kind } : null,
        moved: { hype: a.moved?.hype ?? null },
        expires_at: a.expires_at ?? null, assessed_at: a.assessed_at ?? null,
    }
}

/** The board's list, light: one closed row per assessment, in the same order as listAssessments. */
async function listAssessmentRows() {
    const db = await _io.db()
    const docs = await db.collection(COLLECTION).find({}, { projection: ROW_PROJECTION }).sort({ 'subject.sector': 1, 'subject.name': 1 }).toArray()
    return docs.map(assessmentRow)
}

/** The books a scan can ask for — the verdicts that say "worth this book's attention now". Watch is left out (Roy, 2026-10-13). */
export const BOOKS = Object.freeze(['swing', 'long_term'])
/** A theme sends its direct links and its suppliers, as the house scan does; suppliers' suppliers are too far out. */
const BOOK_LINK_ORDER = 2

/**
 * The house's industries for one BOOK (docs/design/argus-on-pythia.md §3.1) — where a scan for that book looks
 * FIRST. A preference, never a filter: the callers screen the rest of the market too. Pure.
 *
 * `rows` are assessment documents (industries and themes); `themes` the APPROVED themes. An industry is listed
 * when its own unexpired verdict is the book, or when an unexpired theme rated the book links it at order 1–2 —
 * one entry per sub-industry either way, with every theme that brought it. `sector` narrows to one GICS sector.
 * An industry Pythia rates AVOID on its own can still arrive through a theme: it is listed, marked `avoid`.
 * → `[{ code, name, sector, rated, horizon, hype, thesis, top_risk, second_order, avoid, excess_12m, themes: [{ id, name, order, horizon, thesis, second_order }] }]`,
 * the biggest 12-month move over the market first (none last).
 */
export function houseIndustriesFor(rows, themes, { book, sector = null, now = new Date().toISOString() } = {}) {
    if (!BOOKS.includes(book)) return []
    const live = (rows ?? []).filter(r => !r.expires_at || r.expires_at > now)
    const verdictOf = (r) => LEGACY_VERDICTS[r.verdict] ?? r.verdict
    const own = new Map(live.filter(r => r.subject?.kind === 'industry' && r.subject.code).map(r => [r.subject.code, r]))
    // Either spelling — GICS ("Information Technology") or the screener's ("Technology"): a sleeve's sector is model text.
    const _sec = (s) => normalizeSector(s) ?? String(s ?? '').trim().toLowerCase()
    const inSector = (s) => !sector || _sec(s) === _sec(sector)
    const out = new Map()
    const entry = (code, name, sec) => {
        if (!out.has(code)) {
            const r = own.get(code)
            const mine = r && verdictOf(r) === book
            out.set(code, {
                code, name: r?.subject?.name ?? name, sector: r?.subject?.sector ?? sec ?? null,
                rated: Boolean(mine), horizon: mine ? (r.horizon ?? null) : null,
                hype: r?.moved?.hype === true, thesis: mine ? (r.thesis ?? null) : null,
                top_risk: mine ? (r.risks?.[0] ?? null) : null, avoid: r ? verdictOf(r) === 'avoid' : false,
                // Who else it reaches — Pythia's second-order read, required on every assessment (Roy, 2026-10-13: shown
                // beside the first order, neither preferred).
                second_order: mine ? (r.second_order ?? null) : null,
                // The companies its evidence pointed at (pythia-names.md), first and second order alike.
                names: mine ? (r.names ?? []) : [],
                excess_12m: _num(r?.moved?.excess_12m), themes: [],
            })
        }
        return out.get(code)
    }
    for (const r of own.values()) {
        if (verdictOf(r) === book && inSector(r.subject.sector)) entry(r.subject.code, r.subject.name, r.subject.sector)
    }
    const approved = new Map((themes ?? []).filter(t => t?.status === 'approved').map(t => [t.id, t]))
    for (const r of live) {
        if (r.subject?.kind !== 'theme' || verdictOf(r) !== book) continue
        const t = approved.get(r.subject.id)
        if (!t) continue                          // retired since it was rated: its verdict no longer speaks for the house
        const moves = new Map((r.moved?.links ?? []).map(l => [l.code, l]))
        for (const l of (t.links ?? []).filter(x => x.order <= BOOK_LINK_ORDER && inSector(x.sector))) {
            const e = entry(l.code, l.name, l.sector)
            if (e.excess_12m == null) e.excess_12m = _num(moves.get(l.code)?.excess_12m)
            if (moves.get(l.code)?.hype === true) e.hype = true
            e.themes.push({ id: t.id, name: t.name, order: l.order, horizon: r.horizon ?? null, thesis: r.thesis ?? null, second_order: r.second_order ?? null, names: r.names ?? [] })
        }
    }
    return [...out.values()].sort((a, b) => (b.excess_12m ?? -Infinity) - (a.excess_12m ?? -Infinity) || String(a.name).localeCompare(String(b.name)))
}

/**
 * houseIndustriesFor over the stored assessments and the approved themes, for SEVERAL books from ONE read of each
 * (code review 2026-10-13: the label asked both books and read everything twice). → `{ [book]: entries }`. Read-only.
 */
async function listForBooks(books, { sector = null, now = new Date().toISOString() } = {}, deps = {}) {
    const want = (books ?? []).filter(b => BOOKS.includes(b))
    if (!want.length) return {}
    const { themes = () => themeService.listThemes({ statuses: ['approved'] }) } = deps
    const db = await _io.db()
    const [rows, approved] = await Promise.all([
        db.collection(COLLECTION).find({}, { projection: {
            _id: 0, subject: 1, verdict: 1, horizon: 1, thesis: 1, risks: 1, second_order: 1, names: 1, expires_at: 1,
            'moved.hype': 1, 'moved.excess_12m': 1, 'moved.links': 1,
        } }).toArray(),
        themes(),
    ])
    return Object.fromEntries(want.map(book => [book, houseIndustriesFor(rows, approved, { book, sector, now })]))
}

/** The house's industries for one book (listForBooks for one). Read-only. */
async function listForBook(book, opts = {}, deps = {}) {
    return (await listForBooks([book], opts, deps))[book] ?? []
}

export const industryAssessmentService = { publishAssessment, getAssessment, getThemeAssessment, listAssessments, listAssessmentRows, verdictsForCodes, listForBook, listForBooks }
