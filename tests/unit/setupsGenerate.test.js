import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSetup, SETUP_STATUSES } from '../../api/setups/setups.service.js'
import { normalizeSetup } from '../../services/setup.schema.js'
import { resolveMode } from '../../services/venue.resolve.service.js'

// The Generate gate — the boundary where a chat draft becomes a monitored, executable document.
// Everything that gets through here can place a real order, so each rejection below is the last
// thing standing between a half-built draft and the broker.

const DRAFT = {
    asset: 'NVDA', direction: 'long', type: 'swing', trade_mode: 'smc', timeframe: '1hr',
    thesis: 'Sweep and reclaim.',
    watch: [{ kind: 'structure', look_for: 'CHoCH up', timeframe: '15min', weight: 'primary' }],
    entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
    stop_zones:  [{ lower: 234.8, upper: 235.9, quantity: 100 }],
    tp_zones:    [{ lower: 246.0, upper: 247.2, quantity: 100 }],
}
const ACCTS = [{ id: 'a1', broker: 'ctrader' }]

test('a complete setup on a marked account passes the gate', () => {
    assert.deepEqual(validateSetup(normalizeSetup(DRAFT), 'ctrader', ACCTS), { ok: true })
})

test('an unsized setup is rejected — an order needs a quantity', () => {
    const s = normalizeSetup({ ...DRAFT, entry_zones: [{ lower: 237.8, upper: 238.6 }] })
    assert.equal(validateSetup(s, 'ctrader', ACCTS).reason, 'missing_quantity')
})

test('a setup with no stop zone never reaches the broker', () => {
    const s = normalizeSetup({ ...DRAFT, stop_zones: [] })
    assert.equal(validateSetup(s, 'ctrader', ACCTS).reason, 'missing_stop_zone')
})

test('a setup with no entry zone is rejected', () => {
    const s = normalizeSetup({ ...DRAFT, entry_zones: [] })
    assert.equal(validateSetup(s, 'ctrader', ACCTS).ok, false)
})

test('direction and horizon are required — the monitor keys both off them', () => {
    assert.equal(validateSetup(normalizeSetup({ ...DRAFT, direction: null }), 'ctrader', ACCTS).reason, 'missing_direction')
    assert.equal(validateSetup(normalizeSetup({ ...DRAFT, type: null }), 'ctrader', ACCTS).reason, 'missing_horizon')
})

test('an unknown broker is no venue', () => {
    for (const b of [null, undefined, 'robinhood', '']) {
        assert.equal(validateSetup(normalizeSetup(DRAFT), b, ACCTS).reason, 'no_venue', String(b))
    }
})

test('live and manual need a marked account; paper derives its own', () => {
    assert.equal(validateSetup(normalizeSetup(DRAFT), 'ctrader', []).reason, 'no_venue')
    assert.equal(validateSetup(normalizeSetup(DRAFT), 'manual', []).reason, 'no_venue')
    assert.equal(validateSetup(normalizeSetup(DRAFT), 'paper', []).ok, true, 'paper needs no marked account')
})

test('an inverted zone is refused rather than armed as a gate that can never trip', () => {
    // normalizeSetup sorts edges, so reaching the gate inverted means it was bypassed.
    const s = normalizeSetup(DRAFT)
    s.entry_zones[0] = { ...s.entry_zones[0], lower: 240, upper: 238 }
    assert.equal(validateSetup(s, 'ctrader', ACCTS).reason, 'invalid_zone')
})

test('a zero-width zone is allowed — it is an exact level, not a broken band', () => {
    const s = normalizeSetup({ ...DRAFT, stop_zones: [{ price: 235, quantity: 100 }] })
    assert.equal(validateSetup(s, 'ctrader', ACCTS).ok, true)
})

test('the workspace mode is derived from the venue, never authored', () => {
    assert.equal(resolveMode({ broker: 'paper' }), 'paper')
    assert.equal(resolveMode({ broker: 'manual' }), 'manual')
    assert.equal(resolveMode({ broker: 'ctrader' }), 'live')
    assert.equal(resolveMode({ broker: null }), 'live', 'unknown venue defaults to real money, not paper')
})

test('a setup speaks the ONE shared ladder — no private words', () => {
    // The reconciler matches kind-blind on these names, so they must exist here verbatim.
    for (const s of ['waiting', 'looking', 'hit', 'long', 'short', 'closed']) {
        assert.ok(SETUP_STATUSES.has(s), s)
    }
    // Every synonym this kind grew and shed. Each existed for a while and each broke a gate:
    // `unarmed`/`ready` left MainPage confirming on a status nothing wrote, `watching` left the
    // Setups hub counting zero, and `in_position` was never a setup word at all.
    for (const dead of ['unarmed', 'watching', 'ready', 'in_position']) {
        assert.equal(SETUP_STATUSES.has(dead), false, `setups must not speak '${dead}'`)
    }
    // Price sitting inside a zone is armed_zone_id on a `looking` setup — a detail, not a rung.
    assert.ok(SETUP_STATUSES.has('looking'))
})
