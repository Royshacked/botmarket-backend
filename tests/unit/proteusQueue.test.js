import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { queueProfiles, queueState, _setDeps, _drained, _reset, RATE_LIMIT_PAUSE_MS, GAP_MS } from '../../services/proteusQueue.service.js'

// Proteus's measured profile, ahead of any ask (docs/design/proteus.md §4.4–4.5): one queue, one name at a time.

let profiled, slept
beforeEach(() => {
    _reset()
    profiled = []; slept = []
    _setDeps({
        profile: async (s) => { profiled.push(s); return {} },
        leader:  () => true,
        sleep:   async (ms) => { slept.push(ms) },
    })
})

test('names are profiled one at a time, in order, upper-cased, each once — a pause between names', async () => {
    assert.equal(queueProfiles(['tsla', 'NVDA', ' tsla ', '', null, 'AMD'], { source: 'hd_x' }), 3)
    assert.equal(queueProfiles(['NVDA', 'msft'], { source: 'house_scan' }), 1, 'NVDA is already waiting')
    await _drained()
    assert.deepEqual(profiled, ['TSLA', 'NVDA', 'AMD', 'MSFT'])
    assert.deepEqual(slept, [GAP_MS, GAP_MS, GAP_MS], 'a gap between names, none after the last')
    assert.deepEqual(queueState(), { waiting: [], running: false, done: 4, failed: 0 })
})

test('one at a time: the next name never starts before the last one finished', async () => {
    let inWork = 0, most = 0
    _setDeps({ profile: async () => { inWork++; most = Math.max(most, inWork); await new Promise(r => setImmediate(r)); inWork-- } })
    queueProfiles(['A', 'B', 'C'])
    await _drained()
    assert.equal(most, 1)
})

test('a name that fails is logged and skipped; the rest go on', async () => {
    _setDeps({ profile: async (s) => { profiled.push(s); if (s === 'BAD') throw new Error('no price history for BAD') } })
    queueProfiles(['BAD', 'GOOD'])
    await _drained()
    assert.deepEqual(profiled, ['BAD', 'GOOD'])
    assert.equal(queueState().failed, 1)
})

test('a rate limit pauses the queue and tries the SAME name again — a bad key moment is not a bad name', async () => {
    let first = true
    _setDeps({ profile: async (s) => { profiled.push(s); if (s === 'TSLA' && first) { first = false; throw Object.assign(new Error('429'), { status: 429 }) } } })
    queueProfiles(['TSLA', 'NVDA'])
    await _drained()
    assert.deepEqual(profiled, ['TSLA', 'TSLA', 'NVDA'])
    assert.equal(slept[0], RATE_LIMIT_PAUSE_MS)
    assert.equal(queueState().failed, 0)
})

test('not the loop leader → nothing is queued (the leader\'s boards and chain do it)', async () => {
    _setDeps({ leader: () => false })
    assert.equal(queueProfiles(['TSLA']), 0)
    await _drained()
    assert.deepEqual(profiled, [])
})

test('a name can be queued again once it has been profiled (next board, next week)', async () => {
    queueProfiles(['TSLA'])
    await _drained()
    assert.equal(queueProfiles(['TSLA']), 1)
    await _drained()
    assert.deepEqual(profiled, ['TSLA', 'TSLA'])
})

test('the house scan\'s picks are queued for their profile, and the scan\'s result passes through untouched', async () => {
    const { profileHousePicks } = await import('../../services/pythiaWeekly.service.js')
    const calls = []
    const house = { queued: [{ symbol: 'MU', subject: 'semis' }, { symbol: 'AMAT' }, {}], considered: 3 }
    assert.equal(profileHousePicks(house, (symbols, opts) => calls.push({ symbols, opts })), house)
    assert.deepEqual(calls, [{ symbols: ['MU', 'AMAT'], opts: { source: 'house_scan' } }])
    assert.equal(profileHousePicks(null, () => { throw new Error('down') }), null, 'nothing to queue, and a throwing queue is contained')
})
