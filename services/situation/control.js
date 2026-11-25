// THE CONTROL (docs/design/situation-network.md §11.5): the same model, asked weekly and with NO network, "which US
// industries win over the next six months, and from month 6 to month 24?" — scored exactly like the network's calls (scorecard.js), so the forward
// test shows whether the network adds anything over the plain question. Given the same state the network was grown
// from, and the same industry list; nothing else.

import { callAnthropicStructured } from '../../providers/anthropic.provider.js'
import { recordUsage, calcCost } from '../tokenUsage.service.js'
import { getDb } from '../../providers/mongodb.provider.js'
import { CONTROL } from './scorecard.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.control]'
export const CONTROL_MODEL = 'claude-opus-5-5'
export const CONTROL_EFFORT = 'high'

const _io = {
    call: (args) => callAnthropicStructured(args), db: () => getDb(),
    record: (payer, model, usage) => recordUsage(payer, model, usage, 'situation', { monitor: true }),
    payer: async () => { const { houseLedgerUserId } = await import('../../api/user/user.model.js'); return houseLedgerUserId() },
}
export function _setIO(io) { Object.assign(_io, io) }

export const SYSTEM = 'You are given the current state of the world (dated, sourced) and a list of US industries. Say, for each industry you have a '
    + 'view on, the chance it beats the average industry over the next six months (`p_win`) and the chance it trails it (`p_lose`), and '
    + 'separately the same two chances from month 6 to month 24 (`far_win`, `far_lose`); each pair may not sum above 1. Use only the state. Industries you have no view on, leave out. Answer in the JSON schema.'

export function controlSchema() {
    return { type: 'object', additionalProperties: false, required: ['industries'], properties: { industries: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['code', 'p_win', 'p_lose', 'far_win', 'far_lose'],
        properties: { code: { type: 'string' }, p_win: { type: 'number' }, p_lose: { type: 'number' }, far_win: { type: 'number' }, far_lose: { type: 'number' } } } } } }
}

/** Ask the plain question for `asOf` and store the answer. → `{ ok, rows, cost_usd }`. Never throws. */
export async function runControl(state, industries, asOf) {
    let cost = 0, payer = null
    try { payer = await _io.payer() } catch { /* unbooked */ }
    try {
        const sec = Object.entries(state.sections).map(([n, xs]) => `${n.toUpperCase()}:\n${xs.map(i => `- ${i.as_of} [${i.tag}] ${i.text}`).join('\n')}`)
        const user = [`AS-OF DATE: ${asOf}.`, '', ...sec, '', 'THE INDUSTRIES:', ...industries.map(i => `${i.code} ${i.name}`)].join('\n')
        const res = await _io.call({ model: CONTROL_MODEL, effort: CONTROL_EFFORT, systemPrompt: SYSTEM, user, schema: controlSchema(),
            onUsage: (usage, m) => { cost += calcCost(m, usage); if (payer) _io.record(payer, m, usage).catch(() => {}) } })
        const known = new Map(industries.map(i => [i.code, i]))
        const rows = (res?.data?.industries ?? []).filter(r => known.has(r.code) && r.p_win >= 0 && r.p_lose >= 0 && r.p_win + r.p_lose <= 1.01)
            .map(r => ({ code: r.code, level: known.get(r.code).level, name: known.get(r.code).name, p_win: r.p_win, p_lose: r.p_lose,
                far: r.far_win >= 0 && r.far_lose >= 0 && r.far_win + r.far_lose <= 1.01 ? { p_win: r.far_win, p_lose: r.far_lose } : null }))
        const db = await _io.db()
        await db.collection(CONTROL).updateOne({ as_of: asOf }, { $set: { as_of: asOf, rows, cost_usd: cost, model: CONTROL_MODEL } }, { upsert: true })
        return { ok: true, rows: rows.length, cost_usd: cost }
    } catch (err) {
        logger.warn(LOG, 'the control failed', { error: err.message })
        return { ok: false, reason: err.message, cost_usd: cost }
    }
}
