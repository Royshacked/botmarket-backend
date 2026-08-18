import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { _splitRoute, _splitEdit, _cleanOpening, EDIT_KIND_DESKS, axlAgentService } from '../../services/agents/axl.agent.service.js'
import { _sanitizeRouteSymbol, _sanitizeEditRef, _validateEdit, VALID_PIPELINES, EDIT_KINDS } from '../../api/axl/axl.controller.js'
import { ALL_EMIT_TAGS } from '../../services/llmStream.util.js'

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
    assert.deepEqual(_splitEdit('setup s1'), { kind: 'setup', ref: 's1', desk: 'assist' })
    // `call` was here too until Kairos was archived (2026-08-18). A kind with no desk now
    // splits to null, which is the same guard as any other unroutable kind two tests below.
    assert.equal(_splitEdit('call c1'), null, 'an archived desk owns nothing')
    assert.deepEqual(_splitEdit('scan sc1'), { kind: 'scan',  ref: 'sc1', desk: 'scan' })
    assert.deepEqual(_splitEdit('portfolio p1'), { kind: 'portfolio', ref: 'p1', desk: 'portfolio' })
})

test('split edit: tolerant separators + a capitalized kind, and a UUID survives its dashes', () => {
    assert.deepEqual(_splitEdit('Coverage:3f9c'), { kind: 'coverage', ref: '3f9c', desk: 'research' })
    assert.deepEqual(_splitEdit(' setup , 1b4d-9f2c-aa01 '), { kind: 'setup', ref: '1b4d-9f2c-aa01', desk: 'assist' })
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
    const promptPath = join(dirname(fileURLToPath(import.meta.url)), '../../prompts/axl_system_prompt.md')
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
    const promptPath = join(dirname(fileURLToPath(import.meta.url)), '../../prompts/axl_system_prompt.md')
    const prompt = readFileSync(promptPath, 'utf8')
    const taught = [...prompt.matchAll(/<edit>([a-z]+)[^<]*<\/edit>/g)].map(m => m[1])

    assert.ok(taught.length >= 5, 'the prompt still teaches the edit tags')
    for (const kind of new Set(taught)) {
        assert.ok(EDIT_KINDS.has(kind), `the prompt teaches <edit>${kind}</edit> but the controller drops it`)
        assert.ok(EDIT_KIND_DESKS[kind], `the prompt teaches <edit>${kind}</edit> but no desk owns it`)
    }
})

// Kairos is ARCHIVED as of 2026-08-18 (archive/README.md) — it was asleep-but-editable before
// that, and the edit door is now shut too. The failure this catches is the one the user actually
// hit: Axl still introducing Kairos as a desk you can go to, so someone asks for a call and lands
// nowhere. Now there is no landing at all, so the prompt must not offer the door either.
test('the prompt archives Kairos outright and names Mentor as the trader', () => {
    const promptPath = join(dirname(fileURLToPath(import.meta.url)), '../../prompts/axl_system_prompt.md')
    const prompt = readFileSync(promptPath, 'utf8')

    assert.match(prompt, /Kairos\*\*[^.]*is\s+\*\*archived\*\*/, 'the state is stated outright')
    assert.match(prompt, /premium/i, 'and why it is archived rather than deleted')
    assert.match(prompt, /[Nn]ever\s+route\s+anyone\s+there/, 'the rule, not just the fact')
    assert.match(prompt, /A\s+new\s+trade\s+is\s+Mentor's,\s+always/, 'and who took it over')

    // The roster is what Axl describes when asked "who works here" — Kairos must not be a bullet in
    // it, or the sleep rule argues with the list three lines above it.
    const roster = prompt.slice(prompt.indexOf('## Who you are'), prompt.indexOf('Nothing they produce'))
    assert.doesNotMatch(roster, /- \*\*Kairos\*\*/, 'a sleeping desk is not a bullet on the roster')
    assert.match(roster, /- \*\*Mentor\*\* — the trader/, 'Mentor leads it instead')

    // ...and the edit door is shut with it. Offering `<edit>call` now emits a tag the gate drops
    // (EDIT_KINDS), so Axl would promise to open something and then silently do nothing.
    assert.doesNotMatch(prompt, /<edit>call ID<\/edit>/, 'the edit door closed with the desk')
})

// Reception's whole job is WHERE, and the sentence that travels with them. The rules this replaces
// had Axl collecting a risk number and a timeframe at the door — the desk's own Phase 1 — and
// writing them down as an objective that then outlived the job.
test('the prompt teaches the opening hand-off, and keeps reception out of the brief', () => {
    const promptPath = join(dirname(fileURLToPath(import.meta.url)), '../../prompts/axl_system_prompt.md')
    const prompt = readFileSync(promptPath, 'utf8')

    assert.match(prompt, /<open>/, 'the opening tag is taught')
    assert.match(prompt, /AS\s+THE\s+USER'S\s+OWN\s+MESSAGE/, 'and what it becomes on arrival')
    assert.match(prompt, /You\s+are\s+reception,\s+not\s+the\s+meeting/, 'the boundary is stated')
    assert.match(prompt, /Their\s+statement\s+of\s+the\s+job,\s+not\s+your\s+summary/,
        "the user's words, not a brief Axl authored")
    assert.doesNotMatch(prompt, /save_objective/, 'the intake write is gone')
    assert.doesNotMatch(prompt, /Always ask for the risk number/,
        'asking for risk at reception is what the desk does in its own first phase')
})

// The one kind with two modes. A book still being built is a plan to re-work; a book in positions is
// a REVIEW, because re-planning it would stand a live position down to rewrite a plan the market has
// already acted on. That choice is the client's, made from the book's own state (isPortfolioReview)
// — so what the prompt must not do is teach Axl to make it, or to promise the wrong one.
// If this fails because the wording moved, check the two modes are still DESCRIBED, then update it.
test('the prompt teaches the book edit as one tag with two outcomes, decided by the book', () => {
    const promptPath = join(dirname(fileURLToPath(import.meta.url)), '../../prompts/axl_system_prompt.md')
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
        for (const name of ['route', 'edit', 'open']) {
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

// ── the opening turn the desk receives ───────────────────────────────────────
//
// This IS the hand-off. It replaced an `objectives` record (2026-08-05) that carried the job as
// structured data, outlived it, and turned reception into an interrogation for numbers the desk asks
// for itself. What crosses now is one sentence in the user's own words.

test('turn: the opening rides out beside the route, and never shows up in the reply', async () => {
    const result = await axlAgentService.chatStream({
        messages: [{ role: 'user', content: 'several positions' }],
        _run: runWith('Taking you to Atlas. <route>portfolio</route><open>I want 5% profit.</open>'),
    })
    assert.equal(result.route, 'portfolio')
    assert.equal(result.opening, 'I want 5% profit.')
    assert.equal(result.reply, 'Taking you to Atlas.', 'the user sees the sentence, never the tags')
})

test('turn: a hard-wrapped opening arrives as one line — it becomes a chat message', async () => {
    const result = await axlAgentService.chatStream({
        messages: [{ role: 'user', content: 'go' }],
        _run: runWith('Off you go. <route>trade</route><open>I think NVDA\n  breaks out   this week.</open>'),
    })
    assert.equal(result.opening, 'I think NVDA breaks out this week.')
})

test('turn: an opening with no route has nowhere to land', async () => {
    // A clarifying turn that emits one anyway would be a message sent to no desk.
    const result = await axlAgentService.chatStream({
        messages: [{ role: 'user', content: 'i want 5% profit' }],
        _run: runWith('One position or several? <open>I want 5% profit.</open>'),
    })
    assert.equal(result.route, null)
    assert.equal(result.opening, null)
})

test('turn: an EDIT never carries an opening — it resumes a conversation that exists', async () => {
    // Reopening a setup restores the chat that built it. An opening turn there talks over the page.
    const result = await axlAgentService.chatStream({
        messages: [{ role: 'user', content: 'change the entry on my TSLA setup' }],
        _run: runWith('Opening it in Mentor. <edit>setup s1</edit><open>I want to move the entry.</open>'),
    })
    assert.equal(result.edit?.kind, 'setup')
    assert.equal(result.opening, null)
})

test('turn: routing with no opening at all is fine — the desk simply asks', async () => {
    const result = await axlAgentService.chatStream({
        messages: [{ role: 'user', content: 'find me a trade on tsla' }],
        _run: runWith('Off to Kairos. <route>trade TSLA</route>'),
    })
    assert.equal(result.route, 'trade')
    assert.equal(result.opening, null)
})

test('an opening is capped — it is a first message, not a handover document', async () => {
    const long = 'x'.repeat(900)
    const result = await axlAgentService.chatStream({
        messages: [{ role: 'user', content: 'go' }],
        _run: runWith(`Off you go. <route>portfolio</route><open>${long}</open>`),
    })
    assert.equal(result.opening.length, 600)
})

test('_cleanOpening: nothing but whitespace is nothing', () => {
    assert.equal(_cleanOpening('   \n  '), null)
    assert.equal(_cleanOpening(null), null)
    assert.equal(_cleanOpening(undefined), null)
})

// ─── <adopt>: the door for a book that already exists elsewhere ──────────────────
// A third sibling of <route>, for the same reason <edit> is a second one: "they already own this" is
// not a destination, it is what the portfolio desk must DO on arrival. Squeezing it into the route tag
// would collide with the symbol slot (`portfolio adopt` vs `portfolio AAPL`).

test('adopt is registered as an emit tag, or the first turn prints it at the user', () => {
    assert.ok(ALL_EMIT_TAGS.includes('adopt'),
        'an unregistered tag is not suppressed — it reaches the chat as literal text')
})

test('adopt rides ONLY with the portfolio desk', () => {
    // A mode with no desk to arrive at is a flag nothing reads.
    for (const [route, adopt, expected] of [
        ['portfolio', true,  true],
        ['portfolio', false, false],
        ['trade',     true,  false],
        [null,        true,  false],
    ]) {
        assert.equal(route === 'portfolio' && adopt === true, expected,
            `route=${route} adopt=${adopt}`)
    }
})

test('every desk adopt can arrive at is a real desk', () => {
    assert.ok(VALID_PIPELINES.has('portfolio'))
})
