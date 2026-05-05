import { callOpenAI } from "../providers/openai.provider.js"
import { cleanJSON, isCacheFresh, loadFromFile, saveToFile } from "./util.service.js"

export const llmAnalysisService = {
    getAssetAnalysis,
}

function _extractFirstJsonObject(text) {
    if (!text) return null
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return null
    return text.slice(start, end + 1)
}

function _safeParseJsonObject(text) {
    const cleaned = cleanJSON(text || '')
    try {
        return JSON.parse(cleaned)
    } catch {
        const extracted = _extractFirstJsonObject(cleaned)
        if (!extracted) return null
        try {
            return JSON.parse(extracted)
        } catch {
            return null
        }
    }
}

function _isValidAnalysisObject(obj) {
    if (!obj || typeof obj !== 'object') return false
    if (typeof obj.newsSummary !== 'string') return false
    if (typeof obj.sentiment !== 'string') return false
    if (!Array.isArray(obj.positiveDrivers)) return false
    if (!Array.isArray(obj.negativeRisks)) return false
    if (!Array.isArray(obj.keyEvents)) return false
    if (!Array.isArray(obj.whatToWatchNext)) return false
    if (!obj.possibleMarketReaction || typeof obj.possibleMarketReaction !== 'object') return false
    if (typeof obj.possibleMarketReaction.bullishCase !== 'string') return false
    if (typeof obj.possibleMarketReaction.bearishCase !== 'string') return false
    if (typeof obj.confidence !== 'string') return false
    if (typeof obj.limitation !== 'string') return false
    return true
}

async function getAssetAnalysis(articles,symbol) {
    const all = await loadFromFile("assetAnalysis")
    const entry = all[symbol]
    if (isCacheFresh(entry, 120 * 60 * 1000)) return entry

    console.log("no data of:",symbol)
    const assetAnalysisLLM = await _analyzeNews(articles,symbol)
    if (!assetAnalysisLLM) return null

    await saveToFile("assetAnalysis",{...all, [symbol]: {lastFetchedAt: Date.now(), analysis: assetAnalysisLLM}})
    return assetAnalysisLLM
}

async function _analyzeNews(articles,symbol) {
    console.log("analyzeNews",symbol)
    const model = 'gpt-5'
    const systemPrompt = `You are a financial news analyst.
            Analyze the following news articles about ${symbol}.
            Important rules:
            - Base your answer ONLY on the articles provided.
            - Do NOT use price action, charts, technical analysis, support/resistance, volume, RSI, or trend.
            - Do NOT give direct buy/sell instructions.
            - Explain whether the news backdrop is bullish, bearish, mixed, or neutral.
            - Mention what investors/traders should watch next.
            - Return ONLY valid JSON.
            - Do NOT include:
            - any other text outside the JSON
            `
    const userPrompt = `Output format:
            {
                "newsSummary": "short summary of the main story",
                "sentiment": "bullish | bearish | mixed | neutral",
                "positiveDrivers": [],
                "negativeRisks": [],
                "keyEvents": [],
                "whatToWatchNext": [],
                "possibleMarketReaction": {
                    "bullishCase": "",
                    "bearishCase": ""
                },
                "confidence": "low | medium | high",
                "limitation": "This analysis is based only on provided news articles and does not include price action or technical analysis."
            }
    Articles:
    ${JSON.stringify(articles, null, 2)}
    `

    const response = await callOpenAI(model, userPrompt, systemPrompt)

    const parsed = _safeParseJsonObject(response)
    if (!parsed || !_isValidAnalysisObject(parsed)) return null
    return parsed
}