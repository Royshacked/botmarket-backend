import { callOpenAI } from "../providers/openai.provider.js"
import { isCacheFresh, isValidAnalysisObject, loadFromFile, safeParseJsonObject, saveToFile } from "./util.service.js"

export const llmAnalysisService = {
    getLLMNewsAnalysis,
}


async function getLLMNewsAnalysis(articles,symbol) {
    const all = await loadFromFile("assetAnalysis")
    const entry = all[symbol]
    if (isCacheFresh(entry, 1000 * 60 * 1000)) return entry

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

    const parsed = safeParseJsonObject(response)
    if (!parsed || !isValidAnalysisObject(parsed)) return null
    return parsed
}