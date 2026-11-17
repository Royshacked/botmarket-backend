import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pullbackZone, pullbackWords, stopTimeframe, mentorRead } from '../../services/tools/behaviourProfile.tools.js'
import { movesProfile } from '../../services/behaviourProfile.engine.js'

// Size and pace in the trader's read, and the stop checked against the name's usual pullback (Roy, 2026-11-17).

const moves = (over = {}) => ({
    timeframe: 'day', moves: 30, older: 20, recent: 10, verdict: 'measured', session_only: false,
    measures: { depth_atr: { median: 5, older: 5, recent: 5, older_mid: [3, 7], steady: 'steady' }, run_atr: { median: 8 }, depth_pct: { median: 60 } },
    now: { top_at: '2026-11-10T14:30:00.000Z', bars_since_top: 5, off_top_atr: 2, off_top_pct_of_run: 25, rsi: 45, vs_sma50_atr: 0.5, top_close: 100, atr: 2 },
    ...over,
})

test('pullbackZone: from the latest top at today\'s ATR — the median and the older moves\' middle half, as prices', () => {
    assert.deepEqual(pullbackZone(moves()), { top: 100, top_at: '2026-11-10T14:30:00.000Z', median: 90, hi: 94, lo: 86, depth_atr: 5, off_top_atr: 2 })
    assert.equal(pullbackZone(moves({ verdict: 'thin' })), null)
    // A profile stored before the top's price was kept: no zone, no line (never a guessed price).
    assert.equal(pullbackZone(moves({ now: { ...moves().now, top_close: undefined } })), null)
    assert.equal(pullbackWords(moves({ now: { ...moves().now, atr: undefined } }), 'day'), null)
    assert.equal(pullbackZone(null), null)
})

test('pullbackWords: the median is the line a stop is checked against; thin says so', () => {
    const w = pullbackWords(moves(), 'day')
    assert.match(w, /^Its usual pullback \(daily, the stop's chart; 30 moves\): from its latest top 100 \(2026-11-10\)/)
    assert.match(w, /half of its pullbacks before a move went deeper than 90 .* the middle half ended 86–94/)
    assert.match(w, /A stop ABOVE 90 would have been reached by most of this name's pullbacks — a description of its moves, not a tested edge$/)
    assert.match(pullbackWords(moves({ verdict: 'thin', moves: 6 }), 'week'), /too few moves to say where its pullbacks end \(6\)/)
})

test('stopTimeframe: the chart the stop is drawn on — 1-hour for a day trade, daily for a swing, weekly for long term', () => {
    assert.equal(stopTimeframe('intraday'), '1hour')
    assert.equal(stopTimeframe('day'), '1hour')
    assert.equal(stopTimeframe('short term swing'), 'day')
    assert.equal(stopTimeframe('swing'), 'day')
    assert.equal(stopTimeframe('long term'), 'week')
    assert.equal(stopTimeframe(null), 'day')
})

test('mentorRead: size and pace on the horizon\'s timeframes, the usual pullback on the stop\'s chart', () => {
    const tf = { bars: 300, atr_pct: 2, drift: { rate: 0.5 }, indicators: {}, false_breaks: { breaks: 0, after_sweep: {}, recent: {} }, order_blocks: { blocks: 0 } }
    const p = {
        timeframes: { '5min': tf, '1hour': tf, day: tf, week: tf },
        moves: { '5min': moves({ timeframe: '5min', session_only: true }), '15min': moves({ timeframe: '15min', verdict: 'thin', moves: 7 }), '1hour': moves({ timeframe: '1hour', now: { ...moves().now, top_close: 50, atr: 0.5 } }), day: moves(), week: moves({ verdict: 'thin', moves: 5 }) },
    }
    const day = mentorRead(p, { horizon: 'intraday' })
    assert.ok(day.some(l => l.startsWith('Size and pace (5-minute):')))
    assert.ok(day.some(l => l.startsWith('Size and pace (15-minute): too few moves')))
    assert.ok(day.some(l => l.startsWith('Size and pace (1-hour):')))
    assert.ok(!day.some(l => l.startsWith('Size and pace (daily)')), 'a day trade reads its own bars')
    assert.ok(day.some(l => /^Its usual pullback \(1-hour, the stop's chart/.test(l) && /deeper than 47.5/.test(l)), 'the 1-hour zone: 50 − 5 × 0.5')
    const swing = mentorRead(p, { horizon: 'swing' })
    assert.ok(swing.some(l => l.startsWith('Size and pace (daily):')) && swing.some(l => l.startsWith('Size and pace (weekly): too few moves')))
    assert.ok(swing.some(l => /^Its usual pullback \(daily, the stop's chart/.test(l) && /deeper than 90/.test(l)))
    assert.ok(!mentorRead({ timeframes: { day: tf, week: tf } }, { horizon: 'swing' }).some(l => /Size and pace|usual pullback/.test(l)), 'no moves, no lines')
})

test('movesProfile: now carries the top\'s price and the ATR in price', () => {
    let s = 7 >>> 0
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    let px = 100
    const bars = Array.from({ length: 1500 }, (_, i) => { const o = px; px = Math.max(1, px * (1 + (rnd() - 0.495) * 0.04)); return { timestamp: 1451916000 + i * 86_400, open: o, high: Math.max(o, px) * 1.005, low: Math.min(o, px) * 0.995, close: px, volume: 1e6 } })
    const m = movesProfile(bars, 'day')
    const top = Math.max(...bars.slice(-61).map(b => b.close))
    assert.ok(Math.abs(m.now.top_close - top) < 0.01)
    assert.ok(m.now.atr > 0)
})

test('the prompt: the stop is checked against the median, offered as a choice, never moved on his own', () => {
    const prompt = readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8')
    assert.match(prompt, /Check the stop against ITS USUAL PULLBACK/)
    assert.match(prompt, /never move it on your own/)
    assert.match(prompt, /not a tested edge — never call it\s+support/)
})

test('_buildPullbackSection: the stop above the median on the same chart → the line with its prices; else nothing', async () => {
    const { _buildPullbackSection, _buildTurnContext } = await import('../../services/agents/mentor.agent.service.js')
    const zone = { top: 55.43, median: 50.64, lo: 50.31, hi: 51.71, timeframe: '1hour' }
    const facts = { timeframe: 'hour', side: 'long', close: 55.43, stop: 52.42 }
    const s = _buildPullbackSection(facts, zone, null)
    assert.match(s, /ITS USUAL PULLBACK \(checked: the structure stop 52.42 sits ABOVE it\)/)
    assert.match(s, /half of this name's pullbacks before a move went deeper than 50.64; the middle half ended 50.31–51.71/)
    assert.match(s, /never move it on your own/)
    // The worksheet's stop wins over the structure stop.
    const draft = { scenarios: [{ stop_legs: [{ price: 52.1 }] }] }
    assert.match(_buildPullbackSection(facts, zone, draft), /the worksheet's stop 52.1 sits ABOVE/)
    assert.equal(_buildPullbackSection(facts, zone, { scenarios: [{ stop_legs: [{ price: 50 }] }] }), '', 'a stop under the median: nothing to say')
    assert.equal(_buildPullbackSection({ ...facts, timeframe: 'day' }, zone, null), '', 'another chart\'s pullbacks')
    assert.equal(_buildPullbackSection({ ...facts, side: 'short' }, zone, null), '')
    assert.equal(_buildPullbackSection(facts, null, null), '')
    assert.equal(_buildPullbackSection({ timeframe: 'hour' }, zone, null), '', 'no stop yet')
    // In the turn's context, beside the risk read.
    const ctx = _buildTurnContext({ active_asset: 'ARMK' }, null, [], { thesisFacts: facts, pullback: zone })
    assert.match(ctx, /ITS USUAL PULLBACK/)
    assert.doesNotMatch(_buildTurnContext({ active_asset: 'ARMK' }, null, [], { thesisFacts: facts }), /ITS USUAL PULLBACK/)
})
