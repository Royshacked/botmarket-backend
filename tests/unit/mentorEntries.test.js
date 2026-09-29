import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEntries, entryIds, entryProblems, ENTRY_SEMANTICS } from '../../services/mentorBuild.util.js'
import { mentorAgentService, _buildProblemsSection } from '../../services/agents/mentor.agent.service.js'

// The entries gate. The field that matters most here is `semantics`: read the wrong way round, a
// three-entry trade enters at a third of the intended size or at three times it.

const opt = (i, over = {}) => ({
    id: `t1e${i}`, label: `way ${i}`, technique: 'sweep then CHoCH',
    trigger: 'a 15m close back above 238', timeframe: '15min',
    evidence: '11 of the last 14 sweeps closed back inside', ...over,
})
const trade = (over = {}) => ({ id: 't1', options: [opt(1)], ...over })

const turn = (raw, chatState) => mentorAgentService.chatStream({
    messages: [{ role: 'user', content: 'hi' }], chatState, _run: async () => raw,
})

const AT_NVDA = { active_asset: 'NVDA', draft: null, coverage: [] }

// ─── Shape ────────────────────────────────────────────────────────────────────

test('an entry keeps its trigger, its rung and the evidence it was tested on', () => {
    const out = normalizeEntries({ trades: [trade()] })
    assert.deepEqual(out.trades[0].options[0], {
        id: 't1e1', label: 'way 1', technique: 'sweep then CHoCH',
        trigger: 'a 15m close back above 238', timeframe: '15min',
        evidence: '11 of the last 14 sweeps closed back inside',
        share: null, recommended: true,
    })
})

test('ALTERNATIVES is the default — the reading that cannot put on more risk than agreed', () => {
    assert.deepEqual(ENTRY_SEMANTICS, ['alternatives', 'scale_in'])
    assert.equal(normalizeEntries({ trades: [trade()] }).trades[0].semantics, 'alternatives')
    assert.equal(normalizeEntries({ trades: [trade({ semantics: 'both at once' })] }).trades[0].semantics, 'alternatives')
    assert.equal(normalizeEntries({ trades: [trade({ semantics: 'scale_in' })] }).trades[0].semantics, 'scale_in')
})

test('exactly one entry is Mentor\'s pick — the first when it named none, and never two', () => {
    const none = normalizeEntries({ trades: [trade({ options: [opt(1), opt(2)] })] })
    assert.deepEqual(none.trades[0].options.map(o => o.recommended), [true, false])

    const two = normalizeEntries({ trades: [trade({ options: [opt(1, { recommended: true }), opt(2, { recommended: true })] })] })
    assert.deepEqual(two.trades[0].options.map(o => o.recommended), [true, false])

    const second = normalizeEntries({ trades: [trade({ options: [opt(1), opt(2, { recommended: true })] })] })
    assert.deepEqual(second.trades[0].options.map(o => o.recommended), [false, true])
})

test('three ways in per trade, and no more', () => {
    const out = normalizeEntries({ trades: [trade({ options: [1, 2, 3, 4, 5].map(i => opt(i)) })] })
    assert.equal(out.trades[0].options.length, 3)
})

test('an entry with no trigger is not an entry', () => {
    const out = normalizeEntries({ trades: [trade({ options: [opt(1), { id: 'x', label: 'vibes' }] })] })
    assert.equal(out.trades[0].options.length, 1)
})

test('an invented rung is dropped rather than passed to a monitor that cannot read it', () => {
    const out = normalizeEntries({ trades: [trade({ options: [opt(1, { timeframe: 'whenever' })] })] })
    assert.equal(out.trades[0].options[0].timeframe, null)
})

test('entries for a trade the user never agreed to look at are dropped', () => {
    const out = normalizeEntries({ trades: [trade(), { id: 't9', options: [opt(1)] }] }, ['t1'])
    assert.deepEqual(out.trades.map(t => t.id), ['t1'])
    assert.deepEqual(entryIds(out), ['t1:t1e1'])
})

test('junk in, null out', () => {
    assert.equal(normalizeEntries(null), null)
    assert.equal(normalizeEntries({ trades: [] }), null)
    assert.equal(normalizeEntries({ trades: [{ id: 't1', options: [] }] }), null)
})

// ─── Scaling in is where a shape error costs money ────────────────────────────

test('shares that do not add up are reported — the user would be filled for a size nobody chose', () => {
    const half = normalizeEntries({ trades: [trade({
        semantics: 'scale_in', options: [opt(1, { share: 50 }), opt(2, { share: 30 })],
    })] })
    assert.deepEqual(entryProblems(half), ['t1: scaling in, but the shares add up to 80%, not 100%'])

    const whole = normalizeEntries({ trades: [trade({
        semantics: 'scale_in', options: [opt(1, { share: 50 }), opt(2, { share: 50 })],
    })] })
    assert.deepEqual(entryProblems(whole), [])
})

test('a scale-in entry with no share at all is named as the gap it is', () => {
    const out = normalizeEntries({ trades: [trade({ semantics: 'scale_in', options: [opt(1, { share: 50 }), opt(2)] })] })
    assert.match(entryProblems(out)[0], /1 of 2 entries carry no share/)
})

test('alternatives never complain about shares — there is one position, not three', () => {
    const out = normalizeEntries({ trades: [trade({ options: [opt(1, { share: 50 }), opt(2, { share: 30 })] })] })
    assert.deepEqual(entryProblems(out), [])
})

test('the problem reaches the model in the turn context, where it can act on it', () => {
    const draft = { entries: normalizeEntries({ trades: [trade({ semantics: 'scale_in', options: [opt(1, { share: 60 }), opt(2, { share: 60 })] })] }) }
    const text = _buildProblemsSection(draft)
    assert.match(text, /shares add up to 120%/)
    assert.match(text, /DOES NOT ADD UP/)
})

// ─── Through the desk ─────────────────────────────────────────────────────────

const SPANS = { candidates: [{ id: 't1', label: 'the shelf', from: 'a', to: 'b' }] }

test('the entries block rides home on the draft and claims its ids', async () => {
    const first = await turn(`<spans>${JSON.stringify(SPANS)}</spans>`, AT_NVDA)
    const out = await turn(`<entries>${JSON.stringify({ trades: [trade()] })}</entries>`,
        { active_asset: 'NVDA', draft: first.setup, coverage: [] })
    assert.deepEqual(entryIds(out.setup.entries), ['t1:t1e1'])
})

test('entries for a span that is not on the table do not survive the trip', async () => {
    const first = await turn(`<spans>${JSON.stringify(SPANS)}</spans>`, AT_NVDA)
    const out = await turn(`<entries>${JSON.stringify({ trades: [{ id: 't7', options: [opt(1)] }] })}</entries>`,
        { active_asset: 'NVDA', draft: first.setup, coverage: [] })
    assert.equal(out.setup.entries, undefined)
})

test('the block never reaches the user as text', async () => {
    const out = await turn(`Three ways in.\n<entries>${JSON.stringify({ trades: [trade()] })}</entries>`, AT_NVDA)
    assert.equal(out.reply, 'Three ways in.')
})

test('reopening a stage drops its CONTENT too — the ledger and the screen cannot disagree', async () => {
    const built = await turn(`<spans>${JSON.stringify(SPANS)}</spans><entries>${JSON.stringify({ trades: [trade()] })}</entries>`, AT_NVDA)
    assert.ok(built.setup.spans && built.setup.entries)

    // The user reopens the ways in. Without this, the gate is open again while the user is still
    // looking at the answers to it.
    const back = await turn('<build>{"unsettle":"entries"}</build>',
        { active_asset: 'NVDA', draft: built.setup, coverage: [] })
    assert.equal(back.setup.entries, undefined)
    assert.ok(back.setup.spans, 'the stage above it is untouched')

    // Reopening the spans takes the entries with it — they were built on those trades.
    const further = await turn('<build>{"unsettle":"spans"}</build>',
        { active_asset: 'NVDA', draft: built.setup, coverage: [] })
    assert.equal(further.setup.spans, undefined)
    assert.equal(further.setup.entries, undefined)
})

test('a reopen that arrives WITH the replacement keeps the replacement', async () => {
    const built = await turn(`<spans>${JSON.stringify(SPANS)}</spans><entries>${JSON.stringify({ trades: [trade()] })}</entries>`, AT_NVDA)
    const redone = await turn(
        `<entries>${JSON.stringify({ trades: [trade({ options: [opt(9, { label: 'the retest' })] })] })}</entries>`
        + '<build>{"unsettle":"entries"}</build>',
        { active_asset: 'NVDA', draft: built.setup, coverage: [] })
    assert.equal(redone.setup.entries.trades[0].options[0].label, 'the retest')
})
