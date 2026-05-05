import OpenAI from 'openai'
import dotenv from 'dotenv'
dotenv.config()

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

const DEFAULT_SYSTEM_PROMPT =
  process.env.OPENAI_SYSTEM_PROMPT?.trim() || 'You are a helpful assistant.'

export async function callOpenAI(model, prompt, systemPrompt = DEFAULT_SYSTEM_PROMPT) {
    const response = await client.responses.create({
      model,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    })

    return response.output_text
}

