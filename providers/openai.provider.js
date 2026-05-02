import OpenAI from 'openai'
import dotenv from 'dotenv'
dotenv.config()

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

export async function callOpenAI(model,prompt) {
    const response = await client.responses.create({
      model: model,
      input: prompt,
    });
  
    return response.output_text;  
}

