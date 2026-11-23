// A SECTOR'S CURRENT STATE (docs/design/situation-network-layers.md §4.2; build step 5).
//
// buildSectorState(sector, asOf, macroState, industryRows): code writes the BACKDROP (a summary of the macro state — the
// descriptions flow down only) and the sector's PRICES; the sector's own news (news.fetchSectorNews) goes to ONE
// structured call (prompts/situation_sector_state.md) that writes its news, policy and calendar and asks 1–6 questions.
// The result is a checked sector state (model.checkSectorState) and the questions its small network is grown from.

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { callAnthropicStructured } from '../../providers/anthropic.provider.js'
import { recordUsage, calcCost } from '../tokenUsage.service.js'
import { makePromptLoader } from '../agentUtils.js'
import { fetchSectorNews, articleLines } from './news.js'
import { checkSectorState, SECTOR_SECTIONS } from './model.js'
import { shapeAnswer, stateSchema, LEVELS, questionLines, REWRITE_NOTE } from './state.js'
import { sectorOf } from './sectors.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.sector]'
const __dirname = dirname(fileURLToPath(import.meta.url))
const _system = makePromptLoader(join(__dirname, '../../prompts/situation_sector_state.md'), LOG)

export const SECTOR_MODEL = 'claude-opus-5-5'
export const SECTOR_EFFORT = 'medium'
export const SECTOR_QUESTIONS = 6
/** The sections the model writes. */
export const SECTOR_WRITTEN = Object.freeze(['news', 'policy', 'calendar'])
/** How many of the macro state's items the backdrop carries, by section. */
export const BACKDROP = Object.freeze({ regime: 4, policy: 4, stories: 6 })
export const PRICES_SOURCE = 'engine industry_index (equal-weight liquid baskets)'

const _io = {
    news: (sector, asOf, names) => fetchSectorNews(sector, { days: 7, asOf, names }),
    call: (args) => callAnthropicStructured(args),
    record: (payer, model, usage) => recordUsage(payer, model, usage, 'situation', { monitor: true }),
    payer: async () => { const { houseLedgerUserId } = await import('../../api/user/user.model.js'); return houseLedgerUserId() },
    system: () => _system(),
}
export function _setIO(io) { Object.assign(_io, io) }

/**
 * The macro state → the backdrop items a sector state carries: its regime readings, its policy and its stories, the first
 * few of each, sourced to the macro state. Pure.
 */
export function macroBackdrop(state) {
    if (!state?.sections) return []
    const out = []
    for (const [name, n] of Object.entries(BACKDROP)) {
        for (const it of (state.sections[name] ?? []).slice(0, n)) {
            out.push({ text: it.text, value: null, as_of: it.as_of > state.as_of ? state.as_of : it.as_of, source: `the macro state of ${state.as_of} (${name})`, tag: it.tag })
        }
    }
    return out
}

const pct = (v) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : 'n/a')

/** The sector's industries (state.data.industryRows) → one price item per industry, against the S&P. Pure. */
export function sectorPriceItems(sectorCode, rows = []) {
    return rows.filter(r => sectorOf(r.code) === sectorCode).sort((a, b) => (b.vs_m3 ?? -9) - (a.vs_m3 ?? -9)).map(r => ({
        text: `${r.name}: against the S&P 1m ${pct(r.vs_m1)}, 3m ${pct(r.vs_m3)}, 12m ${pct(r.vs_m12)}; ${r.above_50d ? 'above' : 'below'} its 50-day, ${r.above_200d == null ? '200-day n/a' : r.above_200d ? 'above its 200-day' : 'below its 200-day'}`,
        value: r.vs_m3 ?? null, as_of: r.date, source: PRICES_SOURCE, tag: 'fact',
    }))
}

/** The structured answer's schema: the macro state's shape, with the sector's sections. Pure. */
export function sectorSchema() {
    const base = stateSchema()
    const item = base.properties.regime
    return {
        type: 'object', additionalProperties: false, required: [...SECTOR_WRITTEN, 'questions'],
        properties: { ...Object.fromEntries(SECTOR_WRITTEN.map(s => [s, item])), questions: base.properties.questions },
    }
}

/** The user message. Pure. */
export function sectorPrompt(sector, asOf, backdrop, prices, articles, gaps = []) {
    const lines = (xs) => (xs.length ? xs.map(i => `- ${i.as_of} [${i.tag}] ${i.text}`).join('\n') : '- (none)')
    return [
        `SECTOR: ${sector.name} (GICS ${sector.code}). AS-OF DATE: ${asOf}. Nothing after it exists.`, '',
        'THE MACRO BACKDROP (a summary of the macro state; do not restate it):', lines(backdrop), '',
        "THE SECTOR'S INDUSTRIES, PRICES (code, facts):", lines(prices), '',
        gaps.length ? `MISSING FROM THE NEWS (say nothing that depends on these): ${gaps.join('; ')}` : null,
        `THE ARTICLES (${articles.length}, newest first; cite by number):`, articleLines(articles), '',
        "Write the sector's sections and its questions.",
    ].filter(x => x !== null).join('\n')
}

/**
 * Build one sector's state → `{ ok: true, state, questions, gaps, cost_usd }` or `{ ok: false, reason, gaps, cost_usd }`.
 * `names` are the sector's largest companies (sectors.topNames). Never throws.
 */
export async function buildSectorState(sector, asOf, macroState, industryRows = [], names = []) {
    let cost = 0
    const news = await _io.news(sector, asOf, names).catch(err => ({ articles: [], gaps: [`${sector.name} news: ${err.message}`] }))
    const gaps = news.gaps ?? []
    const articles = news.articles ?? []
    const backdrop = macroBackdrop(macroState)
    const prices = sectorPriceItems(sector.code, industryRows)
    let payer = null
    try { payer = await _io.payer() } catch { /* unbooked */ }
    let res
    try {
        res = await _io.call({
            model: SECTOR_MODEL, effort: SECTOR_EFFORT, systemPrompt: _io.system(), user: sectorPrompt(sector, asOf, backdrop, prices, articles, gaps), schema: sectorSchema(),
            onUsage: (usage, m) => { cost += calcCost(m, usage); if (payer) _io.record(payer, m, usage).catch(() => {}) },
        })
    } catch (err) {
        logger.warn(LOG, `${sector.name}: the state call failed`, { error: err.message })
        return { ok: false, reason: `${sector.name}: the state call failed: ${err.message}`, gaps, cost_usd: cost }
    }
    if (!res?.data) return { ok: false, reason: `${sector.name}: the state call returned no answer`, gaps, cost_usd: cost }
    // The macro state's shaping, reused: its sections are named by the macro state, so the sector's are mapped in and out.
    const shaped = shapeAnswer({ regime: [], policy: res.data.policy, money: [], stories: res.data.news, calendar: res.data.calendar, questions: res.data.questions }, asOf, articles)
    const questions = shaped.questions.filter(q => LEVELS.includes(q.impact)).slice(0, SECTOR_QUESTIONS)
    const sections = Object.fromEntries(SECTOR_SECTIONS.map(s => [s, []]))
    sections.backdrop = backdrop
    sections.prices = prices
    sections.news = shaped.sections.stories
    sections.policy = shaped.sections.policy
    sections.calendar = shaped.sections.calendar
    const checked = checkSectorState({ sector: sector.code, as_of: asOf, sections, articles })
    if (!checked.ok) return { ok: false, reason: `${sector.name}: ${checked.reason}`, gaps, cost_usd: cost }
    return { ok: true, state: checked.value, questions, gaps, cost_usd: cost }
}

/**
 * The weekly REWRITE of one sector's description: the backdrop from the (rewritten) macro state and the prices by code,
 * its news, policy and calendar from the week's articles AND its live questions' reasoning → `{ ok: true, state, cost_usd }`
 * or `{ ok: false, reason, cost_usd }`. Never throws.
 */
export async function rewriteSectorState(sector, asOf, macroState, industryRows, articles = [], questions = []) {
    let cost = 0, payer = null
    try { payer = await _io.payer() } catch { /* unbooked */ }
    const backdrop = macroBackdrop(macroState)
    const prices = sectorPriceItems(sector.code, industryRows)
    const user = `${sectorPrompt(sector, asOf, backdrop, prices, articles)}\n\nTHE SECTOR'S LIVE QUESTIONS (${questions.length}; describe what they rest on):\n${questionLines(questions)}`
    let res
    try {
        res = await _io.call({ model: SECTOR_MODEL, effort: SECTOR_EFFORT, systemPrompt: _io.system() + REWRITE_NOTE, user, schema: sectorSchema(),
            onUsage: (usage, m) => { cost += calcCost(m, usage); if (payer) _io.record(payer, m, usage).catch(() => {}) } })
    } catch (err) {
        return { ok: false, reason: `${sector.name}: the rewrite call failed: ${err.message}`, cost_usd: cost }
    }
    if (!res?.data) return { ok: false, reason: `${sector.name}: the rewrite call returned no answer`, cost_usd: cost }
    const shaped = shapeAnswer({ regime: [], policy: res.data.policy, money: [], stories: res.data.news, calendar: res.data.calendar, questions: [] }, asOf, articles)
    const sections = { backdrop, prices, news: shaped.sections.stories, policy: shaped.sections.policy, calendar: shaped.sections.calendar }
    const checked = checkSectorState({ sector: sector.code, as_of: asOf, sections, articles })
    return checked.ok ? { ok: true, state: checked.value, cost_usd: cost } : { ok: false, reason: `${sector.name}: ${checked.reason}`, cost_usd: cost }
}
