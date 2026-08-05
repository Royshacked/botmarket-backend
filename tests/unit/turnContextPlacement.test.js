// Where per-turn context is PLACED, and why it is not in the system prompt.
//   node --test tests/unit/turnContextPlacement.test.js
//
// Caching is a prefix match over `tools → system → messages`, so a block that changes every turn
// invalidates everything after it. Sitting in `system`, a volatile tail is ahead of the ENTIRE
// conversation: the tools and base prompt still cache (their breakpoints come first), but the
// history breakpoint stamped on the last message can never hit, and the whole chat is re-read at
// full price every turn for the life of the session. Moving that block to the end of the messages
// is what makes it cacheable — text written into a message is frozen the moment it is written; text
// written into `system` is regenerated every turn.
//
// These tests pin the placement rules, not the wording, so the blocks can be reworded freely.

import test from 'node:test'
import assert from 'node:assert/strict'

import { attachTurnContext } from '../../services/agentUtils.js'
import { _buildTurnContext } from '../../services/kairos.agent.service.js'
import { _buildTurnContext as analystTurnContext } from '../../services/analyst.agent.service.js'
import { _buildTurnContext as mentorTurnContext } from '../../services/mentor.agent.service.js'

const user = (content) => ({ role: 'user', content })

// ─── placement ────────────────────────────────────────────────────────────────

test('the context lands on the LAST user message', () => {
    const out = attachTurnContext([user('first'), { role: 'assistant', content: 'reply' }, user('latest')], 'CTX')
    assert.equal(out.length, 3)
    assert.match(out[2].content, /latest/)
    assert.match(out[2].content, /CTX/)
})

test('earlier turns are left byte-identical — that is the whole point', () => {
    // If attaching rewrote any earlier message, the prefix would change and the cache it is meant
    // to enable would miss anyway.
    const history = [user('first'), { role: 'assistant', content: 'reply' }, user('latest')]
    const out = attachTurnContext(history, 'CTX')
    assert.equal(out[0].content, 'first')
    assert.equal(out[1].content, 'reply')
})

test('the input array and its messages are never mutated', () => {
    // The caller's history is reused across the turn; mutating it in place would leak this turn's
    // context into the stored conversation.
    const history = [user('latest')]
    const before = JSON.stringify(history)
    attachTurnContext(history, 'CTX')
    assert.equal(JSON.stringify(history), before)
})

test('an assistant-final history is left alone', () => {
    // Appending to an assistant turn would put the words in the model's own mouth — it would read
    // this context as something it had said itself.
    const history = [user('hi'), { role: 'assistant', content: 'reply' }]
    assert.deepEqual(attachTurnContext(history, 'CTX'), history)
})

test('nothing to say attaches nothing', () => {
    const history = [user('latest')]
    assert.deepEqual(attachTurnContext(history, ''), history)
    assert.deepEqual(attachTurnContext(history, '   '), history)
    assert.deepEqual(attachTurnContext(history, null), history)
    assert.deepEqual(attachTurnContext(history, undefined), history)
})

test('an empty or absent history is survived, not thrown on', () => {
    assert.deepEqual(attachTurnContext([], 'CTX'), [])
    assert.deepEqual(attachTurnContext(null, 'CTX'), [])
    assert.deepEqual(attachTurnContext(undefined, 'CTX'), [])
})

test('block-array content gets a block, string content gets a string', () => {
    // The provider stamps its cache breakpoint on the LAST content block of the last message, so
    // the shape has to survive intact either way.
    const asString = attachTurnContext([user('latest')], 'CTX')
    assert.equal(typeof asString[0].content, 'string')

    const asBlocks = attachTurnContext([{ role: 'user', content: [{ type: 'text', text: 'latest' }] }], 'CTX')
    assert.ok(Array.isArray(asBlocks[0].content))
    assert.equal(asBlocks[0].content.length, 2)
    assert.deepEqual(asBlocks[0].content[1], { type: 'text', text: 'CTX' })
})

// ─── what Kairos routes through it ────────────────────────────────────────────

test('Kairos sends its DRAFT down this path — the one thing that changes per turn', () => {
    const ctx = _buildTurnContext({ draft: { asset: 'NVDA', direction: 'long' } })
    assert.match(ctx, /Draft call so far/)
    assert.match(ctx, /NVDA/)
})

test('no draft means no block at all, so a fresh conversation appends nothing', () => {
    assert.equal(_buildTurnContext({}), '')
    assert.equal(_buildTurnContext({ draft: null }), '')
    assert.equal(_buildTurnContext(null), '')
    assert.equal(_buildTurnContext(undefined), '')
})

test('the carry-forward instruction travels WITH the draft', () => {
    // The draft is only useful if the model still knows to carry unset fields forward; the rule and
    // the data moved together, so the instruction cannot be left behind in the system prompt.
    assert.match(_buildTurnContext({ draft: { asset: 'NVDA' } }), /carry set fields forward/)
})

// ─── the other two live desks ─────────────────────────────────────────────────

test('Prometheus moves its coverage draft and nothing else', () => {
    const ctx = analystTurnContext({ draft: { symbol: 'ZTS', rating: 'hold' } })
    assert.match(ctx, /Draft coverage so far/)
    assert.match(ctx, /carry set fields forward/)
    assert.equal(analystTurnContext({}), '')
})

test('Prometheus leaves EXISTING coverage in the system prompt', () => {
    // The stored thesis is fetched once per session and byte-identical after — moving it would add
    // turns of duplicated JSON to the history for no cache gain. It is the DRAFT that changes, not
    // everything that happens to be JSON.
    assert.equal(analystTurnContext({ existing_coverage: { symbol: 'ZTS' } }), '')
})

test('Talos moves all THREE of its per-turn pieces', () => {
    // Any one left behind would have been enough to keep the history breakpoint from hitting — the
    // prefix does not care how small the volatile block is, only that it precedes the conversation.
    const ctx = mentorTurnContext({ draft: { asset: 'AAPL' }, coverage: ['markets', 'company'] }, null)
    assert.match(ctx, /Setup so far/)                 // the draft
    assert.match(ctx, /COVERAGE SO FAR: markets, company/)  // the tally that grows each turn
    assert.match(ctx, /carry every settled field forward/)  // its rule travelled with it
})

test('Talos still emits the coverage line with no draft and no coverage', () => {
    // The re-state instruction has to reach the model on turn one, or the tally never starts.
    const ctx = mentorTurnContext({}, null)
    assert.match(ctx, /COVERAGE SO FAR: nothing yet/)
    assert.doesNotMatch(ctx, /Setup so far/)
})

test('every desk survives a null chatState', () => {
    // These run on the first turn of a fresh conversation, before any state exists.
    assert.doesNotThrow(() => _buildTurnContext(null))
    assert.doesNotThrow(() => analystTurnContext(null))
    assert.doesNotThrow(() => mentorTurnContext(null, null))
})
