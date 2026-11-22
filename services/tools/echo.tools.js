/**
 * Echo's tools (docs/design/echo-pipeline.md, "The app") — the event analyst's view of the pipeline built to the
 * simulator doc. Code makes every number (the map, the six scores, the market check, the flags, the grades); these
 * formatters lay them out so the model reads them as meant: links RANKED BY SCORE (high at 8 of 12), each factor with its
 * reason and its evidence (a 10-K's stated share, the company's own supply sentences), the doc's three flags, and the
 * validation record as RUNNING — never a verdict until walk-forward has its events.
 *
 * BOUND per turn to the user: their own events are theirs; the house's are everyone's.
 */

import { makeToolHandler } from '../agentUtils.js'
import { toolError } from '../toolResult.util.js'
import { echoService } from '../echo.service.js'
import { echoEventsService, TYPES, DURABILITIES } from '../echoEvents.service.js'
import { echoPipelineService } from '../echoPipeline.service.js'
import { echoReadsService, MAX_ASK, MAX_USER_WEEK } from '../echoReads.service.js'
import { judge } from '../echoIntake.service.js'
import { echoMapJobs } from '../echoMapJobs.service.js'

const LOG = '[echo.tools]'
const FLAG_WORDS = { underreacted_winner: 'UNDERREACTED WINNER', overreacted_loser: 'OVERREACTED LOSER', fully_priced: 'fully priced' }
const STATUS_WORDS = {
    framed: 'recorded, not mapped yet', mapped: 'mapped, not scored yet', scored: 'scored, waiting for its day-5 market check',
    watching: 'checked at day 5, under the wave watch', expired: 'expired',
}

export const ECHO_TOOL_SPEC = {
    get_echo_events: `Echo's events — the house's (the intake reads earnings moves, 8-K deals, policy, defense awards, trials and news, and keeps what passes the filter: a surprise, large, more than a one-off) and the user's own — each with where it stands, its top-scored names and its flags; and the validation record so far. Read it first when the user asks what Echo has found, or about an event that may already be here.`,
    get_event_map: `One event whole — the record (type, what changed, size, durability and why), then every link RANKED BY SCORE: relation, layer, direction and why; the six factors (lock-in, supply response, bottleneck, directness, exposure, coverage, 0–2 each, high at 8 of 12) with their reasons; the filing evidence (named in filings, a 10-K's stated share, the company's own supply sentences); the day-5 market check and the flag (underreacted winner, overreacted loser, fully priced); the grades since. \`id\` is "ev_…" from get_echo_events.`,
    request_reads: `Send names from one of the USER's OWN events (an id "ev_…" they mapped) to the analyst and the technical analyst: the analyst's SWING coverage (researched for the house when there is none standing — a few minutes each) and the technical analyst's measured profile. \`tickers\`: the names the user picked from that map (at most ${MAX_ASK} at a time, ${MAX_USER_WEEK} a week); omit for its top-scored directional links. Only when the user asks. The house's flagged names go on their own after the day-5 check — never send those.`,
    map_event: `Map an event the USER names through Echo's whole pipeline — the chain (layers 1–3 both ways, losers and substitutes, every link checked against SEC filings) and the six-factor score on every link. Anything: a launch ("GTA 6 is out"), a guidance cut, a rule, a strike, a deal, a war. FRAME it first, then call once: \`what_changed\` (one sentence: the news, not a stock's move), \`origin\` (the company or country it hits directly, or the demand it moves), \`tickers\` (the origin's US tickers; empty for a country or a demand), \`effect\` (up / down / mixed: what it does to demand AT THE ORIGIN — ask the user once if unsure), \`type\` (${TYPES.join(', ')}), \`durability\` ({kind: ${DURABILITIES.join(' / ')}, why} — a locked-in commitment lasts, a price spike cures itself), \`date\` (YYYY-MM-DD it became public; omit for today), \`size\` (as a sentence, if known), \`terms\` (what other companies' filings call the origin). Echo first JUDGES it by the intake's own filter (a surprise, large, more than a one-off): an event becomes the house's, watched and graded like any (or the house's own, when the intake already has it); otherwise it stays the user's — mapped, scored and checked at day 5, no watch. Say which. Takes two to three minutes and well under a dollar — in a chat it runs in the BACKGROUND: the call returns at once, and you get a turn of your own to tell the user what the map found when it is done. Never for an event already in get_echo_events — read that one instead. NEVER for a what-if ("what happens if China attacks Taiwan?") on your own: it has not happened — answer it from reasoning and offer to map it; only when the user says yes, call with \`hypothetical: true\` (never the house's, no day-5 check).`,
}

const pct = (x) => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${(Math.round(x * 1000) / 10).toFixed(1)}%` : '—')

/** The validation record in words — always "so far", never the verdict. Pure. */
export function recordWords(report) {
    if (!report || !report.events) return 'Validation: no event graded yet. Until there are, nothing Echo flags is proven — say so whenever a flagged name comes up.'
    const parts = [20, 60, 120].filter(h => report.horizons?.[h]?.vsStandIns?.n).map(h => {
        const v = report.horizons[h].vsStandIns
        return `${h} sessions: flagged names ${pct(v.mean)} against their same-sector stand-ins (median ${pct(v.median)}, ${v.n} events)`
    })
    return `Validation so far — ${parts.length ? parts.join('; ') : 'nothing graded past 5 sessions yet'}. ${report.walkForward?.note ?? ''} This is NOT a verdict: until walk-forward has its events the method is unproven — say so whenever a flagged name comes up.`
}

/** An event in one line plus its top names and flags. Pure. */
export function eventLine(e) {
    const who = `${e.origin}${e.tickers?.length ? ` (${e.tickers.join('/')})` : ''}`
    const head = `${e.id}${e.mine ? ' [the user\'s]' : ''}${e.hypothetical ? ' [A WHAT-IF — it has not happened]' : ''} — ${e.date} · ${String(e.type).replace('_', ' ')} · ${who} demand ${e.effect} · ${String(e.durability ?? '').replace(/_/g, ' ')} · ${STATUS_WORDS[e.status] ?? e.status}${e.expiredBecause ? ` (${e.expiredBecause})` : ''}`
    const lines = [head, `   ${e.whatChanged}`]
    if (e.top?.length) lines.push(`   top scores: ${e.top.map(t => `${t.ticker} ${t.total}/12`).join(', ')} · ${e.high} high · ${e.links} links`)
    if (e.flagged?.length) lines.push(`   flagged at day 5: ${e.flagged.map(f => `${f.ticker} (${FLAG_WORDS[f.flag]}, ${f.total}/12)`).join(', ')}`)
    if (e.followUpOf) lines.push(`   a follow-up of ${e.followUpOf}`)
    if (e.error) lines.push(`   stopped: ${e.error}`)
    return lines.join('\n')
}

const F = (f, label, extra = '') => (f ? `${label} ${f.score}${extra}` : `${label} ?`)
/** One link in words: its line, its score and factors, its evidence, its check. `full` adds each factor's reason. Pure. */
export function linkWords(l, full = false) {
    const f = l.factors
    const head = `- ${l.ticker} (${l.name}) — ${l.relation}, layer ${l.layer}, ${l.direction}: ${l.why}`
    const lines = [head]
    if (f) {
        lines.push(`  score ${l.total}/12${l.high ? ' HIGH' : ''}: ${[F(f.lockIn, 'lock-in'), F(f.supplyResponse, 'supply response'), F(f.bottleneck, 'bottleneck', ` (${f.bottleneck?.evidence})`),
            F(f.directness, 'directness'), F(f.exposure, 'exposure', ` (${f.exposure?.source})`), F(f.coverage, 'coverage', ` (${f.coverage?.why})`)].join(' · ')}`)
        if (full) {
            for (const [k, label] of [['lockIn', 'lock-in'], ['supplyResponse', 'supply response'], ['bottleneck', 'bottleneck'], ['directness', 'directness'], ['exposure', 'exposure']]) {
                if (f[k]?.why) lines.push(`    ${label}: ${f[k].why}${k === 'bottleneck' && f[k].quote ? ` — "${f[k].quote}"` : ''}`)
            }
        }
    }
    const fl = l.filings
    if (fl) {
        const where = [fl.share?.form, fl.share?.date].filter(Boolean).join(' ')
        const named = fl.namedBy?.length ? ` (${fl.namedBy.join(', ')})` : ''
        lines.push(`  filings: ${fl.share ? `${fl.share.atLeast ? 'over ' : ''}${pct(fl.share.share).replace('+', '')} of its revenue tied to the origin${where ? ` (${where})` : ''}` : fl.named === true ? `named${named}` : fl.named === false ? 'not named in either company\'s filings' : 'not read'}`)
    }
    if (l.ledger?.conflicted) lines.push(`  CONFLICTED: other events pull it the other way (${l.ledger.events.map(e => e.origin).join(', ')}) — a weak trade`)
    if (l.check) lines.push(`  day 5: ${pct(l.check.signedMove)} its way vs SPY · volume ${l.check.volume?.day5 ? `${l.check.volume.day5.toFixed(1)}× its 20-day average` : '—'} · analyst actions since ${l.check.analysts?.count ?? '?'}${l.flag ? ` · ${FLAG_WORDS[l.flag]}: ${l.flagWhy}` : ''}`)
    const g = Object.entries(l.grades ?? {}).filter(([, v]) => Number.isFinite(v))
    if (g.length) lines.push(`  since the day-5 close (its way, vs SPY): ${g.map(([h, v]) => `${h}d ${pct(v)}`).join(', ')}`)
    return lines.join('\n')
}

/** A whole event in words: the record, the map and score, the links by score. Pure. */
export function mapWords(e, { reasonsFor = 8 } = {}) {
    const ev = e.event
    const lines = [
        `${e.id}${e.hypothetical ? ' — the user\'s WHAT-IF (it has not happened: a scenario, never checked against the market)' : e.mine ? ' — the user\'s event' : ' — the house\'s event'} (${STATUS_WORDS[e.status] ?? e.status})`,
        `Event (${ev.date}, ${String(ev.type).replace('_', ' ')}): ${ev.whatChanged}. Origin: ${ev.origin}${ev.tickers.length ? ` (${ev.tickers.join(', ')})` : ''}; demand at the origin ${ev.effect}.${ev.size ? ` Size: ${ev.size}.` : ''}`,
        `Durability: ${String(ev.durability?.kind).replace(/_/g, ' ')}${ev.durability?.why ? ` — ${ev.durability.why}` : ''}.${ev.filter?.why ? ` Why it is an event: ${ev.filter.why}` : ''}`,
    ]
    if (e.checked) lines.push(`Market check (day 5 = ${e.checked.checkDay}): layer 1 moved ${pct(e.checked.yardstick?.median)} in its direction (${e.checked.yardstick?.from ?? '—'}). Options volatility not measured.`)
    else if (e.waiting) lines.push(`Market check: ${e.waiting}.`)
    if (e.triggers?.length) lines.push(`Wave watch — ${e.triggers.length} trigger(s): ${e.triggers.slice(-3).map(t => `${t.date ?? ''} ${t.what}`).join('; ')}`)
    // Not mapped yet is not "no links" (Roy, 2026-11-19: the analyst said an unmapped event "returned zero links").
    if (!e.map) {
        lines.push(`NOT MAPPED YET — the event is recorded; its chain is mapped and scored when the pipeline next runs${e.error ? ` (the last try stopped: ${e.error})` : ''}. There are no links to read yet — say so; never "zero links" or "nothing found".`)
        return lines.join('\n')
    }
    lines.push(`${e.links.length} links, ranked (flags first, then score; high at 8 of 12):`)
    e.links.forEach((l, i) => lines.push(linkWords(l, i < reasonsFor)))
    if (e.map?.dropped?.length) lines.push(`Dropped (${e.map.dropped.length}): ${e.map.dropped.map(d => `${d.ticker || d.name || '?'} — ${d.reason}`).join('; ')}`)
    return lines.join('\n')
}

const LABEL_MAX = 70

/** The event as the chat's status line names it — short, in quotes; a long framing is cut at a word. Exported for tests. */
export function mapLabel(whatChanged) {
    const s = String(whatChanged ?? '').trim().replace(/\.$/, '')
    if (!s) return 'the event'
    if (s.length <= LABEL_MAX) return `"${s}"`
    const cut = s.slice(0, LABEL_MAX)
    return `"${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : LABEL_MAX).replace(/[,;:\s]+$/, '')}…"`
}

const READ_WORDS = {
    queued: 'queued for the analyst (swing coverage)', waiting: 'already in line for the analyst', ready: "the analyst's coverage stands — read it there",
    covered: 'the analyst covers it on another horizon', passed: 'the analyst researched it and passed', failed: "the analyst's last try failed — not asked again today",
    not_queued: 'could not be queued', unknown: "the analyst's read could not be checked",
}

export function makeEchoHandlers({ userId = null, sessionId = null, read = echoService, events = echoEventsService, pipeline = echoPipelineService, reads = echoReadsService, judged = judge, jobs = echoMapJobs } = {}) {
    return {
        get_echo_events: makeToolHandler('get_echo_events', async () => {
            const { events: list, report } = await read.listEvents(userId)
            if (!list.length) return `No events yet — the intake reads its sources every three hours.\n${recordWords(report)}`
            return [`ECHO — ${list.length} events, newest first.`, recordWords(report), ...list.map(eventLine)].join('\n')
        }, (err) => `Could not read Echo's events: ${err.message}`, LOG),

        get_event_map: makeToolHandler('get_event_map', async ({ id }) => {
            const key = String(id ?? '').trim()
            if (!key) return toolError('Give the event id from get_echo_events.')
            const e = await read.getEvent(key, userId)
            return e ? mapWords(e) : toolError(`No event ${key} — read get_echo_events for the ids.`)
        }, (err, { id }) => `Could not read the map for ${id}: ${err.message}`, LOG),

        request_reads: makeToolHandler('request_reads', async ({ id, tickers } = {}) => {
            if (!userId) return toolError('There is no signed-in user.')
            const e = await read.getEvent(String(id ?? '').trim(), userId)
            if (!e) return toolError(`No event ${id} among the user's events.`)
            if (e.kind !== 'user') return toolError("Only the user's own events: the house's flagged names go to the analyst on their own after the day-5 check.")
            const links = e.links.filter(l => l.ticker)
            const asked = (Array.isArray(tickers) ? tickers : []).map(t => String(t).toUpperCase().trim()).filter(Boolean)
            const missing = asked.filter(t => !links.some(l => l.ticker === t))
            if (missing.length) return toolError(`Not on this map: ${missing.join(', ')}.`)
            const picked = asked.length ? links.filter(l => asked.includes(l.ticker)) : links.filter(l => l.direction !== 'unclear').slice(0, MAX_ASK)
            if (picked.length > MAX_ASK) return toolError(`${picked.length} names — at most ${MAX_ASK} at a time; ask the user which.`)
            if (!picked.length) return toolError('No directional links on this map — ask the user which names.')
            const used = await reads.userAskedThisWeek(userId)
            if (used === null) return toolError('The research queue could not be read just now — try again in a minute.')
            if (used + picked.length > MAX_USER_WEEK) {
                const left = Math.max(0, MAX_USER_WEEK - used)
                return toolError(`The user has sent ${used} names for research this week; the limit is ${MAX_USER_WEEK}${left ? ` — ${left} more, so ask which` : ' — tell them it opens again within the week'}.`)
            }
            const by = new Map(picked.map(l => [l.ticker, l]))
            const ev = e.event
            const res = await reads.sendNames([...by.keys()], (s) => ({
                echo: true, forward: false, horizon: 'swing', event_id: e.id, user_event: true,
                event: `${ev.whatChanged} (${ev.date})`, origin: ev.origin, relation: by.get(s).relation, direction: by.get(s).direction,
                why: by.get(s).why ?? null, reason: `The event analyst: ${by.get(s).relation} of ${ev.origin} (a user's event)`,
            }), { requestedBy: String(userId), maxUsd: Infinity })
            const lines = res.names.map(n => `- ${n.symbol}: ${READ_WORDS[n.read] ?? n.read}; the technical analyst's profile queued`)
            const run = res.research?.outcome === 'busy' ? '\nThe analyst is busy with another run — these wait in line.' : ''
            return `Sent on (swing):\n${lines.join('\n')}${run}\nThe reads land in the analyst's coverage and the technical analyst's profiles — the user finds them on the Hotlist and with the trader.`
        }, (err) => `Could not send the names on: ${err.message}`, LOG),

        // Roy, 2026-11-19: "Echo decides if the user's event is worth it — if it is, it treats it as a regular event". The
        // intake's own triage judges it by the doc's filter: an EVENT becomes the house's (in the triage's words — never
        // the user's text in the house's prompts), watched and graded like any; the house's existing one is used when the
        // intake already has it. Otherwise it stays the user's: mapped, scored, checked at day 5, and no further.
        map_event: makeToolHandler('map_event', async (args = {}) => {
            if (!userId) return toolError('There is no signed-in user to save this event for.')
            const f = events.frame({ ...args, filter: { surprise: null, large: null, lasting: null, why: 'named by the user' } })
            if (!f.ok) return toolError(f.reason)
            let doc, judgedLine
            // A WHAT-IF (Roy, 2026-11-22) — mapped only because the user said yes to it. It has not happened, so the house's
            // filter never sees it (it would be no event of the house's) and the pipeline stops it before a day-5 check.
            const hypothetical = args.hypothetical === true || args.hypothetical === 'true'
            const verdict = hypothetical ? null : await judged(f.event, { userId })
            if (hypothetical) {
                doc = await events.create({ ...f.event, hypothetical: true, filter: { surprise: null, large: null, lasting: null, why: 'a what-if the user asked to have mapped — it has not happened' } }, { userId, source: 'chat' })
                judgedLine = 'A WHAT-IF, the user\'s alone: it has not happened, so it is never the house\'s and has no day-5 market check — the map is a scenario, not a reading of the market. Say so.'
            } else if (verdict.event) {
                const same = await events.findSame(verdict.framed).catch(() => null)
                doc = same ?? await events.create(verdict.framed, { source: 'chat', askedBy: userId })
                judgedLine = same
                    ? `Echo already had this event (${same._id}) — it is the house's, watched and graded; read below.`
                    : 'Echo judged it an EVENT (a surprise, large, more than a one-off): it is now the house\'s — watched after its day-5 check and graded like any.'
            } else {
                doc = await events.create({ ...f.event, filter: { surprise: false, large: false, lasting: false, why: verdict.reason } }, { userId, source: 'chat' })
                judgedLine = `Echo did not take it as a house event (${verdict.reason}): it is the user's — mapped and scored, checked at its 5th session, then no watch.`
            }
            // In a chat, the map runs in the BACKGROUND (modes-and-builders.md step 2): the chat stays free, and the event
            // analyst comes back with the map when it is done.
            if (doc.status === 'framed' && sessionId) {
                jobs.start({ userId, sessionId, doc, label: mapLabel(doc.whatChanged ?? f.event.whatChanged) })
                return `${judgedLine}\nMAPPING STARTED (${doc._id}) — two to three minutes, in the background. Tell the user in one or two ` +
                    'lines: which it is (the house\'s or theirs, and why), that it is being mapped and scored now, and that the map comes ' +
                    'here when it is done — they can keep talking meanwhile. Say nothing about its links: there are none yet.'
            }
            const r = doc.status === 'framed' ? await pipeline.run(doc) : { status: doc.status }
            const e = await read.getEvent(doc._id, userId)
            if (!e) return toolError('The event was saved but could not be read back — try get_echo_events.')
            const note = r.stoppedAt && !r.wait ? `\nStopped at ${r.stoppedAt}: ${r.reason}` : ''
            return `${judgedLine}\n${mapWords(e)}${note}`
        }, (err) => `Could not map the event: ${err.message}`, LOG),
    }
}
