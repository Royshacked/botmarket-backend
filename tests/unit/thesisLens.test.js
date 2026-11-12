import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { MODES } from '../../services/analysisModes.js'
import { sanitizeScanSeed } from '../../services/scanSeed.util.js'
import { normalizeSetup, setupReadiness, computeRR } from '../../services/setup.schema.js'
import { thesisGate, scenarioGate } from '../../monitoring/talos.gates.js'
import { _waitingSetups, _buildModeSection, _buildSeedSection, _buildBreakSection, _buildRedrawSection, _buildRiskReadSection, _buildTargetSection, _snapMeasuredTarget, _readThesisFacts, mentorAgentService } from '../../services/agents/mentor.agent.service.js'
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
        assert.match(text, /start with the rules \(§ How you build every trade, the opening\)/)
        assert.doesNotMatch(text, /RISK-BASED|the `thesis` lens/, 'never named (2026-11-12)')
        assert.doesNotMatch(text, /Argus recommends|smc/)
    }
})

test('the lens prompt: a risk-based build opens with the rules, once, and only there (Roy, 2026-11-05)', () => {
    const p = readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const lens = p.slice(p.indexOf('## How you build every trade'), p.indexOf('## Size comes from the user'))
    assert.match(lens, /the\nreply STARTS with these lines/)
    // 'Your numbers:' — position size, risk and R:R, the ONE question (Roy, 2026-11-12; was 'Your limits:').
    for (const rule of ['Stop:', 'Target:', 'Your numbers:', 'Entry:', 'If it leaves before filling:']) assert.ok(lens.includes(`- **${rule}**`), rule)
    assert.match(lens, /Once per build\. Never on a later turn, or on a redraw or an edit of a saved setup\./)
    assert.match(lens, /> How I'll build it:/, 'the rules open without naming a lens (2026-11-12)')
    assert.doesNotMatch(p, /I'm building this risk-based/)
})

test('the lens prompt: one target, a second one offered (stop unchanged), never set unasked — tests 2 / 2b', () => {
    const p = readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8')
    const lens = p.slice(p.indexOf('## How you build every trade'), p.indexOf('## Size comes from the user'))
    assert.match(lens, /ONE target — yours to JUDGE/)
    assert.match(lens, /OFFER a second target, never set it unasked/)
    assert.match(lens, /the stop\s+UNCHANGED — no trail, no move to breakeven/)
})

test('the lens prompt: building straight through keeps the lens; the house valuation is never the take-profit (NXST)', () => {
    const p = readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8')
    const lens = p.slice(p.indexOf('## How you build every trade'), p.indexOf('## Size comes from the user'))
    assert.match(lens, /Building straight through does not skip the judging/)
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
    assert.match(entryLevelText({ stop: 26.9, target: 31.6, min_rr: 1.5 }), /the stop \$1\.88 \(6\.53%\) away/, 'dollars and percent (Roy, 2026-11-05)')
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
    assert.match(breakWords('long'), /day close over arms B\. The stop is ASSUMED: the higher low/)
    assert.match(breakWords('short'), /day close under arms B\. The stop is ASSUMED: the lower high/)
    const f = unmirrorFacts({ close: -50, swings: [], last_swing_low: null, last_swing_high: null, control: 'buyers', fall: null,
        candidates: { stop: -56, deep_stop: -61, target: -40 }, heavy_days: [],
        break_candidate: { swing_to_break: { type: 'high', price: -45 }, higher_swing: { type: 'low', price: -55 }, fall_low: { date: 'd', price: -60 }, stop: -56, stop_is: 'assumed', floor: -60, target: -40, context: 'reversal' } })
    assert.deepEqual(f.break_candidate, { swing_to_break: { type: 'low', price: 45 }, lower_swing: { type: 'high', price: 55 }, rise_high: { date: 'd', price: 60 }, stop: 56, stop_is: 'assumed', floor: 60, target: 40, context: 'reversal' })
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
    return p.slice(p.indexOf('## How you build every trade'), p.indexOf('## Size comes from the user'))
}

test('the lens prompt: the deeper stop is OFFERED with its cost and its date, never set unasked (GNRC)', () => {
    const lens = _lens()
    assert.match(lens, /OFFER the deeper stop, never set it unasked/)
    assert.match(lens, /deep_stop_last_traded/)
    assert.match(lens, /never guess\s+one/)
    assert.match(lens, /may never fill/)
    assert.match(lens, /stop's depth did not move the edge/)
})

test('the lens prompt: the break scenario is offered on every build with an assumed stop; the user takes A, B or both (Roy, 2026-11-04)', () => {
    const lens = _lens()
    assert.match(lens, /The break scenario — OFFER it on every build, never set it unasked/)
    assert.match(lens, /The user takes \*\*A, B or both\*\*/)
    assert.match(lens, /\*\*B's stop is ASSUMED\*\*/)
    assert.doesNotMatch(lens, /No higher low printed → no B/, 'the higher low has not printed by design')
    assert.match(lens, /The break would CHANGE THE STOP when B's\s+stop sits clearly over A's/, 'Roy: B only when the break moves the stop')
    assert.match(lens, /so there is\s+no B, and you say so in one line/)
    // Both by default, no question (Roy, 2026-11-12); a step-by-step build may drop one.
    assert.match(lens, /\*\*Both is the default — no question\*\* \(§ How a trade goes\)/)
    assert.match(lens, /On a step-by-step build they may drop one: A → A alone, B → B alone/)
    assert.match(lens, /a continuation or a breakout tested around zero/)
    assert.match(lens, /B alone keeps its arming condition/)
    assert.match(lens, /B's: the nearest swing high above both its level\s+and the arming line/, 'the break that arms B is never a runaway')
    assert.match(lens, /so the\s+break IS the entry; under it, the break arms B and the entry is the pullback/, 'Roy 2026-11-03: the break is the entry when the limits allow')
    assert.match(lens, /never "B does not fit"/)
    assert.match(lens, /alternatives: the first to\s+fill takes the full size/)
    assert.match(lens, /A\s+day close over \{swing high\} since \{today\}/, 'B arms on a latching day close')
})

test('the lens prompt: every thesis scenario draws a validity range; the runaway answer is redraw by default (NXST; Roy 2026-11-12)', () => {
    const lens = _lens()
    assert.match(lens, /And if it just goes\?/)
    assert.match(lens, /the recent high — the highest high\s+since the last swing low — however close it sits/)
    assert.match(lens, /`on_away` is \*\*`revise` on every scenario — the default, no question\*\*/)
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
    assert.match(lens, /B is offered at the ENTRIES stage, with the stop — never at spans/)
    assert.match(lens, /never quote an R:R or a level of your own either/)
})

test('the lens prompt: the limits come from the ONE question; Mentor reads what fits from the chart — judgment, no menu (Roy)', () => {
    const lens = _lens()
    assert.match(lens, /Their limits — from the ONE question/)
    assert.match(lens, /the RISK LIMIT is their risk ÷ their position size/)
    assert.match(lens, /in this stock's normal\s+moves \(`atr_pct`/)
    assert.match(lens, /Judgment, not a table\./)
    assert.match(lens, /Any\s+LEVEL you name comes from `get_entry_level`/)
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
    assert.match(lens, /B is a second ENTRY OPTION on the same trade/)
    assert.match(lens, /`semantics: "alternatives"` — one scenario per entry/)
})

// ─── The chart's facts on the turn (Roy, 2026-11-02/03: drive 6 had B in the tool and never offered it; drive 8 refused
// B for a level under the break; three drives asked the limits before the risk read) ───

const B_FACTS = { swing_to_break: { type: 'high', date: '2026-10-29', price: 212.81 }, higher_swing: { type: 'low', date: '2026-10-28', price: 181 },
    fall_low: { date: '2026-09-16', price: 173.25 }, stop: 197.34, stop_is: 'assumed', target: 231.89, context: 'reversal' }
const FACTS = { timeframe: 'day', side: 'long', close: 202.04, atr: 9.1, stop: 178.81, deep_stop: 171.06, break: B_FACTS }
const ON = (stop, target = 231.89) => ({ scenarios: [{ id: 's1', stop_legs: [{ price: stop }], target_legs: [{ price: target }] }] })

test('the break section: B is ON OFFER on the regular stop as well as the deep one — the user takes A, B or both (Roy, 2026-11-04)', () => {
    const structure = _buildBreakSection(FACTS, ON(178.81))
    assert.match(structure, /a DAY close over 212\.81 arms it; the stop you ASSUME for then is 197\.34 — \$15\.47 \(7\.3%\) from the break/)
    assert.match(structure, /has not printed, so judge it and say it is assumed/)
    assert.match(structure, /The worksheet's stop 178\.81 is under B's: the break CHANGES THE STOP, so B is ON OFFER THIS TURN/)
    assert.match(structure, /Take BOTH — the default \(§ How a trade goes\), no question: the first to fill takes the whole size and the other is cancelled/)
    assert.match(structure, /Once they dropped one, leave it/)
    assert.match(_buildBreakSection(FACTS, ON(171.06)), /ON OFFER THIS TURN/, 'the deep stop too')
    assert.match(_buildBreakSection(FACTS, { scenarios: [] }), /The structure stop 178\.81 is under B's: the break CHANGES THE STOP/, 'nothing drawn yet: compared with the structure stop')
})

test('the break section: a break that would not move the stop is no B, said in one line', () => {
    const none = _buildBreakSection(FACTS, ON(196))
    assert.match(none, /the break would not move the stop, so B would be A with one more condition — no B\. Say so in one line/)
    assert.match(none, /If the user takes the deep stop \(171\.06\), B is on offer in THAT same turn/)
    assert.doesNotMatch(none, /ON OFFER THIS TURN/)
})

test('the break section: a regular stop price has gone through leaves B as the only offer (Roy, 2026-11-04)', () => {
    const off = _buildBreakSection({ ...FACTS, close: 175 }, { scenarios: [] })
    assert.match(off, /The regular stop 178\.81 is already over today's 175: price has gone through it, so the regular scenario is OFF/)
    assert.match(off, /B is ON OFFER THIS TURN/)
    assert.match(off, /The deep stop \(171\.06\) is still on the right side of the price: offer it too, with its cost, and do not recommend it over B/)
    assert.match(off, /If they take it, there is a regular scenario again, and both can stand/)
    assert.match(off, /a bare "agreed" is not a choice, so ask which/)
    assert.match(off, /B's ENTRY is get_entry_level/)
    assert.doesNotMatch(off, /Ask which they take/, 'no choice to put: A is gone')
    assert.doesNotMatch(_buildBreakSection({ ...FACTS, close: 165 }, { scenarios: [] }), /deep stop \(171\.06\) is still/, 'price under the deep stop too: it is not offered')
    assert.match(_buildBreakSection({ ...FACTS, close: 175, break: { ...B_FACTS, stop: 178.9 } }, { scenarios: [] }), /ON OFFER THIS TURN/, 'offered even when B\'s stop barely clears the dead one')
    const short = { side: 'short', close: 60, atr: 2, stop: 58, deep_stop: 66, break: { swing_to_break: { type: 'low', price: 45 }, stop: 50, target: 38, context: 'reversal' } }
    assert.match(_buildBreakSection(short, { scenarios: [] }), /The regular stop 58 is already under today's 60/)
    assert.doesNotMatch(_buildBreakSection(FACTS, ON(178.81)), /regular scenario is OFF/, 'the price over the stop: the regular scenario stands')
})

test('the lens prompt: the numbers offered are the numbers built; no default of Mentor\'s own for the runaway answer', () => {
    assert.match(_lens(), /The\s+numbers you offer are the ones you build/)
    assert.match(readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8'), /Never announce a default of your own/)
})

test('the break section: no structure stop is not a stop of 0 (code review)', () => {
    const none = _buildBreakSection({ ...FACTS, stop: null }, { scenarios: [] })
    assert.doesNotMatch(none, /stop 0\b/)
    assert.match(none, /A structure stop would be/)
    assert.doesNotMatch(_buildBreakSection({ side: 'short', close: 60, atr: 2, stop: null, deep_stop: 66, break: { swing_to_break: { type: 'low', price: 45 }, stop: 50, target: 38, context: 'reversal' } }, { scenarios: [] }), /regular scenario is OFF/)
})

test('the break section at spans carries what it would at the entries, only the timing differs (code review)', () => {
    const spans = _buildBreakSection({ ...FACTS, stage: 'spans' }, ON(178.81))
    assert.match(spans, /ON OFFER ONCE THE SPAN SETTLES/)
    assert.match(spans, /Take BOTH — the default/)
    assert.match(spans, /B's ENTRY is get_entry_level/)
    assert.match(_buildBreakSection({ ...FACTS, close: 175, stage: 'spans' }, { scenarios: [] }), /regular scenario is OFF/)
    assert.match(_buildBreakSection({ ...FACTS, stage: 'spans' }, ON(196)), /no B/)
})

test('a redraw gets fresh numbers for a lone B, and two scenarios (code review)', () => {
    const loneB = { scenarios: [{ id: 's1', stop_legs: [{ price: 197.34 }], conditions: [{ id: 'c', weight: 'primary', persistence: 'latching', text: 'A day close over 212.81' }] }] }
    assert.equal(_buildBreakSection(FACTS, loneB), '')
    assert.match(_buildBreakSection(FACTS, loneB, { redraw: true }), /the stop you ASSUME for then is 197\.34.*\n.*The structure stop 178\.81 is under B's/)
    assert.match(_buildRedrawSection({ event: 'ran_away' }, { trade_mode: 'thesis' }), /takes its line and its assumed stop from THE BREAK SCENARIO below instead, and a new arm_close/)
})

test('the risk read gives no distance for a stop price has already crossed (code review)', () => {
    const text = _buildRiskReadSection({ ...FACTS, close: 175 }, null)
    assert.match(text, /the structure stop 178\.81 is already crossed at today's 175, so give no distance for it/)
    assert.doesNotMatch(text, /178\.81 is 2\.2%/)
    assert.match(text, /the deep stop 171\.06 is \$3\.94 \(2\.3%\) from today's 175/)
})

test('thesis: B needs its arming price, and the worksheet keeps it', () => {
    const b = { direction: 'long', trade_mode: 'thesis', asset: 'AMD', type: 'swing', entry_mode: 'conditional', valid_until: '2027-01-01T00:00:00.000Z',
        scenarios: [{ id: 's1', entry_legs: [{ price: 570, quantity: 5 }], stop_legs: [{ price: 524 }], target_legs: [{ price: 639 }],
            validity: { lower: 524, upper: 630, approach: 639, timeframe: 'day', on_away: 'revise', on_break: 'revise' },
            conditions: [{ id: 'c', text: 'A day close over 579', weight: 'primary', mode: 'measured', persistence: 'latching' }] }] }
    assert.ok(setupReadiness(normalizeSetup(b), true).missing.some(m => /arming price/.test(m)))
    const armed = normalizeSetup({ ...b, scenarios: [{ ...b.scenarios[0], arm_close: 579.18 }] })
    assert.equal(armed.scenarios[0].arm_close, 579.18)
    assert.ok(!setupReadiness(armed, true).missing.some(m => /arming price/.test(m)))
})

test('the lens prompt: B carries arm_close, and its pivot has a rule at the highs', () => {
    assert.match(_lens(), /`arm_close`: that line's price/)
    assert.match(_lens(), /or its target when there is none \(at the highs\)/)
})

test('the lens prompt: price through the regular stop leaves B alone', () => {
    assert.match(_lens(), /there is no regular\s+trade: say the regular scenario is off, draw nothing on that stop, and offer B alone/)
    assert.match(_lens(), /never recommended over it/)
    assert.match(_lens(), /a bare "agreed" is not a choice/)
})

test('the break section: says what the tests found for this break', () => {
    assert.match(_buildBreakSection(FACTS, ON(178.81)), /a reversal, the one context that held an edge/)
    assert.match(_buildBreakSection({ ...FACTS, break: { ...B_FACTS, context: 'continuation' } }, ON(178.81)), /a continuation, a context that tested around zero: say so/)
    assert.match(_buildBreakSection({ ...FACTS, break: { ...B_FACTS, context: 'breakout' } }, ON(178.81)), /a breakout, a context that tested around zero/)
})

test('the break section: B taken alone is settled, nothing more to offer; A alone stays on offer until declined', () => {
    const loneB = { scenarios: [{ id: 's1', stop_legs: [{ price: 197.34 }], conditions: [{ id: 'c', weight: 'primary', persistence: 'latching', text: 'A day close over 212.81' }] }] }
    assert.equal(_buildBreakSection(FACTS, loneB), '')
    const loneA = { scenarios: [{ id: 's1', stop_legs: [{ price: 178.81 }], conditions: [{ id: 'c', weight: 'primary', persistence: 'live', text: 'strength' }] }] }
    assert.match(_buildBreakSection(FACTS, loneA), /ON OFFER THIS TURN/)
})

test('the break section: B\'s entry is the tool\'s level — the break itself when it fits, a pullback after it when under (Roy, 2026-11-03)', () => {
    const deep = _buildBreakSection(FACTS, ON(171.06))
    assert.match(deep, /B's ENTRY is get_entry_level on B's stop 197\.34, B's target and their limits — never an R:R of your own/)
    assert.match(deep, /Level at or over 212\.81: the break price fits their limits, so the break IS the entry/)
    assert.match(deep, /Level under 212\.81: B waits for a pullback to the level after the break\. Both are B/)
    assert.match(deep, /never "does not fit" for a level under the line/)
    assert.doesNotMatch(_buildBreakSection(FACTS, ON(196)), /B's ENTRY/, 'no B, no entry to explain')
})

test('the break section: A\'s target at B\'s arming line is said; two scenarios or no candidate → nothing', () => {
    assert.match(_buildBreakSection(FACTS, ON(171.06, 212.81)), /B arms where A takes profit, so B's target is the next sellers above 212\.81/)
    assert.doesNotMatch(_buildBreakSection(FACTS, ON(171.06)), /takes profit/)
    assert.equal(_buildBreakSection(FACTS, { scenarios: [ON(171.06).scenarios[0], { id: 's2' }] }), '')
    assert.equal(_buildBreakSection({ ...FACTS, break: null }, ON(171.06)), '')
    assert.equal(_buildBreakSection(null, ON(171.06)), '')
})

test('the break section on a short: mirrored words, the stop compared the other way', () => {
    const s = { side: 'short', atr: 2, deep_stop: 61, break: { swing_to_break: { type: 'low', price: 45 }, lower_swing: { type: 'high', price: 55 }, stop: 56, target: 38, context: 'reversal' } }
    const text = _buildBreakSection(s, ON(61, 40))
    assert.match(text, /a DAY close under 45 arms it; the stop you ASSUME for then is 56/)
    assert.match(text, /the lower high it stands for has not printed/)
    assert.match(text, /stop 61 is over B's: the break CHANGES THE STOP.* its stop is lower than A's/)
    assert.match(text, /Level at or under 45: the break price fits/)
})

test('the risk read: each stop\'s distance in % and in normal moves, said with the result — the limits are never asked (Roy 2026-11-12)', () => {
    const text = _buildRiskReadSection(FACTS, ON(178.81))
    assert.match(text, /SAY IT with the result \(their limits come from the ONE question: risk ÷ position size, and their R:R — never ask for limits\)/)
    assert.match(text, /the structure stop 178\.81 is \$23\.23 \(11\.5%\) from today's 202\.04 — 2\.6 normal days \(ATR 9\.1\)/)
    assert.match(text, /the deep stop 171\.06 is \$30\.98 \(15\.3%\) from today's 202\.04 — 3\.4 normal days/)
    assert.match(text, /judgment, no fixed menu; any level you name comes from get_entry_level/)
    assert.doesNotMatch(text, /worksheet's stop/, 'the worksheet on a candidate stop is not said twice')
    assert.match(_buildRiskReadSection(FACTS, ON(175)), /the worksheet's stop 175 is \$27\.04 \(13\.4%\)/)
    assert.match(_buildRiskReadSection({ ...FACTS, timeframe: 'week' }, null), /normal weeks/)
    assert.equal(_buildRiskReadSection(null, ON(175)), '')
})

test('the risk read carries the deep stop\'s date; B waits for the entries stage (drive 9)', () => {
    assert.match(_buildRiskReadSection({ ...FACTS, deep_stop_last_traded: '2026-02-05' }, null), /the deep stop \(not traded under since 2026-02-05\) 171\.06 is \$30\.98 \(15\.3%\)/)
    assert.match(_buildRiskReadSection({ ...FACTS, deep_stop_last_traded: null }, null), /not traded under since any day in the history read/)
    assert.match(_buildRiskReadSection({ ...FACTS, side: 'short', deep_stop_last_traded: '2026-01-02' }, null), /not traded over since 2026-01-02/)
    const spans = _buildBreakSection({ ...FACTS, stage: 'spans' }, ON(171.06))
    assert.match(spans, /a DAY close over 212\.81 arms it/, 'the numbers are there for the turn that settles the span (AMD drive: it made up its own)')
    assert.match(spans, /Not an offer yet: B waits for the entries\. If this turn settles the span and goes on to the entries, offer B with these numbers/)
    assert.doesNotMatch(spans, /ON OFFER THIS TURN/, 'never offered at spans')
    assert.equal(_buildBreakSection({ ...FACTS, stage: 'sizing' }, ON(171.06)), '')
    assert.match(_buildBreakSection({ ...FACTS, stage: 'entries' }, ON(171.06)), /ON OFFER THIS TURN/)
})

test('thesisTurnFacts: the close, the normal move, both stops and the chart\'s B — or null', async () => {
    const closes = [...Array(60).fill(100), 98, 96, 97, 99, 100, ...Array(30).fill(100), 98, 95, 92, 89, 86, 83, 81, 80.5, 82, 84, 86, 87, 85, 84, 83.6, 83.5, 84.5, 86]
    const f = await thesisTurnFacts({ ticker: 'gnrc', timeframe: 'day' }, { get: provider(closes) })
    assert.ok(f.break && f.break.swing_to_break.price > f.close && f.break.stop_is === 'assumed' && f.break.stop < f.break.swing_to_break.price, JSON.stringify(f))
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
    assert.match(atSpans, /Not an offer yet: B waits for the entries/, 'the numbers ride along; the offer waits for entries')
    assert.doesNotMatch(atSpans, /ON OFFER THIS TURN/)
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

// ─── The code review (2026-11-03) ─────────────────────────────────────────────

test('CR: an empty bar feed is "could not be read", never "not traded in two years"', async () => {
    const text = await entryLevelReply({ ticker: 'gnrc', stop: 26.9, target: 31.6, min_rr: 1.5 }, { get: async () => [] })
    assert.match(text, /\(When GNRC last traded under 26\.9 could not be read\.\)$/)
    assert.doesNotMatch(text, /no day/)
})

test('CR: the facts read before a turn — the week for a long-term trade, bounded, dropped on Stop', async () => {
    const at = (settled) => { const b = upsertName(emptyBuild(), 'GNRC'); return putName(b, { ...activeName(b), settled }) }
    const build = at({ direction: 'long', horizon: 'long_term', lens: 'thesis', spans: ['t1'] })
    const asked = []
    const read = async (a) => { asked.push(a); return FACTS }
    await _readThesisFacts({ draft: { asset: 'GNRC', trade_mode: 'thesis', type: 'long_term', timeframe: 'day' }, build }, read)
    assert.equal(asked[0].timeframe, 'week', 'the horizon decides, not an unset or day timeframe')
    await _readThesisFacts({ draft: { asset: 'GNRC', trade_mode: 'thesis', type: 'swing' }, build }, read)
    assert.equal(asked[1].timeframe, 'day')
    const never = () => new Promise(() => {})
    const t0 = Date.now()
    assert.equal(await _readThesisFacts({ draft: { asset: 'GNRC', trade_mode: 'thesis' }, build }, never, { timeoutMs: 50 }), null)
    assert.ok(Date.now() - t0 < 2000, 'a slow feed costs the facts, never the turn')
    const ac = new AbortController()
    const p = _readThesisFacts({ draft: { asset: 'GNRC', trade_mode: 'thesis' }, build }, never, { signal: ac.signal, timeoutMs: 60000 })
    ac.abort()
    assert.equal(await p, null, 'the user\'s Stop drops it')
})

test('the risk read asks for the NUMBERS in the user\'s words, never the line\'s name (drive 12)', () => {
    assert.match(_buildRiskReadSection(FACTS, null), /with these numbers \(each stop's dollars, its % and its normal days\) — never call it "the risk read"/)
})

test('the break edge is asked in the user\'s words, with the away edge, never as "revise / close / notify only" (Roy, 2026-11-03)', () => {
    const p = readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8')
    const v = p.slice(p.indexOf('## `validity`'), p.indexOf('### `on_away`'))
    assert.match(v, /Ask it in their words, never the field names/)
    assert.match(v, /want a ping to redraw it, close it, or just a heads-up\?/)
    assert.match(v, /Nothing redraws by itself/)
    assert.match(v, /One question for both edges/)
    assert.match(_lens(), /The break edge is not a question here/)
})

test('B needs its floor as well as its line, or Generate refuses it (Roy, 2026-11-04)', () => {
    const b = normalizeSetup({ trade_mode: 'thesis', direction: 'long', asset: 'X', scenarios: [{ id: 'B', name: 'B', arm_close: 100, arm_floor: 90,
        conditions: [{ id: 'c', text: 'A day close over 100', weight: 'primary', persistence: 'latching' }], validity: { lower: 95, upper: 110, approach: 120, on_away: 'pass' } }] })
    assert.equal(b.scenarios[0].arm_floor, 90)
    assert.ok(!setupReadiness(b).missing.some(m => /arming floor/.test(m)))
    const none = { ...b, scenarios: [{ ...b.scenarios[0] }] }
    delete none.scenarios[0].arm_floor
    assert.ok(setupReadiness(none).missing.some(m => /arming floor/.test(m)))
})

test('the lens prompt: a broken stop is not asked about', () => {
    assert.match(_lens(), /The break edge is not a question here/)
    assert.match(_lens(), /`arm_floor`: the candidate's `floor`/)
    assert.match(_lens(), /`lower` at the stop/)
})

// ── Roy, 2026-11-05: target at the highs · dollars and percent · the chart before the limits ─────────────────────────

test('the target section: the measured move at the highs, until the worksheet has a target', () => {
    const facts = { ...FACTS, target: 368.5, target_kind: 'measured_move', range_high: 351.73 }
    assert.match(_buildTargetSection(facts, null), /at the highs.* 351\.73 is the high price is already at, so it is NOT the target.*the measured move, exactly 368\.5: the current range's height added to its high.*anchor: "measured_move"/)
    assert.match(_buildTargetSection({ ...facts, side: 'short' }, null), /at the lows.*added under its low/)
    assert.equal(_buildTargetSection({ ...facts, target_kind: 'range_top' }, null), '', 'a real level overhead needs no nudge')
    assert.equal(_buildTargetSection({ ...facts, target: null }, null), '', 'no number, nothing to say')
    assert.doesNotMatch(_buildTargetSection({ ...facts, range_high: null }, null), /NOT the target/, 'no high read, none named')
    assert.equal(_buildTargetSection(null, null), '')
    assert.equal(_buildTargetSection(facts, { scenarios: [{ arm_close: 351, target_legs: [{ price: 377.53, anchor: 'measured_move' }] }] }), '', 'a lone B keeps its own')
    assert.equal(_buildTargetSection(facts, { scenarios: [{ target_legs: [{ price: 360 }] }] }), '', 'the plan has its target')
    assert.equal(_buildTargetSection(facts, { scenarios: [{ target_legs: [{ price: 360, anchor: 'structure' }] }] }), '', 'a level of its own stands')
    assert.equal(_buildTargetSection(facts, { scenarios: [{ target_legs: [{ price: 368.5, anchor: 'measured_move' }] }] }), '', 'the number is on the sheet')
    assert.match(_buildTargetSection(facts, { scenarios: [{ target_legs: [{ price: 383.67, anchor: 'measured_move' }] }] }), /exactly 368\.5/, 'its own arithmetic is corrected')
})

test('the measured move on the worksheet is the calculated one, whatever the model wrote', () => {
    const facts = { target: 378.13, target_kind: 'measured_move', asset: 'AAPL', side: 'long', timeframe: 'day' }
    const plan = (scenarios, over = {}) => normalizeSetup({ asset: 'AAPL', direction: 'long', trade_mode: 'thesis', scenarios, ...over })
    const regular = (price, anchor = 'measured_move') => ({ id: 's1', entry_legs: [{ price: 335 }], stop_legs: [{ price: 323.73 }], target_legs: [{ price, anchor }] })

    const p = plan([regular(383.67)])
    assert.deepEqual(_snapMeasuredTarget(p, facts), { from: 383.67, to: 378.13 })
    assert.equal(p.scenarios[0].target_legs[0].price, 378.13)
    assert.equal(p.target_legs[0].price, 378.13, 'the flat projection the rest of the app reads')
    assert.equal(p.scenarios[0].rr, computeRR({ direction: 'long', ...p.scenarios[0] }), 'the scenario\'s R follows the target')
    assert.equal(_snapMeasuredTarget(p, facts), null, 'already there: nothing to report')

    const spanned = plan([regular(383.67)])
    spanned.spans = { candidates: [{ id: 't1', to: 'the measured move, 383.67', to_price: 383.67 }, { id: 't2', to: 'the shelf', to_price: 360 }] }
    _snapMeasuredTarget(spanned, facts)
    assert.deepEqual(spanned.spans.candidates.map(c => [c.to, c.to_price]), [['the measured move, 378.13', 378.13], ['the shelf', 360]], 'the span on the table follows')

    const theirs = plan([regular(400)])
    assert.equal(_snapMeasuredTarget(theirs, facts, 'Sell it at $400 please'), null)
    assert.equal(theirs.scenarios[0].target_legs[0].price, 400, 'a price the user just named stays')
    assert.equal(theirs.scenarios[0].target_legs[0].anchor, 'structure', 'and no later turn takes it back')
    const near = plan([regular(400)])
    _snapMeasuredTarget(near, facts, 'the account is 4000, stop at 1,400')
    assert.equal(near.scenarios[0].target_legs[0].price, 378.13, 'digits inside another number are not that price')

    const own = plan([regular(390, 'structure')])
    assert.equal(_snapMeasuredTarget(own, facts), null)
    assert.equal(own.scenarios[0].target_legs[0].price, 390, 'a price with another anchor is left alone')

    const two = plan([{ ...regular(300), target_legs: [{ price: 360, anchor: 'structure' }, { price: 383.67, anchor: 'measured_move' }] }])
    _snapMeasuredTarget(two, facts)
    assert.deepEqual(two.scenarios[0].target_legs.map(l => l.price), [360, 378.13], 'only the measured leg')

    const b = plan([regular(383.67), { ...regular(377.53), id: 's2', arm_close: 351.43, arm_floor: 337.87 }])
    _snapMeasuredTarget(b, facts)
    assert.deepEqual(b.scenarios.map(s => s.target_legs[0].price), [378.13, 377.53], 'B keeps the break candidate\'s target')

    const untouched = plan([regular(383.67)])
    assert.equal(_snapMeasuredTarget(untouched, null), null, 'no facts this turn')
    assert.equal(_snapMeasuredTarget(untouched, { ...facts, target: 400, target_kind: 'range_top' }), null, 'the chart has a real level')
    assert.equal(_snapMeasuredTarget(untouched, { ...facts, asset: 'AMD' }), null, 'the turn moved to another name: not its facts')
    assert.equal(_snapMeasuredTarget(untouched, { ...facts, side: 'short' }), null, 'nor the other side')
    assert.equal(_snapMeasuredTarget(untouched, { ...facts, timeframe: 'week' }), null, 'nor the other chart')
    assert.equal(_snapMeasuredTarget(plan([regular(383.67)], { trade_mode: 'discretionary' }), facts), null, 'the user\'s setup mode is theirs')
    assert.equal(untouched.scenarios[0].target_legs[0].price, 383.67)
})

test('the risk read puts the stop and the target on the worksheet on the turn of the result: the chat charts them', () => {
    const text = _buildRiskReadSection(FACTS, null)
    assert.match(text, /The stop and the target must be on the worksheet's scenario on the turn you give the result/)
    assert.match(text, /Say "the chart below"; get_chart does not put a picture in the chat/)
    assert.doesNotMatch(_buildRiskReadSection(FACTS, null, { redraw: true }), /the chart below/, 'editing a saved setup hides the chart')
})

test('the prompt: a distance is dollars and percent, a measured move at the highs in any mode, the chart before the ask', () => {
    const p = readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8')
    assert.match(p, /A distance is always said in dollars AND percent/)
    assert.match(p, /At the highs, with no price over them worth selling at, the target is a measured move/)
    assert.match(p, /with the stop and the target on the\s+worksheet by that turn/)
})

// ─── The code review of 2026-11-05 ────────────────────────────────────────────

test('a short\'s measured move under zero is no candidate, and no price reaches the plan', async () => {
    const { structureFacts, mirror } = await import('../../services/swingStructure.service.js')
    const rows = []; let p = 100
    const push = (to, n) => { const st = (to - p) / n; for (let k = 0; k < n; k++) { p += st; rows.push({ time: 1700000000 + rows.length * 86400, date: `d${rows.length}`, open: p - st / 2, high: p + 0.4, low: p - 0.4, close: p, volume: 1e6 }) } }
    push(100, 60); push(60, 30); push(70, 10); push(25, 35)
    const f = unmirrorFacts(structureFacts(mirror(rows)))
    assert.equal(f.candidates.target, null)
    const facts = { target_kind: 'measured_move', target: -21.2, asset: 'X', side: 'short', timeframe: 'day' }
    const plan = { trade_mode: 'thesis', asset: 'X', direction: 'short', type: 'swing', scenarios: [{ id: 's1', entry_legs: [{ price: 26 }], stop_legs: [{ price: 30 }], target_legs: [{ price: 15, anchor: 'measured_move' }] }] }
    assert.equal(_snapMeasuredTarget(plan, facts), null)
    assert.equal(plan.scenarios[0].target_legs[0].price, 15)
    assert.equal(_buildTargetSection(facts, {}), '')
})

test('a price the user typed stays, however they wrote it: 354.50 is 354.5', () => {
    const facts = { target_kind: 'measured_move', target: 357.28, asset: 'AAPL', side: 'long', timeframe: 'day' }
    const plan = (price) => ({ trade_mode: 'thesis', asset: 'AAPL', direction: 'long', type: 'swing', scenarios: [{ id: 's1', entry_legs: [{ price: 340 }], stop_legs: [{ price: 330 }], target_legs: [{ price, anchor: 'measured_move' }] }] })
    for (const [price, text] of [[354.5, 'make the target 354.50'], [354.5, 'target $354.5.'], [355, 'target 355.00'], [1200, 'target 1,200']]) {
        const p = plan(price)
        assert.equal(_snapMeasuredTarget(p, facts, text), null, text)
        assert.equal(p.scenarios[0].target_legs[0].price, price)
    }
    for (const [price, text] of [[400, 'somewhere near 4000'], [354.5, 'the 354.55 area']]) assert.ok(_snapMeasuredTarget(plan(price), facts, text), text)
})

test('the waiting remark sizes each setup on its own name\'s multiplier', () => {
    const name = (asset, multiplier) => ({ asset, claimed: {}, settled: { size: { unit: 'risk_cash', value: 100, multiplier } } })
    const build = { names: [name('SPY', 1), name('ES', 50)], active: 'SPY' }
    const leg = { entry_legs: [{ price: 100, quantity: 1 }], stop_legs: [{ price: 90 }], target_legs: [{ price: 120, quantity: 1 }], quantity: 1 }
    const doc = (asset) => ({ id: asset, asset, mainAccountId: 'a', direction: 'long', type: 'swing', ...leg, scenarios: [{ id: 's1', ...leg }], chat_state: { draft: { build } } })
    assert.equal(_waitingSetups([doc('ES')], { accountId: 'a' }).notional, 5000)
    assert.equal(_waitingSetups([doc('SPY')], { accountId: 'a' }).notional, 100)
})
