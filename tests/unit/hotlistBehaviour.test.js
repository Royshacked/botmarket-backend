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

test('nothing holds → the headline is its DAILY ATR, never the false-break rate; a rate that beats chance holds (Roy, 2026-11-13)', () => {
    const fb = (rate, chance) => ({ breaks: 40, false_rate: rate, sweep_depth_atr: { median: 0.24, p80: 0.5 }, after_sweep: { verdict: 'no' }, chance })
    const p = { timeframes: { '5min': { ...tf(), atr_pct: 0.51, false_breaks: fb(0.744, { verdict: 'chance', base: 0.79, z: -1.1 }) }, '1hour': tf(), day: { ...tf(), atr_pct: 3.02 } } }
    const b = behaviourBadge(p, 'intraday')
    assert.deepEqual({ badge: b.badge, kind: b.kind }, { badge: 'ATR 3.02%/day', kind: 'trait' }, 'noise is never a headline')
    assert.match(b.tip, /^Nothing technical holds on the 5-minute and 1-hour bars\. It moves ~3\.02% a day\./)
    const noDaily = behaviourBadge({ timeframes: { '5min': { ...tf(), atr_pct: 0.51 }, '1hour': tf() } }, 'intraday')
    assert.equal(noDaily.badge, 'ATR 0.51% per 5-minute bar')
    const faking = behaviourBadge({ timeframes: { day: { ...tf(), atr_pct: 3, false_breaks: fb(0.9, { verdict: 'more', base: 0.78, z: 4.1 }) }, week: tf() } }, 'swing')
    assert.deepEqual([faking.badge, faking.kind], ['fakes its lows', 'holds'], 'a rate that BEATS chance is the stock\'s own — it holds')
    const running = behaviourBadge({ timeframes: { day: { ...tf(), atr_pct: 3, false_breaks: fb(0.5, { verdict: 'less', base: 0.78, z: -5 }) }, week: tf() } }, 'swing')
    assert.equal(running.badge, 'breaks follow through')
})

test('an opened row shows how the name trades on its horizon: what holds, the breaks against chance, the stop room, the latest example, ATR, fit (proteus.md §8.1)', () => {
    const fb = (rate, breaks = 40) => ({ breaks, false_rate: rate, recent: { false_rate: 0.7 }, bars_to_direction: 3, sweep_depth_atr: { median: 0.24, p80: 0.53 },
        latest: { at: '2026-11-12T05:00:00.000Z', reclaimed_at: '2026-11-12T05:00:00.000Z', level: 151.49, swept_to: 148.8, depth_atr: 0.27 }, after_sweep: { verdict: 'no' },
        chance: { verdict: 'chance', base: 0.79, z: -0.8 } })
    const p = { timeframes: { day: { ...tf(), atr_pct: 2.99, gap_pct: 1.15, false_breaks: fb(0.768) }, week: { ...tf(), atr_pct: 7.47, false_breaks: { ...fb(0.6, 12), chance: { verdict: 'thin', base: null, z: null } } } },
        suitability: { day_trade: { fits: true, why: 'moves, liquid, and nothing technical holds' }, swing: { fits: true, why: 'moves and liquid, but nothing technical holds' } } }
    const row = rowProfile(p, 'swing')
    assert.deepEqual(row.headline, { text: 'ATR 2.99%/day', kind: 'trait' })
    assert.deepEqual(row.on, ['day', 'week'])
    assert.deepEqual(Object.fromEntries(row.lines), {
        'What it obeys': 'Nothing technical holds on the daily and weekly bars.',
        'Daily breaks of a low': '77% of 40 closed back above within 3 bars — about what its own moves in random order do (79%): no trait of its own; sweeps ~0.24 ATR under the low (80% within 0.53) — how far noise pokes under a low; a direction ~3 bars after.',
        'Weekly breaks of a low': '60% of 12 closed back above within 3 bars — too few breaks to tell it from chance; sweeps ~0.24 ATR under the low (80% within 0.53) — how far noise pokes under a low; a direction ~3 bars after.',
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
    assert.equal(ok.headline.text, 'ATR 3%/day')
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

test('Wyckoff in the opened row and the tool text: the range now, each verdict against its baseline, a spring HOLDS only when it beats both (proteus.md §8.1)', async () => {
    const { wyckoffWords, wyckoffLines } = await import('../../services/tools/behaviourProfile.tools.js')
    const s = (verdict, rate, base, extra = {}) => ({ verdict, n: 30, rate, base, z: 1.2, recent: { n: 10, rate, base }, ...extra })
    const w = {
        ranges: 40, current: { low: 140.2, high: 151.8, since: '2026-10-20T00:00:00.000Z' },
        springs: s('no', 0.5, 0.45, { vs_sweeps: { rate: 0.5, base: 0.48, base_n: 60, z: 0.3, verdict: 'no' } }),
        breakouts: s('no', 0.52, 0.47, { upthrust_rate: 0.6 }), dry_up: s('thin', 0.6, 0.5),
    }
    assert.equal(wyckoffWords(w), 'In a range 140.2–151.8 since 2026-10-20. Springs: no edge (50% vs 45% for any bar, 48% for an ordinary false break). Range breakouts: no edge (52% vs 47%).')
    assert.ok(!/fell back|upthrust/.test(wyckoffWords(w)), 'the upthrust share is noise-level — never in the row')
    assert.equal(wyckoffWords({ ranges: 0 }), null)
    const holding = wyckoffWords({ ...w, current: null, springs: s('respects', 0.7, 0.45, { vs_sweeps: { base: 0.5, verdict: 'respects' } }) })
    assert.match(holding, /^Springs hold: 70% vs 45% for any bar, 50% for an ordinary false break\./)
    const lines = wyckoffLines(w)
    assert.match(lines[0], /40 trading ranges.*NOW in a range 140\.2–151\.8 since 2026-10-20/)
    assert.match(lines[1], /a spring HOLDS only when it beats both/)
    assert.match(lines[2], /60% closed back inside.*noise does 50–65% too/)
    assert.deepEqual(wyckoffLines({ ranges: 0 }), ['  Wyckoff: no tight trading range in this history'])
    // A spring that holds is a badge word like any other.
    const b = behaviourBadge({ timeframes: { day: { ...tf(), atr_pct: 3, wyckoff: { springs: { verdict: 'respects' } } }, week: tf() } }, 'swing')
    assert.deepEqual([b.badge, b.kind], ['Wyckoff springs', 'holds'])
})

test('Fibonacci in the opened row: measured against other depths, said plainly either way', async () => {
    const { fibWords, fibLine } = await import('../../services/tools/behaviourProfile.tools.js')
    const f = (verdict, rate, base) => ({ impulses: 50, verdict, n: 60, rate, base, z: 0.2, recent: { n: 20, rate, base } })
    assert.equal(fibWords(f('no', 0.52, 0.5)), 'Pullbacks turn at 38.2/50/61.8% no more than at other depths (52% vs 50% at other depths, 60 touches).')
    assert.match(fibWords(f('respects', 0.7, 0.5)), /^Pullbacks turn at 38\.2\/50\/61\.8% more than at other depths/)
    assert.equal(fibWords({ ...f('thin', 0.5, 0.5) }), null)
    assert.equal(fibWords({ impulses: 0 }), null)
    assert.match(fibLine(f('no', 0.52, 0.5)), /Fibonacci pullbacks \(38\.2\/50\/61\.8% of 50 impulses of 4\+ ATR/)
    const b = behaviourBadge({ timeframes: { day: { ...tf(), atr_pct: 3, fib: { verdict: 'respects' } }, week: tf() } }, 'swing')
    assert.equal(b.badge, 'Fibonacci pullbacks')
})

test('Fibonacci: a wide gap that did not clear z is a near-miss, not "no more" (KO daily, 2026-11-13)', async () => {
    const { fibWords } = await import('../../services/tools/behaviourProfile.tools.js')
    assert.equal(fibWords({ impulses: 72, verdict: 'no', n: 64, rate: 0.781, base: 0.628, z: 2.13 }),
        'Pullbacks turned at 38.2/50/61.8% more often (78% vs 63% at other depths, 64 touches, z 2.13) — a near-miss: not enough to rule out chance.')
})

test("the trader's read (5b): what holds priced now, what never to lean on, the range, Fibonacci and the cycle only when they hold, the stop's room", async () => {
    const { mentorRead } = await import('../../services/tools/behaviourProfile.tools.js')
    const room = { breaks: 135, by_buffer: { 0.2: { stopped_share: 0.741, whipsaw: 0.67 }, 0.5: { stopped_share: 0.42, whipsaw: 0.42 }, 1: { stopped_share: 0.252, whipsaw: 0.176 } } }
    const nothing = mentorRead({ timeframes: { day: { ...tf(), atr_pct: 2.99, stop_room: room, wyckoff: { current: { low: 140.2, high: 151.8, since: '2026-10-20T00:00:00.000Z' } }, fib: { verdict: 'no', latest_impulse: { low: 100, high: 150 } } }, week: tf() } })
    assert.match(nothing[0], /^Nothing technical holds .*never cite one as the reason for a level/)
    assert.equal(nothing[1], 'In a daily trading range 140.2–151.8 since 2026-10-20 — structure (its low and high are levels), not a measured edge')
    assert.equal(nothing[2], "Your stop's room (your own daily swing lows, 135 breaks): 74% of breaks reached a stop 0.2 ATR under the low and 67% of those closed back above within 3 days; 1 ATR under, 25% reached it, 18% came back — the cost of the tight stop; most names look alike here")
    assert.equal(nothing[3], "Daily ATR 2.99% — a day's normal move")
    assert.ok(!nothing.some(l => /Fibonacci pullbacks/.test(l)), 'Fibonacci prices only when it holds')
    const holding = mentorRead({ timeframes: {
        day: { ...tf({ holds: ['sma50'] }), atr_pct: 3, levels_now: { sma50: 214.59 }, fib: { verdict: 'respects', latest_impulse: { low: 100, high: 150 } },
            cycle: { verdict: 'respects', window: { from: '2026-11-20T00:00:00.000Z', to: '2026-11-28T00:00:00.000Z' } } },
        week: tf() } })
    assert.match(holding[0], /^50 SMA \(daily\) HOLDS; at 214\.59 now: a LEVEL an entry or a stop may sit on$/)
    assert.match(holding[1], /next window 2026-11-20 → 2026-11-28: timing for how long an entry waits/)
    assert.equal(holding[2], 'Fibonacci pullbacks (daily) HOLD — the latest impulse 100 → 150: 38.2% 130.9, 50% 125, 61.8% 119.1')
    assert.equal(holding[3], 'Anything not listed above did not hold — never cite it as support')
    assert.deepEqual(mentorRead({ timeframes: {} }).slice(0, 1).length, 1)
})

test("the trader's section: the read as levels to use, the stop rule unchanged, and no internal name anywhere in it (One Axl)", async () => {
    const { _buildProteusSection, _buildReadSection } = await import('../../services/agents/mentor.agent.service.js')
    const { INTERNAL_NAMES } = await import('../../services/agentUtils.js')
    const s = _buildProteusSection({ symbol: 'NVDA', at: '2026-11-13T10:00:00Z', brief: 'nothing technical holds', read: ['Nothing technical holds on the daily or weekly bars', "Daily ATR 3% — a day's normal move"] })
    assert.match(s, /THE TECHNICAL ANALYST'S READ on NVDA \(measured 2026-11-13\)/)
    assert.match(s, /\n {2}- Nothing technical holds on the daily or weekly bars\n {2}- Daily ATR 3%/)
    assert.match(s, /Your stop rule does not change/)
    assert.ok(!/use it for the stop's room/.test(s), 'the old line moved a tested stop on an untested number')
    assert.match(_buildProteusSection({ symbol: 'KO', brief: 'only the brief' }), /\n {2}- only the brief\n/, 'an older read without lines still says its brief')
    const sections = [s, ...['ready', 'waiting', 'failed', 'unknown'].map(state => _buildReadSection({ symbol: 'NVDA', horizon: 'swing', kind: 'coverage', state, facts: 'f', against: false })),
        _buildReadSection({ symbol: 'NVDA', kind: 'coverage', decide: true, state: 'ready', facts: 'f' })]
    for (const text of sections) for (const name of INTERNAL_NAMES) assert.ok(!new RegExp(`\b${name}\b`, 'i').test(text), `${name} in: ${text.slice(0, 120)}`)
})

test('CR 2026-11-13: the trader\'s read takes EVERY hold from the one list — order blocks, sweeps, breakouts, chance — and an event is a signal, never a level', async () => {
    const { mentorRead, holdKeys, holdsOf } = await import('../../services/tools/behaviourProfile.tools.js')
    const day = { ...tf(), atr_pct: 2, order_blocks: { verdict: 'respects', rate: 0.6, base: 0.4 },
        indicators: { ema20: { verdict: 'no' }, rsi_oversold: { verdict: 'respects', rate: 0.6, base: 0.4 } },
        false_breaks: { after_sweep: { verdict: 'respects', rate: 0.55, base: 0.4 }, false_rate: 0.9, chance: { verdict: 'more', base: 0.78 } } }
    const p = { timeframes: { day }, suitability: { day_trade: { fits: false, why: 'too slow for a day' }, swing: { fits: true, why: 'moves and liquid' } } }
    const read = mentorRead(p)
    assert.ok(!read.some(l => /^Nothing technical holds/.test(l)), 'something holds — never "nothing"')
    assert.match(read.join('\n'), /Bullish order blocks \(daily\) HOLD on a retest/)
    assert.match(read.join('\n'), /A sweep of a daily low that closes back above has led higher/)
    assert.match(read.join('\n'), /Daily breaks of its lows reverse more than chance \(90% false vs 78%\)/)
    const rsi = read.find(l => /RSI/.test(l))
    assert.match(rsi, /a SIGNAL that has led higher — timing for an entry, not a level$/)
    assert.ok(!/at .* now/.test(rsi), 'an event has no price')
    assert.equal(read.at(-1), 'Fits: day trade no, swing yes — moves and liquid')
    // One list: the badge's holds, holdsOf and the trader's read agree.
    assert.deepEqual(holdKeys(day), ['rsi_oversold', 'sweeps', 'order_blocks', 'fakes'])
    assert.equal(holdsOf({ day }).length, 4)
})

test('CR 2026-11-13: a thin chance verdict says it cannot be told; a cycle near-miss is said as one', async () => {
    const { chanceWords, cycleWords } = await import('../../services/tools/behaviourProfile.tools.js')
    const thin = { chance: { verdict: 'thin', base: null, z: null } }
    assert.equal(chanceWords(thin, 'row'), ' — too few breaks to tell it from chance')
    assert.equal(chanceWords(thin, 'tool'), '; too few breaks to compare with chance')
    assert.equal(chanceWords(thin, 'brief'), ' (too few to compare with chance)')
    assert.equal(chanceWords({}, 'row'), '', 'an older profile with no chance at all says nothing')
    assert.match(cycleWords({ verdict: 'no', rate: 0.68, base: 0.5, z: 1.4 }, 'week'), /a near-miss: not enough to rule out chance/)
    assert.match(cycleWords({ verdict: 'no', rate: 0.42, base: 0.51, z: -0.8 }, 'day'), /^No regular cycle/)
})
