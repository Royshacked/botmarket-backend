import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { MODES } from '../../services/analysisModes.js'
import { sanitizeScanSeed } from '../../services/scanSeed.util.js'
import { normalizeSetup, setupReadiness } from '../../services/setup.schema.js'
import { thesisGate, scenarioGate } from '../../monitoring/talos.gates.js'
import { _buildSeedSection, _buildBreakSection, _buildRiskReadSection, mentorAgentService } from '../../services/agents/mentor.agent.service.js'
import { emptyBuild, upsertName, putName, activeName } from '../../services/mentorBuild.util.js'
import { lensLine } from '../../monitoring/assess.shared.js'
import { priceStructureText, entryLevelText, entryLevelReply, breakWords, thesisTurnFacts, unmirrorFacts, targetWords, unfinishedWeek } from '../../services/tools/thesisStructure.tools.js'

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

test('get_entry_level with the ticker: the last date price traded past the stop, read off two years of days (GNRC drive 5)', async () => {
    const closes = [...Array(30).fill(30), 26, ...Array(30).fill(30)]   // one dip under 26.9, then flat
    let asked = null
    const get = async (sym, o) => { asked = { sym, ...o }; return provider(closes)() }
    const days = await provider(closes)()
    const dip = new Date(days[30].timestamp * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const text = await entryLevelReply({ ticker: 'mtg', stop: 26.9, target: 31.6, min_rr: 1.5 }, { get })
    assert.match(text, /^Entry level 28\.78/)
    assert.ok(text.endsWith(`MTG last traded under 26.9 on ${dip}.`), text)
    assert.equal(Math.round((asked.to - asked.from) / (365 * 86_400_000)), 2)
    assert.match(await entryLevelReply({ ticker: 'mtg', stop: 20, target: 31.6, min_rr: 1.5 }, { get }), /under 20 on no day in the last two years \(61 sessions read\)/)
    assert.match(await entryLevelReply({ ticker: 'mtg', stop: 34, target: 25, min_rr: 1, side: 'short' }, { get }), /over 34 on no day/, 'a short: over the stop')
    assert.match(await entryLevelReply({ ticker: 'mtg', stop: 30.2, target: 25, min_rr: 1, side: 'short' }, { get }), /MTG last traded over 30\.2 on \d{4}-\d\d-\d\d\./)
})

test('get_entry_level: no ticker or no level → no fetch; a failed fetch still answers the level', async () => {
    let calls = 0
    const get = async () => { calls++; throw new Error('feed down') }
    assert.equal(await entryLevelReply({ stop: 26.9, target: 31.6, min_rr: 1.5 }, { get }), entryLevelText({ stop: 26.9, target: 31.6, min_rr: 1.5 }))
    assert.match(await entryLevelReply({ ticker: 'X', stop: 26.9, target: 31.6 }, { get }), /^No entry level/)
    assert.equal(calls, 0)
    assert.match(await entryLevelReply({ ticker: 'X', stop: 26.9, target: 31.6, min_rr: 1.5 }, { get }), /^Entry level 28\.78.*\(When X last traded under 26\.9 could not be read\.\)$/)
})

test('get_price_structure: the break candidate worded for its side, and a short\'s turned the right way up', () => {
    assert.match(breakWords('long'), /HIGHER LOW .* day close over arms B/)
    assert.match(breakWords('short'), /LOWER HIGH .* day close under arms B/)
    const f = unmirrorFacts({ close: -50, swings: [], last_swing_low: null, last_swing_high: null, control: 'buyers', fall: null,
        candidates: { stop: -56, deep_stop: -61, target: -40 }, heavy_days: [],
        break_candidate: { swing_to_break: { type: 'high', price: -45 }, higher_swing: { type: 'low', price: -55 }, fall_low: { date: 'd', price: -60 }, stop: -56 } })
    assert.deepEqual(f.break_candidate, { swing_to_break: { type: 'low', price: 45 }, lower_swing: { type: 'high', price: 55 }, rise_high: { date: 'd', price: 60 }, stop: 56 })
    assert.equal(unmirrorFacts({ ...f, close: -50, swings: [], heavy_days: [], candidates: {}, break_candidate: null }).break_candidate, null)
})

test('the lens prompt: the dates and B come from the tools, never the candles (GNRC drive 5)', () => {
    const lens = _lens()
    assert.match(lens, /gets its date from `get_entry_level`/)
    assert.match(lens, /`break_candidate`/)
    assert.match(readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8'), /never skip it for\s+the candles/)
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
    assert.match(lens, /never guess\s+one/)
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
    assert.match(lens, /so the\s+break IS the entry; under it, the break arms B and the entry is the pullback/, 'Roy 2026-11-03: the break is the entry when the limits allow')
    assert.match(lens, /never "B does not fit"/)
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
    assert.match(lens, /SAY that\s+date, from the tool or the turn's RISK READ line, which carries it/)
    assert.match(lens, /never a reason to withhold the offer/, 'drive 9: "can\'t responsibly quote it without its date"')
    assert.match(lens, /the deep one goes on only when the user takes it/)
    assert.match(lens, /B is offered at the ENTRIES stage, in the same turn the user takes the deep stop — never at spans/)
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

test('the lens on the stages: spans holds one trade; entries carries the stop, offers, risk read, limits and levels, and B as an alternative entry', () => {
    const lens = _lens()
    assert.match(lens, /\*\*spans\*\* holds ONE trade/)
    assert.match(lens, /\*\*entries\*\* carries steps 2–6 and settles only when they are done/)
    assert.match(lens, /the stage cannot settle before it exists/)
    assert.match(lens, /second ENTRY OPTION on the same trade, B/)
    assert.match(lens, /`semantics: "alternatives"` — one scenario per entry/)
})

// ─── The chart's facts on the turn (Roy, 2026-11-02/03: drive 6 had B in the tool and never offered it; drive 8 refused
// B for a level under the break; three drives asked the limits before the risk read) ───

const B_FACTS = { swing_to_break: { type: 'high', date: '2026-10-29', price: 212.81 }, higher_swing: { type: 'low', date: '2026-10-28', price: 181 },
    fall_low: { date: '2026-09-16', price: 173.25 }, stop: 178.81 }
const FACTS = { timeframe: 'day', side: 'long', close: 202.04, atr: 9.1, stop: 178.81, deep_stop: 171.06, break: B_FACTS }
const ON = (stop, target = 231.89) => ({ scenarios: [{ id: 's1', stop_legs: [{ price: stop }], target_legs: [{ price: target }] }] })

test('the break section: on the deep stop B is ON OFFER this turn; on the structure stop no B, and the deep stop named as its trigger', () => {
    const deep = _buildBreakSection(FACTS, ON(171.06))
    assert.match(deep, /a DAY close over 212\.81 arms it; its stop 178\.81, under the higher low at 181 \(2026-10-28\) — 16% from the break/)
    assert.match(deep, /the break CHANGES THE STOP, so B is ON OFFER THIS TURN/)
    assert.match(deep, /once they declined, leave it/)
    const structure = _buildBreakSection(FACTS, ON(178.81))
    assert.match(structure, /no B\. If the user takes the deep stop \(171\.06\), B is on offer in THAT same turn/)
    assert.doesNotMatch(structure, /ON OFFER THIS TURN/)
    assert.match(_buildBreakSection(FACTS, ON(177.5)), /no B/, 'within the stop\'s own noise buffer (0.2 ATR) is the same stop')
    assert.match(_buildBreakSection(FACTS, { scenarios: [] }), /A structure stop would be at B's/)
})

test('the break section: B\'s entry is the tool\'s level — the break itself when it fits, a pullback after it when under (Roy, 2026-11-03)', () => {
    const deep = _buildBreakSection(FACTS, ON(171.06))
    assert.match(deep, /B's ENTRY is get_entry_level on B's stop 178\.81, B's target and their limits — never an R:R of your own/)
    assert.match(deep, /Level at or over 212\.81: the break price fits their limits, so the break IS the entry/)
    assert.match(deep, /Level under 212\.81: B waits for a pullback to the level after the break\. Both are B/)
    assert.match(deep, /never "does not fit" for a level under the line/)
    assert.doesNotMatch(_buildBreakSection(FACTS, ON(178.81)), /B's ENTRY/, 'no B, no entry to explain')
})

test('the break section: A\'s target at B\'s arming line is said; two scenarios or no candidate → nothing', () => {
    assert.match(_buildBreakSection(FACTS, ON(171.06, 212.81)), /B arms where A takes profit, so B's target is the next sellers above 212\.81/)
    assert.doesNotMatch(_buildBreakSection(FACTS, ON(171.06)), /takes profit/)
    assert.equal(_buildBreakSection(FACTS, { scenarios: [ON(171.06).scenarios[0], { id: 's2' }] }), '')
    assert.equal(_buildBreakSection({ ...FACTS, break: null }, ON(171.06)), '')
    assert.equal(_buildBreakSection(null, ON(171.06)), '')
})

test('the break section on a short: mirrored words, the stop compared the other way', () => {
    const s = { side: 'short', atr: 2, deep_stop: 61, break: { swing_to_break: { type: 'low', price: 45 }, lower_swing: { type: 'high', price: 55 }, stop: 56 } }
    const text = _buildBreakSection(s, ON(61, 40))
    assert.match(text, /a DAY close under 45 arms it; its stop 56, over the lower high at 55/)
    assert.match(text, /stop 61 is over B's: the break CHANGES THE STOP.* its stop is lower than A's/)
    assert.match(text, /Level at or under 45: the break price fits/)
})

test('the risk read: each stop\'s distance in % and in normal moves, said BEFORE the limits are asked', () => {
    const text = _buildRiskReadSection(FACTS, ON(178.81))
    assert.match(text, /SAY IT BEFORE you ask for their risk limit and minimum reward to risk/)
    assert.match(text, /the structure stop 178\.81 is 11\.5% from today's 202\.04 — 2\.6 normal days \(ATR 9\.1\)/)
    assert.match(text, /the deep stop 171\.06 is 15\.3% from today's 202\.04 — 3\.4 normal days/)
    assert.match(text, /judgment, no fixed menu; any level you name comes from get_entry_level/)
    assert.doesNotMatch(text, /worksheet's stop/, 'the worksheet on a candidate stop is not said twice')
    assert.match(_buildRiskReadSection(FACTS, ON(175)), /the worksheet's stop 175 is 13\.4%/)
    assert.match(_buildRiskReadSection({ ...FACTS, timeframe: 'week' }, null), /normal weeks/)
    assert.equal(_buildRiskReadSection(null, ON(175)), '')
})

test('the risk read carries the deep stop\'s date; B waits for the entries stage (drive 9)', () => {
    assert.match(_buildRiskReadSection({ ...FACTS, deep_stop_last_traded: '2026-02-05' }, null), /the deep stop \(not traded under since 2026-02-05\) 171\.06 is 15\.3%/)
    assert.match(_buildRiskReadSection({ ...FACTS, deep_stop_last_traded: null }, null), /not traded under since any day in the history read/)
    assert.match(_buildRiskReadSection({ ...FACTS, side: 'short', deep_stop_last_traded: '2026-01-02' }, null), /not traded over since 2026-01-02/)
    assert.equal(_buildBreakSection({ ...FACTS, stage: 'spans' }, ON(171.06)), '', 'never offered at spans')
    assert.match(_buildBreakSection({ ...FACTS, stage: 'entries' }, ON(171.06)), /ON OFFER THIS TURN/)
})

test('thesisTurnFacts: the close, the normal move, both stops and the chart\'s B — or null', async () => {
    const closes = [...Array(60).fill(100), 98, 96, 97, 99, 100, ...Array(30).fill(100), 98, 95, 92, 89, 86, 83, 81, 80.5, 82, 84, 86, 87, 85, 84, 83.6, 83.5, 84.5, 86]
    const f = await thesisTurnFacts({ ticker: 'gnrc', timeframe: 'day' }, { get: provider(closes) })
    assert.ok(f.break && f.break.swing_to_break.price > f.break.higher_swing.price && f.break.stop < f.break.higher_swing.price, JSON.stringify(f))
    assert.ok(f.atr > 0 && f.deep_stop < f.stop && f.close === 86)
    assert.deepEqual([f.side, f.timeframe], ['long', 'day'])
    assert.equal((await thesisTurnFacts({ ticker: 'x', timeframe: 'day' }, { get: provider(Array(80).fill(10)) })).break, null, 'no B, the risk facts still there')
    assert.equal(await thesisTurnFacts({ ticker: 'x' }, { get: provider([1, 2, 3]) }), null)
    assert.equal(await thesisTurnFacts({ ticker: '' }, { get: provider(closes) }), null)
})

test('the turn: a thesis trade at ENTRIES reads the chart and is told the risk read and B; any other stage never reads', async () => {
    const asked = []
    const facts = async (args) => { asked.push(args); return FACTS }
    const at = (settled) => { const b = upsertName(emptyBuild(), 'GNRC'); return putName(b, { ...activeName(b), settled }) }
    const run = async (build, draft) => {
        let ctx = ''
        await mentorAgentService.chatStream({
            messages: [{ role: 'user', content: 'I\'ll take the deeper stop.' }],
            chatState: { active_asset: 'GNRC', draft: { asset: 'GNRC', direction: 'long', type: 'swing', trade_mode: 'thesis', timeframe: 'day', ...ON(171.06), ...draft, build }, build, coverage: [] },
            _run: async ({ messages }) => { ctx = JSON.stringify(messages.at(-1)); return '' },
            _readSetup: async () => null, _venueSection: async () => '', _thesisFacts: facts,
        })
        return ctx
    }
    const ctx = await run(at({ direction: 'long', horizon: 'swing', lens: 'thesis', spans: ['t1'] }))
    assert.deepEqual(asked, [{ ticker: 'GNRC', timeframe: 'day', side: 'long' }])
    assert.match(ctx, /THE RISK READ/)
    assert.match(ctx, /B is ON OFFER THIS TURN/)
    assert.ok(ctx.indexOf('THE RISK READ') < ctx.indexOf('THE BREAK SCENARIO'))
    const atSpans = await run(at({ direction: 'long', horizon: 'swing', lens: 'thesis' }))
    assert.equal(asked.length, 2, 'the turn that settles spans asks the limits — it reads too (drive 9)')
    assert.match(atSpans, /THE RISK READ/)
    assert.doesNotMatch(atSpans, /THE BREAK SCENARIO/, 'B waits for entries')
    await run(at({ direction: 'long', horizon: 'swing' }))
    await run(at({ direction: 'long', horizon: 'swing', lens: 'thesis', spans: ['t1'] }), { trade_mode: 'smc' })
    assert.equal(asked.length, 2, 'the opening, or another lens: no read')
    const failed = await mentorAgentService.chatStream({
        messages: [{ role: 'user', content: 'go' }],
        chatState: { active_asset: 'GNRC', draft: { asset: 'GNRC', trade_mode: 'thesis', timeframe: 'day' }, build: at({ direction: 'long', horizon: 'swing', lens: 'thesis', spans: ['t1'] }), coverage: [] },
        _run: async () => 'ok', _readSetup: async () => null, _venueSection: async () => '', _thesisFacts: async () => { throw new Error('feed down') },
    })
    assert.ok(failed, 'a failed read never stalls the turn')
})
