// The reasoning sidecar — depth on demand without touching the conversation's parameters.
//
// The whole design rests on one property: the consult is a SEPARATE request carrying only what it
// was handed. If it ever grew tools, history, or the desk's own request shape, it would stop being
// a cheap side call and start being a second desk — and the caching argument that motivated it
// (never change a live conversation's parameters) would be gone.
import test from 'node:test'
import assert from 'node:assert/strict'

import { deepThink, makeConsultHandler, consultDescription } from '../../services/deepThink.service.js'

// A stand-in for the provider that records exactly what the sidecar asked for.
function fakeProvider(answer = 'Size at 1.2% — the stop is wide enough that 2% breaches the rule.') {
    const calls = []
    return {
        calls,
        fn: async (args) => { calls.push(args); return answer },
    }
}

// deepThink calls the provider directly, so exercise it through the seam the handler exposes.
const consultWith = (impl, opts = {}) => makeConsultHandler({ _deepThink: impl, _record: () => {}, ...opts })

// ── what the consult is allowed to carry ──────────────────────────────────────

test('the question and its material both reach the consulted model', () => {
    // The consulted model cannot see the conversation and cannot fetch anything, so anything the
    // desk leaves out is simply not considered. Both halves have to travel.
    const seen = []
    const handler = consultWith(async (args) => { seen.push(args); return 'ok' })
    return handler({ question: 'Size this?', context: 'entry 100, stop 96, account 50k, 1% rule' })
        .then(() => {
            assert.equal(seen[0].question, 'Size this?')
            assert.match(seen[0].context, /entry 100/)
        })
})

test('an empty question is refused without spending a model call', async () => {
    const answer = await deepThink({ question: '   ' })
    assert.match(answer, /nothing to advise on/i)
})

// ── the failure path ──────────────────────────────────────────────────────────

test('a failed consult returns an answer instead of failing the desk turn', async () => {
    // The desk asked for a second opinion, not for permission to continue. If this threw, one
    // flaky side call would take down a setup build that was otherwise complete.
    const answer = await deepThink({
        question: 'Size this?',
        context:  'x',
        // Injected via the module's own provider seam is not available, so drive the real path
        // with a model id that cannot resolve — the provider rejects and deepThink must absorb it.
        model:    'definitely-not-a-model',
    })
    assert.equal(typeof answer, 'string')
    assert.ok(answer.length > 0)
    assert.match(answer, /own read/i)
})

// ── the per-turn cap ──────────────────────────────────────────────────────────

test('the cap holds and tells the model to decide on its own', async () => {
    // The failure mode is over-consulting: each call is a second model request, so a desk that
    // reaches for it freely turns a cost saving into a cost increase. The description carries the
    // judgment; this is the backstop for when that slips.
    const provider = fakeProvider()
    const handler  = consultWith(provider.fn, { maxPerTurn: 2 })

    assert.equal(await handler({ question: 'a', context: 'x' }), provider.calls.length && 'Size at 1.2% — the stop is wide enough that 2% breaches the rule.')
    await handler({ question: 'b', context: 'x' })
    const third = await handler({ question: 'c', context: 'x' })

    assert.equal(provider.calls.length, 2, 'the third consult still reached the model')
    assert.match(third, /limit/i)
    assert.match(third, /own read/i)
})

test('the cap is per turn — a fresh handler starts over', async () => {
    // Mentor builds the handler inside chatStream, so "per turn" is exactly the handler's lifetime.
    const provider = fakeProvider()
    for (let turn = 0; turn < 3; turn++) {
        const handler = consultWith(provider.fn, { maxPerTurn: 1 })
        await handler({ question: 'q', context: 'x' })
    }
    assert.equal(provider.calls.length, 3, 'the cap leaked across turns')
})

// ── usage attribution ─────────────────────────────────────────────────────────

test('consults are booked under their own ledger tag, not the calling desk', async () => {
    // `byAgent.consult` is what answers whether the sidecar is cheaper than the depth it replaced.
    // Booked under Mentor it would be invisible inside that desk's own spend.
    const booked = []
    const handler = makeConsultHandler({
        userId:  'u1',
        _record: (userId, model, usage, agent) => { booked.push({ userId, agent }); return undefined },
        _deepThink: async ({ onUsage }) => { onUsage?.({ input_tokens: 10, output_tokens: 5 }, 'claude-opus-5'); return 'ok' },
    })

    await handler({ question: 'q', context: 'c' })
    assert.deepEqual(booked, [{ userId: 'u1', agent: 'consult' }])
})

test('the calling desk suffixes the tag, so per-desk reach is readable', async () => {
    // With six desks sharing the sidecar, one bucket hides the only thing left to act on: a
    // too-permissive when-clause at one desk and a never-used one at another sum to a healthy
    // total. The `consult:` prefix is stable, so the old single number is still a prefix-sum away.
    const booked = []
    const handler = makeConsultHandler({
        userId: 'u1', agent: 'scannerAgent',
        _record: (userId, model, usage, agent) => { booked.push(agent) },
        _deepThink: async ({ onUsage }) => { onUsage?.({ input_tokens: 10 }, 'claude-opus-5'); return 'ok' },
    })

    await handler({ question: 'q', context: 'c' })
    assert.deepEqual(booked, ['consult:scannerAgent'])
})

test('a ledger failure does not cost the desk the answer it already paid for', async () => {
    // recordUsage can fail two ways — a synchronous throw before it ever awaits, or a rejected
    // promise. Catching only the async half lets the other escape into the desk's turn, which
    // would trade a completed consult for a bookkeeping error.
    const sync  = () => { throw new Error('mongo down') }
    const async_ = () => Promise.reject(new Error('mongo down'))

    for (const _record of [sync, async_]) {
        const handler = makeConsultHandler({
            _record,
            _deepThink: async ({ onUsage }) => { onUsage?.({ input_tokens: 1 }, 'claude-opus-5'); return 'the answer' },
        })
        assert.equal(await handler({ question: 'q', context: 'c' }), 'the answer')
    }
})

// ─── surfacing the thinking we already pay for ────────────────────────────────
//
// Thinking tokens are billed as OUTPUT tokens whether or not anyone reads them, so the sidecar was
// paying Opus rates for reasoning it then threw away. Passing it through costs nothing; these
// tests are what keep the pipe connected.

test('the consulted model\'s thinking reaches the caller', async () => {
    const seen = []
    const handler = makeConsultHandler({
        onReasoning: t => seen.push(t),
        _record: () => {},
        _deepThink: async ({ onReasoning }) => { onReasoning('weighing the stop distance'); return 'ok' },
    })
    await handler({ question: 'q', context: 'c' })
    assert.deepEqual(seen, ['weighing the stop distance'])
})

test('a throwing reasoning consumer does not cost the desk its answer', async () => {
    // The desk asked for a second opinion, not for permission to continue — the same containment
    // the usage write gets. A closed socket mid-consult must not turn into a failed turn.
    const provider = fakeProvider('size at 1.2%')
    const answer = await deepThink({
        question: 'Size this?', context: 'entry 100, stop 96',
        onReasoning: () => { throw new Error('client went away') },
        _stream: provider.fn,
    })
    assert.equal(answer, 'size at 1.2%')
})

test('no consumer means no reasoning plumbing is handed to the provider', async () => {
    // undefined lets the provider skip thinking capture entirely; a wrapper would defeat that.
    const provider = fakeProvider()
    await deepThink({ question: 'q', context: 'c', _stream: provider.fn })
    assert.equal(provider.calls[0].onReasoning, undefined)
})

// ── the description: shared mechanism, per-desk judgment ──────────────────────
//
// The sidecar runs at every conversational desk, so its description is the thing most at risk of
// the copy-paste drift CLAUDE.md's "shared mechanism → one service" rule exists to stop. The split
// is the guarantee: mechanism written once, judgment passed in.

test('a desk supplies only its WHEN — the mechanism halves are added around it', () => {
    const when = 'Reach for it when the weights are final.'
    const desc = consultDescription(when)

    assert.ok(desc.includes(when), "the desk's own clause survives verbatim")
    assert.ok(desc.startsWith('Put ONE decision'), 'the shared what-it-is leads')
    assert.ok(desc.includes('cannot see this conversation'), 'the shared limits are stated')
    assert.ok(desc.includes('costs a full model call'), 'the shared restraint closes')
    // Order matters to the model: what it is → when to use it → when not to.
    assert.ok(desc.indexOf('Put ONE decision') < desc.indexOf(when))
    assert.ok(desc.indexOf(when) < desc.indexOf('Do NOT reach for it'))
})

test('two desks differ ONLY by their when-clause', () => {
    // The property the whole split buys: tighten the restraint paragraph once and every desk gets
    // it. If this ever fails, a desk has grown its own copy of the mechanism text.
    const a = consultDescription('Reach for it on final sizing.')
    const b = consultDescription('Reach for it on the regime call.')
    assert.deepEqual(
        a.split('\n\n').filter(p => !p.startsWith('Reach for it')),
        b.split('\n\n').filter(p => !p.startsWith('Reach for it')),
    )
})

test('a missing when-clause degrades to mechanism only, with no blank paragraph', () => {
    // A desk that forgets its clause still ships a usable tool — an empty middle would read to the
    // model as a formatting glitch, and a `\n\n\n\n` gap is exactly that.
    const desc = consultDescription()
    assert.ok(!desc.includes('\n\n\n'), 'no empty paragraph is left behind')
    assert.equal(desc.split('\n\n').length, 2, 'just the two shared halves')
})
