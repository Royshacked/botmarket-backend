import OpenAI from 'openai'
import dotenv from 'dotenv'
dotenv.config()

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

const DEFAULT_SYSTEM_PROMPT =
  process.env.OPENAI_SYSTEM_PROMPT?.trim() || 'You are a helpful assistant.'

function _toTypedContent(content) {
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return [{ type: 'input_text', text: content }]
  if (content == null) return [{ type: 'input_text', text: '' }]
  return [{ type: 'input_text', text: String(content) }]
}

function _normalizeInput(promptOrMessages, systemPrompt) {
  const resolvedSystemPrompt = (systemPrompt ?? DEFAULT_SYSTEM_PROMPT)

  // If caller passed an array, treat it as "messages"
  if (Array.isArray(promptOrMessages)) {
    const normalized = promptOrMessages.map((m) => ({
      role: m.role,
      content: _toTypedContent(m.content),
    }))

    const hasSystem = normalized.some((m) => m?.role === 'system')
    if (!hasSystem && resolvedSystemPrompt) {
      normalized.unshift({
        role: 'system',
        content: _toTypedContent(resolvedSystemPrompt),
      })
    }

    return normalized
  }

  // Otherwise treat it as a user prompt string
  return [
    { role: 'system', content: _toTypedContent(resolvedSystemPrompt) },
    { role: 'user', content: _toTypedContent(promptOrMessages) },
  ]
}

export async function callOpenAI(model, promptOrMessages, systemPrompt = DEFAULT_SYSTEM_PROMPT) {
    const response = await client.responses.create({
      model,
      input: _normalizeInput(promptOrMessages, systemPrompt),
    })

    return response.output_text
}

