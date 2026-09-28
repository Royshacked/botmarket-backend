import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    mentorAgentService, emptyMentorState, _parseMentorResponse, _buildLedgerSection, _buildTurnContext,
} from '../../services/agents/mentor.agent.service.js'
import { emptyBuild, upsertName, activeName, stageOf } from '../../services/mentorBuild.util.js'

// The ledger, wired: what the model emits reaches it, what it holds reaches the next prompt, and
// what it refuses does not quietly happen anyway.

const SETUP = {
    asset: 'NVDA', direction: 'long', type: 'swing', trade_mode: 'smc', timeframe: '1hr',
    scenarios: [{
        id: 's1',
        entry_legs:  [{ price: 238.6, quantity: 100 }],
        stop_legs:   [{ price: 234.8 }],
        target_legs: [{ price: 246.0, quantity: 100 }],
    }],
}

/** One turn through the agent with a canned model reply. Returns what the desk hands back. */
const turn = (raw, chatState = emptyMentorState()) => mentorAgentService.chatStream({
    messages: [{ role: 'user', content: 'hi' }],
    chatState,
    _run: async () => raw,
})

// ─── The tag ──────────────────────────────────────────────────────────────────

test('the <build> block is parsed and never reaches the user', () => {
    const raw = 'Long and swing, then.\n<build>{"settle":["direction"],"source":"user"}</build>'
    const { reply, buildOps } = _parseMentorResponse(raw)
    assert.equal(reply, 'Long and swing, then.')
    assert.deepEqual(buildOps, { settle: ['direction'], source: 'user' })
})

test('a malformed <build> block is treated as absent, not as a crash', () => {
    const { reply, buildOps } = _parseMentorResponse('Here.\n<build>{oops</build>')
    assert.equal(buildOps, null)
    assert.equal(reply, 'Here.')
})

// ─── The turn ─────────────────────────────────────────────────────────────────

test('the worksheet alone claims; it does not settle', async () => {
    const out = await turn(`<setup>${JSON.stringify(SETUP)}</setup>`)
    assert.equal(stageOf(activeName(out.build)), 'opening')
    assert.equal(activeName(out.build).claimed.direction.value, 'long')
    assert.deepEqual(activeName(out.build).settled, {})
})

test('a settle in the tag moves the ledger, and the ledger rides home on the draft', async () => {
    const raw = `<setup>${JSON.stringify(SETUP)}</setup>`
        + '<build>{"settle":["direction","horizon","lens"],"source":"user"}</build>'
    const out = await turn(raw)
    assert.equal(stageOf(activeName(out.build)), 'spans')
    // The draft is the carrier: the client rebuilds chatState from what it was sent.
    assert.equal(out.setup.build.names[0].settled.direction, 'long')
})

test('the ledger survives the round trip through the client', async () => {
    const first = await turn(`<setup>${JSON.stringify(SETUP)}</setup>`
        + '<build>{"settle":["direction","horizon","lens"],"source":"user"}</build>')

    // Exactly what the client sends back: it keeps the draft, and the draft carries the ledger.
    const second = await turn(`<setup>${JSON.stringify(SETUP)}</setup>`,
        { active_asset: 'NVDA', draft: first.setup, coverage: [] })

    assert.equal(stageOf(activeName(second.build)), 'spans', 'the settled opening was not forgotten')
})

test('an out-of-order settle is refused, and the refusal travels to the next turn', async () => {
    const out = await turn(`<setup>${JSON.stringify(SETUP)}</setup>`
        + '<build>{"claim":{"size":100},"settle":["size"]}</build>')

    assert.equal(activeName(out.build).settled.size, undefined)
    assert.match(out.build.refused[0].reason, /opening must be settled/)

    const next = _buildLedgerSection({ draft: out.setup })
    assert.match(next, /REFUSED LAST TURN/)
    assert.match(next, /opening must be settled/)
})

test('a worksheet that contradicts a settled value is put back, and the model is told', async () => {
    const first = await turn(`<setup>${JSON.stringify(SETUP)}</setup>`
        + '<build>{"settle":["direction","horizon","lens"],"source":"user"}</build>')

    const flipped = { ...SETUP, direction: 'short' }
    const second  = await turn(`<setup>${JSON.stringify(flipped)}</setup>`,
        { active_asset: 'NVDA', draft: first.setup, coverage: [] })

    assert.equal(second.setup.direction, 'long', 'the settled direction wins')
    assert.match(second.build.refused[0].reason, /restored/)
})

test('a reopen cascades, so the build goes back to the stage the user reopened', async () => {
    const first = await turn(`<setup>${JSON.stringify(SETUP)}</setup>`
        + '<build>{"settle":["direction","horizon","lens"],"source":"user"}</build>')

    const second = await turn(`<setup>${JSON.stringify(SETUP)}</setup>`
        + '<build>{"unsettle":"opening"}</build>',
    { active_asset: 'NVDA', draft: first.setup, coverage: [] })

    assert.equal(stageOf(activeName(second.build)), 'opening')
})

test('a prose-only turn still carries the ledger home — a confirmation is not lost to a missing worksheet', async () => {
    const first = await turn(`<setup>${JSON.stringify(SETUP)}</setup>`)

    // The ordinary shape of turn two: the user says yes, Mentor answers in words and emits no
    // worksheet. Before this was handled, the settlement went nowhere and the question came back.
    const second = await turn('Long and swing it is.\n<build>{"settle":["direction","horizon","lens"],"source":"user"}</build>',
        { active_asset: 'NVDA', draft: first.setup, coverage: [] })

    assert.ok(second.setup, 'the draft is re-issued so the ledger has a carrier')
    assert.equal(second.setup.build.names[0].settled.direction, 'long')
    assert.equal(second.setup.direction, 'long', 'and the content is unchanged')

    // And it survives the next round trip, which is the point of carrying it at all.
    const third = await turn('Right.', { active_asset: 'NVDA', draft: second.setup, coverage: [] })
    assert.equal(stageOf(activeName(third.build)), 'spans')
})

test('a refusal reason survives the round trip in full, not cut mid-sentence', async () => {
    const first = await turn(`<setup>${JSON.stringify(SETUP)}</setup>`
        + '<build>{"settle":["direction","horizon","lens"],"source":"user"}</build>')

    const flipped = { ...SETUP, direction: 'short' }
    const second  = await turn(`<setup>${JSON.stringify(flipped)}</setup>`,
        { active_asset: 'NVDA', draft: first.setup, coverage: [] })

    // Read it back the way the next turn does — through the client, through normalizeBuild.
    const text = _buildLedgerSection({ draft: second.setup })
    assert.match(text, /Unsettle the stage if the user changed their mind/)
})

// ─── What the next prompt says ────────────────────────────────────────────────

test('the ledger section tells the model where it is, and that talking never moves it', () => {
    const build = upsertName(emptyBuild(), 'NVDA')
    const text  = _buildLedgerSection({ build })
    assert.match(text, /BUILD LEDGER — NVDA/)
    assert.match(text, /YOU ARE AT: opening/)
    assert.match(text, /direction, horizon, lens/)
    assert.match(text, /talking never moves this ledger/i)
    assert.match(text, /opening → spans → entries → sizing → summary/)
})

test('a waived gate tells the model to decide and say so; an unwaived one tells it to ask', async () => {
    const settled = await turn(`<setup>${JSON.stringify(SETUP)}</setup>`
        + '<build>{"settle":["direction","horizon","lens"],"waiver":true}</build>')
    const waived = _buildLedgerSection({ draft: settled.setup })
    assert.match(waived, /YOU ARE AT: spans/)
    assert.match(waived, /make the call yourself/i)

    const asked = await turn(`<setup>${JSON.stringify(SETUP)}</setup>`
        + '<build>{"settle":["direction","horizon","lens"]}</build>')
    assert.match(_buildLedgerSection({ draft: asked.setup }), /once they have/i)
})

test('no name means no ledger block at all — an empty build says nothing', () => {
    assert.equal(_buildLedgerSection({}), '')
    assert.equal(_buildLedgerSection({ build: emptyBuild() }), '')
})

test('the ledger reaches the turn context, next to the draft it rides on', async () => {
    const out  = await turn(`<setup>${JSON.stringify(SETUP)}</setup>`)
    const text = _buildTurnContext({ active_asset: 'NVDA', draft: out.setup, coverage: [] })
    assert.match(text, /BUILD LEDGER — NVDA/)
    assert.match(text, /Setup so far/)
})
