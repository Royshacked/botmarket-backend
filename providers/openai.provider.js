import OpenAI from 'openai'

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

const DEFAULT_SYSTEM_PROMPT =
    process.env.OPENAI_SYSTEM_PROMPT?.trim() || 'You are a helpful assistant.'

const DEFAULT_MAX_TOOL_TURNS = 12

const ALLOWED_ROLES = new Set(['user', 'assistant', 'system'])



export async function callOpenAI(model, promptOrMessages, systemPrompt = DEFAULT_SYSTEM_PROMPT) {
    const response = await client.responses.create({
        model,
        input: normalizeInput(promptOrMessages, systemPrompt),
    })

    return response.output_text ?? ''
}

export async function callOpenAIWithTools({
    model,
    promptOrMessages,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    tools,
    executeTool,
    tool_choice = 'auto',
    maxTurns = DEFAULT_MAX_TOOL_TURNS,
}) {
    let input = normalizeInput(promptOrMessages, systemPrompt)

    for (let turn = 0; turn < maxTurns; turn++) {
        const response = await client.responses.create({
            model,
            input,
            tools,
            tool_choice,
        })

        const functionCalls = (response.output ?? []).filter((item) => item?.type === 'function_call')

        if (functionCalls.length === 0) {
            return response.output_text ?? ''
        }

        input = [...input, ...(response.output ?? [])]

        for (const call of functionCalls) {
            const callId = call.call_id
            const toolId = call.name

            let args = {}
            try {
                args = call.arguments ? JSON.parse(call.arguments) : {}
            } catch {
                input.push({
                    type: 'function_call_output',
                    call_id: callId,
                    output: JSON.stringify({ error: `Invalid JSON arguments for ${toolId}` }),
                })
                continue
            }

            try {
                const outcome = await executeTool(toolId, args)
                const output = outcome.ok
                    ? JSON.stringify(outcome.result ?? null)
                    : JSON.stringify({ error: outcome.error ?? 'Tool execution failed' })
                input.push({ type: 'function_call_output', call_id: callId, output })
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                input.push({
                    type: 'function_call_output',
                    call_id: callId,
                    output: JSON.stringify({ error: message }),
                })
            }
        }
    }

    throw new Error(`OpenAI tool loop exceeded maxTurns (${maxTurns})`)
}

/**
 * String prompt → [system, user]. Array → typed messages; inject system if missing.
 */

function normalizeInput(promptOrMessages, systemPrompt) {
    const resolvedSystemPrompt = systemPrompt ?? DEFAULT_SYSTEM_PROMPT

    const toTypedContent = (content, role) => {
        if (Array.isArray(content)) return content
        const type = role === 'assistant' ? 'output_text' : 'input_text'
        if (typeof content === 'string') return [{ type, text: content }]
        if (content == null) return [{ type, text: '' }]
        return [{ type, text: String(content) }]
    }

    if (Array.isArray(promptOrMessages)) {
        const normalized = promptOrMessages.map((m) => {
            const role = m?.role
            if (!ALLOWED_ROLES.has(role)) {
                throw new Error(`Invalid message role: ${role}`)
            }
            return { role, content: toTypedContent(m.content, role) }
        })

        const hasSystem = normalized.some((m) => m.role === 'system')
        if (!hasSystem && resolvedSystemPrompt) {
            normalized.unshift({
                role: 'system',
                content: toTypedContent(resolvedSystemPrompt, 'system'),
            })
        }

        return normalized
    }

    return [
        { role: 'system', content: toTypedContent(resolvedSystemPrompt, 'system') },
        { role: 'user', content: toTypedContent(promptOrMessages, 'user') },
    ]
}
