// The monitors' shared read mechanics: how hard they may think, and how their prefix is cached.
//   node --test tests/unit/assessShared.test.js
//
// Both were set from the September 2026 ledger. Output was 46% of what Talos cost and the ONE user
// on `high` paid a third more per read than the users on `off`; cache WRITES were another 43%,
// because a prefix that is identical for every setup was re-written on nearly every wake — the
// wakes are paced by candle closes, which outlive the 5-minute default.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capEffort, ASSESS_MAX_EFFORT, ALLOWED_EFFORTS, ASSESS_PREFIX_CACHE, assessSystem,
    indicatorsText, formatCandles } from '../../monitoring/assess.shared.js'
import { _thinkingConfig } from '../../providers/anthropic.provider.js'

// ─── the effort cap ───────────────────────────────────────────────────────────

test('the cap is `low` — thinking, but the affordable kind', () => {
    assert.equal(ASSESS_MAX_EFFORT, 'low')
    assert.ok(ALLOWED_EFFORTS.has(ASSESS_MAX_EFFORT), 'the cap must be a real level or nothing could ever reach it')
})

test('a stored `high` reads as `low`; anything at or under the cap is untouched', () => {
    assert.equal(capEffort('high'), 'low')
    assert.equal(capEffort('low'),  'low')
    assert.equal(capEffort('off'),  'off')
})

test('an unknown or missing preference is `off`, exactly as before the cap', () => {
    assert.equal(capEffort(undefined), 'off')
    assert.equal(capEffort(null), 'off')
    assert.equal(capEffort('max'), 'off')
    assert.equal(capEffort(''), 'off')
})

test('lifting the cap is one argument — the user’s own choice comes back', () => {
    // The preference is never rewritten, so a premium tier that raises the ceiling restores what
    // the user actually chose rather than what the cap left them with.
    assert.equal(capEffort('high', 'high'), 'high')
    assert.equal(capEffort('high', 'off'), 'off')
})

test('at the cap, a read still thinks — on Sonnet 4.6 that is an explicit adaptive block', () => {
    // The point of capping to `low` rather than to `off`: the user asked for reasoning. On a model
    // that does not think unasked, `low` has to produce a thinking block or the cap silently
    // became an off-switch.
    const cfg = _thinkingConfig(capEffort('high'), 'claude-sonnet-4-6')
    assert.equal(cfg?.thinking?.type, 'adaptive')
    assert.equal(cfg?.output_config?.effort, 'low')
})

// ─── the prefix marker ────────────────────────────────────────────────────────

test('the assessment prefix is cached for an hour', () => {
    assert.deepEqual(ASSESS_PREFIX_CACHE, { type: 'ephemeral', ttl: '1h' })
})

test('the assessment system block is one text block carrying that marker', () => {
    // What Talos sends. The marker sits on the LAST block of the prefix, so tools + system are
    // cached together for the hour; `messages` after it keep the 5-minute tool-loop stamp, which
    // is the order the API requires (longer TTL first).
    const system = assessSystem('You are Talos…')
    assert.equal(system.length, 1)
    assert.equal(system[0].type, 'text')
    assert.equal(system[0].text, 'You are Talos…')
    assert.deepEqual(system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('the marker is frozen — it is spread into every request, and a mutation would be silent', () => {
    assert.ok(Object.isFrozen(ASSESS_PREFIX_CACHE))
    assert.throws(() => { 'use strict'; ASSESS_PREFIX_CACHE.ttl = '5m' })
})

// ─── The opening block carries NUMBERS, not just rows (2026-09-23) ─────────────
//
// docs/design/talos-two-tier.md §Phase 4.1. Measured before this change: 0 of 71 recorded reads
// declined to pull a tool, and 3.77 tools per read — the same rate the chart-first Talos ran at
// before the per-candle rewrite. A read handed nothing but OHLCV reaches for a picture.

const BARS = Array.from({ length: 60 }, (_, i) => ({
    timestamp: 1789673400 + i * 3600, open: 100 + i * 0.1, high: 101 + i * 0.1,
    low: 99 + i * 0.1, close: 100.5 + i * 0.1, volume: 1000 + i,
}))

test('the indicator block is computed from the bars in hand — no fetch, no tool, no model call', () => {
    const txt = indicatorsText('NVDA', BARS, '1hr')
    for (const want of ['ema(20)', 'ema(50)', 'rsi(14)', 'atr(14)']) {
        assert.ok(txt.includes(want), `missing ${want}`)
    }
})

test('VWAP is intraday-only — on a daily rung it is absent, not printed as n/a', () => {
    // The bars on a daily+ rung pre-date any session anchor, so the number would be noise wearing
    // a name. Absent is the honest answer.
    assert.ok(indicatorsText('NVDA', BARS, '1hr').includes('vwap'))
    assert.ok(!indicatorsText('NVDA', BARS, 'day').includes('vwap'))
    assert.ok(!indicatorsText('NVDA', BARS, 'week').includes('vwap'))
})

test('no bars is an empty block, never a block of nulls', () => {
    // _dataBlocks drops it on falsy, so a failed candle fetch costs the indicators and nothing else.
    assert.equal(indicatorsText('NVDA', [], '1hr'), '')
    assert.equal(indicatorsText('NVDA', null, '1hr'), '')
    assert.equal(formatCandles(null), '')
})

test('the indicator lines are the SAME format get_indicators returns', () => {
    // Both go through _formatIndicator. Two VWAPs that disagree is a bug nobody would ever find.
    const line = indicatorsText('NVDA', BARS, 'day').split('\n')[0]
    assert.match(line, /^ema\(20\): [\d.]+ \(prev [\d.]+, [\d.]+\)$/)
})

test('openingContext fetches the bars ONCE and returns both blocks off them', async () => {
    // The whole point of splitting candlesText: the indicators used to be a tool call that
    // re-fetched these same bars, for the same ticker and rung, seconds later.
    const { openingContext } = await import('../../monitoring/talos.assess.js')
    let fetches = 0
    const g = await openingContext({ asset: 'nvda', referenced_symbols: [] }, '1hr', {
        candleRows: async () => { fetches++; return BARS },
        quotes: async () => '',
    })
    assert.equal(fetches, 1, 'one fetch')
    assert.ok(g.candles.includes('O:100'), 'the rows are formatted')
    assert.ok(g.indicators.includes('ema(20)'), 'and the indicators come off the same bars')
})

test('a failed candle fetch costs both blocks and never kills the read', async () => {
    const { openingContext } = await import('../../monitoring/talos.assess.js')
    const g = await openingContext({ asset: 'nvda', referenced_symbols: [] }, '1hr', {
        candleRows: async () => { throw new Error('provider down') },
        quotes: async () => '',
    })
    assert.equal(g.candles, '')
    assert.equal(g.indicators, '')
})
