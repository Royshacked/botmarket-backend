import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildRouteRule, makeRouteCapture, routeFields, ROUTABLE_DESKS, ROUTE_TAGS } from '../../services/routing.util.js'
import { analystAgentService }   from '../../services/agents/analyst.agent.service.js'
import { aetherAgentService }    from '../../services/agents/aether.agent.service.js'
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
    assert.match(argus, /Sending the user to another desk/)
    assert.match(argus, /\*\*Prometheus\*\* \(`research`\)/)
    assert.match(argus, /\*\*Mentor\*\* \(`assist`\)/)
    assert.match(argus, /\*\*Atlas\*\* \(`portfolio`\)/)
    assert.doesNotMatch(argus, /\*\*Argus\*\* \(`scan`\)/, 'Argus offers its own door')

    const prometheus = buildRouteRule('analyst')
    assert.doesNotMatch(prometheus, /\*\*Prometheus\*\* \(`research`\)/)
    assert.match(prometheus, /\*\*Argus\*\* \(`scan`\)/)
})

test('the rule never offers an admin desk, and teaches the grammar and the ask-gate', () => {
    for (const agent of ['scanner', 'mentor', 'analyst', 'portfolio', 'strategy', 'aether']) {
        const rule = buildRouteRule(agent)
        assert.doesNotMatch(rule, /`strategy`|`aether`|Pythia/, `${agent}'s rule offers an admin desk`)
        assert.match(rule, /<route>\w+ NVDA<\/route>/)
        assert.match(rule, /<open>/)
        assert.match(rule, /Only when the user asked/)
        assert.match(rule, /never your own desk/)
    }
    assert.deepEqual(Object.keys(ROUTABLE_DESKS).sort(), ['assist', 'portfolio', 'research', 'scan'])
})

test('the rule is constant per agent — the cached spine stays byte-identical across turns', () => {
    assert.equal(buildRouteRule('mentor'), buildRouteRule('mentor'))
})

// ── the capture ──────────────────────────────────────────────────────────────
function drive(route, { open = null, edit = null } = {}) {
    const cap = makeRouteCapture()
    if (route != null) cap.captures.route(route)
    if (open  != null) cap.captures.open(open)
    if (edit  != null) cap.captures.edit(edit)
    return cap.result()
}

test('capture: route + opening travel together; the opening is collapsed', () => {
    assert.deepEqual(drive(' research NVDA ', { open: 'Look at NVDA.\n  It is basing.' }),
        { route: 'research', routeSymbol: 'NVDA', opening: 'Look at NVDA. It is basing.', edit: null })
})

test('capture: a desk routing to ITSELF is dropped, opening and all', () => {
    const cap = makeRouteCapture('scanner')
    cap.captures.route('scan NVDA'); cap.captures.open('back to where you are')
    assert.deepEqual(cap.result(), { route: null, routeSymbol: null, opening: null, edit: null })
    // …and Axl, which stands at no desk, may route anywhere.
    assert.equal(drive('scan NVDA').route, 'scan')
})

test('capture: no route → no opening; an edit → no opening either', () => {
    assert.deepEqual(drive(null, { open: 'orphan' }), { route: null, routeSymbol: null, opening: null, edit: null })
    const r = drive('research NVDA', { open: 'talks over the page', edit: 'coverage c1' })
    assert.equal(r.opening, null)
    assert.deepEqual(r.edit, { kind: 'coverage', ref: 'c1', desk: 'research' })
})

// ── the controller tier ──────────────────────────────────────────────────────
test('routeFields: validates the desk for the role, sanitizes the symbol, gates the opening on a desk', () => {
    const ok = routeFields({ route: 'research', routeSymbol: 'nvda', opening: 'Look at it.', edit: null }, 'trader')
    assert.deepEqual(ok, { route: 'research', routeSymbol: 'NVDA', edit: null, opening: 'Look at it.' })

    const junk = routeFields({ route: 'kairos', routeSymbol: 'NVDA', opening: 'Look at it.' }, 'admin')
    assert.deepEqual(junk, { route: null, routeSymbol: null, edit: null, opening: null })

    assert.equal(routeFields({ route: 'strategy' }, 'trader').route, null, 'a trader is never sent to Pythia')
    assert.equal(routeFields({ route: 'strategy' }, 'admin').route, 'strategy')

    // The OPENING travels to the admin desks for an admin, and is dropped with the route for a
    // trader: a sentence for Pythia or Aether must never survive the desk it was written for.
    for (const desk of ['strategy', 'aether']) {
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
    { key: 'mentor',    own: 'assist',    chatStream: mentorAgentService.chatStream,    args: { userPrompt: 'send nvda to prometheus' } },
    { key: 'analyst',   own: 'research',  chatStream: analystAgentService.chatStream,   args: { userPrompt: 'send nvda to mentor' } },
    { key: 'portfolio', own: 'portfolio', chatStream: portfolioAgentService.chatStream, args: { messages: [{ role: 'user', content: 'send nvda to prometheus' }] } },
    { key: 'strategy',  own: null,        chatStream: strategyAgentService.chatStream,  args: { messages: [{ role: 'user', content: 'send nvda to prometheus' }], userPrompt: 'send nvda to prometheus' } },
    { key: 'aether',    own: null,        chatStream: aetherAgentService.chatStream,    args: { messages: [{ role: 'user', content: 'send nvda to prometheus' }] } },
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
        assert.match(spine.text, /Sending the user to another desk/)
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
