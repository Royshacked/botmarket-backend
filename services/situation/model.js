// THE SITUATION NETWORK'S RECORDS (docs/design/situation-network.md; plan step 1).
//
// Pure: the shapes, their checks and their ids. No I/O (store.js writes them). Every check returns
// `{ ok: true, value }` or `{ ok: false, reason }`; the reason is said to the model that wrote the record, so it can fix it.
//
// A RUN is one build or one update. Everything a run writes carries its `run_id`, so any week can be read back whole:
//   state     the dated snapshot (§2): six sections of items + the articles used
//   node      a question with 2–4 options (§3): open or settled, a dormant minority branch with its signpost, a lag
//   link      branch → node across trees (§4): a log-odds shift on one target option, weighted by its branch
//   dropped   the questions considered and not kept, with reasons and the counts (§3)
//   industry  an industry's score over every live path (§6), its early warning (§11.9) and would-be entries (§11.4)
//   forecast  one probability as set, for the scorecard (§9): who set it, the resolve date, the outcome
//   outside   an event that hits one industry and no node (§11.11)

import { randomUUID } from 'node:crypto'

export const RUN_KINDS = Object.freeze(['build', 'rebuild', 'weekly', 'event'])
export const SECTIONS = Object.freeze(['regime', 'policy', 'money', 'stories', 'prices', 'calendar'])
export const TAGS = Object.freeze(['fact', 'reading'])
export const NODE_KINDS = Object.freeze(['open', 'settled'])
export const NODE_STATUSES = Object.freeze(['live', 'resolved', 'dropped', 'split'])
export const SET_BY = Object.freeze(['llm', 'roy'])
export const CONFIDENCE = Object.freeze(['low', 'high'])
export const BUCKETS = Object.freeze(['small', 'medium', 'large'])
export const DROP_REASONS = Object.freeze(['low_impact', 'nearly_settled', 'duplicate', 'too_far_out', 'cap'])
export const EVENT_DECISIONS = Object.freeze(['moves_option', 'new_option', 'new_question', 'resolves', 'outside'])

/** A settled node has one option at or above this; below it the node is open (§3: "one option dominates"). */
export const SETTLED_AT = 0.8
/** The options of a node must sum to 1 within this. */
export const SUM_TOLERANCE = 0.011
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 4

const DATE = /^\d{4}-\d{2}-\d{2}$/
const KEY = /^[a-z0-9_]{1,40}$/
const text = (x, max) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const isProb = (p) => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1
const realDate = (d) => {
    if (typeof d !== 'string' || !DATE.test(d)) return false
    const t = new Date(`${d}T00:00:00Z`)
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d
}
const ok = (value) => ({ ok: true, value })
const bad = (reason) => ({ ok: false, reason })

export const newId = (prefix) => `${prefix}_${randomUUID()}`

/** A lag in days, `{ min, max }`, 0 ≤ min ≤ max. */
export function checkLag(lag) {
    if (lag == null) return ok(null)
    const { min, max } = lag
    if (![min, max].every(n => Number.isInteger(n) && n >= 0)) return bad('lag must be { min, max } in whole days, both ≥ 0')
    if (min > max) return bad('lag.min must not exceed lag.max')
    return ok({ min, max })
}

/** One item of a state section (§2): a statement, its as-of date and source, fact or reading. */
export function checkItem(input = {}) {
    const statement = text(input.text, 400)
    if (!statement) return bad('an item needs its text')
    if (!realDate(input.as_of)) return bad(`"${statement.slice(0, 40)}": as_of must be a real YYYY-MM-DD date`)
    const source = text(input.source, 200)
    if (!source) return bad(`"${statement.slice(0, 40)}": every item needs its source`)
    if (!TAGS.includes(input.tag)) return bad(`"${statement.slice(0, 40)}": tag must be fact or reading`)
    const value = input.value == null ? null : (typeof input.value === 'number' && Number.isFinite(input.value) ? input.value : NaN)
    if (Number.isNaN(value)) return bad(`"${statement.slice(0, 40)}": value must be a number when given`)
    return ok({ text: statement, value, as_of: input.as_of, source, tag: input.tag })
}

/** A state (§2): every section present (an empty section is allowed and says so), every item checked. */
export function checkState(input = {}) {
    if (!realDate(input.as_of)) return bad('the state needs its as_of date')
    const sections = {}
    for (const name of SECTIONS) {
        const items = input.sections?.[name]
        if (!Array.isArray(items)) return bad(`section ${name} is missing (send [] if there is nothing)`)
        const out = []
        for (const it of items) {
            const c = checkItem(it)
            if (!c.ok) return bad(`${name}: ${c.reason}`)
            if (c.value.as_of > input.as_of) return bad(`${name}: "${c.value.text.slice(0, 40)}" is dated after the state's as_of`)
            out.push(c.value)
        }
        sections[name] = out
    }
    const articles = (Array.isArray(input.articles) ? input.articles : []).map(a => ({
        url: text(a?.url, 500), title: text(a?.title, 300), source: text(a?.source, 120),
        published_at: typeof a?.published_at === 'string' ? a.published_at : null,
    })).filter(a => a.url)
    const late = articles.find(a => a.published_at && a.published_at.slice(0, 10) > input.as_of)
    if (late) return bad(`article "${late.title.slice(0, 40)}" was published after the state's as_of`)
    return ok({ as_of: input.as_of, sections, articles })
}

/**
 * A node (§3): 2–4 options summing to 1; open or settled DERIVED from the numbers (a settled node's top option is
 * ≥ SETTLED_AT); a settled node's minority options are dormant and each needs a signpost; a resolved node names the
 * option that happened and its evidence.
 */
export function checkNode(input = {}) {
    const question = text(input.question, 300)
    if (!question) return bad('a node needs its question')
    const tree = text(input.tree, 40)
    if (!tree) return bad(`"${question.slice(0, 40)}": a node needs its tree`)
    const raw = Array.isArray(input.options) ? input.options : []
    if (raw.length < MIN_OPTIONS || raw.length > MAX_OPTIONS) return bad(`"${question.slice(0, 40)}": a node has ${MIN_OPTIONS}–${MAX_OPTIONS} options`)
    const options = []
    for (const o of raw) {
        if (!KEY.test(String(o?.key ?? ''))) return bad(`"${question.slice(0, 40)}": option key must be lower_snake (a–z, 0–9, _)`)
        if (!text(o.label, 160)) return bad(`"${question.slice(0, 40)}": option ${o.key} needs a label`)
        if (!isProb(o.p)) return bad(`"${question.slice(0, 40)}": option ${o.key} needs p between 0 and 1`)
        options.push({ key: o.key, label: text(o.label, 160), p: o.p, signpost: text(o.signpost, 240) || null })
    }
    if (new Set(options.map(o => o.key)).size !== options.length) return bad(`"${question.slice(0, 40)}": option keys must be distinct`)
    const sum = options.reduce((s, o) => s + o.p, 0)
    if (Math.abs(sum - 1) > SUM_TOLERANCE) return bad(`"${question.slice(0, 40)}": options sum to ${sum.toFixed(3)}, not 1`)
    const top = options.reduce((a, b) => (b.p > a.p ? b : a))
    const kind = top.p >= SETTLED_AT ? 'settled' : 'open'
    for (const o of options) o.dormant = kind === 'settled' && o.key !== top.key
    const missing = options.find(o => o.dormant && !o.signpost)
    if (missing) return bad(`"${question.slice(0, 40)}": dormant option ${missing.key} needs a signpost (what would show it is happening)`)
    const lag = checkLag(input.lag)
    if (!lag.ok) return bad(`"${question.slice(0, 40)}": ${lag.reason}`)
    if (input.resolve_by != null && !realDate(input.resolve_by)) return bad(`"${question.slice(0, 40)}": resolve_by must be a real date`)
    const status = input.status ?? 'live'
    if (!NODE_STATUSES.includes(status)) return bad(`status must be one of ${NODE_STATUSES.join(', ')}`)
    let resolved = null
    if (status === 'resolved') {
        const r = input.resolved ?? {}
        if (!options.some(o => o.key === r.option)) return bad(`"${question.slice(0, 40)}": a resolved node names the option that happened`)
        if (!text(r.evidence, 600)) return bad(`"${question.slice(0, 40)}": a resolution needs its evidence`)
        if (!realDate(r.on)) return bad(`"${question.slice(0, 40)}": a resolution needs its date`)
        resolved = { option: r.option, evidence: text(r.evidence, 600), on: r.on, by: SET_BY.includes(r.by) ? r.by : 'llm' }
    }
    if (input.confidence != null && !CONFIDENCE.includes(input.confidence)) return bad('confidence must be low or high')
    // The numbers at Roy's last review — the drift rule's baseline (§11.1): the card shows a node that has moved more
    // than ~10 points since then. Null until he first reviews it.
    let review = null
    if (input.review != null) {
        const r = input.review
        if (!realDate(r.on) || typeof r.p !== 'object' || r.p === null) return bad(`"${question.slice(0, 40)}": review is { on, p: { option: p } }`)
        const keys = new Set(options.map(o => o.key))
        const p = {}
        for (const [k, v] of Object.entries(r.p)) {
            if (!keys.has(k) || !isProb(v)) return bad(`"${question.slice(0, 40)}": review.p.${k} is not an option with a probability`)
            p[k] = v
        }
        review = { on: r.on, p }
    }
    return ok({
        review,
        node_id: input.node_id ?? newId('node'), tree, question, kind, status, options,
        lag: lag.value, resolve_by: input.resolve_by ?? null, resolved,
        reasoning: text(input.reasoning, 2000) || null, confidence: input.confidence ?? null,
        set_by: SET_BY.includes(input.set_by) ? input.set_by : 'llm',
        split_from: input.split_from ?? null,
    })
}

/**
 * A link (§4, plan §6): from one BRANCH (node + option) to one option of another node. `shift` is in log-odds, signed
 * (+ raises the target option); propagation weights it by the probability of the branch it starts from.
 */
export function checkLink(input = {}, nodesById = null) {
    const from = input.from ?? {}, to = input.to ?? {}
    if (!from.node_id || !KEY.test(String(from.option ?? ''))) return bad('a link starts on a branch: from { node_id, option }')
    if (!to.node_id || !KEY.test(String(to.option ?? ''))) return bad('a link ends on an option: to { node_id, option }')
    if (from.node_id === to.node_id) return bad('a link joins two different nodes')
    const shift = input.shift
    if (typeof shift !== 'number' || !Number.isFinite(shift) || shift === 0 || Math.abs(shift) > 3) return bad('shift is a log-odds number, non-zero, at most 3 either way')
    const lag = checkLag(input.lag)
    if (!lag.ok) return bad(lag.reason)
    if (nodesById) {
        const f = nodesById.get(from.node_id), t = nodesById.get(to.node_id)
        if (!f || !f.options.some(o => o.key === from.option)) return bad(`link from ${from.node_id}.${from.option}: no such branch`)
        if (!t || !t.options.some(o => o.key === to.option)) return bad(`link to ${to.node_id}.${to.option}: no such option`)
    }
    return ok({
        link_id: input.link_id ?? newId('link'),
        from: { node_id: from.node_id, option: from.option }, to: { node_id: to.node_id, option: to.option },
        shift, lag: lag.value, why: text(input.why, 400) || null, live: input.live !== false,
    })
}

/** The dropped list (§3): the counts must add up, and every dropped question has its options and a reason. */
export function checkDropped(input = {}) {
    const list = Array.isArray(input.dropped) ? input.dropped : []
    const dropped = []
    for (const d of list) {
        const question = text(d?.question, 300)
        if (!question) return bad('a dropped question needs its question')
        if (!DROP_REASONS.includes(d.reason)) return bad(`"${question.slice(0, 40)}": reason must be one of ${DROP_REASONS.join(', ')}`)
        if (d.reason === 'duplicate' && !d.duplicate_of) return bad(`"${question.slice(0, 40)}": a duplicate names the node it duplicates`)
        dropped.push({
            question, reason: d.reason, note: text(d.note, 240) || null, duplicate_of: d.duplicate_of ?? null,
            options: (Array.isArray(d.options) ? d.options : []).map(o => text(o, 160)).filter(Boolean),
            flagged: d.flagged === true,
        })
    }
    const { considered, open, settled } = input
    if (![considered, open, settled].every(n => Number.isInteger(n) && n >= 0)) return bad('considered, open and settled are counts')
    if (considered !== open + settled + dropped.length) return bad(`counts do not add up: ${considered} considered ≠ ${open} open + ${settled} settled + ${dropped.length} dropped`)
    return ok({ considered, open, settled, dropped })
}

/** An industry's score for one run (§6). Chances in [0, 1], win + lose ≤ 1 (the rest is "no clear effect"). */
export function checkIndustry(input = {}) {
    const code = text(input.code, 20), name = text(input.name, 120)
    if (!code || !name) return bad('an industry needs its code and name')
    const { p_win, p_lose } = input
    if (!isProb(p_win) || !isProb(p_lose)) return bad(`${name}: p_win and p_lose are between 0 and 1`)
    if (p_win + p_lose > 1 + SUM_TOLERANCE) return bad(`${name}: p_win + p_lose exceed 1`)
    if (input.bucket != null && !BUCKETS.includes(input.bucket)) return bad(`${name}: bucket must be small, medium or large`)
    if (input.agreement != null && !isProb(input.agreement)) return bad(`${name}: agreement is a share between 0 and 1`)
    return ok({
        level: text(input.level, 20) || 'sub_industry', code, name, p_win, p_lose,
        bucket: input.bucket ?? null, agreement: input.agreement ?? null,
        paths: Array.isArray(input.paths) ? input.paths.slice(0, 50) : [],
        early_warning: input.early_warning ?? null,
    })
}

/** One logged probability (§9). `llm_p` keeps the model's number when Roy overrode it. */
export function checkForecast(input = {}) {
    if (!input.node_id || !KEY.test(String(input.option ?? ''))) return bad('a forecast names its node and option')
    if (!isProb(input.p)) return bad('a forecast needs p between 0 and 1')
    if (!SET_BY.includes(input.set_by)) return bad('set_by must be llm or roy')
    if (input.llm_p != null && !isProb(input.llm_p)) return bad('llm_p must be between 0 and 1')
    if (input.set_by === 'roy' && input.llm_p == null) return bad("an override keeps the model's number (llm_p)")
    if (input.resolve_by != null && !realDate(input.resolve_by)) return bad('resolve_by must be a real date')
    return ok({
        forecast_id: input.forecast_id ?? newId('fc'), node_id: input.node_id, option: input.option,
        p: input.p, set_by: input.set_by, llm_p: input.llm_p ?? null, reviewed: input.reviewed === true,
        resolve_by: input.resolve_by ?? null, outcome: null, resolved_on: null,
    })
}

/** An event outside the network (§11.11): it hits named industries and no node. */
export function checkOutside(input = {}) {
    const what = text(input.text, 400)
    if (!what) return bad('an outside event needs its text')
    if (!realDate(input.date)) return bad('an outside event needs its date')
    const industries = (Array.isArray(input.industries) ? input.industries : []).map(i => text(i, 120)).filter(Boolean)
    if (!industries.length) return bad('an outside event names the industry it hits')
    return ok({ event_id: input.event_id ?? newId('out'), date: input.date, text: what, industries, source: text(input.source, 300) || null, promoted_to: null })
}

/** A run's header (plan §1). */
export function checkRun(input = {}) {
    if (!RUN_KINDS.includes(input.kind)) return bad(`run kind must be one of ${RUN_KINDS.join(', ')}`)
    if (!realDate(input.as_of)) return bad('a run needs its as_of date')
    if (input.kind === 'event' && !text(input.trigger, 300)) return bad('an event run names its trigger')
    return ok({
        run_id: input.run_id ?? newId('run'), kind: input.kind, as_of: input.as_of,
        trigger: text(input.trigger, 300) || null, parent_run_id: input.parent_run_id ?? null,
    })
}
