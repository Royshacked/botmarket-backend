// THE CURRENT STATE, BUILT (docs/design/situation-network.md §2; plan step 4).
//
// buildState(asOf): the code's four data sections (state.data.js) + the week's dated news (news.js) → ONE structured
// call that writes the reading sections and the open questions (prompts/situation_state.md) → a checked state
// (model.js checkState) and the questions the network is grown from (step 5). The articles given are stored on the
// state. The cost is measured and returned (`cost_usd`): the weekly budget cap is set from it (plan, Roy's call 4).

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { callAnthropicStructured } from '../../providers/anthropic.provider.js'
import { recordUsage, calcCost } from '../tokenUsage.service.js'
import { makePromptLoader } from '../agentUtils.js'
import { buildDataSections } from './state.data.js'
import { fetchNews, articleLines } from './news.js'
import { checkState, SECTIONS, TAGS } from './model.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.state]'
const __dirname = dirname(fileURLToPath(import.meta.url))
const _system = makePromptLoader(join(__dirname, '../../prompts/situation_state.md'), LOG)

export const STATE_MODEL = 'claude-opus-5-5'
export const STATE_EFFORT = 'high'
export const LEVELS = Object.freeze(['low', 'medium', 'high'])
export const MAX_QUESTIONS = 40
/** The sections the model writes (regime gets its readings beside the code's facts). */
export const WRITTEN = Object.freeze(['regime', 'policy', 'money', 'stories', 'calendar'])

const _io = {
    data: (asOf) => buildDataSections(asOf),
    news: (asOf) => fetchNews({ days: 7, asOf }),
    call: (args) => callAnthropicStructured(args),
    record: (payer, model, usage) => recordUsage(payer, model, usage, 'situation', { monitor: true }),
    payer: async () => { const { houseLedgerUserId } = await import('../../api/user/user.model.js'); return houseLedgerUserId() },
    system: () => _system(),
}
export function _setIO(io) { Object.assign(_io, io) }

const item = {
    type: 'object', additionalProperties: false, required: ['text', 'as_of', 'cites', 'tag'],
    properties: { text: { type: 'string' }, as_of: { type: 'string' }, cites: { type: 'array', items: { type: 'integer' } }, tag: { type: 'string', enum: [...TAGS] } },
}

/** The structured answer's schema. Pure. */
export function stateSchema() {
    const list = { type: 'array', items: item }
    return {
        type: 'object', additionalProperties: false, required: [...WRITTEN, 'questions'],
        properties: {
            ...Object.fromEntries(WRITTEN.map(s => [s, list])),
            questions: {
                type: 'array',
                items: {
                    type: 'object', additionalProperties: false, required: ['question', 'tree', 'options', 'impact', 'uncertainty', 'why'],
                    properties: {
                        question: { type: 'string' }, tree: { type: 'string' },
                        options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'label'], properties: { key: { type: 'string' }, label: { type: 'string' } } } },
                        impact: { type: 'string', enum: [...LEVELS] }, uncertainty: { type: 'string', enum: [...LEVELS] }, why: { type: 'string' },
                    },
                },
            },
        },
    }
}

/** The user message: the as-of date, the code's sections, the numbered articles. Pure. */
export function statePrompt(asOf, sections, articles, gaps = []) {
    const block = (name) => {
        const xs = sections[name] ?? []
        return `${name.toUpperCase()} (code, facts):\n${xs.length ? xs.map(i => `- ${i.as_of}: ${i.text} [${i.source}]`).join('\n') : '- (none)'}`
    }
    return [
        `AS-OF DATE: ${asOf}. Nothing after it exists.`, '',
        'THE DATA SECTIONS, WRITTEN BY CODE:', '', ...['regime', 'prices', 'money', 'calendar'].map(block), '',
        gaps.length ? `MISSING FROM THE DATA (say nothing that depends on these): ${gaps.join('; ')}` : null,
        `THE ARTICLES (${articles.length}, newest first; cite by number):`, articleLines(articles), '',
        'Write the sections and the questions.',
    ].filter(x => x !== null).join('\n')
}

const KEY = /^[a-z0-9_]{1,40}$/
const _snake = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)

/**
 * The model's answer → state items (sources from the cited articles; as-of clamped to the state's date and to a real
 * date) and tidy questions (2–4 options with distinct snake keys, at most MAX_QUESTIONS). Drops what cannot be fixed,
 * and says how many. Pure.
 */
export function shapeAnswer(data, asOf, articles) {
    const dropped = { items: 0, questions: 0 }
    const sourceOf = (cites) => {
        const named = [...new Set(cites ?? [])].map(n => articles[n - 1]).filter(Boolean)
        return named.length ? named.slice(0, 4).map(a => `${a.source}, ${a.published_at.slice(0, 10)}: ${a.title.slice(0, 90)}`).join(' | ') : null
    }
    const latestCited = (cites) => (cites ?? []).map(n => articles[n - 1]?.published_at?.slice(0, 10)).filter(Boolean).sort().at(-1) ?? null
    const real = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d
    const sections = {}
    for (const name of WRITTEN) {
        sections[name] = []
        for (const it of data?.[name] ?? []) {
            const text = String(it?.text ?? '').trim()
            if (!text || !TAGS.includes(it.tag)) { dropped.items++; continue }
            const src = sourceOf(it.cites) ?? (it.tag === 'reading' ? "the model's reading of the data sections" : null)
            if (!src) { dropped.items++; continue }          // a fact with nothing behind it is not kept
            let d = real(it.as_of) ? it.as_of : (latestCited(it.cites) ?? asOf)
            if (d > asOf) d = asOf
            sections[name].push({ text, value: null, as_of: d, source: src, tag: it.tag })
        }
    }
    const questions = []
    for (const q of data?.questions ?? []) {
        const question = String(q?.question ?? '').trim()
        const opts = (q?.options ?? []).map(o => ({ key: KEY.test(o?.key) ? o.key : _snake(o?.key || o?.label), label: String(o?.label ?? '').trim() })).filter(o => o.key && o.label)
        const keys = new Set(opts.map(o => o.key))
        if (!question || opts.length < 2 || opts.length > 4 || keys.size !== opts.length || !LEVELS.includes(q.impact) || !LEVELS.includes(q.uncertainty)) { dropped.questions++; continue }
        questions.push({ question, tree: _snake(q.tree) || 'other', options: opts, impact: q.impact, uncertainty: q.uncertainty, why: String(q.why ?? '').trim() })
    }
    if (questions.length > MAX_QUESTIONS) { dropped.questions += questions.length - MAX_QUESTIONS; questions.length = MAX_QUESTIONS }
    return { sections, questions, dropped }
}

/**
 * Build the state for `asOf` → `{ ok: true, state, questions, numbers, gaps, cost_usd, dropped }` or `{ ok: false,
 * reason, gaps, cost_usd }`. Never throws.
 */
export async function buildState(asOf = new Date().toISOString().slice(0, 10)) {
    const data = await _io.data(asOf)
    const news = await _io.news(asOf)
    const gaps = [...(data.gaps ?? []), ...(news.gaps ?? [])]
    const articles = news.articles ?? []
    let cost = 0
    let payer = null
    try { payer = await _io.payer() } catch { /* booked nowhere; the cost is still returned */ }
    let res
    try {
        res = await _io.call({
            model: STATE_MODEL, effort: STATE_EFFORT, systemPrompt: _io.system(), user: statePrompt(asOf, data.sections, articles, gaps), schema: stateSchema(),
            onUsage: (usage, m) => { cost += calcCost(m, usage); if (payer) _io.record(payer, m, usage).catch(() => {}) },
        })
    } catch (err) {
        logger.warn(LOG, 'the state call failed', { error: err.message })
        return { ok: false, reason: `the state call failed: ${err.message}`, gaps, cost_usd: cost }
    }
    if (!res?.data) return { ok: false, reason: `the state call returned no answer (${res?.stopReason ?? 'unknown'})`, gaps, cost_usd: cost }
    const shaped = shapeAnswer(res.data, asOf, articles)
    const sections = Object.fromEntries(SECTIONS.map(s => [s, []]))
    for (const s of ['regime', 'prices', 'money', 'calendar']) sections[s].push(...(data.sections[s] ?? []))
    for (const s of WRITTEN) sections[s].push(...shaped.sections[s])
    const checked = checkState({ as_of: asOf, sections, articles })
    if (!checked.ok) return { ok: false, reason: `the state did not pass its check: ${checked.reason}`, gaps, cost_usd: cost }
    return { ok: true, state: checked.value, questions: shaped.questions, numbers: data.numbers, gaps, cost_usd: cost, dropped: shaped.dropped, model: res.model }
}
