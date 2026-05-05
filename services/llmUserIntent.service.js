import OpenAI from 'openai'
import { callOpenAI } from '../providers/openai.provider.js'

export const llmUserIntentService = {
    getUserIntent,
}

async function getUserIntent(userPrompt) {
    const model = 'gpt-4o-mini'
    const systemPrompt = `You are an intent parser for a financial analysis application.
    Your task is to extract structured intent from a user prompt.
    - Identify the asset symbol (ticker) if possible
    - Identify the asset name (company or asset)
    - for now user need only news analysis, so return only "news"

    Important rules:
    - Return ONLY valid JSON
    - Do NOT explain anything
    - Do NOT answer the user’s question
    - Do NOT perform any analysis
    - Do NOT include any text outside JSON
    `
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ]
    const response = await callOpenAI(model, messages)
    return response
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
