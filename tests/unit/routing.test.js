import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildRouteRule, makeRouteCapture, mayRoute, routeFields, ROUTABLE_DESKS, ROUTE_TAGS } from '../../services/routing.util.js'
import { analystAgentService }   from '../../services/agents/analyst.agent.service.js'
import { mentorAgentService }    from '../../services/agents/mentor.agent.service.js'
import { portfolioAgentService } from '../../services/agents/portfolio.agent.service.js'
import { scannerAgentService }   from '../../services/agents/scanner.agent.service.js'
import { strategyAgentService }  from '../../services/agents/strategy.agent.service.js'

// Desk-to-desk routing — ONE mechanism for every agent. A user at any desk says "send NVDA to
// Prometheus" and the desk emits the grammar Axl has always spoken (`<route>` + `<open>`); the
// controller validates it with the same tier Axl's does; the client lands it on the same doorway.
// What this file guards: that each desk carries the rule, captures the tags, strips them from the
// reply and returns the fields — and that no desk lists its own door or an admin desk.

// ── the rule ─────────────────────────────────────────────────────────────────
test('the rule lists every routable desk but the sender\'s own', () => {
    const argus = buildRouteRule('scanner')
    assert.match(argus, /Sending the user to another role/)
    assert.match(argus, /\*\*the analyst\*\* \(`research`\)/)
    assert.match(argus, /\*\*the trader\*\* \(`assist`\)/)
    assert.match(argus, /\*\*the portfolio manager\*\* \(`portfolio`\)/)
    assert.doesNotMatch(argus, /\*\*the stock picker\*\* \(`scan`\)/, 'The stock picker offers its own door')

    const prometheus = buildRouteRule('analyst')
    assert.doesNotMatch(prometheus, /\*\*the analyst\*\* \(`research`\)/)
    // Argus takes the user only from Mentor since 2026-11-09 — see the routedFrom tests below.
    assert.doesNotMatch(prometheus, /\*\*the stock picker\*\* \(`scan`\)/)
    assert.match(buildRouteRule('mentor'), /\*\*the stock picker\*\* \(`scan`\)/)
})

test('the rule never offers an admin desk, and teaches the grammar and the ask-gate', () => {
    for (const agent of ['scanner', 'mentor', 'analyst', 'portfolio', 'strategy']) {
        const rule = buildRouteRule(agent)
        assert.doesNotMatch(rule, /`strategy`|`aether`|the industry strategist/, `${agent}'s rule offers an admin desk`)
        assert.match(rule, /<route>\w+ NVDA<\/route>/)
        assert.match(rule, /<open>/)
        // The opening is not optional. A bare route lands the user at a desk that cannot see this
        // chat, so it opens blank and asks for what they just said — see Axl's own routing section.
        assert.match(rule, /\*\*Always emit it\.\*\*/, `${agent}'s rule leaves the opening optional`)
        assert.match(rule, /Only when the user asked/)
        assert.match(rule, /never your own desk/)
    }
    assert.deepEqual(Object.keys(ROUTABLE_DESKS).sort(), ['assist', 'events', 'portfolio', 'research', 'scan'])
})

test('the rule is constant per agent — the cached spine stays byte-identical across turns', () => {
    assert.equal(buildRouteRule('mentor'), buildRouteRule('mentor'))
})

// ── the capture ──────────────────────────────────────────────────────────────
function drive(route, { open = null, edit = null, show = null } = {}) {
    const cap = makeRouteCapture()
    if (route != null) cap.captures.route(route)
    if (open  != null) cap.captures.open(open)
    if (edit  != null) cap.captures.edit(edit)
    if (show  != null) cap.captures.show(show)
    return cap.result()
}

test('capture: route + opening travel together; the opening is collapsed', () => {
    assert.deepEqual(drive(' research NVDA ', { open: 'Look at NVDA.\n  It is basing.' }),
        { route: 'research', routeSymbol: 'NVDA', opening: 'Look at NVDA. It is basing.', edit: null, show: null })
})

test('capture: a desk routing to ITSELF is dropped, opening and all', () => {
    const cap = makeRouteCapture('scanner')
    cap.captures.route('scan NVDA'); cap.captures.open('back to where you are')
    assert.deepEqual(cap.result(), { route: null, routeSymbol: null, opening: null, edit: null, show: null })
    // …and Axl, which stands at no desk, may route anywhere a desk is open to him (not Argus — Mentor's only).
    assert.equal(drive('research NVDA').route, 'research')
})

// ── Argus is Mentor's (2026-11-09) ───────────────────────────────────────────
// His list-building chat is archived; what is left is the single pick Mentor asks for. A desk with `routedFrom`
// takes the user only from the agents it names — gated in the capture, and left off every other sender's prompt.

test('mayRoute: only the trader may send the user to the stock picker; every open desk stays open to everyone', () => {
    assert.equal(mayRoute('mentor', 'scan'), true)
    for (const from of [null, undefined, 'axl', 'analyst', 'portfolio', 'strategy', 'scanner']) {
        assert.equal(mayRoute(from, 'scan'), false, `${from} must not route to the stock picker`)
    }
    for (const desk of ['research', 'assist', 'portfolio']) {
        assert.equal(mayRoute(null, desk), true, `Axl → ${desk}`)
        assert.equal(mayRoute('analyst', desk), true, `The analyst → ${desk}`)
    }
    // A desk that does not exist is not this gate's business — routeFor drops it.
    assert.equal(mayRoute(null, 'nowhere'), true)
})

test('capture: Axl naming the stock picker is dropped, opening and all; the trader naming the stock picker lands', () => {
    assert.deepEqual(drive('scan NVDA', { open: 'find me a swing long in semis' }), { route: null, routeSymbol: null, opening: null, edit: null, show: null })
    for (const agent of ['analyst', 'portfolio']) {
        const cap = makeRouteCapture(agent)
        cap.captures.route('scan'); cap.captures.open('find one')
        assert.equal(cap.result().route, null, `${agent} → the stock picker is dropped`)
    }
    const mentor = makeRouteCapture('mentor')
    mentor.captures.route('scan'); mentor.captures.open('A swing long in semis — they have no name.')
    assert.deepEqual(mentor.result(), { route: 'scan', routeSymbol: null, opening: 'A swing long in semis — they have no name.', edit: null, show: null })
    // Axl still routes everywhere else.
    for (const desk of ['assist', 'research', 'portfolio']) assert.equal(drive(`${desk} NVDA`).route, desk)
})

// ── Proteus is no desk (2026-11-21, docs/design/proteus-v2.md P1) ─────────────
// His measured profile is the house's technical read: Axl's get_company_view, Mentor's context. No route reaches him.

test('mayRoute: nobody routes to `technicals` any more — the desk is gone; Axl\'s old route is dropped', async () => {
    assert.equal(ROUTABLE_DESKS.technicals, undefined)
    // A desk still emitting the old tag goes nowhere: the controller tier (routeFor) drops a pipeline that does not exist.
    const { routeFor } = await import('../../services/routing.util.js')
    assert.equal(routeFor('trader', 'technicals'), null)
    assert.equal(routeFor('admin', 'technicals'), null)
    for (const desk of ['assist', 'research', 'portfolio']) {
        const c = makeRouteCapture('axl'); c.captures.route(`${desk} NVDA`)
        assert.equal(c.result().route, desk)
    }
    const c = makeRouteCapture('axl'); c.captures.route('scan')
    assert.equal(c.result().route, null)
})

test('no desk\'s rule offers the technical analyst', () => {
    for (const agent of ['analyst', 'mentor', 'portfolio', 'scanner', 'strategy', 'echo']) {
        assert.doesNotMatch(buildRouteRule(agent), /`technicals`|the technical analyst/, `${agent}'s rule offers the technical analyst`)
    }
})

test("Axl's prompt: how a stock trades is the measured profile in get_company_view — nobody to ask, no route", async () => {
    const { readFileSync } = await import('node:fs')
    const axl = readFileSync(new URL('../../prompts/axl_system_prompt.md', import.meta.url), 'utf8')
    assert.doesNotMatch(axl, /<route>technicals|technical_analyst/)
    assert.match(axl, /\*\*How a stock trades is not a specialist's\*\*/)
    assert.match(axl, /gives you material, not a reply/)
})

// ── Echo takes Axl's (2026-11-19) ────────────────────────────────────────────
// docs/design/echo-desk.md §5: "GTA 6 is out — who benefits?" goes from Axl to the event analyst. No other desk lists
// him, so their cached prompts did not change.

test('mayRoute: nobody sends the user to the event analyst — Axl ASKS him (modes-and-builders.md M2)', () => {
    for (const from of [null, undefined, 'axl', 'analyst', 'mentor', 'portfolio', 'scanner', 'strategy', 'echo']) {
        assert.equal(mayRoute(from, 'events'), false, `${from} must not route to the event analyst`)
    }
    const axl = makeRouteCapture('axl')
    axl.captures.route('events TTWO'); axl.captures.open('GTA 6 is out — who does it reach?')
    assert.equal(axl.result().route, null)
})

test("no desk's rule offers the event analyst, and his own offers the open desks but not the restricted ones", () => {
    for (const agent of ['analyst', 'mentor', 'portfolio', 'scanner', 'strategy', 'echo']) {
        assert.doesNotMatch(buildRouteRule(agent), /`events`/, `${agent}'s rule offers the event analyst`)
    }
    const echo = buildRouteRule('echo')
    for (const key of ['research', 'assist', 'portfolio']) assert.ok(echo.includes(`(\`${key}\`)`), key)
    for (const key of ['scan', 'technicals', 'strategy']) assert.ok(!echo.includes(`(\`${key}\`)`), key)
})

test("Axl's prompt ASKS the event analyst who an event reaches, naming every company (ANT, Roy 2026-11-19)", async () => {
    const { readFileSync } = await import('node:fs')
    const axl = readFileSync(new URL('../../prompts/axl_system_prompt.md', import.meta.url), 'utf8')
    assert.doesNotMatch(axl, /<route>events/)
    assert.match(axl, /\*\*Who a NEW event reaches through the supply chain\*\* → `specialist: "event_analyst"`/)
    assert.match(axl, /`\[\{"ticker": "ANT", "name": "Anthropic"\}\]`/)
    // 2026-11-21: events already mapped that reach one company come with get_company_view.
    assert.match(axl, /Events already\s+mapped that reach ONE company come with `get_company_view`/)
    assert.doesNotMatch(axl, /event-exposure|what's on the event list/, 'the deleted event board is not offered')
})

test('the rule offers the stock picker to the trader alone', () => {
    assert.match(buildRouteRule('mentor'), /\*\*the stock picker\*\* \(`scan`\)/)
    for (const agent of ['analyst', 'portfolio', 'scanner', 'strategy']) {
        assert.doesNotMatch(buildRouteRule(agent), /`scan`/, `${agent}'s rule offers the stock picker`)
    }
})

test("Axl's prompt teaches no route to the stock picker and no the stock picker list", async () => {
    const { readFileSync } = await import('node:fs')
    const axl = readFileSync(new URL('../../prompts/axl_system_prompt.md', import.meta.url), 'utf8')
    assert.doesNotMatch(axl, /<route>scan/)
    assert.doesNotMatch(axl, /<edit>scan/)
    assert.doesNotMatch(axl, /<show>watchlists/)
})

test('capture: no route → no opening; an edit → no opening either', () => {
    assert.deepEqual(drive(null, { open: 'orphan' }), { route: null, routeSymbol: null, opening: null, edit: null, show: null })
    const r = drive('research NVDA', { open: 'talks over the page', edit: 'coverage c1' })
    assert.equal(r.opening, null)
    assert.deepEqual(r.edit, { kind: 'coverage', ref: 'c1', desk: 'research' })
})

// ── the controller tier ──────────────────────────────────────────────────────
test('routeFields: validates the desk for the role, sanitizes the symbol, gates the opening on a desk', () => {
    const ok = routeFields({ route: 'research', routeSymbol: 'nvda', opening: 'Look at it.', edit: null }, 'trader')
    assert.deepEqual(ok, { route: 'research', routeSymbol: 'NVDA', edit: null, show: null, opening: 'Look at it.' })

    const junk = routeFields({ route: 'zeus', routeSymbol: 'NVDA', opening: 'Look at it.' }, 'admin')
    assert.deepEqual(junk, { route: null, routeSymbol: null, edit: null, show: null, opening: null })

    assert.equal(routeFields({ route: 'strategy' }, 'trader').route, null, 'a trader is never sent to the industry strategist')
    assert.equal(routeFields({ route: 'strategy' }, 'admin').route, 'strategy')

    // The OPENING travels to the admin desks for an admin, and is dropped with the route for a
    // trader: a sentence for Pythia must never survive the desk it was written for.
    // Aether, the other admin desk, went with the event board (2026-11-18): its key routes nowhere now.
    assert.equal(routeFields({ route: 'aether' }, 'admin').route, null)
    for (const desk of ['strategy']) {
        const admin = routeFields({ route: desk, opening: 'Change the Technology stance.' }, 'admin')
        assert.deepEqual([admin.route, admin.opening], [desk, 'Change the Technology stance.'])
        const trader = routeFields({ route: desk, opening: 'Change the Technology stance.' }, 'trader')
        assert.deepEqual([trader.route, trader.opening], [null, null])
    }
    assert.equal(routeFields({ route: 'research', routeSymbol: 'Nvidia Corp' }, 'trader').routeSymbol, null)
    assert.equal(routeFields(null, 'trader').route, null)
})

// ── every desk ───────────────────────────────────────────────────────────────
// Each agent supplies its minimal valid input; the assertions are shared. A new agent joins by
// adding one row.
const DESKS = [
    { key: 'scanner',   own: 'scan',      chatStream: scannerAgentService.chatStream,   args: { messages: [{ role: 'user', content: 'send nvda to prometheus' }] } },
    { key: 'mentor',    own: 'assist',    chatStream: mentorAgentService.chatStream,    args: { messages: [{ role: 'user', content: 'send nvda to prometheus' }] } },
    { key: 'analyst',   own: 'research',  chatStream: analystAgentService.chatStream,   args: { messages: [{ role: 'user', content: 'send nvda to mentor' }] } },
    { key: 'portfolio', own: 'portfolio', chatStream: portfolioAgentService.chatStream, args: { messages: [{ role: 'user', content: 'send nvda to prometheus' }] } },
    { key: 'strategy',  own: null,        chatStream: strategyAgentService.chatStream,  args: { messages: [{ role: 'user', content: 'send nvda to prometheus' }] } },
]

// Prometheus is the destination for everyone but Prometheus, who sends to Mentor — a desk's own
// door is dropped by the capture (tested above), so its row has to route somewhere else.
const reply = (to) => `Sending NVDA to the ${to} desk — it reads as a long-term hold, not a trade.\n<route>${to} NVDA</route>\n<open>Look at NVDA — the user wants to know if it is worth owning. Basing under 250.</open>`

// Stand in for runAgentStream: play the captured tags the way the provider would, hand back the raw.
function seam(reply) {
    const seen = {}
    return {
        seen,
        _run: async (bag) => {
            Object.assign(seen, bag)
            for (const name of ROUTE_TAGS) {
                const m = reply.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
                const cap = bag.tagCaptures?.find(t => t.open === `<${name}>`)
                if (m && cap?.onCapture) cap.onCapture(m[1])
            }
            return reply
        },
    }
}

for (const { key, own, chatStream, args } of DESKS) {
    test(`${key}: carries the rule in its cached spine, with its own door left off`, async () => {
        const { seen, _run } = seam('ok')
        await chatStream({ ...args, _run })
        const spine = seen.systemPrompt[0]
        assert.equal(spine.cache_control?.type, 'ephemeral', 'the rule must ride the cached block, not a new breakpoint')
        assert.match(spine.text, /Sending the user to another role/)
        if (own) assert.doesNotMatch(spine.text, new RegExp(`\\(\`${own}\`\\)`), `${key} lists its own desk`)
    })

    test(`${key}: a routing turn returns the fields and strips the tags from the reply`, async () => {
        const to = own === 'research' ? 'assist' : 'research'
        const { _run } = seam(reply(to))
        const result = await chatStream({ ...args, _run })
        assert.equal(result.route, to)
        assert.equal(result.routeSymbol, 'NVDA')
        assert.match(result.opening, /^Look at NVDA/)
        assert.equal(result.edit, null)
        assert.doesNotMatch(result.reply, /<route>|<open>|Look at NVDA/)
        assert.match(result.reply, /^Sending NVDA to the \w+ desk/)
    })

    test(`${key}: a plain turn routes nowhere`, async () => {
        const { _run } = seam('Here is the read.')
        const result = await chatStream({ ...args, _run })
        assert.equal(result.route, null)
        assert.equal(result.opening, null)
    })
}

test('back to reception: every main-chat desk may hand a question to Axl; Axl, the admin desks and no sender may not (Roy, 2026-11-13)', async () => {
    const { RECEPTION_RULE } = await import('../../services/routing.util.js')
    const { entryOf } = await import('../../services/desks/registry.js')
    assert.deepEqual(entryOf('reception'), { agent: 'axl', state: null })
    for (const from of ['analyst', 'mentor', 'portfolio', 'scanner']) {
        assert.equal(mayRoute(from, 'reception'), true, from)
        assert.ok(buildRouteRule(from).endsWith(RECEPTION_RULE), `${from}'s prompt carries the hand-back`)
    }
    for (const from of ['axl', 'strategy', null, 'nobody']) assert.equal(mayRoute(from, 'reception'), false, String(from))
    for (const from of ['strategy']) assert.ok(!buildRouteRule(from).includes(RECEPTION_RULE), `${from} talks where Axl does not`)
    // The capture holds it: Axl naming reception routes nowhere; the analyst naming it routes.
    const axl = makeRouteCapture('axl'); axl.captures.route('reception'); assert.equal(axl.result().route, null)
    const pr = makeRouteCapture('analyst'); pr.captures.route('reception'); pr.captures.open('is it a good business?')
    assert.deepEqual({ route: pr.result().route, opening: pr.result().opening }, { route: 'reception', opening: 'is it a good business?' })
    assert.equal(routeFields({ route: 'reception', opening: 'q' }, 'trader').route, 'reception', 'a trader may be handed back')
})

test('an opening reads as plain words: a desk\'s <ticker> markup is unwrapped, the name kept (2026-11-13)', async () => {
    const { cleanOpening } = await import('../../services/routing.util.js')
    assert.equal(cleanOpening('is <ticker>NVDA</ticker> a good business vs <TICKER> amd </TICKER>?'), 'is NVDA a good business vs amd?')
})

test('the opening stands alone: a ticker carries its company (Roy 2026-11-19: a bare "ANT" read as Ant Group)', () => {
    for (const key of ['axl', 'echo', 'mentor']) {
        const rule = buildRouteRule(key)
        if (!rule) continue
        assert.match(rule, /Write it so it stands alone/, key)
        assert.match(rule, /the ANT \(Anthropic\) IPO/, key)
    }
})
