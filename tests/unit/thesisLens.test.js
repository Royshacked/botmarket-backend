import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { MODES } from '../../services/analysisModes.js'
import { sanitizeScanSeed } from '../../services/scanSeed.util.js'
import { normalizeSetup, setupReadiness } from '../../services/setup.schema.js'
import { thesisGate, scenarioGate } from '../../monitoring/talos.gates.js'
import { _buildSeedSection } from '../../services/agents/mentor.agent.service.js'
import { lensLine } from '../../monitoring/assess.shared.js'
import { priceStructureText, entryLevelText, unmirrorFacts, targetWords, unfinishedWeek } from '../../services/tools/thesisStructure.tools.js'

// THE THESIS LENS (Roy, 2026-10-30; docs/design/stock-playbook.md) — the stop where the thesis breaks, the entry from
// the user's risk, the Hotlist's Build with Mentor opening in it, and Talos told what the setup is.

test('thesis is a lens: a setup keeps it instead of being coerced to discretionary', () => {
    assert.ok(MODES.includes('thesis'))
    assert.equal(normalizeSetup({ trade_mode: 'thesis' }).trade_mode, 'thesis')
})

test('a hand-off seed carries no lens — Argus stopped recommending one (mentor-modes.md)', () => {
    assert.equal('recommended_mode' in sanitizeScanSeed({ ticker: 'mtg', recommended_mode: 'thesis' }), false)
})

test('the seed section: every hand-off — the Hotlist, the book, Argus — opens risk-based (mentor-modes.md)', () => {
    for (const seed of [
        { ticker: 'MTG', hotlist_facts: 'this week (2–10 days)' },
        { ticker: 'MTG', book_facts: 'Prometheus: buy', book_name: 'swing' },
        { ticker: 'MTG', hotlist: { board: 'hb_2026-10-29_week', column: 'week' } },
        { ticker: 'MTG', recommended_mode: 'smc' },
    ]) {
        const text = _buildSeedSection(seed)
        assert.match(text, /building it RISK-BASED \(the `thesis` lens\)/)
        assert.doesNotMatch(text, /Argus recommends|smc/)
    }
})

test('the lens prompt: one target, a second one offered (stop unchanged), never set unasked — tests 2 / 2b', () => {
    const p = readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8')
    const lens = p.slice(p.indexOf('## The thesis lens'), p.indexOf('## Size comes from the user'))
    assert.match(lens, /ONE target — yours to JUDGE/)
    assert.match(lens, /OFFER a second target, never set it unasked/)
    assert.match(lens, /the stop\s+UNCHANGED — no trail, no move to breakeven/)
})

test('the lens prompt: building straight through keeps the lens; the house valuation is never the take-profit (NXST)', () => {
    const p = readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8')
    const lens = p.slice(p.indexOf('## The thesis lens'), p.indexOf('## Size comes from the user'))
    assert.match(lens, /Building straight through does not skip the lens/)
    assert.match(lens, /read `get_price_structure`/)
    assert.match(lens, /Prometheus's price target is never the take-profit here/)
})

test('a thesis setup naming no rungs is read on the 1h / 4h, not the horizon’s ladder; named rungs still win', () => {
    assert.deepEqual(normalizeSetup({ trade_mode: 'thesis', type: 'swing', timeframe: 'day' }).pace_rungs, ['4hr', '1hr'])
    assert.deepEqual(normalizeSetup({ trade_mode: 'thesis', type: 'swing', pace_rungs: ['15min'] }).pace_rungs, ['15min'])
    assert.notDeepEqual(normalizeSetup({ trade_mode: 'discretionary', type: 'swing', timeframe: 'day', market_cap: 'mid' }).pace_rungs, ['4hr', '1hr'],
        'another lens keeps the ladder')
})

test('Talos is told what a thesis setup is: the level and below, strength judged on the 1h / 4h', () => {
    const line = lensLine('thesis')
    assert.match(line, /LEVEL, valid at that price and below/)
    assert.match(line, /STRENGTH on the 1h \/ 4h/)
    assert.notEqual(line, lensLine('discretionary'))
})

/** Weekday daily bars as the candle provider returns them (`timestamp` in seconds). */
function provider(closes) {
    const out = []
    for (let t = Date.parse('2025-01-06T14:30:00Z'), i = 0; out.length < closes.length; t += 86_400_000) {
        const d = new Date(t).getUTCDay()
        if (d === 0 || d === 6) continue
        const c = closes[i++]
        out.push({ timestamp: t / 1000, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1e6 })
    }
    return async () => out
}

test('get_price_structure: the facts as JSON for the chart asked, two years of days fetched', async () => {
    const closes = [...Array(80).fill(100), 98, 95, 92, 89, 86, 83, 81, 80.5, 82, 84, 86, 86, 85, 84, 83.6, 83.5, 84.5, 86, 87.5]
    let asked = null
    const get = async (sym, o) => { asked = { sym, ...o }; return provider(closes)() }
    const text = await priceStructureText({ ticker: 'mtg', timeframe: 'day' }, { get, now: Date.parse('2025-06-01') })
    assert.equal(asked.sym, 'MTG')
    assert.equal(asked.timeSpan, 'day')
    assert.equal(Math.round((asked.to - asked.from) / (365 * 86_400_000)), 2)
    const facts = JSON.parse(text.slice(text.indexOf('{')))
    assert.equal(facts.control, 'buyers')
    assert.ok(facts.candidates.stop < facts.close && facts.candidates.target > facts.close)
    assert.match(await priceStructureText({ ticker: 'X', timeframe: 'day' }, { get: provider([1, 2, 3]) }), /Not enough day history/)
})

test('the week still trading is no week: Monday to Friday (ET) it is open, from Saturday closed', () => {
    assert.equal(unfinishedWeek('2026-10-26', Date.parse('2026-10-28T15:00:00Z')), true)
    assert.equal(unfinishedWeek('2026-10-26', Date.parse('2026-10-30T19:00:00Z')), true, 'Friday, still trading')
    assert.equal(unfinishedWeek('2026-10-26', Date.parse('2026-10-31T15:00:00Z')), false)
    assert.equal(unfinishedWeek('2026-10-19', Date.parse('2026-10-28T15:00:00Z')), false, 'a past week')
})

test('get_price_structure on the weekly: the unfinished week is left out of the swings and shown apart', async () => {
    // 80 weeks of days, the last one a Monday–Wednesday; asked on that Wednesday.
    const closes = Array.from({ length: 80 * 5 + 3 }, (_, i) => 100 + 10 * Math.sin(i / 25))
    const get = provider(closes)
    const days = await get()
    const now = days.at(-1).timestamp * 1000 + 6 * 3_600_000
    const text = await priceStructureText({ ticker: 'mtg', timeframe: 'week' }, { get, now })
    const facts = JSON.parse(text.slice(text.indexOf('{')))
    assert.ok(facts.this_week, 'the open week is shown apart')
    assert.ok(facts.as_of < facts.this_week.from, 'the facts end at the last closed week')
    const closed = await priceStructureText({ ticker: 'mtg', timeframe: 'week' }, { get, now: now + 4 * 86_400_000 })
    assert.equal(JSON.parse(closed.slice(closed.indexOf('{'))).this_week, undefined, 'on the weekend the week is closed')
})

test('get_price_structure for a short: the mirrored read turned back the right way up', () => {
    const f = unmirrorFacts({ close: -50, swings: [{ type: 'low', price: -55 }], last_swing_low: { type: 'low', price: -55 },
        last_swing_high: { type: 'high', price: -45 }, control: 'buyers', fall: { from: { price: -40 }, low: { price: -60 }, atrs: 6 },
        candidates: { stop: -56, deep_stop: -61, target: -40, target_kind: 'range_top', lookback_bars: 40 }, heavy_days: [{ close: -50, change_pct: 3 }] })
    assert.equal(f.close, 50)
    assert.equal(f.control, 'sellers', 'buyers of the mirror are the sellers of the chart')
    assert.equal(f.last_swing_high.price, 55, 'the stop side: the buyers’ last swing up')
    assert.deepEqual([f.candidates.stop, f.candidates.target], [56, 40])
    assert.equal(f.heavy_days[0].change_pct, -3)
})

test('the target candidate is worded for its chart and side — weeks on the weekly, the low on a short', () => {
    const c = { target_kind: 'range_top', lookback_bars: 40 }
    assert.match(targetWords(c, 'day'), /highest high of the last 40 sessions — the start of the fall/)
    assert.match(targetWords(c, 'week'), /last 40 weeks/)
    const short = targetWords(c, 'day', 'short')
    assert.match(short, /lowest low .* start of the rise, or the trend's low/)
    assert.doesNotMatch(short, /high/)
    assert.match(targetWords({ target_kind: 'measured_move', lookback_bars: 40 }), /measured move — at its highs/)
})

test('get_entry_level: the level read out, or why there is none', () => {
    assert.match(entryLevelText({ stop: 26.9, target: 31.6, min_rr: 1.5 }), /Entry level 28\.78 \(and below\).*reward to risk 1\.5/)
    assert.match(entryLevelText({ stop: 26.9, target: 31.6, risk_limit_pct: 5 }), /set by the risk limit/)
    assert.match(entryLevelText({ stop: 110, target: 90, min_rr: 1, side: 'short' }), /Entry level 100 \(and above\)/)
    assert.match(entryLevelText({ stop: 26.9, target: 31.6 }), /^No entry level/)
})

// ─── The follow-ups (docs/design/thesis-lens-followups.md, 2026-11-02) ─────────

const _lens = () => {
    const p = readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8')
    return p.slice(p.indexOf('## The thesis lens'), p.indexOf('## Size comes from the user'))
}

test('the lens prompt: the deeper stop is OFFERED with its cost and its date, never set unasked (GNRC)', () => {
    const lens = _lens()
    assert.match(lens, /OFFER the deeper stop, never set it unasked/)
    assert.match(lens, /deep_stop_last_traded/)
    assert.match(lens, /never guess one/)
    assert.match(lens, /may never fill/)
    assert.match(lens, /stop's depth did not move the edge/)
})

test('the lens prompt: the break scenario is offered only over a printed higher low, as an alternative, never the break at market', () => {
    const lens = _lens()
    assert.match(lens, /The break scenario — OFFER it, never set it unasked/)
    assert.match(lens, /HIGHER LOW has already printed/)
    assert.match(lens, /No higher low printed → no B/)
    assert.match(lens, /the break would CHANGE\s+THE STOP/, 'Roy: B only when the break moves the stop')
    assert.match(lens, /so there is no B: A is that trade/)
    assert.match(lens, /NOT buying the break at market/)
    assert.match(lens, /ALTERNATIVES: the first to fill takes the full\s+size/)
    assert.match(lens, /A\s+day close over \{swing high\} since \{today\}/, 'B arms on a latching day close')
})

test('the lens prompt: every thesis scenario draws a validity range and asks the runaway question (NXST)', () => {
    const lens = _lens()
    assert.match(lens, /And if it just goes\?/)
    assert.match(lens, /the recent high — the highest high\s+since the last swing low — however close it sits/)
    assert.match(lens, /A's `on_away` is `pass`/)
    assert.match(lens, /never a chase/)
    assert.match(lens, /conditions ON THE SCENARIO, not the root/)
})

const THESIS = (scenarios) => normalizeSetup({
    asset: 'NXST', direction: 'long', type: 'swing', trade_mode: 'thesis', timeframe: 'day', valid_until: '2027-01-04T21:00:00Z',
    scenarios,
})
const leg = (price) => [{ price }]
const A = { id: 'A', entry_legs: leg(164.7), stop_legs: leg(152.3), target_legs: leg(190.49), quantity: 17,
    conditions: [{ text: 'Price at or under 164.70 shows strength on the 1h / 4h', weight: 'primary', mode: 'judgment' }] }
const B = { id: 'B', entry_legs: leg(173.77), stop_legs: leg(161.61), target_legs: leg(190.49), quantity: 16,
    conditions: [{ text: 'A day close over 169.66 since 2026-10-28', weight: 'primary', mode: 'measured', persistence: 'latching' }] }
const RANGE = (lower, upper, approach, on_away) => ({ lower, upper, approach, timeframe: 'day', on_away })

test('readiness: a thesis premise with no validity range is not finished — the runaway question must be asked', () => {
    const bare = setupReadiness(THESIS([A]), true)
    assert.ok(bare.missing.includes('validity range'), bare.missing.join(', '))
    const drawn = setupReadiness(THESIS([{ ...A, validity: RANGE(152.3, 169, 169.66, 'revise') }]), true)
    assert.equal(drawn.missing.includes('validity range'), false)
    const unanswered = setupReadiness(THESIS([{ ...A, validity: RANGE(152.3, 169, 169.66) }]), true)
    assert.ok(unanswered.missing.includes('runaway answer'), 'the range puts the away question in front of the user')
    const other = setupReadiness(normalizeSetup({ ...THESIS([A]), trade_mode: 'discretionary' }), true)
    assert.equal(other.missing.includes('validity range'), false, 'another lens is unchanged')
})

test('readiness: with two scenarios, the one missing its range is named', () => {
    const r = setupReadiness(THESIS([{ ...A, validity: RANGE(152.3, 169, 169.66, 'pass') }, B]), true)
    assert.equal(r.missing.filter(m => m.startsWith('validity range')).length, 1)
    assert.match(r.missing.find(m => m.startsWith('validity range')), /on /)
})

test('thesisGate: the level and below — the nearest level price is at or under is the premise on the table', () => {
    const s = THESIS([A, B])
    assert.equal(thesisGate(s, 175), null, 'over every level: nothing reached')
    assert.equal(thesisGate(s, 172).scenario.id, 'B', 'under B\'s level only')
    assert.equal(thesisGate(s, 173.77).scenario.id, 'B', 'at the level is at it')
    assert.equal(thesisGate(s, 160).scenario.id, 'A', 'under both: the nearest, A')
    assert.equal(thesisGate(s, 172).leg.id, s.scenarios[1].entry_legs[0].id, 'the leg comes with it')
    assert.equal(scenarioGate(s, 172), null, 'the exact-match gate never saw it')
})

test('thesisGate: a short is the mirror; another lens and a dead scenario are not gated', () => {
    const short = normalizeSetup({ ...THESIS([{ ...A, entry_legs: leg(100), stop_legs: leg(110), target_legs: leg(80) },
        { ...B, entry_legs: leg(95), stop_legs: leg(104), target_legs: leg(80) }]), direction: 'short' })
    assert.equal(thesisGate(short, 97).scenario.id, 'B', 'at or over B\'s level only')
    assert.equal(thesisGate(short, 101).scenario.id, 'A', 'over both: the nearest, A')
    assert.equal(thesisGate(short, 94), null, 'under every level: nothing reached')
    assert.equal(thesisGate(normalizeSetup({ ...THESIS([A, B]), trade_mode: 'smc' }), 172), null)
    const dead = { ...THESIS([A, B]), monitor_state: { scenarios: { B: { invalidation_status: 'fired' } } } }
    assert.equal(thesisGate(dead, 172), null, 'B broke; A\'s level is not reached at 172')
    assert.equal(thesisGate(THESIS([A, B]), NaN), null)
})

test('the lens prompt after the GNRC drive: the date said from the tool, the deep stop on only when taken, B reopened', () => {
    const lens = _lens()
    assert.match(lens, /SAY that\s+date, from the tool on this turn/)
    assert.match(lens, /the deep one goes on only when the user takes it/)
    assert.match(lens, /When the user then TAKES the deep stop, the answer has changed: reopen the ways in and offer B then/)
    assert.match(lens, /never quote an R:R or a level of your own either/)
})

test('the lens prompt: Mentor reads what risk fits from the chart — judgment, no menu; the limit stays the user\'s (Roy)', () => {
    const lens = _lens()
    assert.match(lens, /Your read of what risk fits — then ask the user/)
    assert.match(lens, /in this stock's normal\s+moves \(`atr_pct`/)
    assert.match(lens, /Judgment, not a table — no fixed menu of percents/)
    assert.match(lens, /Any\s+LEVEL you name in that read comes from `get_entry_level`/)
    assert.match(lens, /no limit better for the edge/)
    assert.match(lens, /theirs, never yours/)
})

test('the lens prompt: an offer carries its numbers in one bullet — the brevity cap cuts words, not the offer (GNRC drive)', () => {
    const lens = _lens()
    assert.match(lens, /An offer carries its numbers, or it was not made/)
    assert.match(lens, /never "a wider stop remains an option"/)
    assert.match(lens, /not traded under since Feb 5/)
    assert.match(lens, /about 2\.5 of this stock's normal days/)
})
