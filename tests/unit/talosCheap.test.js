// Talos's CHEAP tier (docs/design/talos-two-tier.md §Phase 3) — the numbers-only pass that decides
// whether the expensive read is worth paying for.
//   node --test tests/unit/talosCheap.test.js
//
// The load-bearing property is the ASYMMETRY of its failure modes. Being wrong towards "escalate"
// costs one read the user was going to pay for anyway; being wrong towards "sleep" costs them the
// trade. So every test here that looks paranoid is the paranoid direction on purpose.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    cheapRead, cheapWatch, normalizeCheapReply, buildCheapUserText, CHEAP_STATES, CHEAP_MODEL,
} from '../../monitoring/talos.cheap.js'
import { normalizeSetup } from '../../services/setup.schema.js'

const PLAN = {
    asset: 'NVDA', asset_class: 'stock', direction: 'long', type: 'swing',
    trade_mode: 'discretionary', timeframe: '1hr', market_cap: 'large',
    scenarios: [{
        id: 's1',
        entry_legs: [{ id: 'ez1', price: 238, quantity: 100 }],
        stop_legs:  [{ id: 'sz1', price: 234 }],
        conditions: [
            { id: 's1c1', text: '15min close above VWAP', weight: 'primary', mode: 'measured', persistence: 'live' },
            { id: 's1c2', text: 'a false break down at the prior daily low', weight: 'confirming', mode: 'judgment', persistence: 'latching' },
        ],
    }],
}
const SETUP = { id: 'setup_NVDA_1', userId: 'u1', ...normalizeSetup(PLAN) }

const BARS = Array.from({ length: 40 }, (_, i) => ({
    timestamp: 1789673400 + i * 3600, open: 238 + i * 0.01, high: 239, low: 237, close: 238.5, volume: 1000,
}))

/** A stub Anthropic reply carrying `obj` as its JSON text. */
const reply = (obj, usage = { input_tokens: 10, output_tokens: 5 }) => ({
    content: [{ type: 'text', text: JSON.stringify(obj) }], usage,
})

const deps = (send) => ({ rows: async () => BARS, send })

// ─── normalizeCheapReply ──────────────────────────────────────────────────────

const DECLARED = [{ id: 's1c1' }, { id: 's1c2' }]

test('every declared condition comes back, whatever the model chose to mention', () => {
    const out = normalizeCheapReply({ conditions: [{ id: 's1c1', state: 'not_fired' }] }, DECLARED)
    assert.equal(out.conditions.length, 2)
    assert.equal(out.conditions[1].id, 's1c2')
    assert.equal(out.conditions[1].state, 'unknown', 'a condition it did not answer is unknown, not absent')
})

test('an off-menu state is unknown — never quietly not_fired', () => {
    for (const bad of ['met', 'yes', 'no', null, 42, undefined]) {
        const out = normalizeCheapReply({ conditions: [{ id: 's1c1', state: bad }] }, [{ id: 's1c1' }])
        assert.equal(out.conditions[0].state, 'unknown', String(bad))
    }
    assert.deepEqual(CHEAP_STATES, ['fired', 'not_fired', 'unknown'])
})

test('THE MODEL CANNOT DECLINE TO ESCALATE — fired or unknown forces it', () => {
    const declined = (states) => normalizeCheapReply(
        { escalate: false, conditions: states.map((s, i) => ({ id: DECLARED[i].id, state: s })) },
        DECLARED).escalate

    assert.equal(declined(['fired', 'not_fired']), true, 'fired forces a read')
    assert.equal(declined(['unknown', 'not_fired']), true, 'so does unknown')
    assert.equal(declined(['not_fired', 'not_fired']), false, 'only all-clear sleeps')
})

test('the model MAY escalate for its own reasons even with everything clear', () => {
    const out = normalizeCheapReply(
        { escalate: true, conditions: DECLARED.map(d => ({ id: d.id, state: 'not_fired' })) }, DECLARED)
    assert.equal(out.escalate, true)
})

test('a junk reply escalates rather than reading as all-clear', () => {
    for (const junk of [null, undefined, {}, { conditions: null }, { conditions: 'nope' }]) {
        assert.equal(normalizeCheapReply(junk, DECLARED).escalate, true, JSON.stringify(junk))
    }
})

// ─── cheapWatch ───────────────────────────────────────────────────────────────

test('the watched rung is what the last EXPENSIVE read declared', () => {
    const w = cheapWatch({ ...SETUP, watch: { rung: '15min', indicators: ['vwap'] } })
    assert.deepEqual(w, { rung: '15min', indicators: ['vwap'] })
})

test('with nothing declared it falls to the stored rung, then the premise', () => {
    // The fallback exists so this tier is usable before the expensive read learns to declare a
    // watch at all.
    assert.equal(cheapWatch({ ...SETUP, monitor_state: { timeframe: '4hr' } }).rung, '4hr')
    assert.equal(cheapWatch(SETUP).rung, '1hr', 'the premise')
    assert.ok(cheapWatch({ type: 'swing', market_cap: 'large' }).rung, 'a bare setup still has a rung')
})

// ─── the user turn ────────────────────────────────────────────────────────────

test('the user turn carries the conditions verbatim, with their ids', () => {
    const txt = buildCheapUserText(SETUP, {
        scenario: SETUP.scenarios[0], conditions: SETUP.scenarios[0].conditions,
        rung: '1hr', candles: 'rows', indicators: 'ema(20): 1', price: 238,
    })
    assert.ok(txt.includes('[s1c1]'))
    assert.ok(txt.includes('15min close above VWAP'), 'the sentence, not a parse of it')
    assert.ok(txt.includes('CURRENT PRICE: 238'))
    assert.ok(txt.includes('ema(20): 1'))
})

test('a settled latching condition is shown as settled and never re-asked', () => {
    const withLedger = { ...SETUP, monitor_state: { conditions: { s1c2: { met: true, at: '2026-09-20T10:00:00Z' } } } }
    const txt = buildCheapUserText(withLedger, {
        scenario: SETUP.scenarios[0], conditions: SETUP.scenarios[0].conditions,
        rung: '1hr', candles: '', indicators: '', price: 238,
    })
    assert.match(txt, /\[s1c2\][\s\S]*ALREADY ESTABLISHED on 2026-09-20/)
})

// ─── cheapRead ────────────────────────────────────────────────────────────────

test('an all-clear read sleeps', async () => {
    const out = await cheapRead(SETUP, { price: 238 }, deps(async () => reply({
        escalate: false, read: 'Nothing has moved.',
        conditions: [{ id: 's1c1', state: 'not_fired' }, { id: 's1c2', state: 'not_fired' }],
    })))
    assert.equal(out.escalate, false)
    assert.equal(out.read, 'Nothing has moved.')
    assert.equal(out._model, CHEAP_MODEL)
})

test('it sends NO tools — that is what makes the prefix cache worth having', async () => {
    let sent = null
    await cheapRead(SETUP, { price: 238 }, deps(async (req) => { sent = req; return reply({ conditions: [] }) }))
    assert.equal(sent.tools, undefined)
    assert.ok(Array.isArray(sent.system), 'the frozen system block carries the cache marker')
    assert.equal(sent.system[0].cache_control.ttl, '1h')
})

test('an unparseable reply escalates, with its own reason', async () => {
    const out = await cheapRead(SETUP, { price: 238 },
        deps(async () => ({ content: [{ type: 'text', text: 'I think probably not.' }], usage: {} })))
    assert.equal(out.escalate, true)
    assert.equal(out._failReason, 'unparseable')
})

test('a dead provider escalates rather than failing the wake', async () => {
    const out = await cheapRead(SETUP, { price: 238 }, deps(async () => { throw new Error('502') }))
    assert.equal(out.escalate, true)
    assert.equal(out._failReason, 'io')
})

test('a failed candle fetch still runs the read — it just has less to go on', async () => {
    let sent = null
    const out = await cheapRead(SETUP, { price: 238 }, {
        rows: async () => { throw new Error('provider down') },
        send: async (req) => { sent = req; return reply({ conditions: [{ id: 's1c1', state: 'unknown' }] }) },
    })
    assert.ok(sent, 'the model was still asked')
    assert.equal(out.escalate, true, 'and with no numbers it can only say unknown')
})

test('a setup with no conditions in words escalates — there is nothing here to judge', async () => {
    const bare = { ...SETUP, conditions: [], scenarios: [{ ...SETUP.scenarios[0], conditions: [] }] }
    let called = false
    const out = await cheapRead(bare, { price: 238 }, deps(async () => { called = true; return reply({}) }))
    assert.equal(out.escalate, true)
    assert.equal(out._failReason, 'no_conditions')
    assert.equal(called, false, 'and it does not spend a model call to find that out')
})

test('the spend is booked under its OWN agent key, so the two tiers are separable', async () => {
    // The cost pass of 2026-09-20 was written because two lines were invisible in the ledger.
    const { bookAssessUsage } = await import('../../monitoring/assess.shared.js')
    assert.equal(typeof bookAssessUsage, 'function')
    // The call itself is fire-and-forget inside cheapRead; what is pinned here is that the tier has
    // a distinct key at all, checked by reading the module source rather than the ledger.
    const src = await import('node:fs').then(fs => fs.promises.readFile('monitoring/talos.cheap.js', 'utf8'))
    assert.match(src, /bookAssessUsage\([^)]*'talosCheap'\)/)
})
