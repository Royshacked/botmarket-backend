import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkElliottCount, formatElliottCheck, makeElliottHandlers } from '../../services/tools/elliott.tools.js'

// The Elliott rule check (proteus.md §8.1): an impossible count is never shown; a possible one carries the price that
// kills it.

test('the three hard rules: wave 2 past the start, wave 4 into wave 1, wave 3 the shortest', () => {
    assert.deepEqual(checkElliottCount({ direction: 'up', points: [100, 120, 98] }).broken, ['wave 2 retraced past the start of wave 1'])
    assert.deepEqual(checkElliottCount({ direction: 'up', points: [100, 120, 110, 140, 118] }).broken, ["wave 4 entered wave 1's price territory"])
    assert.deepEqual(checkElliottCount({ direction: 'up', points: [100, 120, 110, 125, 121, 140] }).broken, ['wave 3 is the shortest of waves 1, 3 and 5'])
    assert.deepEqual(checkElliottCount({ direction: 'up', points: [100, 120, 110, 118] }).broken, ['wave 3 did not go beyond the end of wave 1'])
})

test('a possible count states the price that kills it from here, and how far wave 5 may run', () => {
    const at2 = checkElliottCount({ direction: 'up', points: [100, 120, 108] })
    assert.deepEqual([at2.possible, at2.kills_at], [true, 100])
    const at4 = checkElliottCount({ direction: 'up', points: [100, 120, 110, 125, 121] })
    assert.deepEqual([at4.possible, at4.kills_at, at4.wave5_max], [true, 120, 136], 'wave 3 (15) < wave 1 (20): wave 5 under 15 too')
    const done = checkElliottCount({ direction: 'up', points: [100, 120, 110, 150, 130, 160] })
    assert.deepEqual([done.possible, done.kills_at, done.complete], [true, 160, true], 'complete: past the end of wave 5 it is still running')
    assert.match(formatElliottCheck(done), /complete as counted/)
})

test('a down count is the mirror; bad input is refused, not guessed', () => {
    const d = checkElliottCount({ direction: 'down', points: [100, 80, 92, 60, 75] })
    assert.deepEqual([d.possible, d.kills_at], [true, 80])
    assert.deepEqual(checkElliottCount({ direction: 'down', points: [100, 80, 101] }).broken, ['wave 2 retraced past the start of wave 1'])
    assert.ok(checkElliottCount({ direction: 'up', points: [100, 90] }).error)
    assert.ok(checkElliottCount({ direction: 'up', points: [100, 90, 95] }).error, 'wave 1 against the direction')
    assert.ok(checkElliottCount({ direction: 'sideways', points: [1, 2, 3] }).error)
})

test('the handler: an impossible count is told never to be shown', async () => {
    const out = await makeElliottHandlers({ deps: { fetchBars: async () => [] } }).check_elliott_count({ direction: 'up', points: [100, 120, 98] })
    assert.match(out, /^IMPOSSIBLE count .*Do not show/)
    assert.match(await makeElliottHandlers().check_elliott_count({ direction: 'up', points: [100, 120, 108] }), /POSSIBLE count \(up\).*dead beyond 100/)
})

// ── The candle check: the wave ends must BE on the chart ──
const mk = (hl) => hl.map(([high, low], i) => ({ open: low, high, low, close: high, volume: 1, timestamp: 1_760_000_000 + i * 86_400 }))
// An up impulse on the bars: start 100 (bar 1), w1 120 (3), w2 110 (5), w3 150 (8), w4 130 (10), then 135.
const IMPULSE = mk([[104, 102], [103, 100], [112, 103], [120, 111], [116, 112], [113, 110], [125, 112], [140, 124], [150, 139], [145, 135], [138, 130], [135, 131]])

test('a count whose wave ends are on the candles passes, each with its date', async () => {
    const { checkCountOnCandles } = await import('../../services/tools/elliott.tools.js')
    const c = checkCountOnCandles(IMPULSE, { direction: 'up', points: [100, 120, 110, 150, 130], kills_at: 120 })
    assert.deepEqual(c.problems, [])
    assert.deepEqual(c.found.map(f => f.at), [1, 3, 5, 8, 10].map(i => new Date((1_760_000_000 + i * 86_400) * 1000).toISOString().slice(0, 10)))
})

test('a misread price, a wave end that is not the extreme of its leg, a count already dead — each refused', async () => {
    const { checkCountOnCandles } = await import('../../services/tools/elliott.tools.js')
    assert.match(checkCountOnCandles(IMPULSE, { direction: 'up', points: [100, 120, 110, 160] }).problems[0], /the end of wave 3 \(160\) is not a high on these candles/)
    // w3 called at 140 (bar 7) — but bar 8 went to 150 before "wave 4" at 130: 140 was not the leg's top.
    assert.match(checkCountOnCandles(IMPULSE, { direction: 'up', points: [100, 120, 110, 140, 130] }).problems.join(' '), /price reached 150, above both/)
    // At wave 2 (kills under 100): a later low at 99 has already killed it.
    const dead = mk([[104, 102], [103, 100], [112, 103], [120, 111], [116, 110], [111, 99]])
    assert.match(checkCountOnCandles(dead, { direction: 'up', points: [100, 120, 110], kills_at: 100 }).problems[0], /already crossed 100 on .* the count is dead/)
    // Complete at 135? Not here — but a complete count whose wave 5 end was exceeded is out of date.
    const ran = mk([[104, 102], [103, 100], [112, 103], [120, 111], [116, 112], [113, 110], [125, 112], [150, 124], [145, 135], [138, 130], [160, 131], [170, 150]])
    assert.match(checkCountOnCandles(ran, { direction: 'up', points: [100, 120, 110, 150, 130, 160], kills_at: 160, complete: true }).problems[0], /past the end of wave 5 \(160\).*still running/)
})

test('the handler: the rules first, then the candles; a fetch failure says UNCHECKED, never passes', async () => {
    const { makeElliottHandlers } = await import('../../services/tools/elliott.tools.js')
    const ok = makeElliottHandlers({ deps: { fetchBars: async () => IMPULSE } }).check_elliott_count
    assert.match(await ok({ ticker: 'nvda', timeframe: 'day', direction: 'up', points: [100, 120, 110, 150, 130] }), /^POSSIBLE count.*On the candles: the start of wave 1 /)
    assert.match(await ok({ ticker: 'NVDA', timeframe: 'day', direction: 'up', points: [100, 120, 110, 160] }), /^NOT ON THE CHART/)
    const down = makeElliottHandlers({ deps: { fetchBars: async () => { throw new Error('429') } } }).check_elliott_count
    assert.match(await down({ ticker: 'NVDA', timeframe: 'day', direction: 'up', points: [100, 120, 110] }), /UNCHECKED: the candles could not be read \(429\)/)
    assert.match(await ok({ direction: 'up', points: [100, 120, 110] }), /UNCHECKED against the candles \(no ticker\)/)
})
