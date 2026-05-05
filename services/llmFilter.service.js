import { callOpenAI } from '../providers/openai.provider.js'
import { cleanJSON, deduplicateNewsFeed, loadFromFile, saveToFile } from './util.service.js';

export const llmService = {
    getRelevantNews,
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

function _isValidArticle(a) {
    if (!a || typeof a !== 'object') return false
    if (typeof a.headline !== 'string' || !a.headline.trim()) return false
    if (typeof a.summary !== 'string') return false
    if (typeof a.url !== 'string') return false
    return true
}



async function getRelevantNews(news) {
    const relevantNews = loadFromFile("relevantNews")
    try {
        const relevant = await _llmFilterNewsFeed(news)
        const unique = deduplicateNewsFeed(relevant, "relevantNews")
        const llmFilteredNews = [...relevantNews, ...unique]
        await saveToFile("relevantNews",llmFilteredNews)
        return llmFilteredNews
    } catch (error) {
        console.error("Error filtering news", error)
        return []
    }
}

async function _llmFilterNewsFeed(articles) {
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
    const userPrompt = `filter the articles by the summery and the headline only.
            
            Return ONLY a valid JSON array of objects with exactly these keys:
            ["category","datetime","headline","id","image","related","source","summary","url"]
            
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
            "url": "https://example.com/article"
            }]
            
            
            Articles:
            ${JSON.stringify(articles.map(a=> ({
                category: a.category,
                datetime: a.datetime,
                headline: a.headline,
                id: a.id,
                image: a.image,
                related: a.related,
                source: a.source,
                summary: a.summary,
                url: a.url
            })))} // make .map of articles to JSON.stringify
            `;

    const response = await callOpenAI(model, userPrompt, systemPrompt)

    const parsed = _safeParseJsonArray(response)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(_isValidArticle)
}

