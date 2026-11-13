import { test } from 'node:test'
import assert from 'node:assert/strict'
import { behaviourBadge } from '../../services/tools/behaviourProfile.tools.js'
import { badgesFor, MAX_SYMBOLS } from '../../services/hotlistBehaviour.service.js'

// The Hotlist badge (docs/design/proteus.md §8.2, step 5): what a name obeys, in a word or two, on the timeframes the
// row's horizon trades on — from the stored profile, never computed on the request.

const tf = ({ holds = [], sweeps = false, obs = false } = {}) => ({
    indicators: Object.fromEntries(['ema20', 'sma50', 'sma200', 'vwap'].map(k => [k, { verdict: holds.includes(k) ? 'respects' : 'no' }])),
    false_breaks: { after_sweep: { verdict: sweeps ? 'respects' : 'no' } },
    order_blocks: { verdict: obs ? 'respects' : 'no' },
})

test('the badge reads the row\'s horizon: a swing on daily + weekly, a day trade on 5-minute + 1-hour', () => {
    const p = { timeframes: { '5min': tf({ holds: ['vwap'] }), '1hour': tf(), day: tf({ holds: ['sma50'] }), week: tf({ sweeps: true }) } }
    const swing = behaviourBadge(p, 'swing')
    assert.equal(swing.badge, '50 MA +1')
    assert.deepEqual(swing.holds, ['50 MA (daily)', 'sweeps lows (weekly)'])
    assert.match(swing.tip, /^Measured on the daily and weekly bars, it holds at: 50 MA \(daily\), sweeps lows \(weekly\)\. Click for the read\.$/)
    assert.equal(behaviourBadge(p, 'intraday').badge, 'VWAP')
    assert.equal(behaviourBadge(p, 'open').badge, 'VWAP', 'a day board column is a day trade')
    assert.equal(behaviourBadge(p, 'week').badge, '50 MA', 'the run-up week reads hourly and daily')
})

test('nothing holding is said plainly; no bars for the horizon → no badge at all', () => {
    const nothing = behaviourBadge({ timeframes: { day: tf(), week: tf() } }, 'long_term')
    assert.equal(nothing.badge, 'nothing')
    assert.match(nothing.tip, /nothing technical holds/)
    assert.equal(behaviourBadge({ timeframes: { day: tf() } }, 'intraday'), null, 'no 5-minute or hourly history')
    assert.equal(behaviourBadge(null, 'swing'), null)
    assert.equal(behaviourBadge({ timeframes: { day: tf({ holds: ['sma50'] }) } }, 'bogus').badge, '50 MA', 'an unknown horizon reads like a swing')
})

test('a list: stored profiles only; the names without one are queued once, sorted; junk dropped, capped, a failed read is one name', async () => {
    const queued = []
    const profiles = { NVDA: { timeframes: { day: tf({ holds: ['sma200'] }), week: tf() } } }
    const deps = {
        stored: async (s) => { if (s === 'BOOM') throw new Error('mongo blip'); return profiles[s] ?? null },
        queue: (syms, opts) => { queued.push({ syms, opts }); return syms.length },
    }
    const out = await badgesFor(['nvda', 'NVDA', 'tsla', 'amd', '', 'not a ticker!', 'BOOM'], 'week', deps)
    assert.equal(out.horizon, 'week')
    assert.equal(out.badges.NVDA.badge, '200 MA')
    assert.equal(out.badges.TSLA, null)
    assert.equal(out.badges.BOOM, null)
    assert.deepEqual(Object.keys(out.badges).sort(), ['AMD', 'BOOM', 'NVDA', 'TSLA'])
    assert.deepEqual(queued, [{ syms: ['AMD', 'TSLA'], opts: { source: 'hotlist_week' } }])
    assert.equal(out.queued, 2)
    const many = await badgesFor(Array.from({ length: 300 }, (_, i) => `S${i}`), 'nonsense', { stored: async () => null, queue: () => 0 })
    assert.equal(Object.keys(many.badges).length, MAX_SYMBOLS)
    assert.equal(many.horizon, 'swing')
})

test('the covered book is never queued from a look — it is profiled weekly (Roy, 2026-11-13, option b)', async () => {
    const { profileHouseBook } = await import('../../services/hotlistBehaviour.service.js')
    const queued = []
    const deps = { stored: async () => null, queue: (syms, opts) => { queued.push({ syms, opts }); return syms.length }, book: async () => ({
        swing: [{ symbol: 'nvda' }, { symbol: 'AMD' }], long_term: [{ symbol: 'NVDA' }, { symbol: 'MSFT' }, { symbol: 'bad ticker' }] }) }
    for (const h of ['swing', 'long_term', 'covered']) await badgesFor(['TSLA'], h, deps)
    assert.deepEqual(queued, [], 'a first look at Swing must not start ~25 minutes of FMP calls in market hours')
    await badgesFor(['TSLA'], 'week', deps)
    assert.deepEqual(queued.map(q => q.syms), [['TSLA']], 'the few names on This week / Intraday still queue on a look')
    queued.length = 0
    assert.equal(await profileHouseBook(deps), 3)
    assert.deepEqual(queued, [{ syms: ['AMD', 'MSFT', 'NVDA'], opts: { source: 'house_book_weekly' } }])
    assert.equal(await profileHouseBook({ ...deps, book: async () => { throw new Error('mongo down') } }), 0, 'never throws')
})
