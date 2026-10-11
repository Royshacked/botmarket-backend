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

const LOG = '[industryAssessment]'
export const COLLECTION = 'industry_assessment'

/** The verdict words (Roy, 2026-10-10) and what the board says for each. */
export const VERDICTS = Object.freeze({
    interesting_trade:  'Interesting to trade',
    interesting_invest: 'Interesting to invest',
    watch:              'Watch',
    avoid:              'Avoid',
})
export const HORIZONS = Object.freeze(['weeks', 'months', 'years'])
export const CONFIDENCE = Object.freeze(['low', 'medium', 'high'])
/** The five inputs (design §4), each with a line of evidence. */
export const INPUTS = Object.freeze(['news', 'price', 'money', 'regime', 'geopolitics'])
/** The two the desk can always read today; the rest may say they are not built yet. */
const REQUIRED_INPUTS = ['news', 'price']
/**
 * What caused the move (design §4.2). `none` is a FINDING — the desk looked and nothing nameable moved it,
 * the hype pattern. `unverified` is NOT: the research could not be done (a search refused, a source down),
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
    hype: 'Up 100%+ in two years and 100%+ above the market. Of 98 such run-ups across US industries since 1928, 22% fell 40%+ within 24 months (base rate 9%), and the median one trailed the market by 10.6% over the next two years. A risk flag, not a probability: that history used value-weighted industries, this flag reads an equal-weighted basket of today\'s companies, which runs hotter.',
})
export const NOT_MEASURED = Object.freeze(['value_trap', 'customer_demand', 'momentum_at_turns'])

const _io = { db: () => getDb() }
// The repo reads the same seam, so a test's fake database sees the revision write too.
const _repo = makeHouseArtifactRepo({ collection: COLLECTION, getDb: () => _io.db() })
/** Test seam. */
export function _setAssessmentIO(io) { Object.assign(_io, io) }

const _str = (v, max = 900) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const _list = (v, max = 6) => (Array.isArray(v) ? v.map(x => _str(x, 300)).filter(Boolean).slice(0, max) : [])
const _num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * One <industry_assessment> block, checked → `{ ok, assessment, gaps }` or `{ ok:false, detail }`. Pure.
 *
 * Refused when it lacks what makes it a judgment rather than a story: a verdict, a horizon, a thesis, the
 * news and price evidence, what caused the move, the second-order view, a risk, and what would change it.
 * The inputs not built yet (money, regime, geopolitics in build step 1) may be absent — they are stored as
 * gaps, so the board shows what the verdict was NOT based on. Facts the agent sends (moves, flags) are
 * ignored: the code attaches them.
 */
export function checkAssessment(block, { expect = null } = {}) {
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
    const verdict = _str(block.verdict, 40)
    if (!verdict || !VERDICTS[verdict]) problems.push(`verdict must be one of ${Object.keys(VERDICTS).join('/')}`)
    const horizon = _str(block.horizon, 20)
    if (!horizon || !HORIZONS.includes(horizon)) problems.push(`horizon must be one of ${HORIZONS.join('/')}`)
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
    return {
        ok: true, gaps,
        assessment: {
            code: industry, theme, verdict, horizon, thesis, evidence, cause: { kind: causeKind, text: causeText },
            second_order: secondOrder, risks, change_view_if: changeIf, confidence,
            confidence_reason: _str(block.confidence_reason, 300),
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
        hype: typeof r.hype === 'boolean' ? r.hype : null,
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
    if (!moved) return 'No price measurements for this industry yet — the engine screen has not covered it.'
    const pctile = moved.ext_percentile != null ? `${ordinal(Math.round(moved.ext_percentile * 100))} percentile of its own two years` : 'percentile n/a'
    return [
        `HOW FAR IT HAS MOVED (engine run ${moved.asof}; equal-weight basket: ${moved.basket ?? 'its own'}):`,
        `  12 months ${_pct(moved.ret_12m)} vs SPY ${_pct(moved.spy_12m)} → ${_pct(moved.excess_12m)} over the market`,
        `  24 months ${_pct(moved.ret_24m)} vs SPY ${_pct(moved.spy_24m)} → ${_pct(moved.excess_24m)} over the market`,
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
                ext_percentile: m.ext_percentile, hype: m.hype, asof: m.asof } : {}),
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
 * (industryData.moneyFacts), `structure` the standing industry_view grades. For a THEME (step 3): `theme` is
 * the approved theme and `facts` its themeFacts; `basket` the symbols its call is graded on.
 * → `{ ok, doc, changed, call }` or `{ ok:false, reason, detail }`.
 */
async function publishAssessment(block, { sub = null, row = null, money = null, theme = null, facts: given = null, basket = null,
    structure = null, recordCall = null, now = new Date().toISOString(), source = 'chat' } = {}) {
    const checked = checkAssessment(block, { expect: theme ? 'theme' : sub ? 'industry' : null })
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
    const set = {
        subject, verdict: a.verdict, horizon: a.horizon, thesis: a.thesis, evidence: a.evidence, gaps: checked.gaps,
        cause: a.cause, second_order: a.second_order, risks: a.risks, change_view_if: a.change_view_if,
        confidence: a.confidence, confidence_reason: a.confidence_reason,
        moved: facts.moved, base_rates: facts.base_rates, not_measured: facts.not_measured,
        // Companies' own money (§4.3) — facts from the engine's metrics node, like the moves (industryData.moneyFacts).
        money: facts.money ?? null,
        structure, assessed_at: now, expires_at: _plusDays(now, EXPIRY_DAYS[a.horizon]), source, updated_at: now,
    }
    const fields = ['verdict', 'horizon', 'confidence']
    const changed = diffFields(Object.fromEntries(fields.map(f => [f, cur?.[f] ?? null])), a, fields)
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

async function listAssessments() {
    const db = await _io.db()
    return db.collection(COLLECTION).find({}, { projection: { _id: 0, revisions: 0 } }).sort({ 'subject.sector': 1, 'subject.name': 1 }).toArray()
}

export const industryAssessmentService = { publishAssessment, getAssessment, getThemeAssessment, listAssessments }
