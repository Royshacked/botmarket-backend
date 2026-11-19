import { test } from 'node:test'
import assert from 'node:assert/strict'
import { atr, ema, levelsFrom, levelsWords, echoSeed, _setDeps } from '../../services/echoLevels.service.js'
import { sanitizeScanSeed } from '../../services/scanSeed.util.js'
import { _buildSeedSection } from '../../services/agents/mentor.agent.service.js'
import { DOC } from '../fixtures/echoEvent.fixture.js'

// Echo Step 6 — the simulator rules' levels, said to Mentor as considerations (docs/design/echo-pipeline.md).

// 40 sessions: flat at 100 (high 101, low 99) to the event, then Day 0 jumps, a high of 112, and drifts at 108.
const dates = []
for (let d = new Date('2026-09-01T00:00:00Z'); dates.length < 40; d = new Date(d.getTime() + 86_400_000)) if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10))
const DAY0 = dates[30]
const bars = Object.fromEntries(dates.map((d, i) => [d, i < 30 ? { open: 100, high: 101, low: 99, close: 100 }
    : i === 30 ? { open: 104, high: 107, low: 103, close: 106 } : i === 33 ? { open: 109, high: 112, low: 108, close: 110 } : { open: 108, high: 109, low: 107, close: 108 }]))
const spy = Object.fromEntries(dates.map(d => [d, { close: 400 }]))

test('ATR and EMA, plainly', () => {
    const rows = dates.slice(0, 25).map(d => bars[d])
    assert.equal(atr(rows), 2, 'high 101, low 99, flat closes')
    assert.equal(ema(rows), 100)
    assert.equal(ema(rows.slice(0, 20)), null, 'fewer than 21 closes')
    assert.equal(atr(rows.slice(0, 5)), null)
})

test("an underreacted winner: entry on a break above the high since the event, the doc's three stops, the trail", () => {
    const lv = levelsFrom({ bars, spy, day0: DAY0, base: dates[29], flag: 'underreacted_winner' })
    assert.equal(lv.rule, 'underreacted winner')
    assert.equal(lv.entry.level, 112)
    assert.match(lv.entry.how, /a break above the high since the event \(112, \d{4}-\d{2}-\d{2}\); no limit orders below the price/)
    assert.deepEqual(lv.stops.map(s => s.how), ['1.5× ATR below the entry', '2× ATR below the entry', `below the event-day low (${DAY0})`])
    assert.equal(lv.stops[2].level, 103)
    assert.match(lv.exit.how, /a close under the 21-day EMA/)
    assert.ok(lv.partial.level > lv.entry.level)
    assert.equal(lv.filter.ok, null, 'SPY has 40 sessions here, not 200')
})

test('an overreacted loser: a close above the prior 5-day high once the new lows stop; the panic low', () => {
    const down = Object.fromEntries(dates.map((d, i) => [d, i < 30 ? { open: 100, high: 101, low: 99, close: 100 }
        : i === 32 ? { open: 80, high: 82, low: 75, close: 78 } : { open: 85, high: 86, low: 83, close: 85 }]))
    const lv = levelsFrom({ bars: down, spy, day0: DAY0, base: dates[29], flag: 'overreacted_loser' })
    assert.equal(lv.rule, 'overreacted loser')
    assert.equal(lv.stops[0].level, 75)
    assert.equal(lv.entry.level, 86)
    assert.match(lv.entry.how, /the low so far is 75/)
    assert.match(lv.exit.how, /at the pre-event level \(100, the close before the event\)/)
})

test('the SPY 200-day filter: below it, the doc takes no new longs', () => {
    const long = []
    for (let d = new Date('2025-09-01T00:00:00Z'); long.length < 210; d = new Date(d.getTime() + 86_400_000)) if (d.getUTCDay() % 6) long.push(d.toISOString().slice(0, 10))
    const s = Object.fromEntries(long.map((d, i) => [d, { close: i < 205 ? 500 : 400 }]))
    const lv = levelsFrom({ bars, spy: s, day0: DAY0, base: dates[29], flag: 'underreacted_winner' })
    assert.equal(lv.filter.ok, false)
    assert.match(levelsWords(lv), /BELOW its 200-day average .* the doc takes no new longs/)
})

test("the seed: a reference read back — the event, the link, the score, the flag, the levels; Mentor's prompt calls them considerations", async () => {
    const ev = { ...DOC, check: { ...DOC.check, day0: DAY0, links: [{ ticker: 'FN', flag: 'underreacted_winner', why: 'scored 9; moved +1%' }] },
        scores: { links: [{ ticker: 'FN', total: 9, high: true, factors: { bottleneck: { score: 2, why: 'scarce optics capacity' }, lockIn: { score: 1, why: 'x' } } }] } }
    _setDeps({ now: () => new Date(`${dates.at(-1)}T23:00:00Z`), events: { get: async (id, u) => (id === DOC._id && u === 'u1' ? ev : null) },
        bars: async (s) => (s === 'SPY' ? spy : bars) })
    const s = sanitizeScanSeed({ ticker: 'fn', direction: 'long', echo: { event: DOC._id } })
    assert.deepEqual(s.echo, { event: DOC._id, ticker: 'FN' })
    assert.equal(sanitizeScanSeed({ ticker: 'FN', echo: { event: 'csco-earnings-2026-11-12' } }).echo, null, 'only a pipeline id')
    const e = await echoSeed(s.echo, 'u1')
    assert.match(e.echo_facts, /the link: supplier, layer 2, loses — optics for Cisco/)
    assert.match(e.echo_facts, /Echo's score 9\/12 \(HIGH\); bottleneck 2 — scarce optics capacity/)
    assert.match(e.echo_facts, /the day-5 check: an UNDERREACTED WINNER — scored 9; moved \+1%/)
    assert.match(e.echo_facts, /The simulator's underreacted winner rule would set — entry: on strength/)
    assert.equal(await echoSeed(s.echo, 'someone else'), null)
    const prompt = _buildSeedSection({ ...s, ...e })
    assert.match(prompt, /^\n\nFROM ECHO, THE EVENT ANALYST: FN \(long\)/)
    assert.match(prompt, /The simulator's levels are a CONSIDERATION, not the trade: weigh them .* build your regular setup with the user/)
})
