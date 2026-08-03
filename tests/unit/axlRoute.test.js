import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { _splitRoute, _splitEdit, EDIT_KIND_DESKS, axlAgentService } from '../../services/axl.agent.service.js'
import { _sanitizeRouteSymbol, _sanitizeEditRef, _validateEdit, VALID_PIPELINES, EDIT_KINDS } from '../../api/axl/axl.controller.js'

// Axl's desk hand-off: `<route>research NVDA</route>` — the desk AND the name it should open on.
// The symbol is what turns "routing you to Prometheus" into Prometheus already researching NVDA,
// so it is parsed here and sanitized in the controller: it becomes an agent's opening turn.

// ── the tag split (service) ───────────────────────────────────────────────────

test('split: desk + symbol', () => {
    assert.deepEqual(_splitRoute('research NVDA'), { desk: 'research', symbol: 'NVDA' })
})

test('split: a bare desk (a scan, a whole portfolio) → no symbol', () => {
    assert.deepEqual(_splitRoute('scan'), { desk: 'scan', symbol: null })
})

test('split: tolerant separators + a capitalized desk', () => {
    assert.deepEqual(_splitRoute('Research:NVDA'), { desk: 'research', symbol: 'NVDA' })
    assert.deepEqual(_splitRoute(' trade,  TSLA '), { desk: 'trade', symbol: 'TSLA' })
})

test('split: extra words past the symbol are ignored, not concatenated', () => {
    assert.deepEqual(_splitRoute('research NVDA for coverage'), { desk: 'research', symbol: 'NVDA' })
})

test('split: no tag at all → nothing to route', () => {
    assert.deepEqual(_splitRoute(null), { desk: null, symbol: null })
    assert.deepEqual(_splitRoute(''), { desk: null, symbol: null })
})

// ── the symbol gate (controller) ──────────────────────────────────────────────

test('sanitize: uppercases, and passes dotted/dashed tickers', () => {
    assert.equal(_sanitizeRouteSymbol('nvda'), 'NVDA')
    assert.equal(_sanitizeRouteSymbol(' brk.b '), 'BRK.B')
    assert.equal(_sanitizeRouteSymbol('BTC-USD'), 'BTC-USD')
})

test('sanitize: junk the model may have attached → null (the desk opens empty)', () => {
    assert.equal(_sanitizeRouteSymbol('the'), 'THE')          // 3 letters IS a plausible ticker — passes by design
    assert.equal(_sanitizeRouteSymbol('Nvidia Corp'), null)   // a space is never a symbol
    assert.equal(_sanitizeRouteSymbol('$NVDA'), null)         // decorated
    assert.equal(_sanitizeRouteSymbol('NASDAQ:NVDA'), null)   // exchange-prefixed
    assert.equal(_sanitizeRouteSymbol('ABCDEFGHIJKLMNOP'), null)
    assert.equal(_sanitizeRouteSymbol(''), null)
    assert.equal(_sanitizeRouteSymbol(null), null)
    assert.equal(_sanitizeRouteSymbol(42), null)
})

// ── the edit tag: reopening an item that already exists ───────────────────────
//
// The bug this exists for: Axl listed the user's coverage, the user said "edit that one", and the
// only tag Axl had was `<route>research NVDA</route>` — which opens Prometheus on a BLANK page and
// starts a second thesis on a name already covered. A route names a desk; an edit names a document.

test('split edit: kind + handle, and the desk that owns the kind', () => {
    assert.deepEqual(_splitEdit('coverage 3f9c1a2b'), { kind: 'coverage', ref: '3f9c1a2b', desk: 'research' })
    assert.deepEqual(_splitEdit('call c1'),  { kind: 'call',  ref: 'c1', desk: 'trade' })
    assert.deepEqual(_splitEdit('setup s1'), { kind: 'setup', ref: 's1', desk: 'assist' })
    assert.deepEqual(_splitEdit('scan sc1'), { kind: 'scan',  ref: 'sc1', desk: 'scan' })
    assert.deepEqual(_splitEdit('portfolio p1'), { kind: 'portfolio', ref: 'p1', desk: 'portfolio' })
})

test('split edit: tolerant separators + a capitalized kind, and a UUID survives its dashes', () => {
    assert.deepEqual(_splitEdit('Coverage:3f9c'), { kind: 'coverage', ref: '3f9c', desk: 'research' })
    assert.deepEqual(_splitEdit(' call , 1b4d-9f2c-aa01 '), { kind: 'call', ref: '1b4d-9f2c-aa01', desk: 'trade' })
})

test('split edit: half a tag opens nothing — better a plain reply than the wrong desk', () => {
    assert.equal(_splitEdit('coverage'), null, 'a kind with no handle names no item')
    assert.equal(_splitEdit('3f9c'), null, 'a handle with no kind names no list to find it in')
    assert.equal(_splitEdit('idea i1'), null, 'the Idea agent is retired — there is no chat to reopen')
    assert.equal(_splitEdit('position p1'), null, 'a broker position is not something the app authored')
    assert.equal(_splitEdit(''), null)
    assert.equal(_splitEdit(null), null)
})

test('every kind the split can produce maps to a desk the controller accepts', () => {
    for (const [kind, desk] of Object.entries(EDIT_KIND_DESKS)) {
        assert.ok(EDIT_KINDS.has(kind), `the service can emit kind '${kind}' but the controller drops it`)
        assert.ok(VALID_PIPELINES.has(desk), `kind '${kind}' maps to desk '${desk}', which is not a desk`)
    }
})

test('sanitize ref: ids and bare tickers both pass — Axl may have only one of them', () => {
    assert.equal(_sanitizeEditRef('3f9c1a2b-4d5e-6f70-8a9b-0c1d2e3f4a5b'), '3f9c1a2b-4d5e-6f70-8a9b-0c1d2e3f4a5b')
    assert.equal(_sanitizeEditRef(' NVDA '), 'NVDA')
    assert.equal(_sanitizeEditRef('cov_1.2'), 'cov_1.2')
})

test('sanitize ref: anything that is not a handle → null', () => {
    assert.equal(_sanitizeEditRef('the NVDA one'), null)   // a phrase, not a handle
    assert.equal(_sanitizeEditRef('"c1"'), null)           // quoted
    assert.equal(_sanitizeEditRef('-c1'), null)            // must start alphanumeric
    assert.equal(_sanitizeEditRef('x'.repeat(65)), null)
    assert.equal(_sanitizeEditRef(''), null)
    assert.equal(_sanitizeEditRef(null), null)
    assert.equal(_sanitizeEditRef(42), null)
})

test('validate edit: the whole hand-off survives, or none of it does', () => {
    assert.deepEqual(_validateEdit({ kind: 'coverage', ref: 'c1', desk: 'research' }), { kind: 'coverage', ref: 'c1', desk: 'research' })
    assert.equal(_validateEdit(null), null)
    assert.deepEqual(_validateEdit({ kind: 'portfolio', ref: 'p1', desk: 'portfolio' }), { kind: 'portfolio', ref: 'p1', desk: 'portfolio' })
    assert.equal(_validateEdit({ kind: 'idea', ref: 'i1', desk: 'trade' }), null, 'kind not openable')
    assert.equal(_validateEdit({ kind: 'call', ref: 'c1', desk: 'nowhere' }), null, 'desk not routable')
    assert.equal(_validateEdit({ kind: 'call', ref: 'a whole sentence', desk: 'trade' }), null, 'ref not a handle')
})

// ── the prompt and the gate agree ─────────────────────────────────────────────

// The failure this catches is silent and total: the prompt teaches Axl a tag the controller drops,
// so Axl says "taking you there", the desk never opens, and nothing errors. It is exactly how the
// Assist desk sat unroutable — a desk in the hub with no key in the gate.
test('every route tag the prompt teaches is one the controller accepts', () => {
    const promptPath = join(dirname(fileURLToPath(import.meta.url)), '../../axl_system_prompt.md')
    const prompt = readFileSync(promptPath, 'utf8')
    const taught = [...prompt.matchAll(/<route>([a-z]+)(?:[\s:,][^<]*)?<\/route>/g)].map(m => m[1])

    assert.ok(taught.length >= 4, 'the prompt still teaches the route tags')
    for (const desk of new Set(taught)) {
        assert.ok(VALID_PIPELINES.has(desk), `the prompt teaches <route>${desk}</route> but the controller drops it`)
    }
})

// The same silent-and-total failure, one tag over: the prompt teaches an edit kind nothing can open,
// so Axl says "opening that call" and the user watches a desk start from scratch instead.
test('every edit kind the prompt teaches is one the app can actually open', () => {
    const promptPath = join(dirname(fileURLToPath(import.meta.url)), '../../axl_system_prompt.md')
    const prompt = readFileSync(promptPath, 'utf8')
    const taught = [...prompt.matchAll(/<edit>([a-z]+)[^<]*<\/edit>/g)].map(m => m[1])

    assert.ok(taught.length >= 5, 'the prompt still teaches the edit tags')
    for (const kind of new Set(taught)) {
        assert.ok(EDIT_KINDS.has(kind), `the prompt teaches <edit>${kind}</edit> but the controller drops it`)
        assert.ok(EDIT_KIND_DESKS[kind], `the prompt teaches <edit>${kind}</edit> but no desk owns it`)
    }
})

// The one kind with two modes. A book still being built is a plan to re-work; a book in positions is
// a REVIEW, because re-planning it would stand a live position down to rewrite a plan the market has
// already acted on. That choice is the client's, made from the book's own state (isPortfolioReview)
// — so what the prompt must not do is teach Axl to make it, or to promise the wrong one.
// If this fails because the wording moved, check the two modes are still DESCRIBED, then update it.
test('the prompt teaches the book edit as one tag with two outcomes, decided by the book', () => {
    const promptPath = join(dirname(fileURLToPath(import.meta.url)), '../../axl_system_prompt.md')
    const prompt = readFileSync(promptPath, 'utf8')

    assert.match(prompt, /<edit>portfolio/, 'the book edit tag is taught')
    // Whitespace-tolerant throughout: the prompt is hard-wrapped, so these sentences carry newlines.
    assert.match(prompt, /the\s+BOOK\s+decides\s+which/, 'the mode is the book\'s call, not the model\'s')
    assert.match(prompt, /in\s+a\s+position\s+→\s+Atlas\s+opens\s+a\s+REVIEW/,
        'a book in positions must be described as opening a review, never a re-plan')
})

// ── the whole turn (service, over the _run seam) ──────────────────────────────

// Stand in for runAgentStream: the tag never reaches the token stream, so the capture is how the
// service sees it — hand the reply back through the same callback the real stream uses.
function runWith(reply) {
    return async ({ tagCaptures }) => {
        for (const name of ['route', 'edit']) {
            const tag = reply.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
            const capture = (tagCaptures ?? []).find(c => c.open === `<${name}>`)
            if (tag) capture?.onCapture?.(tag[1])
        }
        return reply
    }
}

test('turn: the tag becomes route + routeSymbol and never shows up in the reply', async () => {
    const result = await axlAgentService.chatStream({
        messages: [{ role: 'user', content: "let's research nvda" }],
        _run: runWith('Taking you to Prometheus. <route>research NVDA</route>'),
    })
    assert.equal(result.route, 'research')
    assert.equal(result.routeSymbol, 'NVDA')
    assert.equal(result.reply, 'Taking you to Prometheus.')
})

test('turn: an edit tag becomes the item hand-off, and never shows up in the reply', async () => {
    const result = await axlAgentService.chatStream({
        messages: [{ role: 'user', content: 'edit that NVDA coverage' }],
        _run: runWith('Reopening it in Prometheus. <edit>coverage cov_9</edit>'),
    })
    assert.deepEqual(result.edit, { kind: 'coverage', ref: 'cov_9', desk: 'research' })
    assert.equal(result.route, null, 'an edit is not a route — it carries its own desk')
    assert.equal(result.reply, 'Reopening it in Prometheus.')
})

test('turn: an edit does NOT stamp an open objective — reopening is not a desk taking the goal', async () => {
    const result = await axlAgentService.chatStream({
        userId: 'u1',
        messages: [{ role: 'user', content: 'change the entry on my TSLA call' }],
        _run: runWith('Opening it in Kairos. <edit>call c1</edit>'),
        _objectiveHandlers: () => ({ save_objective: async () => ({}) }),
        _tradingContextHandlers: () => ({}),
        _getOpenObjective: async () => { throw new Error('an edit must not pay for the objective read') },
        _markRouted: async () => { throw new Error('an edit must not stamp the goal') },
    })
    assert.equal(result.edit?.kind, 'call')
})

test('turn: a book edit reaches Atlas as an item, not as a fresh mandate', async () => {
    // The failure it replaces: `<route>portfolio</route>` opens Atlas at Phase 1 and asks for the
    // mandate again — for a book that already has one, and whose plan is what they wanted to change.
    const result = await axlAgentService.chatStream({
        messages: [{ role: 'user', content: 're-work my Core book' }],
        _run: runWith('That takes it off monitoring until you re-activate — opening it in Atlas. <edit>portfolio p1</edit>'),
    })
    assert.deepEqual(result.edit, { kind: 'portfolio', ref: 'p1', desk: 'portfolio' })
    assert.equal(result.route, null)
})

test('turn: a clarifying question (no tag) keeps the user with Axl', async () => {
    const result = await axlAgentService.chatStream({
        messages: [{ role: 'user', content: "let's analyze nvda" }],
        _run: runWith('A tradeable setup on it, or a research thesis?'),
    })
    assert.equal(result.route, null)
    assert.equal(result.routeSymbol, null)
    assert.equal(result.reply, 'A tradeable setup on it, or a research thesis?')
})

// ── intake: the goal the user states on the way in ────────────────────────────
//
// The objective is what survives the hop to a desk, so the turn has to surface its id (the client
// shows the captured goal back to the user) and stamp which desk took it. The collaborators are
// injected here — intake is the one part of Axl that touches a database, and this seam is what
// keeps a unit test of the turn from needing one.

/** Like runWith, but the model calls save_objective before it answers. */
function runWithIntake(reply, args = { target_pct: 5, horizon_days: 7 }) {
    return async ({ tagCaptures, toolHandlers }) => {
        await toolHandlers.save_objective(args)
        const routeTag = reply.match(/<route>([\s\S]*?)<\/route>/)
        const capture = (tagCaptures ?? []).find(c => c.open === '<route>')
        if (routeTag) capture?.onCapture?.(routeTag[1])
        return reply
    }
}

const summary = (id) => ({ id, target: { pct: 5 }, horizon: { days: 7, until: '2026-08-06' }, risk: {}, scope: null, symbol: null })
const stubHandlers = (id = 'obj_1') => () => ({
    save_objective: async () => ({ saved: true, id, deadline: '2026-08-06', objective: summary(id) }),
})

test('turn: an objective captured this turn rides out on the result', async () => {
    const result = await axlAgentService.chatStream({
        userId: 'u1',
        messages: [{ role: 'user', content: 'I want to make 5% in the next week' }],
        _run: runWithIntake('Noted — 5% by August 6th. One position or several?'),
        _objectiveHandlers: stubHandlers('obj_1'),
        _tradingContextHandlers: () => ({}),
    })
    assert.equal(result.objective?.id, 'obj_1')
    assert.equal(result.objective?.horizon.until, '2026-08-06', 'the chip needs the goal, not just its id')
    assert.equal(result.route, null, 'capturing a goal is not the same as handing it to a desk')
})

test('turn: routing a turn LATER still finds the open objective and stamps the desk', async () => {
    // The goal is usually captured a turn or two before the hand-off, so the id from this turn is
    // null while an open objective still exists. Without the lookup the stamp would just be missed.
    const marked = []
    const result = await axlAgentService.chatStream({
        userId: 'u1',
        messages: [{ role: 'user', content: 'one position' }],
        _run: runWith('Taking you to the trading desk. <route>trade NVDA</route>'),
        _objectiveHandlers: stubHandlers(),
        _tradingContextHandlers: () => ({}),
        _getOpenObjective: async () => summary('obj_earlier'),
        _markRouted: async (id, desk) => { marked.push([id, desk]) },
    })
    assert.equal(result.objective?.id, 'obj_earlier')
    assert.deepEqual(marked, [['obj_earlier', 'trade']])
})

test('turn: a reply that does not route never pays for the objective lookup', async () => {
    // Every Axl turn would otherwise carry a database read for a stamp only a hand-off needs.
    let looked = 0
    const result = await axlAgentService.chatStream({
        userId: 'u1',
        messages: [{ role: 'user', content: 'what is a stop loss?' }],
        _run: runWith('A stop is the price where you accept the idea was wrong.'),
        _objectiveHandlers: stubHandlers(),
        _tradingContextHandlers: () => ({}),
        _getOpenObjective: async () => { looked++; return summary('obj_1') },
    })
    assert.equal(looked, 0)
    assert.equal(result.objective, null)
})

test('turn: routing with no objective at all is fine — the desk simply asks', async () => {
    const result = await axlAgentService.chatStream({
        userId: 'u1',
        messages: [{ role: 'user', content: 'find me a trade on tsla' }],
        _run: runWith('Off to Kairos. <route>trade TSLA</route>'),
        _objectiveHandlers: stubHandlers(),
        _tradingContextHandlers: () => ({}),
        _getOpenObjective: async () => null,
        _markRouted: async () => { throw new Error('must not stamp a goal that does not exist') },
    })
    assert.equal(result.objective, null)
    assert.equal(result.route, 'trade')
})
