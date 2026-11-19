// ECHO'S CHAIN MAP, FOR AN EVENT THE USER NAMES (docs/design/echo-desk.md §3–4, step 3, 2026-11-19).
//
// The forward test's mapper is the engine's (aether-engine echo/llm_map.py), and Render's backend cannot run the engine's
// Python — so this is its PORT: the same system prompt, schema, model and effort, the same resolution (active US
// listings via the FMP profile, the origin and duplicates out, at most 30), and the same DIRECTION RULE
// (chains.direction_for): suppliers and infrastructure move WITH what the event does to the origin, substitutes against
// it, peers and customers `unclear`. The model's own direction is kept in the link's note, unused — as the engine does.
// tests/unit/echoMap.test.js checks the system prompt against the engine's file when the engine is checked out beside.
//
// What differs is only the EVENT. The engine maps an earnings print it detected; here the user names anything — "GTA 6
// is out", a guidance cut, a strike, a heatwave — and Echo frames it (§3) into the same shape before it is mapped:
// an origin (a company, or the DEMAND it moves when no one company is the event's), its tickers, the effect (up/down),
// the date, what changed. The user prompt says "event" where the engine's says "result", and PROMPT_VERSION carries a
// `user-` prefix: a user map is never the forward test's arm.
//
// A USER EVENT NEVER ENTERS THE FORWARD TEST (§2): it is stored in `echo_user_events`, owned by the user who asked, and
// the engine never reads it. No market check, no grades, no verdict.

import { randomUUID } from 'node:crypto'
import { callAnthropicStructured } from '../providers/anthropic.provider.js'
import { getListingProfile } from '../providers/fmp.provider.js'
import { recordUsage } from './tokenUsage.service.js'
import { getDb } from '../providers/mongodb.provider.js'
import { logger } from './logger.service.js'

const LOG = '[echoMap]'

export const COLLECTION = 'echo_user_events'
export const MODEL = 'claude-opus-5-5'
export const EFFORT = 'high'
export const ENGINE_PROMPT_VERSION = '2026-11-19'        // llm_map.PROMPT_VERSION this port copies
export const PROMPT_VERSION = `user-${ENGINE_PROMPT_VERSION}`
export const MAX_LINKS = 30
export const RELATIONS = Object.freeze(['peer', 'customer', 'supplier', 'infrastructure', 'substitute'])
export const LAYER = Object.freeze({ peer: 1, customer: 1, substitute: 1, supplier: 2, infrastructure: 3 })
export const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX', 'NYSE AMERICAN', 'NYSE ARCA', 'CBOE', 'BATS'])
const USER_LIST_LIMIT = 50

// VERBATIM from aether-engine src/aether_engine/echo/llm_map.py SYSTEM (PROMPT_VERSION 2026-11-19). Change it there and
// here together, and bump both versions — the engine's is a frozen test arm.
export const SYSTEM = `You map the supply chain an event runs through, for an event-driven study of how news travels to companies \
the market is slow to connect.

The layers:
- Layer 1: the origin's direct peers (competitors) and customers. The market prices these at once; they are the \
yardstick, so name a few of the clearest ones (3 to 6).
- Layer 2: the origin's suppliers — the companies whose revenue rises or falls with the origin's own volumes or capex.
- Layer 3: suppliers' suppliers and infrastructure — power, cooling, materials, equipment, logistics, the things the \
origin's growth (or contraction) consumes.
- Substitutes: companies whose demand moves the OTHER way when the origin's moves.

What matters most is layers 2 and 3 and substitutes: real, specific economic links where the event changes the \
company's revenue in a known direction. A famous name with a weak link is worse than an obscure name with a strong \
one. Do not list a company only because it is in the same sector.

Rules:
- US-listed companies only (NYSE, NASDAQ, or an ADR on them), with the ticker as it trades there. Skip a company with \
no US listing.
- \`direction\` is what the event does to that company's business: gains, loses, or unclear (recorded for study).
- \`why\` is one sentence naming the economic link (what flows between them), not the event.
- Never the origin itself.`   // a backslash at a line's end continues the line, in JS as in the Python

/** llm_map.schema() */
export function schema() {
    return {
        type: 'object',
        properties: {
            links: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name:       { type: 'string' },
                        ticker:     { type: 'string' },
                        relation:   { type: 'string', enum: [...RELATIONS] },
                        direction:  { type: 'string', enum: ['gains', 'loses', 'unclear'] },
                        why:        { type: 'string' },
                        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                    },
                    required: ['name', 'ticker', 'relation', 'direction', 'why', 'confidence'],
                    additionalProperties: false,
                },
            },
        },
        required: ['links'],
        additionalProperties: false,
    }
}

/** chains.direction_for — the backtest's first-order rule; the model's direction never decides it. */
export function directionFor(relation, effect) {
    if (effect !== 'up' && effect !== 'down') return 'unclear'
    const same = effect === 'up' ? 'gains' : 'loses'
    const other = effect === 'up' ? 'loses' : 'gains'
    return { supplier: same, infrastructure: same, substitute: other }[relation] ?? 'unclear'
}

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Check and tidy a framed event (what Echo's `map_event` tool sends). → `{ ok: true, event }` or `{ ok: false, reason }`.
 * `origin` names the company — or the demand moved, when no single listed company is the event's (then `tickers` is
 * empty). `effect` is what the event does to the origin's demand.
 */
export function frameEvent({ what_changed, origin, tickers = [], effect, date, horizon = null } = {}, today = new Date().toISOString().slice(0, 10)) {
    const what = String(what_changed ?? '').trim()
    const who = String(origin ?? '').trim()
    if (!what) return { ok: false, reason: 'what_changed is required — one sentence: what happened' }
    if (!who) return { ok: false, reason: 'origin is required — the company the event happens to, or the demand it moves' }
    if (effect !== 'up' && effect !== 'down') return { ok: false, reason: 'effect must be up or down — what the event does to the origin\'s demand; ask the user if it could go either way' }
    const tks = [...new Set((Array.isArray(tickers) ? tickers : [tickers]).map(t => String(t ?? '').trim().toUpperCase().replace(/\./g, '-')).filter(Boolean))]
    const bad = tks.find(t => !TICKER.test(t))
    if (bad) return { ok: false, reason: `not a ticker: ${bad}` }
    const d = date == null || date === '' ? today : String(date)
    if (!DATE.test(d)) return { ok: false, reason: 'date must be YYYY-MM-DD' }
    return { ok: true, event: { what_changed: what.slice(0, 400), origin: who.slice(0, 120), origin_tickers: tks, effect, date: d,
        horizon: horizon ? String(horizon).toLowerCase() : null } }
}

/** The user message — llm_map.prompt with the framed event in place of the earnings line. */
export function promptFor(ev, description = '') {
    const way = ev.effect === 'up' ? 'raises' : 'lowers'
    const lines = [
        `Event (${ev.date}): ${ev.what_changed}.`,
        ev.origin_tickers.length
            ? `Origin: ${ev.origin} (${ev.origin_tickers.join(', ')}). The event ${way} demand at the origin.`
            : `Origin: ${ev.origin} — no single listed company; this is the demand the event moves. The event ${way} it.`,
    ]
    if (description) lines.push(`About the origin: ${String(description).trim().slice(0, 1500)}`)
    lines.push(`Map the chain this event runs through — up to ${MAX_LINKS} links, layers 2-3 and substitutes first.`)
    return lines.join('\n\n')
}

/**
 * llm_map.resolve. `profileOf(ticker)` → `{ name, exchange, activelyTrading }` or null. → `{ links, dropped }`. A link is
 * kept on an active US listing that is not the origin and not a duplicate; the rest are dropped with the reason.
 */
export async function resolve(ev, raw, profileOf, mappedOn, servedModel = MODEL) {
    const links = [], dropped = []
    const seen = new Set(ev.origin_tickers.map(t => t.toUpperCase()))
    for (const r of (raw ?? []).slice(0, MAX_LINKS)) {
        const tk = String(r?.ticker ?? '').trim().toUpperCase().replace(/\./g, '-')
        const rel = r?.relation
        if (!RELATIONS.includes(rel)) { dropped.push({ ...r, reason: 'relation' }); continue }
        if (!tk || seen.has(tk)) { dropped.push({ ...r, reason: tk ? 'origin or duplicate' : 'no ticker' }); continue }
        const prof = await profileOf(tk)
        if (!prof) { dropped.push({ ...r, reason: 'no FMP profile' }); continue }
        const exch = String(prof.exchange ?? '').toUpperCase()
        if (prof.activelyTrading === false || (exch && !US_EXCHANGES.has(exch))) {
            dropped.push({ ...r, reason: `not an active US listing (${exch || '?'})` }); continue
        }
        seen.add(tk)
        links.push({
            name: r.name || tk, ticker: tk, relation: rel, source: 'llm', evidence_date: mappedOn,
            evidence_ref: `${servedModel} · prompt ${PROMPT_VERSION}`, evidence_text: r.why || '',
            layer: LAYER[rel], direction: directionFor(rel, ev.effect), revenue_share: null, status: 'proposed',
            note: `confidence ${r.confidence ?? '?'}; model's direction ${r.direction ?? '?'}; FMP: ${prof.name ?? '?'}`,
        })
    }
    return { links, dropped }
}

const _deps = {
    call: callAnthropicStructured,
    profile: getListingProfile,
    record: recordUsage,
    db: null,
    now: () => new Date(),
    id: () => `ue_${randomUUID()}`,
}
/** Test-only: swap the model call, the profile lookup, the store, the clock. */
export function _setDeps(d) { Object.assign(_deps, d) }
const coll = async () => (_deps.db ?? await getDb()).collection(COLLECTION)

/**
 * Frame, map, resolve and store one user event. → `{ ok: true, doc }` or `{ ok: false, reason }`. One Opus 5.5 call at
 * effort high (its cost recorded to the user as `echo`); the profile lookups ride the shared 24 h /profile cache.
 */
export async function mapUserEvent(input, { userId }) {
    if (!userId) return { ok: false, reason: 'no user' }
    const framed = frameEvent(input, _deps.now().toISOString().slice(0, 10))
    if (!framed.ok) return framed
    const ev = framed.event
    const description = ev.origin_tickers.length ? (await _deps.profile(ev.origin_tickers[0]))?.description ?? '' : ''
    let res
    try {
        res = await _deps.call({ model: MODEL, systemPrompt: SYSTEM, user: promptFor(ev, description), schema: schema(), effort: EFFORT,
            onUsage: (usage, m) => { _deps.record(userId, m, usage, 'echo').catch(() => {}) } })
    } catch (err) {
        logger.error(LOG, 'map call failed:', err.message)
        return { ok: false, reason: 'The model could not be reached — try again.' }
    }
    const raw = res?.data?.links
    if (!Array.isArray(raw)) return { ok: false, reason: `No map came back (${res?.stopReason ?? 'no answer'}) — try again.` }
    const now = _deps.now()
    const { links, dropped } = await resolve(ev, raw, _deps.profile, now.toISOString().slice(0, 10), res.model)
    const doc = {
        _id: _deps.id(), userId: String(userId), createdAt: now.toISOString(), kind: 'user', event: ev,
        map: { model: res.model, prompt_version: PROMPT_VERSION, mapped_at: now.toISOString(),
            direction_rule: 'chains.direction_for(relation, effect)', links, dropped },
    }
    await (await coll()).insertOne(doc)
    return { ok: true, doc }
}

/** The user's own events, newest first. */
export async function listUserEvents(userId) {
    if (!userId) return []
    return (await coll()).find({ userId: String(userId) }).sort({ createdAt: -1 }).limit(USER_LIST_LIMIT).toArray()
}

/** One of the user's events, or null (another user's is null too). */
export async function getUserEvent(id, userId) {
    if (!id || !userId) return null
    return (await coll()).findOne({ _id: String(id), userId: String(userId) })
}

export const echoMapService = { mapUserEvent, listUserEvents, getUserEvent, frameEvent }
