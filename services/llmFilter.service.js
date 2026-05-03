import { callOpenAI } from '../providers/openai.provider.js'
import { cleanJSON, deduplicateNewsFeed, loadFromFile, saveToFile } from './util.service.js';

export const llmService = {
    getRelevantNews,
}



async function getRelevantNews(news) {
    const relevantNews = loadFromFile("relevantNews")
    try {
        const relevant = await _llmFilterNewsFeed(news)
        const unique = deduplicateNewsFeed(relevant, "relevantNews")
        const llmFilteredNews = [...relevantNews, ...unique]
        saveToFile("relevantNews",llmFilteredNews)
        return llmFilteredNews
    } catch (error) {
        console.error("Error filtering news", error)
        return []
    }
}

async function _llmFilterNewsFeed(articles) {
    console.log("called llm")
    const model = 'gpt-4o-mini'

    const prompt = `You are filtering news for a trading dashboard.
    filter the articles by the summery and the headline only.
    Keep an article if it is even moderately relevant to:
    - indices like Nasdaq / S&P
    - currencies / USD
    - bonds / yields
    - Fed / rates / inflation
    - major companies that can move indices
    - geopolitics that may affect markets

    Do not require certainty.
    You must return ONLY valid JSON.

    Do NOT include:
    - explanations
    - text
    - markdown
    - comments
    
    Return ONLY this format:
    
    [
        {
          "category": "",
    "datetime": ,
    "headline": "",
    "id": ,
    "image": "",
    "related": "",
    "source": "",
    "summary": "",
    "url": ""
        }
    ]
    
    
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

    let response = await callOpenAI(model, prompt)

    response = cleanJSON(response)

    return JSON.parse(response || '[]')
}

