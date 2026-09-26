import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerdict, buildPack, flipTest, makeFlipHandler, FLIP_TOOL, FLIP_DESCRIPTION } from '../../services/flipTest.service.js'

// The blinded direction red-team (Phase 3 of docs/design/mentor-challenge.md).
//
// Almost everything here guards ONE property: the desk cannot influence what its own audit is shown.
// A flip test that could be fed a friendly case file is worse than no flip test, because it costs a
// model call and comes back as reassurance the user will believe.

const PACK = { rungs: ['1hr', 'day'], missing: [], text: 'STRUCTURE…', usable: true }

// ─── The verdict ──────────────────────────────────────────────────────────────

test('the three verdicts map to what they MEAN for the plan', () => {
    assert.equal(parseVerdict('VERDICT: this\nThe short case needs 232 to give way…'), 'stands')
    assert.equal(parseVerdict('VERDICT: neither\nBoth sides clear 1R…'), 'two_sided')
    assert.equal(parseVerdict('VERDICT: the_other\nThe daily CHoCH is down…'), 'reversed')
})

test('a verdict we cannot read is null, never a guess', () => {
    // The prose still reaches the desk; only the provenance is lost. Inventing one here would put a
    // verdict in the document that nobody returned.
    for (const junk of ['', null, undefined, 'The short case is weak.', 'VERDICT: maybe', 'VERDICT:']) {
        assert.equal(parseVerdict(junk), null, String(junk))
    }
    assert.equal(parseVerdict('verdict - THE_OTHER — the numbers favour it'), 'reversed', 'spelling is not meaning')
})

// ─── The pack ─────────────────────────────────────────────────────────────────

const fakeReaders = (calls = []) => ({
    _bars: async (t, tf) => { calls.push(['bars', t, tf]); return [{ close: 1 }] },
    _read: (name, t, tf) => `${name}@${tf}`,
    _indicators: async (args) => { calls.push(['ind', args.timeframe]); return `atr 3.1 (${args.indicators})` },
    _quote: async () => ({ price: 240 }),
})

test('the daily is always in the pack, whatever rung was named', () => {
    // A flip test run only on the rung the plan was drawn on could be steered by naming a friendly
    // timeframe. The daily is where the structure that decides a direction lives.
    return buildPack({ symbol: 'nvda', timeframe: '15min', ...fakeReaders() }).then(pack => {
        assert.deepEqual(pack.rungs, ['15min', 'day'])
        assert.match(pack.text, /get_structure@15min/)
        assert.match(pack.text, /get_structure@day/)
        assert.ok(pack.usable)
    })
})

test('a plan already drawn on the daily is not read twice', async () => {
    const calls = []
    const pack  = await buildPack({ symbol: 'NVDA', timeframe: 'day', ...fakeReaders(calls) })
    assert.deepEqual(pack.rungs, ['day'])
    assert.equal(calls.filter(c => c[0] === 'bars').length, 1)
})

test('the indicators are computed on the PLAN’s rung, not on the anchor', async () => {
    const calls = []
    await buildPack({ symbol: 'NVDA', timeframe: '1hr', ...fakeReaders(calls) })
    assert.deepEqual(calls.filter(c => c[0] === 'ind'), [['ind', '1hr']])
})

test('a failed read costs the pack one section and is NAMED', async () => {
    // A silently thinner pack is exactly the bias this service exists to remove: the judge would be
    // arguing from less than the desk had, and nobody would know which side that favoured.
    const readers = fakeReaders()
    const pack = await buildPack({
        symbol: 'NVDA', timeframe: '1hr', ...readers,
        _quote: async () => { throw new Error('provider down') },
    })
    assert.deepEqual(pack.missing, ['the live quote'])
    assert.ok(pack.usable, 'two structural reads are still worth attacking')
    assert.doesNotMatch(pack.text, /QUOTE/)
})

test('a pack with almost nothing in it is NOT usable', async () => {
    const pack = await buildPack({
        symbol: 'NVDA', timeframe: 'day',
        _bars: async () => [], _read: () => 'x',
        _quote: async () => { throw new Error('down') },
        _indicators: async () => { throw new Error('down') },
    })
    assert.equal(pack.usable, false)
    assert.deepEqual(pack.missing, ['the live quote', 'day candles', 'indicator values'])
})

// ─── The run ──────────────────────────────────────────────────────────────────

test('it argues the OTHER side, and the desk supplies no evidence at all', async () => {
    let seen = null
    const out = await flipTest({
        symbol: 'nvda', timeframe: '1hr', horizon: 'swing', direction: 'long',
        _pack: async () => PACK,
        _think: async (args) => { seen = args; return 'VERDICT: this\nweak.' },
    })
    assert.match(seen.question, /LONG on NVDA/)
    assert.match(seen.question, /case for the SHORT side/)
    assert.equal(seen.context, PACK.text, 'the pack, and nothing the model wrote')
    assert.match(seen.system, /strongest HONEST case for the opposite side/)
    assert.match(seen.system, /NO macro read, NO news/)
    assert.equal(out.verdict, 'stands')
})

test('a short plan gets the long case', async () => {
    let seen = null
    await flipTest({ symbol: 'NVDA', direction: 'short', _pack: async () => PACK, _think: async (a) => { seen = a; return '' } })
    assert.match(seen.question, /case for the LONG side/)
})

test('what the pack is missing rides along, so the judge knows what it is not seeing', async () => {
    let seen = null
    await flipTest({
        symbol: 'NVDA', direction: 'long',
        _pack: async () => ({ ...PACK, missing: ['indicator values'] }),
        _think: async (a) => { seen = a; return '' },
    })
    assert.match(seen.context, /NOT AVAILABLE: indicator values/)
})

test('no ticker or no direction runs nothing', async () => {
    let called = false
    const think = async () => { called = true; return '' }
    for (const args of [{ direction: 'long' }, { symbol: 'NVDA' }, { symbol: 'NVDA', direction: 'sideways' }]) {
        const out = await flipTest({ ...args, _pack: async () => PACK, _think: think })
        assert.equal(out.verdict, null)
        assert.match(out.text, /needs the ticker and the direction/)
    }
    assert.equal(called, false, 'a model call for a question that cannot be asked')
})

test('an unusable pack spends nothing and says the direction was NOT checked', async () => {
    let called = false
    const out = await flipTest({
        symbol: 'NVDA', direction: 'long',
        _pack: async () => ({ rungs: ['day'], missing: ['day candles'], text: '', usable: false }),
        _think: async () => { called = true; return 'VERDICT: this' },
    })
    assert.equal(called, false, 'nothing to attack the plan with — do not pay for an opinion')
    assert.equal(out.verdict, null)
    assert.match(out.text, /NOT checked/)
})

test('a pack that throws never becomes a verdict', async () => {
    const out = await flipTest({
        symbol: 'NVDA', direction: 'long',
        _pack: async () => { throw new Error('provider exploded') },
        _think: async () => 'VERDICT: this',
    })
    assert.equal(out.verdict, null)
    assert.match(out.text, /could not be gathered \(provider exploded\)/)
    assert.match(out.text, /Say so rather than implying it was/)
})

// ─── The handler ──────────────────────────────────────────────────────────────

test('ONE per turn — a second run is the desk shopping for the answer it wanted', async () => {
    let runs = 0
    const handler = makeFlipHandler({ _flipTest: async () => { runs++; return { text: 'ok', verdict: 'stands' } }, _record: () => {} })
    assert.equal(await handler({ symbol: 'NVDA', direction: 'long' }), 'ok')
    const second = await handler({ symbol: 'NVDA', direction: 'long' })
    assert.match(second, /already been attacked once/)
    assert.equal(runs, 1)
})

test('the verdict is handed to the SERVER, not left for the model to report', async () => {
    const recorded = []
    const handler = makeFlipHandler({
        onVerdict: (v) => recorded.push(v),
        _flipTest: async () => ({ text: 'VERDICT: neither …', verdict: 'two_sided' }),
        _record: () => {},
    })
    await handler({ symbol: 'NVDA', direction: 'long' })
    assert.deepEqual(recorded, ['two_sided'])
})

test('an unreadable verdict records nothing rather than something', async () => {
    const recorded = []
    const handler = makeFlipHandler({
        onVerdict: (v) => recorded.push(v),
        _flipTest: async () => ({ text: 'the short case is weak', verdict: null }),
        _record: () => {},
    })
    await handler({ symbol: 'NVDA', direction: 'long' })
    assert.deepEqual(recorded, [])
})

test('the spend books under its own tag, per desk', async () => {
    const booked = []
    const handler = makeFlipHandler({
        userId: 'u1', agent: 'mentor', _record: (...args) => booked.push(args),
        _flipTest: async ({ onUsage }) => { onUsage({ input: 10 }, 'claude-opus-5-5'); return { text: 'ok', verdict: 'stands' } },
    })
    await handler({ symbol: 'NVDA', direction: 'long' })
    assert.deepEqual(booked, [['u1', 'claude-opus-5-5', { input: 10 }, 'flip:mentor']])
})

test('nothing in the handler can take the turn down', async () => {
    // Same containment as the consult handler: a tool that throws costs the desk its whole reply.
    const thrower = makeFlipHandler({ _flipTest: async () => { throw new Error('boom') }, _record: () => {} })
    assert.match(await thrower({ symbol: 'NVDA', direction: 'long' }), /could not be run \(boom\)/)

    const badLedger = makeFlipHandler({
        _record: () => { throw new Error('ledger down') },
        _flipTest: async ({ onUsage }) => { onUsage({}, 'm'); return { text: 'ok', verdict: 'stands' } },
    })
    assert.equal(await badLedger({ symbol: 'NVDA', direction: 'long' }), 'ok')

    const badRecorder = makeFlipHandler({
        onVerdict: () => { throw new Error('consumer down') },
        _flipTest: async () => ({ text: 'ok', verdict: 'stands' }),
        _record: () => {},
    })
    assert.equal(await badRecorder({ symbol: 'NVDA', direction: 'long' }), 'ok')
})

// ─── The declaration ──────────────────────────────────────────────────────────

test('the description tells the desk it cannot feed its own audit', () => {
    assert.equal(FLIP_TOOL, 'flip_test')
    assert.match(FLIP_DESCRIPTION, /cannot influence what it is shown/)
    assert.match(FLIP_DESCRIPTION, /live` or `manual/, 'the offer rule is the cost control')
    assert.match(FLIP_DESCRIPTION, /never on a plan the user brought unless they ask/i)
})
