import { callOpenAI } from "../providers/openai.provider.js"
import { isCacheFresh, loadFromFile, safeParseJsonObject, saveToFile } from "./util.service.js"
import { groq } from '@ai-sdk/groq';
import { generateText } from 'ai';

export const llmPriceAnalysisService = {
    getLLMPriceAnalysis,
}

async function getLLMPriceAnalysis(ticker, priceData, analysisGoal) {
    const all = await loadFromFile("assetPriceAnalysis")
    const entry = all[ticker]
    console.log("i am in analyse service")
    const lastFetchedAt = entry?.lastFetchedAt || 0
    if (isCacheFresh(lastFetchedAt, 1000 * 60 * 1000)) return entry

    console.log("no price analysis of:",ticker)

    const assetPriceAnalysisLLM = await _analyzePrice(ticker, priceData, analysisGoal)
    if (!assetPriceAnalysisLLM) return null

    await saveToFile("assetPriceAnalysis",{...all, [ticker]: {lastFetchedAt: Date.now(), analysis: assetPriceAnalysisLLM}})
    return assetPriceAnalysisLLM
}

async function _analyzePrice(ticker, priceData, analysisGoal) {
    console.log("analysing price for:",ticker)
    const model = 'gpt-4o-mini'
    const systemPrompt = `You are a financial price analyst.
    Analyze the following 1 day candles data: ${JSON.stringify(priceData, null, 2)} for ${ticker}.
    Important rules:
    - Base your answer ONLY on the price data provided.
    - Do NOT use news.
    - Do NOT give direct buy/sell instructions.
    - focus answer on users goal: ${analysisGoal}
    - answer only ${analysisGoal} in very short summery.
    - give only the levels that are supported by the price data.
    - Return ONLY valid JSON.
    - Do NOT include: any other text outside the JSON
    `
    const userPrompt = `Output format:
            {
                "analysisGoal": "${analysisGoal}",
                "summary": "short summary of the analysis",
                "sentiment": "bullish | bearish | mixed | neutral",
                "whatToWatchNext": [],
                "possibleMarketReaction": {
                    "bullishCase": "",
                    "bearishCase": ""
                },
                "confidence": "low | medium | high",
            }
    `
    // const response = await callOpenAI(model, userPrompt, systemPrompt)
    const { text } = await generateText({
        model: groq('openai/gpt-oss-120b'),
        prompt: userPrompt,
        system: systemPrompt,
        stream: true,
    })

    const parsed = safeParseJsonObject(text)
    if (!parsed || !_isValidAnalysisObject(parsed)) return null
    console.log('parsed',parsed)
    return parsed
}

export function _isValidAnalysisObject(obj) {
    if (!obj || typeof obj !== 'object') return false
    if (typeof obj.analysisGoal !== 'string') return false
    if (typeof obj.summary !== 'string') return false
    if (typeof obj.sentiment !== 'string') return false
    if (!Array.isArray(obj.whatToWatchNext)) return false
    if (!obj.possibleMarketReaction || typeof obj.possibleMarketReaction !== 'object') return false
    if (typeof obj.possibleMarketReaction.bullishCase !== 'string') return false
    if (typeof obj.possibleMarketReaction.bearishCase !== 'string') return false
    if (typeof obj.confidence !== 'string') return false
    return true
}
