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
    const out = await makeElliottHandlers().check_elliott_count({ direction: 'up', points: [100, 120, 98] })
    assert.match(out, /^IMPOSSIBLE count .*Do not show/)
    assert.match(await makeElliottHandlers().check_elliott_count({ direction: 'up', points: [100, 120, 108] }), /POSSIBLE count \(up\).*dead beyond 100/)
})
