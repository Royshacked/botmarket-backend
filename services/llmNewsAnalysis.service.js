import { callOpenAI } from "../providers/openai.provider.js"
import { isCacheFresh, loadFromFile, safeParseJsonObject, saveToFile } from "./util.service.js"
import { groq } from '@ai-sdk/groq';
import { generateText } from 'ai';

export const llmNewsAnalysisService = {
    getLLMNewsAnalysis,
}


async function getLLMNewsAnalysis(ticker , articles, analysisGoal) {
    const all = await loadFromFile("assetNewsAnalysis")
    const entry = all[ticker]
    const lastFetchedAt = entry?.lastFetchedAt || 0
    if (isCacheFresh(lastFetchedAt, 1000 * 60 * 1000)) return entry

    console.log("no news analysis of:",ticker)

    const assetAnalysisLLM = await _analyzeNews(ticker, articles, analysisGoal)
    if (!assetAnalysisLLM) return null

    await saveToFile("assetNewsAnalysis",{...all, [ticker]: {lastFetchedAt: Date.now(), analysis: assetAnalysisLLM}})
    return assetAnalysisLLM
}

async function _analyzeNews(ticker, articles, analysisGoal) {
    console.log("analysing news for:",ticker)
    const model = 'gpt-4o-mini'
    const systemPrompt = `You are a financial news analyst.
            Analyze the following news articles about ${ticker}.
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
                "analysisGoal": "${analysisGoal}",
                "summary": "short summary of the main story",
                "sentiment": "bullish | bearish | mixed | neutral",
                "whatToWatchNext": [],
                "possibleMarketReaction": {
                    "bullishCase": "",
                    "bearishCase": ""
                },
                "confidence": "low | medium | high",
            }
    Articles:
    ${JSON.stringify(articles, null, 2)}
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
