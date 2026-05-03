import { callOpenAI } from "../providers/openai.provider.js"
import { cleanJSON, isCacheFresh, loadFromFile, saveToFile } from "./util.service.js"

export const llmAnalysisService = {
    getAssetAnalysis,
}

async function getAssetAnalysis(articles,symbol) {
    const all = loadFromFile("assetAnalysis")
    const entry = all[symbol]
    if (isCacheFresh(entry, 120 * 60 * 1000)) return entry

    console.log("no data of:",symbol)
    const assetAnalysisLLM = await _analyzeNews(articles,symbol)
    saveToFile("assetAnalysis",assetAnalysisLLM)
    return assetAnalysisLLM
}

async function _analyzeNews(articles,symbol) {
    console.log("analyzeNews",symbol)
    const model = 'gpt-5'
    const prompt = `You are a financial news analyst.

    Analyze the following news articles about ${symbol}.
    
    Important rules:
    - Base your answer ONLY on the articles provided.
    - Do NOT use price action, charts, technical analysis, support/resistance, volume, RSI, or trend.
    - Do NOT give direct buy/sell instructions.
    - Explain whether the news backdrop is bullish, bearish, mixed, or neutral.
    - Mention what investors/traders should watch next.
    - Return ONLY valid JSON.
    
    Output format:
    {
        "${symbol}": {
            "lastAnalysisAt": ${Date.now()},
            "analysis": 
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
        }
    }
    Articles:
    ${JSON.stringify(articles, null, 2)}
    `

    let response = await callOpenAI(model, prompt)

    response = cleanJSON(response)

    return JSON.parse(response || '[]')
}