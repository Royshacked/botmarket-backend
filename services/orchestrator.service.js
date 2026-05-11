import { callOpenAI } from '../providers/openai.provider.js'
import { safeParseJsonObject } from './util.service.js'

export const orchestratorService = {
    getUserIntent,
}

async function getUserIntent(userPrompt) {
    const model = 'gpt-4o-mini'
    const systemPrompt = `You are an intent parser for a financial analysis application.
Your task is to extract structured intent from a user prompt.

Return ONLY one JSON object with exactly these keys (use null when unknown):
{
  "ticker": string | null,
  "assetName": string | null,
  "analysisType": "news" | "technical" | "both" | "unclear"
  "analysisGoal": string | null
}

Rules:
- ticker: uppercase symbol if identifiable (e.g. AAPL), else null
- assetName: company or asset name if identifiable, else null
- analysisType: must be one of the following: "news" | "technical" | "both" | "unclear"
- analysisGoal: a short description of the goal of the analysis, else null
- Return ONLY valid JSON, no markdown, no prose
`
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ]
    const response = await callOpenAI(model, messages)
    const parsed = safeParseJsonObject(response)
    console.log('parsed',parsed)
    if (!parsed || !_isValidUserIntentObject(parsed)) return null
    return parsed
}

export function _isValidUserIntentObject(obj) {
    if (!obj || typeof obj !== 'object') return false 
    if (obj.analysisType != null && typeof obj.analysisType !== 'string') return false
    if (obj.ticker != null && typeof obj.ticker !== 'string') return false
    if (obj.assetName != null && typeof obj.assetName !== 'string') return false
    return true
}



// const systemPrompt = `You are an intent parser for a financial analysis application.
// Your task is to extract structured intent from a user prompt.

// You MUST:
// - Identify the asset symbol (ticker) if possible
// - Identify the asset name (company or asset)
// - Determine what kind of analysis the user is requesting:
// - "news"
// - "technical"
// - "both"
// - "unclear"
// - Detect if clarification is needed

// Rules:
// - Return ONLY valid JSON
// - Do NOT explain anything
// - Do NOT answer the user’s question
// - Do NOT perform any analysis
// - Do NOT include any text outside JSON
// `
