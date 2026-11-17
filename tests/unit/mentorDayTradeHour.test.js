// A DAY TRADE'S STOP IS DRAWN ON THE 1-HOUR CHART (Roy, 2026-11-14: "lets go for stop in 1hr"; docs/design/stock-playbook.md
// §Test 4 — the 1-hour stop tied the daily, the 5- and 15-minute did worse). Mentor reads the session's closed hourly bars,
// with no break scenario; the trade monitor breaks it on a 1-hour close and paces it on the 15m / 1h.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { priceStructureText, thesisTurnFacts, hourRows, targetWords, chartOf } from '../../services/tools/thesisStructure.tools.js'
import { _readThesisFacts, _buildRiskReadSection } from '../../services/agents/mentor.agent.service.js'
import { emptyBuild, upsertName, putName, activeName } from '../../services/mentorBuild.util.js'
import { normalizeSetup, breakRung, THESIS_PACE_DAY } from '../../services/setup.schema.js'
import { lensLine } from '../../monitoring/assess.shared.js'

/** Hourly bars as FMP serves them (09:30-anchored, ET; October = EDT, UTC−4), with a pre-market bar each day to be dropped. */
function hourly(closes, firstDay = '2026-10-01') {
    const out = []
    let d = Date.parse(`${firstDay}T00:00:00Z`), i = 0
    while (i < closes.length) {
        const wd = new Date(d).getUTCDay()
        if (wd !== 0 && wd !== 6) {
            out.push({ timestamp: (d + (8 * 60 + 4 * 60) * 60_000) / 1000, open: 1, high: 999, low: 0.01, close: 1, volume: 1 })   // 08:00 ET
            for (let h = 0; h < 7 && i < closes.length; h++, i++) {
                const c = closes[i], min = 9 * 60 + 30 + h * 60
                out.push({ timestamp: (d + (min + 4 * 60) * 60_000) / 1000, open: c, high: c + 0.4, low: c - 0.4, close: c, volume: 1e5 })
            }
        }
        d += 86_400_000
    }
    return out
}
// A fall then buyers taking over, about 13 sessions of hours.
const CLOSES = [...Array(70).fill(100), 98, 95, 92, 89, 86, 83, 81, 80.5, 82, 84, 86, 86, 85, 84, 83.6, 83.5, 84.5, 86, 87.5, 88, 88.5]

test('hourRows: regular session only, the forming bar left out, each dated with its ET hour', async () => {
    const bars = hourly(CLOSES)
    const last = bars.at(-1)
    // Asked 20 minutes into the last bar: it is still forming.
    const rows = await hourRows('X', async () => bars, last.timestamp * 1000 + 20 * 60_000)
    assert.equal(rows.length, CLOSES.length - 1, 'the pre-market bars and the forming bar are out')
    assert.ok(rows.every(r => /^\d{4}-\d{2}-\d{2} (09:30|1[0-5]:30)$/.test(r.date)), rows.slice(0, 3).map(r => r.date).join())
    assert.ok(!rows.some(r => r.high === 999), 'no pre-market bar')
    const after = await hourRows('X', async () => bars, last.timestamp * 1000 + 61 * 60_000)
    assert.equal(after.length, CLOSES.length, 'once it closes it counts')
})

test('hourRows: the 15:30 bar is closed at the 16:00 bell, not at 16:30', async () => {
    const bars = hourly(Array(7).fill(50))
    const b1530 = bars.at(-1)
    assert.equal((await hourRows('X', async () => bars, b1530.timestamp * 1000 + 31 * 60_000)).length, 7)
    assert.equal((await hourRows('X', async () => bars, b1530.timestamp * 1000 + 29 * 60_000)).length, 6)
})

test('hourRows on an early close (the day after Thanksgiving): the 12:30 bar closes at 13:00, and nothing after it counts', async () => {
    // 2026-11-27, EST (UTC−5): bars 09:30 … 12:30, plus a stray 13:30 print to be dropped.
    const at = (h, m) => Date.parse(`2026-11-27T${String(h + 5).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`) / 1000
    const bars = [[9, 30], [10, 30], [11, 30], [12, 30], [13, 30]].map(([h, m]) => ({ timestamp: at(h, m), open: 50, high: 51, low: 49, close: 50, volume: 1 }))
    const rows = await hourRows('X', async () => bars, at(13, 5) * 1000)
    assert.deepEqual(rows.map(r => r.date.slice(11)), ['09:30', '10:30', '11:30', '12:30'], 'closed at the 13:00 bell')
    assert.equal((await hourRows('X', async () => bars.slice(0, 4), at(12, 55) * 1000)).length, 3, 'before the bell it is still forming')
    const { equityCloseMin } = await import('../../services/market.service.js')
    assert.equal(equityCloseMin('2026-11-27'), 13 * 60)
    assert.equal(equityCloseMin('2026-12-24'), 13 * 60)
    assert.equal(equityCloseMin('2026-11-26'), 16 * 60, 'Thanksgiving itself is a holiday, not an early close — not known here')
    assert.equal(equityCloseMin('2026-07-03'), 16 * 60, 'July 4 2026 is a Saturday: July 3 is the holiday')
    assert.equal(equityCloseMin('2027-11-26'), 13 * 60)
    assert.equal(equityCloseMin('2026-11-13'), 16 * 60)
})

test('a bar with a later bar after it has closed, whatever the clock', async () => {
    const bars = hourly(Array(14).fill(50))
    const rows = await hourRows('X', async () => bars, bars[3].timestamp * 1000)   // a clock behind the feed
    assert.equal(rows.length, 13, 'all but the last are closed: later bars came after them')
})

test('get_price_structure on the hour: hourly bars asked, the 1-hour read, no break scenario, no heavy days', async () => {
    let asked = null
    const bars = hourly(CLOSES)
    const get = async (sym, o) => { asked = { sym, ...o }; return bars }
    const now = bars.at(-1).timestamp * 1000 + 2 * 3_600_000
    const text = await priceStructureText({ ticker: 'nvda', timeframe: 'hour' }, { get, now })
    assert.equal(asked.timeSpan, 'hour')
    assert.equal(asked.multiplier, 1)
    assert.match(text, /^NVDA 1-hour \(regular session, closed bars\) structure, long side/)
    const facts = JSON.parse(text.slice(text.indexOf('{')))
    assert.match(facts.as_of, / \d{2}:30$/, 'the swings say the hour')
    assert.ok(facts.candidates.stop < facts.close, 'a stop under the price')
    assert.match(facts.break_candidate, /none — a day trade/)
    assert.equal(facts.heavy_days, undefined)
    assert.match(facts.candidates.deep_stop, /none — a day trade offers no deeper stop/)
    assert.equal(facts.candidates.deep_stop_last_traded, undefined)
    assert.match(facts.candidates.target_kind, /hourly bars|measured move/)
})

test('thesisTurnFacts on the hour: the turn is told the hour chart, and B is null (a day trade waits on no close)', async () => {
    const bars = hourly(CLOSES)
    const f = await thesisTurnFacts({ ticker: 'nvda', timeframe: 'hour' }, { get: async () => bars, now: bars.at(-1).timestamp * 1000 + 2 * 3_600_000 })
    assert.equal(f.timeframe, 'hour')
    assert.equal(f.break, null)
    assert.ok(f.stop < f.close)
    assert.equal(f.deep_stop, null, 'no deeper stop on a day trade')
    const s = _buildRiskReadSection({ ...f }, {})
    assert.match(s, /the structure stop/)
    assert.doesNotMatch(s, /deep stop/, 'the risk read names no deep stop')
})

test('the chart per horizon: intraday and day read the hour; a swing the day; long term the week', async () => {
    const at = (settled) => { const b = upsertName(emptyBuild(), 'NVDA'); return putName(b, { ...activeName(b), settled }) }
    const build = at({ direction: 'long', horizon: 'intraday', lens: 'thesis', spans: ['t1'] })
    const asked = []
    const read = async (a) => { asked.push(a.timeframe); return { close: 100, atr: 1, stop: 98, side: 'long', timeframe: a.timeframe } }
    for (const type of ['intraday', 'day', 'swing', 'short term swing', 'long_term'])
        await _readThesisFacts({ draft: { asset: 'NVDA', trade_mode: 'thesis', type }, build }, read)
    assert.deepEqual(asked, ['hour', 'hour', 'day', 'day', 'week'])
    assert.equal(chartOf('hour'), 'hour')
    assert.equal(chartOf('15min'), 'day', 'anything else is the day')
    assert.equal(targetWords({ target_kind: 'range_top', lookback_bars: 40 }, 'hour'), "the highest high of the last 40 hourly bars — the start of the fall, or the trend's high before the pullback")
})

test('the risk read on the hour chart counts normal HOURS', () => {
    const s = _buildRiskReadSection({ close: 100, atr: 0.8, stop: 98.4, deep_stop: 97, timeframe: 'hour', side: 'long' }, {})
    assert.match(s, /2 normal hours \(ATR 0\.8\)/)
    assert.doesNotMatch(s, /normal days/)
})

test('the trade monitor: a day trade breaks on a 1-hour close, paces on 1h / 15m, and is told strength on the 15m / 1h', () => {
    const sc = { validity: { lower: 1, upper: 2, timeframe: 'day' } }
    assert.equal(breakRung({ type: 'intraday', timeframe: 'day' }, sc), '1hr')
    assert.equal(breakRung({ type: 'day', timeframe: 'day' }, sc), '1hr')
    assert.equal(breakRung({ type: 'swing', timeframe: 'day' }, sc), 'day')
    assert.deepEqual(normalizeSetup({ trade_mode: 'thesis', type: 'intraday', timeframe: 'day' }).pace_rungs, [...THESIS_PACE_DAY])
    assert.deepEqual(normalizeSetup({ trade_mode: 'thesis', type: 'day', timeframe: 'day' }).pace_rungs, ['1hr', '15min'])
    assert.deepEqual(normalizeSetup({ trade_mode: 'thesis', type: 'swing', timeframe: 'day' }).pace_rungs, ['4hr', '1hr'])
    assert.match(lensLine('thesis', 'intraday'), /STRENGTH on the 15m \/ 1h/)
    assert.match(lensLine('thesis', 'swing'), /STRENGTH on the 1h \/ 4h/)
    assert.match(lensLine('thesis', 'day'), /STRENGTH on the 15m \/ 1h/)
    for (const h of ['short term swing', 'long term', null]) assert.match(lensLine('thesis', h), /STRENGTH on the 1h \/ 4h/, String(h))
})

test('CR: the monitor reads the last COMPLETED bar — after 16:00 the 15:30 hour bar and the day bar count', async () => {
    const { _lastClosed } = await import('../../monitoring/talos.monitor.service.js')
    const et = (d, hm) => Date.parse(`${d}T${hm}:00-05:00`)
    const hr = [['14:30', 1], ['15:30', 2]].map(([h, c]) => ({ t: et('2026-11-13', h) / 1000, c }))
    assert.equal(_lastClosed(hr, 'AAPL', '1hr', et('2026-11-13', '16:05')), 2, 'closed at the bell')
    assert.equal(_lastClosed(hr, 'AAPL', '1hr', et('2026-11-13', '15:50')), 1, 'still forming')
    const day = [['2026-11-12', 1], ['2026-11-13', 2]].map(([d, c]) => ({ t: Date.parse(`${d}T05:00:00Z`) / 1000, c }))
    assert.equal(_lastClosed(day, 'AAPL', 'day', et('2026-11-13', '16:05')), 2)
    assert.equal(_lastClosed(day, 'AAPL', 'day', et('2026-11-13', '12:00')), 1)
    assert.equal(_lastClosed([], 'AAPL', 'day', 0), null)
    assert.equal(_lastClosed([{ c: 5 }, { c: 6 }], 'AAPL', 'day', 0), 5, 'no time on the bar → the old reading, the one before')
})

test('the prompt: a day trade reads the hour, opens with its own entry and break lines, and never calls itself tested better', () => {
    const p = readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    assert.match(p, /`hour` for a day trade, `day` for a swing, `week` for long term/)
    assert.match(p, /A day trade \(intraday · day\) reads the `hour` chart/)
    assert.match(p, /showing strength on the 15m and 1h/)
    assert.match(p, /a 1-hour close under the stop sends you a card to redraw or close\. An intraday trade is over at today's close\./)
    assert.match(p, /\(a day trade: `\["15min", "1hr"\]`\)/)
    assert.match(p, /Never call a day trade\s+tested better/)
    assert.match(p, /a day\s+trade has neither a deeper stop nor a B: leave both unsaid/)
    assert.match(p, /\*\*A day trade has no deeper stop\*\*/)
    assert.doesNotMatch(p, /intraday scenario\s+on a 15-minute close/)
})
