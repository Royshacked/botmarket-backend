import { callOpenAI } from '../providers/openai.provider.js'
import { cleanJSON } from './util.service.js';

export const filterService = {
    filterNews,
}


async function filterNews(articles) {
    const model = 'gpt-4o-mini'
    const systemPrompt = `You filter news articles for a trading dashboard. Return ONLY a valid JSON array — no explanation, no markdown.`
    const userPrompt = `Filter these articles for trading relevance (financial markets, stocks, macro, commodities). Remove irrelevant ones.
For each kept article add: sentiment ("bullish"|"bearish"|"neutral") and confidence (0–1).

Return a JSON array preserving all original fields plus sentiment and confidence. Example:
[{"category":"business","datetime":1714760000,"headline":"Fed raises rates","id":1,"image":"","related":"SPY","source":"Reuters","summary":"...","url":"...","sentiment":"bearish","confidence":0.91}]

Articles:
${JSON.stringify(articles.map(a => ({
    category: a.category,
    datetime: a.datetime,
    headline: a.headline,
    id: a.id,
    image: a.image,
    related: a.related,
    source: a.source,
    summary: a.summary,
    url: a.url,
})))}`.trim()

    const response = await callOpenAI(model, userPrompt, systemPrompt)

    const parsed = _safeParseJsonArray(response)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(_isValidArticle)
}


function _extractFirstJsonArray(text) {
    if (!text) return null
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end === -1 || end <= start) return null
    return text.slice(start, end + 1)
}

function _safeParseJsonArray(text) {
    const cleaned = cleanJSON(text || '')
    try {
        return JSON.parse(cleaned)
    } catch {
        const extracted = _extractFirstJsonArray(cleaned)
        if (!extracted) return null
        try {
            return JSON.parse(extracted)
        } catch {
            return null
        }
    }
}

const VALID_SENTIMENTS = new Set(['bullish', 'bearish', 'neutral'])

function _isValidArticle(a) {
    if (!a || typeof a !== 'object') return false
    if (typeof a.headline !== 'string' || !a.headline.trim()) return false
    if (typeof a.summary !== 'string') return false
    if (typeof a.url !== 'string') return false
    if (!VALID_SENTIMENTS.has(a.sentiment)) a.sentiment = 'neutral'
    if (typeof a.confidence !== 'number' || a.confidence < 0 || a.confidence > 1) a.confidence = 0
    return true
}


