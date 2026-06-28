import { getDb } from '../providers/mongodb.provider.js'

const TOKEN_BUDGET_USD = Number(process.env.TOKEN_BUDGET_USD) || 20

// Pricing per 1M tokens in USD
const PRICING = {
    'claude-haiku-4-5-20251001': { input: 1.00,  output: 5.00,  cacheRead: 0.10,  cacheWrite: 1.25  },
    'claude-sonnet-4-6':        { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
    'claude-opus-4-8':          { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
}
const DEFAULT_PRICING = { input: 3.00, output: 15.00 }

export function monthKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function calcCost(model, usage) {
    const p = PRICING[model] ?? DEFAULT_PRICING
    return (
        (usage.input_tokens                  ?? 0) * p.input              / 1_000_000 +
        (usage.output_tokens                 ?? 0) * p.output             / 1_000_000 +
        (usage.cache_read_input_tokens       ?? 0) * (p.cacheRead  ?? 0) / 1_000_000 +
        (usage.cache_creation_input_tokens   ?? 0) * (p.cacheWrite ?? 0) / 1_000_000
    )
}

export async function recordUsage(userId, model, usage) {
    if (!userId || !usage) return
    const db      = await getDb()
    const key     = monthKey()
    const cost    = calcCost(model, usage)
    const mKey    = model.replace(/\./g, '_')  // dots are not allowed in MongoDB field paths

    await db.collection('token_usage').updateOne(
        { userId, month: key },
        {
            $inc: {
                inputTokens:       usage.input_tokens                  ?? 0,
                outputTokens:      usage.output_tokens                 ?? 0,
                cacheReadTokens:   usage.cache_read_input_tokens       ?? 0,
                cacheWriteTokens:  usage.cache_creation_input_tokens   ?? 0,
                totalCost:         cost,
                [`byModel.${mKey}.inputTokens`]:  usage.input_tokens  ?? 0,
                [`byModel.${mKey}.outputTokens`]: usage.output_tokens ?? 0,
                [`byModel.${mKey}.cost`]:         cost,
            },
            $setOnInsert: { userId, month: key },
        },
        { upsert: true }
    )
}

export async function getMonthlyUsage(userId, month = monthKey()) {
    const db  = await getDb()
    const doc = await db.collection('token_usage').findOne({ userId, month })

    const totalCost = doc?.totalCost ?? 0
    return {
        month,
        totalCost:    +totalCost.toFixed(4),
        budgetUsd:    TOKEN_BUDGET_USD,
        percentUsed:  +(Math.min(100, (totalCost / TOKEN_BUDGET_USD) * 100)).toFixed(1),
        inputTokens:       doc?.inputTokens      ?? 0,
        outputTokens:      doc?.outputTokens     ?? 0,
        cacheReadTokens:   doc?.cacheReadTokens  ?? 0,
        cacheWriteTokens:  doc?.cacheWriteTokens ?? 0,
        byModel:           doc?.byModel          ?? {},
    }
}
