import { callOpenAI } from '../providers/openai.provider.js'
import { cleanJSON } from './util.service.js';

export const filterService = {
    filterNews,
}


async function filterNews(articles) {
    console.log("called llm")
    const model = 'gpt-4o-mini'
    const systemPrompt = `You are filtering news for a trading dashboard.
            You must return ONLY valid JSON.
            Do NOT include:
            - explanations
            - text
            - markdown
            - comments
            - any other text outside the JSON
    `
    const userPrompt = `Filter the articles by headline and summary for trading relevance. Remove anything not relevant to financial markets, stocks, macro, or commodities.

            For each article that passes, also classify market sentiment based on the headline and summary.

            Return ONLY a valid JSON array of objects with exactly these keys:
            ["category","datetime","headline","id","image","related","source","summary","url","sentiment","confidence"]

            - sentiment: "bullish" | "bearish" | "neutral"
            - confidence: number between 0 and 1 (how confident the sentiment classification is)

            Example (valid JSON):
            [{
            "category": "business",
            "datetime": 1714760000,
            "headline": "Example headline",
            "id": 123,
            "image": "https://example.com/image.jpg",
            "related": "META",
            "source": "Reuters",
            "summary": "Example summary",
            "url": "https://example.com/article",
            "sentiment": "bullish",
            "confidence": 0.82
            }]

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
            })))}
            `;

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


