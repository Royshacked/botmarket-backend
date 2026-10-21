// The hotlist's NEWS LABELS (docs/design/daily-names.md §3) — the one judgment in the checkpoint
// pass. Code has already done what code can: the headlines are fresh (timestamps), deduped and
// linked to their ticker. A cheap model then reads each pooled name's headlines ONCE for everyone
// and says what kind of event it is — material or noise, how long its catalyst lives (short /
// drift / lasting, which feeds the column grades), and whether it surprised.
//
// It FAILS SOFT: any error — no credits, a dead provider, junk back — returns an empty map and the
// board is published unlabelled, never not at all. The model is DAILY_SCREENER_NEWS_MODEL (Haiku 4.5
// by Roy's decision, §10), reached through the registry so a different one is a setting, not code.

import Anthropic from '@anthropic-ai/sdk'
import { modelRoute, CHEAP_MODEL } from './llmModels.js'
import { callOpenAICompatOnce } from '../providers/openaiCompat.provider.js'
import { extractFirstJSON } from '../monitoring/parsers/llmReply.parser.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[hotlist.news]'
const _client = new Anthropic({ apiKey: config.anthropicApiKey })

/** Headlines read per name, and how much of each. */
const PER_TICKER = 5
const TITLE_CHARS = 160

export const CATALYST_TYPES = Object.freeze(['short', 'drift', 'lasting', 'none'])
export const SURPRISES      = Object.freeze(['positive', 'negative', 'mixed', 'none'])

export const SYSTEM = `You label stock headlines for a short-horizon trading screen. For each ticker you are given its headlines since the last close. Judge the EVENT behind them, not the writing.

For each ticker answer:
- "material": true when there is a real event that can move the stock — earnings or guidance, M&A, an FDA or regulatory decision, a contract, an index change, a rating change from a major firm, litigation, a management change. false for opinion pieces, "should you buy" articles, listicles, recaps and recycled news.
- "type": how long the catalyst keeps working —
  "short" (fades within the session: an upgrade, a PR headline, a sympathy move, a squeeze),
  "drift" (keeps working 2–5 sessions: an earnings beat WITH raised guidance, a big contract, an FDA approval),
  "lasting" (1–2+ weeks: an index addition, M&A or activist involvement, a re-rating, a sector rotation),
  "none" when nothing is material.
- "surprise": against what was expected — "positive", "negative", "mixed" (e.g. beat but guided down), or "none".
- "magnitude": "major" or "minor".
- "headline": the ONE headline that decided it, copied exactly.

Output ONLY a JSON object, no prose:
{"labels":[{"ticker":"TICKER","material":true,"type":"drift","surprise":"positive","magnitude":"major","headline":"..."}]}`

/** The user turn: each ticker's headlines, newest first, capped. Pure. */
export function buildNewsText(byTicker) {
    return [...byTicker.entries()].map(([t, items]) =>
        `${t}:\n${items.slice(0, PER_TICKER).map(i => `- ${String(i.title ?? '').slice(0, TITLE_CHARS)}`).join('\n')}`,
    ).join('\n\n')
}

/** The model's reply → Map ticker → label, holding every field to its vocabulary. Pure. */
export function normalizeLabels(raw, wanted) {
    const out = new Map()
    const ok = new Set([...wanted].map(t => t.toUpperCase()))
    for (const l of Array.isArray(raw?.labels) ? raw.labels : []) {
        const ticker = String(l?.ticker ?? '').toUpperCase()
        if (!ok.has(ticker) || out.has(ticker)) continue
        const material = l.material === true
        out.set(ticker, {
            material,
            type:      material && CATALYST_TYPES.includes(l.type) ? l.type : 'none',
            surprise:  SURPRISES.includes(l.surprise) ? l.surprise : 'none',
            magnitude: l.magnitude === 'major' ? 'major' : 'minor',
            headline:  typeof l.headline === 'string' && l.headline.trim() ? l.headline.trim().slice(0, TITLE_CHARS) : null,
        })
    }
    return out
}

async function _send({ model, systemText, userText }) {
    const route = modelRoute(model)
    if (route.provider === 'openai-compat') {
        return callOpenAICompatOnce({ endpoint: route.endpoint, wire: route.wire, model: route.model, systemText, userText, maxTokens: 4000 })
    }
    const res = await _client.messages.create({
        model: route.model, max_tokens: 4000, system: systemText, messages: [{ role: 'user', content: userText }],
    })
    return (res?.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('')
}

/**
 * Label the pooled names' headlines in ONE call. → Map ticker → label; empty on any failure.
 *
 * @param {Map<string, {title:string}[]>} byTicker
 * @param {{ model?: string, send?: Function }} [opts]  `send` is the test seam
 */
export async function labelNews(byTicker, { model = config.dailyScreenerNewsModel || CHEAP_MODEL, send = _send } = {}) {
    if (!byTicker?.size) return new Map()
    try {
        const text = await send({ model, systemText: SYSTEM, userText: buildNewsText(byTicker) })
        return normalizeLabels(extractFirstJSON(text), byTicker.keys())
    } catch (err) {
        logger.warn(LOG, `labels skipped — the board goes out unlabelled: ${err.message}`)
        return new Map()
    }
}
