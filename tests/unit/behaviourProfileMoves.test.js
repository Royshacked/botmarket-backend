import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moveFlags, moveStartsOf, movesProfile, behaviourProfile, MOVES, MOVE_MEASURES, MOVES_ONLY_TIMEFRAMES, SESSION_MOVES } from '../../services/behaviourProfile.engine.js'
import { fifteenFromFive } from '../../services/behaviourProfile.service.js'
import { movesWords, movesViews, rowProfile, formatProfile } from '../../services/tools/behaviourProfile.tools.js'

// K. Size and pace — the name's own moves (docs/design/proteus.md §10.8, Roy 2026-11-16).

const DAY = 86_400
/** A daily random walk with a drift, `n` bars. */
function walk(n, seed = 7, step = DAY, start = Date.parse('2016-01-04T14:30:00Z') / 1000) {
    let s = seed >>> 0
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    let p = 100
    return Array.from({ length: n }, (_, i) => {
        const o = p
        p = Math.max(1, p * (1 + (rnd() - 0.48) * 0.05))
        return { timestamp: start + i * step, open: o, high: Math.max(o, p) * 1.006, low: Math.min(o, p) * 0.994, close: p, volume: 1e6 * (0.5 + rnd()) }
    })
}

test('moveFlags: +4 ATR on a high before a close 1 ATR under; the stop first is not a move; no room ahead is null', () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({ timestamp: i * DAY, open: 100, high: 100.5, low: 99.5, close: 100 }))
    const atrs = bars.map(() => 1)
    bars[3] = { ...bars[3], high: 104.5 }
    assert.equal(moveFlags(bars, atrs)[0], true)
    assert.equal(moveFlags(bars, atrs)[29], null)
    bars[2] = { ...bars[2], close: 98.5 }
    assert.equal(moveFlags(bars, atrs)[0], false)
})

test('moveFlags, session: an intraday move must finish inside its own ET session', () => {
    const t0 = Date.parse('2026-11-12T20:45:00Z') / 1000   // 15:45 ET — two bars before the close
    const bars = Array.from({ length: 30 }, (_, i) => ({ timestamp: t0 + (i < 3 ? i * 300 : 86_400 - 6 * 3600 + i * 300), open: 100, high: 100.5, low: 99.5, close: 100 }))
    bars[5] = { ...bars[5], high: 104.5 }                  // the next morning
    const atrs = bars.map(() => 1)
    assert.equal(moveFlags(bars, atrs)[0], true)
    assert.equal(moveFlags(bars, atrs, { session: true })[0], false)
})

test('moveStartsOf: qualifying bars within 20 of each other are one move, starting at the lowest close', () => {
    const bars = Array.from({ length: 80 }, (_, i) => ({ close: i === 5 ? 98 : 100 }))
    assert.deepEqual(moveStartsOf(bars, bars.map((_, i) => [3, 5, 8, 60].includes(i))), [5, 60])
})

test('movesProfile: null under 260 bars; otherwise every measure with its median, older / recent, steadiness and now', () => {
    assert.equal(movesProfile(walk(200), 'day'), null)
    const m = movesProfile(walk(2500), 'day')
    assert.equal(m.timeframe, 'day')
    assert.equal(m.session_only, false)
    assert.equal(m.moves, m.older + m.recent)
    assert.ok(m.moves > 0)
    assert.deepEqual(Object.keys(m.measures), [...MOVE_MEASURES])
    for (const v of Object.values(m.measures)) {
        assert.ok(v.steady === null || v.steady === 'steady' || v.steady === 'changed')
        if (v.steady) assert.ok(v.older_mid[0] <= v.older_mid[1])
    }
    assert.ok(m.measures.depth_atr.median > 0)
    assert.equal(m.verdict, m.moves < MOVES.minMoves ? 'thin' : 'measured')
    assert.ok(m.now && m.now.bars_since_top >= 0 && m.now.bars_since_top <= MOVES.look)
    assert.equal(movesProfile(walk(600, 3, 300), '5min').session_only, true)
    assert.equal(movesProfile(walk(600, 3, 3600), '1hour').session_only, false)
    assert.ok(SESSION_MOVES.has('15min') && !SESSION_MOVES.has('1hour'))
})

test('behaviourProfile: moves on every timeframe; the 15-minute measured for moves only', () => {
    const p = behaviourProfile('ZZZ', { day: walk(1000), '15min': walk(600, 5, 900) })
    assert.ok(p.timeframes.day && !('15min' in p.timeframes))
    assert.ok(MOVES_ONLY_TIMEFRAMES.includes('15min'))
    assert.ok(p.moves.day && p.moves['15min'])
})

test('fifteenFromFive: three 5-minute bars of a slot make one 15-minute bar', () => {
    const t0 = Date.parse('2026-11-12T14:30:00Z') / 1000
    const five = [0, 1, 2, 3].map(k => ({ timestamp: t0 + k * 300, open: 10 + k, high: 11 + k, low: 9 + k, close: 10.5 + k, volume: 100 }))
    const f = fifteenFromFive(five)
    assert.equal(f.length, 2)
    assert.deepEqual(f[0], { timestamp: t0, open: 10, high: 13, low: 9, close: 12.5, volume: 300 })
    assert.equal(f[1].timestamp, t0 + 900)
    assert.deepEqual(fifteenFromFive(null), [])
})

test('the words: size and pace in the row on the horizon\'s bars (15-minute beside 5-minute), and in the tool text', () => {
    assert.deepEqual(movesViews(['5min', '1hour']), ['5min', '15min', '1hour'])
    const day = walk(2500)
    const p = { ...behaviourProfile('ZZZ', { day, week: walk(600, 9, 7 * DAY) }), computed_at: '2026-11-16T00:00:00Z' }
    const w = movesWords(p.moves.day, 'day')
    assert.match(w, p.moves.day.verdict === 'thin' ? /too few moves/ : /moves: a run of ~.* ATR .* into a top.*pullback of ~\d+% .*Steady lately: \d+ of \d+ measures/)
    assert.equal(movesWords(null, 'day'), null)
    assert.match(movesWords({ verdict: 'thin', moves: 3, session_only: true }, '5min'), /too few moves to say \(3; 10 needed\) — moves inside one session/)
    const row = rowProfile(p, 'swing')
    assert.ok(row.lines.some(([k]) => k === 'Daily size and pace'))
    const text = formatProfile(p)
    assert.match(text, /SIZE AND PACE — described on the name's own moves/)
    assert.match(text, /never cite it as support/)
})

// Fix 1 (Roy, 2026-11-17): a profile is never measured on a short fallback daily history.
import { fmpDaily, fetchProfileBars } from '../../services/behaviourProfile.service.js'
import { profileRow } from '../../services/hotlistBehaviour.service.js'

const noSleep = async () => {}
test('fmpDaily: FMP\'s bars when it answers; retried on a failure; the router only when FMP answers empty', async () => {
    const bars = [{ timestamp: 1, close: 1 }]
    let calls = 0
    assert.deepEqual(await fmpDaily('X', {}, { fmp: async () => { if (++calls < 3) throw Object.assign(new Error('429'), { status: 429 }); return bars }, router: async () => { throw new Error('router must not be asked') }, sleep: noSleep }), bars)
    assert.equal(calls, 3)
    const fallback = [{ timestamp: 2, close: 2 }]
    assert.deepEqual(await fmpDaily('X', {}, { fmp: async () => [], router: async () => fallback, sleep: noSleep }), fallback)
})

test('fmpDaily: FMP failing every try → no profile, an error saying to try again (code DAILY_UNAVAILABLE, the status kept)', async () => {
    let router = 0
    await assert.rejects(
        fmpDaily('LLY', {}, { fmp: async () => { throw Object.assign(new Error('FMP candles LLY/dayx1 429'), { status: 429 }) }, router: async () => { router++; return [] }, sleep: noSleep }),
        (err) => err.code === 'DAILY_UNAVAILABLE' && err.status === 429 && /try again later/.test(err.message))
    assert.equal(router, 0)   // never the short fallback history
})

test('fetchProfileBars: a test\'s own get still serves the daily; getDaily overrides it', async () => {
    const day = Array.from({ length: 5 }, (_, i) => ({ timestamp: 1_700_000_000 + i * DAY, open: 1, high: 1, low: 1, close: 1 }))
    const b = await fetchProfileBars('X', { get: async (s, o) => (o.timeSpan === 'day' ? day : []), now: Date.parse('2026-11-17T00:00:00Z') })
    assert.equal(b.day.length, 5)
    const c = await fetchProfileBars('X', { get: async () => [], getDaily: async () => day.slice(0, 2), now: Date.parse('2026-11-17T00:00:00Z') })
    assert.equal(c.day.length, 2)
})

test('profileRow: a daily fetch that failed just now reads `unavailable`, not `no_history`', async () => {
    const err = Object.assign(new Error('the daily history could not be fetched just now'), { code: 'DAILY_UNAVAILABLE', status: 429 })
    assert.equal((await profileRow('LLY', 'swing', { profile: async () => { throw err } })).reason, 'unavailable')
    assert.equal((await profileRow('ZZZ', 'swing', { profile: async () => { throw new Error('no price history for ZZZ') } })).reason, 'no_history')
})
