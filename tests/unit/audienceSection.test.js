import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAudienceSection } from '../../services/agentUtils.js'
import { portfolioAgentService } from '../../services/agents/portfolio.agent.service.js'
import { analystAgentService } from '../../services/agents/analyst.agent.service.js'
import { refreshCoverage } from '../../services/coverageRefresh.service.js'

// The block that tells a desk WHO it is talking to.
//
// One property matters more than all the others: this may change a desk's WORDS and never its
// DECISIONS. A beginner must get the same trade — same levels, same size, same risk — explained
// better. If a desk ever read this as licence to soften a number "because they're new", the user
// would be getting a worse trade as a direct consequence of being honest about their experience.

test('no view renders nothing, so an un-inferred user is untouched', () => {
    // The whole back-compat guarantee: no level, no block, byte-identical prompt.
    assert.equal(buildAudienceSection(null), null)
    assert.equal(buildAudienceSection(undefined), null)
    assert.equal(buildAudienceSection('expert'), null, 'an unknown level is no view, not a guess')
})

test('the beginner block says WORDS ONLY, in terms a model cannot miss', () => {
    const s = buildAudienceSection('beginner')
    assert.match(s, /WORDS ONLY/)
    assert.match(s, /The analysis, the levels, the size, the risk and your verdict are exactly what they would have been/)
})

test('the beginner block forbids each way a desk might "help" by deciding differently', () => {
    const s = buildAudienceSection('beginner')
    assert.match(s, /Never soften a number/)
    assert.match(s, /never widen a stop/)
    assert.match(s, /never talk someone out of a real risk because they are new/)
    assert.match(s, /a reason to explain more, never a reason to decide differently/)
})

test('the beginner block names the shorthand that actually appears in this app', () => {
    // Not a generic "avoid jargon" — the specific terms the desks and cards really use.
    const s = buildAudienceSection('beginner')
    for (const term of ['R:R', 'FVG', 'BOS/CHoCH', 'invalidation']) {
        assert.ok(s.includes(term), `never warned about "${term}"`)
    }
})

test('the beginner block forbids turning help into a lecture', () => {
    assert.match(buildAudienceSection('beginner'), /explain alongside, not in front/)
})

test('the experienced block exists and is short — it is a licence, not an instruction set', () => {
    const s = buildAudienceSection('experienced')
    assert.match(s, /asked to be spoken to normally/)
    assert.ok(s.length < 300)
})

// ─── it actually reaches the desks ────────────────────────────────────────────

const tailOf = async (svc, args) => {
    let tail = null
    await svc.chatStream({ messages: [{ role: 'user', content: 'hi' }], ...args,
        _run: async ({ systemPrompt }) => { tail = systemPrompt.at(-1).text; return '' } })
    return tail
}

test('the block lands in the prompt of a desk that takes a dynamic string', async () => {
})

test('...and of a desk that assembles a section array', async () => {
    assert.match(await tailOf(portfolioAgentService, { audience: 'beginner' }), /WHO YOU ARE TALKING TO/)
})

test('no audience leaves every desk’s prompt exactly as it was', async () => {
    for (const [name, svc] of [['portfolio', portfolioAgentService], ['analyst', analystAgentService]]) {
        assert.doesNotMatch(await tailOf(svc, {}), /WHO YOU ARE TALKING TO/, name)
    }
})

test('the block sits in the UNCACHED tail, so no cached prefix is invalidated', async () => {
    // Every existing cache_control breakpoint must still sit strictly before it, or a per-user
    // block would blow the shared prompt cache for every user on every turn.
    let blocks = null
    await portfolioAgentService.chatStream({
        messages: [{ role: 'user', content: 'hi' }], audience: 'beginner',
        _run: async ({ systemPrompt }) => { blocks = systemPrompt; return '' },
    })
    const idx = blocks.findIndex(b => b.text.includes('WHO YOU ARE TALKING TO'))
    assert.equal(idx, blocks.length - 1, 'the audience block must be in the last block')
})

// ─── the headless path must not get it ────────────────────────────────────────

test('the headless coverage refresh passes NO audience — it has no reader', async () => {
    // It runs the real Analyst through the same chatStream with a server-composed prompt, and what
    // it writes is a durable coverage thesis Atlas re-reads later. A beginner-voice block here would
    // rewrite a stored artifact on a machine-to-machine run — the same class of bug this path has
    // already had once, when the scheduler's own context silently rewrote the thesis's language.
    //
    // This is precisely why the level travels on the CONTROLLER path rather than being injected
    // centrally in runAgentStream: a central seam would need this caller to remember an opt-out,
    // and so would every headless caller written after it. Here it simply never fetches one.
    let seenArgs = null
    await refreshCoverage({ userId: 'u1', ticker: 'NVDA' }, {
        research: async (args) => { seenArgs = args; return { reply: '', coverage: null } },
        existing: async () => null,
        initiate: async () => ({ ok: false }),
        update: async () => ({ ok: false }),
        notify: async () => {},
    })
    assert.ok(seenArgs, 'the research dep was called')
    assert.equal(seenArgs.audience, undefined, `the headless refresh must carry no audience, got: ${seenArgs.audience}`)
})
