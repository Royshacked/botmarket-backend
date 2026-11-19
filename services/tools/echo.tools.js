/**
 * Echo's tools (docs/design/echo-desk.md §5): the forward test's events and maps, read; and a map for an event the user
 * names, made. The numbers and the maps come from code (echo.service reads the engine's `echo_forward`; echoMap.service
 * maps a user event) — these formatters only lay them out so the model reads them as they were meant: a forward-test
 * map is the RECORD (frozen at the day-5 check, graded by the market), the running record is "so far" and never the
 * verdict, and a link's direction follows the event's move by rule, not the model's reading of the news.
 *
 * BOUND per turn to the user: their own events are theirs (`echo_user_events` by userId); the forward test is shared.
 */

import { makeToolHandler } from '../agentUtils.js'
import { toolError } from '../toolResult.util.js'
import { echoService, HORIZONS } from '../echo.service.js'
import { echoMapService } from '../echoMap.service.js'
import { echoReadsService, MAX_ASK } from '../echoReads.service.js'

const LOG = '[echo.tools]'

export const ECHO_TOOL_SPEC = {
    get_echo_events: `The FORWARD TEST's events (the engine's: earnings moves of 5%+ against SPY in the 152 largest US names, mapped by the model before their 5th session, checked at the day-5 close, graded at 20 / 60 / 120 sessions) with where each stands and its LAGGING links, the record so far, and the user's OWN events (maps they asked you for). Read it first when the user asks what Echo has found, or about an event that may already be here.`,
    get_event_map: `One event's whole map — every link with its relation, layer, direction (by rule), the model's own direction, why it is linked, and, for a forward-test event once checked, whether the market had caught up by day 5 and how the link did since (vs its own same-sector stand-ins). \`id\` is the event's id from get_echo_events (a forward-test id like "csco-earnings-2026-11-12", or a user event's "ue_…").`,
    request_reads: `Send names from one of the USER's OWN events (an id "ue_…") to the analyst and the technical analyst: the analyst's SWING coverage (researched for the house when there is none standing — a few minutes each) and the technical analyst's measured profile. \`tickers\`: the names the user picked from that map (at most ${MAX_ASK}); omit for its directional links (suppliers, infrastructure, substitutes). Only when the user asks. The forward test's lagging names go on their own after the day-5 check — never send those.`,
    map_event: `Map an event the USER names to the companies it reaches through the supply chain — anything: a product launch ("GTA 6 is out"), a guidance cut, a strike, a deal, a heatwave. FRAME it first, then call once: \`what_changed\` (one sentence: what happened), \`origin\` (the company the event happens to — or, when no single listed company is the event's, the DEMAND it moves, e.g. "European air-conditioning demand"), \`tickers\` (the origin's US tickers; empty for a demand), \`effect\` (up / down: what the event does to the origin's demand — ask the user once if it could go either way), \`date\` (YYYY-MM-DD it became public; omit for today), \`horizon\` (the user's, if they said one). One model call, about 40 seconds and a few cents; the map is saved to the user's events. Never for an event already in get_echo_events — read that map instead.`,
}

const pct = (x) => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${(Math.round(x * 1000) / 10).toFixed(1)}%` : '—')
const ownDirection = (note) => /model's direction (gains|loses|unclear)/.exec(note ?? '')?.[1] ?? '?'
const STATUS_WORDS = {
    detected: 'found, not mapped yet', mapped: 'mapped, waiting for its day-5 market check', late: 'reached after its day-5 close — not mapped, not graded',
    checked: 'checked at day 5, being graded', done: 'graded at every horizon',
}

/** The record so far, in words — never called the verdict. Pure. */
export function recordWords(record) {
    if (!record) return 'No record yet.'
    const parts = HORIZONS.filter(h => record[h]?.n).map(h => `${h} sessions: ${pct(record[h].mean)} mean over ${record[h].n} events, ${Math.round(record[h].positive * 100)}% positive`)
    return `${parts.length ? `So far — ${parts.join('; ')}.` : 'Nothing graded yet.'} This is NOT the verdict: the pre-declared rule reads ONCE, on the first ${record.verdictAt} events graded at 120 sessions (${record.gradedAt120} so far). Until then the test is unproven — say so whenever a forward-test name comes up.`
}

/** A forward-test event in one line plus its lagging links. Pure. */
export function eventLine(e) {
    const head = `${e.id} — ${e.date} · ${e.tickers?.join('/') || e.origin} ${e.effect === 'up' ? 'up' : 'down'} (${e.size ?? ''}) · ${STATUS_WORDS[e.status] ?? e.status} · ${e.links} links`
    const spreads = HORIZONS.filter(h => Number.isFinite(e.spread?.[h])).map(h => `${h}d ${pct(e.spread[h])}`)
    const lag = e.flagged?.length ? `\n   lagging at day 5: ${e.flagged.map(f => `${f.ticker} (${f.relation}, ${f.direction})`).join(', ')}` : ''
    return `${head}${spreads.length ? ` · lagging vs stand-ins ${spreads.join(', ')}` : ''}${lag}`
}

/** One link of a map, in one line. Pure. */
export function linkLine(l) {
    const own = ownDirection(l.note)
    const checked = l.group ? ` · day 5 ${l.group === 'flagged' ? 'LAGGING' : 'caught up'} (${pct(l.reaction)})${HORIZONS.filter(h => Number.isFinite(l.spread?.[h])).map(h => `, ${h}d ${pct(l.spread[h])} vs stand-ins`).join('')}` : ''
    return `- ${l.ticker ?? l.name} (${l.name}) — ${l.relation}, layer ${l.layer}, ${l.direction}${own !== l.direction ? ` (the model said ${own})` : ''}${checked}: ${l.why ?? l.evidence_text ?? ''}`
}

/** A whole map in words: the event, the rule, every link, what was dropped. Pure. */
export function mapWords({ id, event, map, kind }) {
    const ev = event ?? {}
    const way = ev.effect === 'up' ? 'up' : 'down'
    const links = map?.links ?? []
    const lines = [
        `${id} — ${kind === 'user' ? 'the user\'s event (not part of the forward test; no market check, no grades)' : 'forward-test event'}`,
        `Event (${ev.date}): ${ev.what_changed}. Origin: ${ev.origin}${ev.origin_tickers?.length ? ` (${ev.origin_tickers.join(', ')})` : ' — a demand, no single listed company'}; effect ${way}.`,
        `Direction by rule (the backtest's): suppliers and infrastructure move WITH the origin (${way === 'up' ? 'gain' : 'lose'}), substitutes against it, peers and customers unclear. The model's own reading is kept beside it.`,
        `Mapped by ${map?.model ?? '?'} (prompt ${map?.prompt_version ?? map?.promptVersion ?? '?'}) — ${links.length} links:`,
        ...links.map(linkLine),
    ]
    const dropped = map?.dropped ?? []
    if (dropped.length) lines.push(`Dropped (${dropped.length}): ${dropped.map(d => `${d.ticker || d.name || '?'} — ${d.reason}`).join('; ')}`)
    return lines.join('\n')
}

const READ_WORDS = {
    queued: 'queued for the analyst (swing coverage)', waiting: 'already in line for the analyst', ready: "the analyst's coverage stands — read it there",
    covered: 'the analyst covers it on another horizon', passed: 'the analyst researched it and passed', failed: "the analyst's last try failed — not asked again today",
    not_queued: 'could not be queued', unknown: "the analyst's read could not be checked",
}

/** echo.service's shaped event → mapWords' shape. */
const fromForward = (e) => ({ id: e.id, kind: 'forward', event: e.event, map: { ...(e.map ?? {}), links: e.all } })
/** A stored user event → mapWords' shape (its links have no check: `group` null). */
const fromUser = (d) => ({ id: d._id, kind: 'user', event: d.event, map: { ...d.map, links: (d.map?.links ?? []).map(l => ({ ...l, why: l.evidence_text, group: null })) } })

export function makeEchoHandlers({ userId = null, events = echoService, maps = echoMapService, reads = echoReadsService } = {}) {
    return {
        get_echo_events: makeToolHandler('get_echo_events', async () => {
            const { events: list, record } = await events.listEvents()
            const own = userId ? await maps.listUserEvents(userId) : []
            const parts = [
                `FORWARD TEST — ${list.length} events, newest first.`,
                recordWords(record),
                ...list.map(eventLine),
            ]
            parts.push(own.length
                ? `\nTHE USER'S OWN EVENTS (${own.length}):\n${own.map(d => `${d._id} — ${d.event.date} · ${d.event.what_changed} · ${d.map?.links?.length ?? 0} links`).join('\n')}`
                : '\nThe user has no events of their own yet.')
            return parts.join('\n')
        }, (err) => `Could not read Echo's events: ${err.message}`, LOG),

        get_event_map: makeToolHandler('get_event_map', async ({ id }) => {
            const key = String(id ?? '').trim()
            if (!key) return toolError('Give the event id from get_echo_events.')
            if (key.startsWith('ue_')) {
                const d = await maps.getUserEvent(key, userId)
                return d ? mapWords(fromUser(d)) : toolError(`No event ${key} among the user's events.`)
            }
            const e = await events.getEvent(key)
            return e ? mapWords(fromForward(e)) : toolError(`No forward-test event ${key} — read get_echo_events for the ids.`)
        }, (err, { id }) => `Could not read the map for ${id}: ${err.message}`, LOG),

        request_reads: makeToolHandler('request_reads', async ({ id, tickers } = {}) => {
            if (!userId) return toolError('There is no signed-in user.')
            const key = String(id ?? '').trim()
            if (!key.startsWith('ue_')) return toolError("Only the user's own events (ue_…): the forward test's lagging names go to the analyst on their own after the day-5 check.")
            const d = await maps.getUserEvent(key, userId)
            if (!d) return toolError(`No event ${key} among the user's events.`)
            const links = (d.map?.links ?? []).filter(l => l.ticker)
            const asked = (Array.isArray(tickers) ? tickers : []).map(t => String(t).toUpperCase().trim()).filter(Boolean)
            const picked = asked.length ? links.filter(l => asked.includes(l.ticker)) : links.filter(l => l.direction !== 'unclear')
            const missing = asked.filter(t => !links.some(l => l.ticker === t))
            if (missing.length) return toolError(`Not on this map: ${missing.join(', ')}.`)
            if (picked.length > MAX_ASK) return toolError(`${picked.length} names — at most ${MAX_ASK} at a time; ask the user which.`)
            if (!picked.length) return toolError('No directional links on this map — ask the user which names.')
            const by = new Map(picked.map(l => [l.ticker, l]))
            const ev = d.event
            const res = await reads.sendNames([...by.keys()], (s) => ({
                echo: true, forward: false, horizon: 'swing', event_id: d._id, user_event: true,
                event: `${ev.what_changed} (${ev.date})`, origin: ev.origin, relation: by.get(s).relation, direction: by.get(s).direction,
                why: by.get(s).evidence_text ?? null, reason: `The event analyst: ${by.get(s).relation} of ${ev.origin} (a user's event)`,
            }), { requestedBy: String(userId), maxUsd: Infinity })
            const lines = res.names.map(n => `- ${n.symbol}: ${READ_WORDS[n.read] ?? n.read}; the technical analyst's profile queued`)
            const run = res.research?.outcome === 'busy' ? '\nThe analyst is busy with another run — these wait in line.' : ''
            return `Sent on (swing):\n${lines.join('\n')}${run}\nThe reads land in the analyst's coverage and the technical analyst's profiles — the user finds them on the Hotlist and with the trader.`
        }, (err) => `Could not send the names on: ${err.message}`, LOG),

        map_event: makeToolHandler('map_event', async (args) => {
            if (!userId) return toolError('There is no signed-in user to save this event for.')
            const r = await maps.mapUserEvent(args, { userId })
            if (!r.ok) return toolError(r.reason)
            return mapWords(fromUser(r.doc))
        }, (err) => `Could not map the event: ${err.message}`, LOG),
    }
}
