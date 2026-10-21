import { test } from 'node:test'
import assert from 'node:assert/strict'
import { oneTierPrompt, preEntrySystem, inPositionSystem } from '../../monitoring/talos.assess.js'

// THE PROMPT MATCHES THE TIER SWITCH (2026-10-21). With the cheap tier off — the default — every
// candle close is a full read (talos.tiers), so the countdown and `watch` route nothing. A prompt that
// still told Talos a cheap pass watches between its reads, and to pick long countdowns to save money,
// described a monitor that was not running. The one-tier text is DERIVED from the two-tier one, so
// these pin both what goes and what must stay.

for (const [name, system] of [['pre-entry', preEntrySystem], ['in-position', inPositionSystem]]) {
    test(`${name}, one tier: no countdown, no watch, no cheap pass — and it is told every close is read`, () => {
        const one = system(false)
        assert.doesNotMatch(one, /next_expensive_in/)
        assert.doesNotMatch(one, /"watch"/)
        assert.doesNotMatch(one, /cheap pass|numbers-only pass/)
        assert.match(one, /read IN FULL at the close of every candle/)
    })

    test(`${name}, one tier: the parts that still work are kept`, () => {
        const one = system(false)
        assert.match(one, /"guards" ARE THE PRICES THAT MUST NOT WAIT FOR A CANDLE/, 'the guard sweep still runs')
        assert.match(one, /"next_timeframe"/, 'the rung is still the model\'s to choose')
        assert.match(one, /HOW YOU LOOK/)
    })

    test(`${name}, two tiers: the original text, untouched`, () => {
        const two = system(true)
        assert.match(two, /"next_expensive_in" IS HOW FAR THIS IS FROM BEING DECIDABLE/)
        assert.match(two, /"watch" IS WHAT A NUMBERS-ONLY PASS SHOULD CHECK/)
        assert.equal(oneTierPrompt(two), system(false), 'one tier is exactly the derivation of two')
    })
}

test('pre-entry, one tier: the step-down still reads — it is the pacing that remains', () => {
    assert.match(preEntrySystem(false), /"ripe" IS WHETHER ONLY THE MOMENT IS LEFT/)
    assert.match(preEntrySystem(false), /"ripe":false/)
})

test('the derivation drops only whole paragraphs and the two answer fields', () => {
    const text = [
        'WHEN YOU ARE READ AGAIN. old pacing with a cheap pass.',
        '"next_expensive_in" IS a countdown.',
        '"watch" IS a cheap pass.',
        'KEEP ME.',
        '{"verdict":"wait","next_expensive_in":1,"watch":{"rung":"15min","indicators":["vwap","ema(20)"]},"guards":[]}',
    ].join('\n\n')
    const out = oneTierPrompt(text)
    assert.match(out, /^WHEN YOU ARE READ AGAIN\. You are read IN FULL/)
    assert.match(out, /KEEP ME\./)
    assert.match(out, /\{"verdict":"wait","guards":\[\]\}/)
    assert.doesNotMatch(out, /countdown\.|a cheap pass\./)
})
