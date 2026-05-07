import { callOpenAI } from '../providers/openai.provider.js'
import { isValidUserIntentObject, safeParseJsonObject } from './util.service.js'

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
  "analysisType": "news"
}

Rules:
- ticker: uppercase symbol if identifiable (e.g. AAPL), else null
- assetName: company or asset name if identifiable, else null
- analysisType: must always be the string "news"
- Return ONLY valid JSON, no markdown, no prose
`
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ]
    const response = await callOpenAI(model, messages)

    const parsed = safeParseJsonObject(response)
    if (!parsed || !isValidUserIntentObject(parsed)) return null
    return parsed
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
