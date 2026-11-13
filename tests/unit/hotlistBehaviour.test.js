import { test } from 'node:test'
import assert from 'node:assert/strict'
import { behaviourBadge } from '../../services/tools/behaviourProfile.tools.js'
import { rowProfile } from '../../services/tools/behaviourProfile.tools.js'
import { profileRow, profileHouseBook } from '../../services/hotlistBehaviour.service.js'

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

test('nothing holds → the trait it DOES have, on the horizon\'s first timeframe: how often its low-breaks fake (Roy, 2026-11-13, option 2)', () => {
    const faking = (rate, breaks = 40) => ({ ...tf(), atr_pct: 0.51, false_breaks: { breaks, false_rate: rate, sweep_depth_atr: { median: 0.24, p80: 0.5 }, after_sweep: { verdict: 'no' } } })
    const b = behaviourBadge({ timeframes: { '5min': faking(0.744), '1hour': faking(0.71) } }, 'intraday')
    assert.deepEqual({ badge: b.badge, kind: b.kind, holds: b.holds }, { badge: 'fakes 74%', kind: 'trait', holds: [] })
    assert.equal(b.tip, 'Nothing technical holds on the 5-minute and 1-hour bars. What it does: 74% of its 40 breaks of a 5-minute swing low closed back above within 3 bars, sweeping ~0.24 ATR under the low. 5-minute ATR 0.51%. Click for the read.')
    assert.equal(behaviourBadge({ timeframes: { day: faking(0.77), week: faking(0.6) } }, 'swing').badge, 'fakes 77%', 'a swing reads its daily breaks')
    const holding = behaviourBadge({ timeframes: { day: { ...faking(0.77), indicators: { sma50: { verdict: 'respects' } } }, week: faking(0.6) } }, 'swing')
    assert.deepEqual([holding.badge, holding.kind], ['50 MA', 'holds'], 'a line that holds is the badge — the trait is only for when nothing does')
    assert.equal(behaviourBadge({ timeframes: { day: faking(null, 0), week: tf() } }, 'swing').kind, 'nothing', 'no breaks measured → nothing to say but "nothing"')
})

test('an opened row shows how the name trades on its horizon: what holds or what it does, the latest example, ATR, fit (proteus.md §8.1)', () => {
    const fb = (rate, breaks = 40) => ({ breaks, false_rate: rate, recent: { false_rate: 0.7 }, bars_to_direction: 3, sweep_depth_atr: { median: 0.24, p80: 0.53 },
        latest: { at: '2026-11-12T05:00:00.000Z', reclaimed_at: '2026-11-12T05:00:00.000Z', level: 151.49, swept_to: 148.8, depth_atr: 0.27 }, after_sweep: { verdict: 'no' } })
    const p = { timeframes: { day: { ...tf(), atr_pct: 2.99, gap_pct: 1.15, false_breaks: fb(0.768) }, week: { ...tf(), atr_pct: 7.47, false_breaks: fb(0.6, 12) } },
        suitability: { day_trade: { fits: true, why: 'moves, liquid, and nothing technical holds' }, swing: { fits: true, why: 'moves and liquid, but nothing technical holds' } } }
    const row = rowProfile(p, 'swing')
    assert.deepEqual(row.headline, { text: 'fakes 77%', kind: 'trait' })
    assert.deepEqual(row.on, ['day', 'week'])
    assert.deepEqual(Object.fromEntries(row.lines), {
        'What it obeys': 'Nothing technical holds on the daily and weekly bars.',
        'Daily breaks of a low': '77% of 40 closed back above within 3 bars (recent 70%); sweeps ~0.24 ATR under the low (80% within 0.53); a direction ~3 bars after.',
        'Weekly breaks of a low': '60% of 12 closed back above within 3 bars (recent 70%); sweeps ~0.24 ATR under the low (80% within 0.53); a direction ~3 bars after.',
        'Latest example': '2026-11-12 the swing low 151.49 was swept to 148.8 (0.27 ATR under), closed back above 2026-11-12.',
        'ATR': 'Daily 2.99% · Weekly 7.47% · typical gap 1.15%',
        'Fits': 'Day trade yes · swing yes — moves and liquid, but nothing technical holds.',
    })
    const holding = rowProfile({ timeframes: { day: { ...tf({ holds: ['sma50'] }), atr_pct: 3 }, week: tf() } }, 'swing')
    assert.equal(holding.lines[0][1], '50 MA (daily)')
    assert.equal(rowProfile({ timeframes: { day: tf() } }, 'intraday'), null, 'no bars for the horizon')
})

test('opening a row: computed when not stored, and every failure is a reason, never a throw', async () => {
    const ok = await profileRow('nvda', 'swing', { profile: async () => ({ computed_at: '2026-11-13T01:00:00Z', timeframes: { day: { ...tf(), atr_pct: 3 }, week: tf() } }) })
    assert.equal(ok.symbol, 'NVDA')
    assert.equal(ok.computed_at, '2026-11-13T01:00:00Z')
    assert.equal(ok.headline.text, 'nothing')
    assert.deepEqual(await profileRow('not a ticker!', 'swing', {}), { symbol: 'NOT A TICKER!', horizon: 'swing', reason: 'bad_symbol' })
    assert.equal((await profileRow('ZZZ', 'swing', { profile: async () => { throw new Error('no price history for ZZZ') } })).reason, 'no_history')
    assert.equal((await profileRow('ZZZ', 'intraday', { profile: async () => ({ timeframes: { day: tf() } }) })).reason, 'too_short')
    assert.equal((await profileRow('ZZZ', 'bogus', { profile: async () => ({ timeframes: { day: tf(), week: tf() } }) })).horizon, 'swing')
})

test('the covered book is profiled weekly, deduplicated and sorted, never throwing (Roy, 2026-11-13, option b)', async () => {
    const queued = []
    const deps = { queue: (syms, opts) => { queued.push({ syms, opts }); return syms.length }, book: async () => ({
        swing: [{ symbol: 'nvda' }, { symbol: 'AMD' }], long_term: [{ symbol: 'NVDA' }, { symbol: 'MSFT' }, { symbol: 'bad ticker' }] }) }
    assert.equal(await profileHouseBook(deps), 3)
    assert.deepEqual(queued, [{ syms: ['AMD', 'MSFT', 'NVDA'], opts: { source: 'house_book_weekly' } }])
    assert.equal(await profileHouseBook({ ...deps, book: async () => { throw new Error('mongo down') } }), 0)
})
