// ECHO, STEP 2 — CHAIN MAPPING (docs/design/echo-pipeline.md; the simulator doc's Step 2).
//
// From the event's origin the chain is walked in BOTH directions, winners and losers alike:
//   layer 0  the origin (the event's own) · layer 1 direct peers and customers · layer 2 suppliers · layer 3 suppliers'
//   suppliers and infrastructure (power, cooling, materials, real estate) · LOSERS — whose demand shrinks or whose supply
//   is cut (dialysis, snack food, Uniper).
// The model proposes the links, each with its layer (from what the link IS), its direction (gains / loses, with the
// event's effect at the origin in hand) and why. Then the FILINGS: does the linked company's business filing name the
// origin, or the origin's name it; and the 10-K's stated share of the linked company's revenue tied to the origin.
// Evidence, not a gate (Roy, 2026-11-19): every link stays, marked named / not named — Step 3 caps an unnamed link's
// Exposure.
//
// EVENT TEMPLATES (the doc): the last map of the same kind of event on the same origin is the model's starting point
// ("update it"), and every map becomes the template for the next.

import { callAnthropicStructured } from '../providers/anthropic.provider.js'
import { getListingProfile } from '../providers/fmp.provider.js'
import { getDb } from '../providers/mongodb.provider.js'
import { recordUsage } from './tokenUsage.service.js'
import { namedIn, customerShare, termsFor } from './echoFilings.service.js'
import { logger } from './logger.service.js'

const LOG = '[echoChain]'
export const MODEL = 'claude-opus-5-5'
export const EFFORT = 'high'
export const PROMPT_VERSION = 'chain-2026-11-19'
export const MAX_LINKS = 40
export const TEMPLATES = 'echo_templates'
export const RELATIONS = Object.freeze(['peer', 'customer', 'supplier', 'infrastructure', 'substitute', 'demand_loser', 'supply_loser'])
export const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX', 'NYSE AMERICAN', 'NYSE ARCA', 'CBOE', 'BATS'])
const FILING_PAUSE_MS = 120      // EDGAR asks for ≤ 10 requests a second; three reads a link

export const SYSTEM = `You map the supply chain an event runs through, for a system that looks for the companies the market is slow \
to connect to news: not who hears the event first, but the second- and third-order effects others miss.

Walk the chain from the origin in BOTH directions and list companies at each layer, winners AND losers:
- Layer 1: the origin's direct peers (competitors) and its customers — the obvious names the market reprices within \
hours. Name the clearest few; they are the yardstick.
- Layer 2: suppliers — who sells the inputs the origin needs more of (or less of): foundries, contract manufacturers, \
fill-finish plants, tankers.
- Layer 3: suppliers' suppliers and infrastructure — power, cooling, materials, equipment, logistics, real estate: what \
the origin's growth (or contraction) consumes.
- Losers, at any layer: whose demand SHRINKS because of the event (relation demand_loser — dialysis after a kidney \
drug, snack food after GLP-1s) or whose SUPPLY is cut (relation supply_loser — a gas importer when its supplier stops).
- Substitutes: companies whose demand moves the OTHER way when the origin's moves.

What matters most are layers 2 and 3, the losers and the substitutes: real, specific economic links where the event \
changes the company's revenue in a known direction. The best link is often an obscure company — one that controls \
scarce capacity, or is filed outside the event's theme (a cooling maker filed as an industrial, not tech) — and a \
famous name with a weak link is worse than an obscure name with a strong one. Do not list a company only because it is \
in the same sector.

For each link:
- \`relation\`: peer, customer, supplier, infrastructure, substitute, demand_loser or supply_loser.
- \`layer\`: 1, 2 or 3 — from what the link IS (a supplier's supplier is 3).
- \`direction\`: what the event does to that company's business — gains or loses. Take the event's effect at the \
origin as given (demand up or down). Use unclear only when it truly could go either way.
- \`why\`: one sentence naming the economic link — what flows between them and why the event moves it.
- \`confidence\`: how sure you are the link is real and material — high, medium or low.

Rules:
- US-listed companies only (NYSE, NASDAQ, or an ADR on them), with the ticker as it trades there. Skip a company with \
no US listing.
- Never the origin itself.
- When a previous map of this kind of event on this origin is given, start from it: keep the links that still hold, \
drop the ones that do not, add what is missing.`

export function schema() {
    return {
        type: 'object',
        properties: {
            links: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' }, ticker: { type: 'string' },
                        relation: { type: 'string', enum: [...RELATIONS] },
                        layer: { type: 'integer', enum: [1, 2, 3] },
                        direction: { type: 'string', enum: ['gains', 'loses', 'unclear'] },
                        why: { type: 'string' },
                        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                    },
                    required: ['name', 'ticker', 'relation', 'layer', 'direction', 'why', 'confidence'],
                    additionalProperties: false,
                },
            },
        },
        required: ['links'],
        additionalProperties: false,
    }
}

/** The event's terms for the filing search: its own, else the origin's name without its suffix. Pure. */
export const originTerms = (ev) => (ev.terms?.length ? ev.terms : termsFor(ev.origin))

/** The user message: the event as Step 1 recorded it, the origin's description, the template. Pure. */
export function promptFor(ev, { description = '', template = null } = {}) {
    const way = { up: 'RAISES demand at the origin', down: 'LOWERS demand at the origin', mixed: 'moves demand at the origin both ways' }[ev.effect]
    const lines = [
        `Event (${ev.date}, ${ev.type.replace('_', ' ')}): ${ev.whatChanged}.`,
        ev.originTickers?.length ? `Origin: ${ev.origin} (${ev.originTickers.join(', ')}).` : `Origin: ${ev.origin} — no single listed company.`,
        `Effect: the event ${way}.${ev.size ? ` Size: ${ev.size}.` : ''} Durability: ${ev.durability.kind.replace(/_/g, ' ')}${ev.durability.why ? ` — ${ev.durability.why}` : ''}.`,
    ]
    if (description) lines.push(`About the origin: ${String(description).trim().slice(0, 1500)}`)
    if (template?.links?.length) {
        lines.push(`A previous map of a ${ev.type.replace('_', ' ')} on this origin (${template.from}) — start from it:\n` +
            template.links.map(l => `- ${l.ticker} ${l.name} — ${l.relation}, layer ${l.layer}, ${l.direction}: ${l.why}`).join('\n'))
    }
    lines.push(`Map the chain — up to ${MAX_LINKS} links, layers 2 and 3, the losers and the substitutes first.`)
    return lines.join('\n\n')
}

/**
 * The model's links on active US listings, the origin and duplicates out, the rest dropped with the reason. Each keeps
 * the model's layer, direction, why and confidence. → `{ links, dropped }`.
 */
export async function resolve(ev, raw, profileOf) {
    const links = [], dropped = []
    const seen = new Set((ev.originTickers ?? []).map(t => t.toUpperCase()))
    for (const r of (raw ?? []).slice(0, MAX_LINKS)) {
        const tk = String(r?.ticker ?? '').trim().toUpperCase().replace(/\./g, '-')
        if (!RELATIONS.includes(r?.relation)) { dropped.push({ name: r?.name, ticker: tk, reason: 'relation' }); continue }
        if (!tk || seen.has(tk)) { dropped.push({ name: r?.name, ticker: tk, reason: tk ? 'origin or duplicate' : 'no ticker' }); continue }
        const prof = await profileOf(tk)
        if (!prof) { dropped.push({ name: r.name, ticker: tk, reason: 'no listing found' }); continue }
        const exch = String(prof.exchange ?? '').toUpperCase()
        if (prof.activelyTrading === false || (exch && !US_EXCHANGES.has(exch))) {
            dropped.push({ name: r.name, ticker: tk, reason: `not an active US listing (${exch || '?'})` }); continue
        }
        seen.add(tk)
        links.push({
            ticker: tk, name: prof.name || r.name || tk, relation: r.relation, layer: [1, 2, 3].includes(r.layer) ? r.layer : 2,
            direction: ['gains', 'loses', 'unclear'].includes(r.direction) ? r.direction : 'unclear',
            why: String(r.why ?? '').slice(0, 400), confidence: r.confidence ?? null, sector: prof.sector ?? null,
        })
    }
    return { links, dropped }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * Step 2's filing check on every link: named by the linked company's filings, or naming it in the origin's; the
 * 10-K's stated share of its revenue tied to the origin. → the links with `filings: { named, namedBy, share, excerpt }`
 * (`named` null when nothing could be read). Never throws.
 */
export async function withFilings(ev, links, deps = _deps) {
    const terms = originTerms(ev)
    const origin = ev.originTickers?.[0] ?? null
    const out = []
    for (const l of links) {
        const byLink = await deps.namedIn(l.ticker, terms); await deps.sleep(FILING_PAUSE_MS)
        const byOrigin = origin ? await deps.namedIn(origin, termsFor(l.name)) : { named: null }; await deps.sleep(FILING_PAUSE_MS)
        const share = await deps.customerShare(l.ticker, terms); await deps.sleep(FILING_PAUSE_MS)
        const named = byLink.named === true || byOrigin.named === true ? true
            : byLink.named === false && (byOrigin.named === false || !origin) ? false : null
        out.push({
            ...l,
            filings: {
                named: share.share ? true : named,
                namedBy: [byLink.named && 'its filings', byOrigin.named && "the origin's filings", share.share && 'its 10-K customer table'].filter(Boolean),
                share: share.share ? { share: share.share, atLeast: Boolean(share.atLeast), form: share.form, date: share.date, url: share.url } : null,
                excerpt: share.excerpt ?? byLink.excerpt ?? byOrigin.excerpt ?? null,
            },
        })
    }
    return out
}

const templateKey = (ev) => `${ev.type}|${(ev.originTickers?.[0] ?? ev.origin).toLowerCase()}`

const _deps = {
    call: callAnthropicStructured, profile: getListingProfile, record: recordUsage, namedIn, customerShare,
    sleep, db: null, now: () => new Date(),
    async houseLedger() { const { houseLedgerUserId } = await import('../api/user/user.model.js'); return houseLedgerUserId() },
}
export function _setDeps(d) { Object.assign(_deps, d) }
const coll = async (name) => (_deps.db ?? await getDb()).collection(name)

/**
 * Map one framed event: the model's chain (from the template when there is one), resolved to active US listings, the
 * filings on every link; the map saved as the next template. One Opus 5.5 call, booked to the user (or the house).
 * → `{ ok: true, map }` or `{ ok: false, reason }`.
 */
export async function mapEvent(ev, { userId = null } = {}) {
    let description = '', originSector = null
    if (ev.originTickers?.length) {
        const prof = await _deps.profile(ev.originTickers[0])
        if (!prof) return { ok: false, reason: `No listing found for ${ev.originTickers[0]} — check the ticker, or try again in a minute.` }
        description = prof.description ?? ''
        originSector = prof.sector ?? null
    }
    const tcol = await coll(TEMPLATES)
    const tdoc = await tcol.findOne({ _id: templateKey(ev) })
    const template = tdoc ? { from: tdoc.from, links: tdoc.links } : null
    const payer = userId ?? await _deps.houseLedger().catch(() => null)
    let res
    try {
        res = await _deps.call({ model: MODEL, systemPrompt: SYSTEM, user: promptFor(ev, { description, template }), schema: schema(), effort: EFFORT,
            onUsage: (usage, m) => { if (payer) _deps.record(payer, m, usage, 'echo', userId ? {} : { monitor: true }).catch(() => {}) } })
    } catch (err) {
        logger.error(LOG, 'map call failed:', err.message)
        return { ok: false, reason: 'The model could not be reached — try again.' }
    }
    const raw = res?.data?.links
    if (!Array.isArray(raw)) return { ok: false, reason: `No map came back (${res?.stopReason ?? 'no answer'}) — try again.` }
    const { links, dropped } = await resolve(ev, raw, _deps.profile)
    const named = raw.filter(r => String(r?.ticker ?? '').trim()).length
    if (!links.length && named >= 3 && dropped.every(d => d.reason === 'no listing found')) {
        return { ok: false, reason: 'The listing data could not be reached to check the names — try again in a minute.' }
    }
    const checked = await withFilings(ev, links)
    const now = _deps.now().toISOString()
    const map = { model: res.model, promptVersion: PROMPT_VERSION, mappedAt: now, fromTemplate: template?.from ?? null, originSector, links: checked, dropped }
    await tcol.updateOne({ _id: templateKey(ev) }, { $set: { from: `${ev.origin} ${ev.date}`, links: links.map(({ ticker, name, relation, layer, direction, why }) => ({ ticker, name, relation, layer, direction, why })), updatedAt: now } }, { upsert: true })
    return { ok: true, map }
}

export const echoChainService = { mapEvent, resolve, withFilings, promptFor }
