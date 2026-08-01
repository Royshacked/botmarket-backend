import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    TAPE, MAJOR_EARNINGS, formatTapeRow, formatTape, formatBriefCalendar, buildBriefInput,
    getMarketBrief, _resetBriefCache,
} from '../../services/marketBrief.service.js'
import { makeMarketBriefHandlers, MARKET_BRIEF_TOOL_SPEC } from '../../services/marketBrief.tools.js'
import { TOOL_SCHEMAS } from '../../services/agentTools.registry.js'
import { TOOLS as AXL_TOOLS } from '../../services/axl.agent.service.js'
import { _isOfferTime, _dayStart } from '../../monitoring/marketBrief.notify.js'

// The brief is a BROADCAST: one text, about the world, identical for every reader. These tests pin
// the three things that keep it that way — the numbers are formatted for what they are, "major"
// earnings is decided in code, and one build is shared rather than run per user.

// ── The tape board ───────────────────────────────────────────────────────────

test('a yield is reported in points, not as a percent change', () => {
    const row = TAPE.find(r => r.kind === 'yield')
    const line = formatTapeRow(row, { price: 4.34, prevClose: 4.28 })
    // 4.28 → 4.34 is +1.4% as a ratio, which reads as the bond market moving 1.4%. It moved 6bp.
    assert.match(line, /4\.34%/)
    assert.match(line, /\+0\.06 pts/)
    assert.ok(!line.includes('1.40%'), 'a yield must not be reported as a percent change')
})

test('a cross keeps four decimals, an index gets thousands separators', () => {
    const fx = formatTapeRow({ label: 'EUR/USD', kind: 'fx' }, { price: 1.08423, prevClose: 1.0810 })
    assert.match(fx, /1\.0842/)

    const idx = formatTapeRow({ label: 'S&P 500', kind: 'index' }, { price: 6512.3, prevClose: 6485.1 })
    assert.match(idx, /6,512\.3/)
    assert.match(idx, /\+0\.42%/)
})

test('a quote that did not come back produces no line at all', () => {
    assert.equal(formatTapeRow({ label: 'DAX', kind: 'index' }, null), null)
    // Number(null) is 0 and passes a finite check — without an explicit guard this printed
    // "DAX: 0", i.e. a missing quote reported as a real level.
    assert.equal(formatTapeRow({ label: 'DAX', kind: 'index' }, { price: null }), null)
    assert.equal(formatTapeRow({ label: 'DAX', kind: 'index' }, { price: '' }), null)
})

test('a missing prevClose still prints the level, without a change', () => {
    const line = formatTapeRow({ label: 'Gold', kind: 'level' }, { price: 3401.5, prevClose: null })
    assert.match(line, /3,401\.5/)
    assert.ok(!line.includes('%'), 'no change is better than a change against nothing')
})

test('the board groups its rows and drops the failures', () => {
    const rows = [
        { group: 'Global equity', label: 'S&P 500', kind: 'index' },
        { group: 'Global equity', label: 'DAX',     kind: 'index' },
        { group: 'Currencies',    label: 'EUR/USD', kind: 'fx' },
    ]
    const out = formatTape(rows, [{ price: 100, prevClose: 99 }, null, { price: 1.08, prevClose: 1.08 }])

    assert.match(out, /Global equity:/)
    assert.match(out, /Currencies:/)
    assert.ok(!out.includes('DAX'), 'a failed quote leaves no row')
})

test('a board with nothing on it says so rather than returning empty', () => {
    const out = formatTape([{ group: 'Global equity', label: 'S&P 500', kind: 'index' }], [null])
    assert.match(out, /unavailable/i)
})

// ── The calendar ─────────────────────────────────────────────────────────────

const CAL = {
    from: '2026-08-01', to: '2026-08-08',
    fed: [{ date: '2026-08-05', event: 'CPI', impact: 'high' }],
    earnings: [
        { date: '2026-08-04', symbol: 'AAPL' },
        { date: '2026-08-04', symbol: 'ZVSA' },   // a real earnings row, not a major one
        { date: '2026-08-06', symbol: 'nvda' },   // provider casing varies
    ],
}

test('only major earnings survive — the rest of the market is dropped', () => {
    const out = formatBriefCalendar(CAL)
    assert.match(out, /AAPL/)
    assert.match(out, /NVDA/, 'a lowercase symbol still matches the major list')
    assert.ok(!out.includes('ZVSA'), 'a small cap must not reach the brief')
})

test('the Fed rows are never filtered — a rate decision is everyone\'s event', () => {
    const out = formatBriefCalendar(CAL)
    assert.match(out, /2026-08-05 CPI \(high\)/)
})

test('a source that could not be read is named, never reported as nothing scheduled', () => {
    const out = formatBriefCalendar({ ...CAL, earnings: [], fed: [], unavailable: ['earnings', 'fed'] })
    assert.match(out, /Fed \/ macro: could not be read/)
    assert.match(out, /Major earnings: could not be read/)
    assert.ok(!out.includes('nothing scheduled'))
})

test('an empty window reads as empty, not as an error', () => {
    const out = formatBriefCalendar({ from: 'a', to: 'b', earnings: [], fed: [] })
    assert.match(out, /nothing scheduled/)
    assert.match(out, /none of the large caps report/)
})

test('both Berkshire spellings are covered — the providers disagree', () => {
    assert.ok(MAJOR_EARNINGS.has('BRK-B') && MAJOR_EARNINGS.has('BRK.B'))
})

// ── The data block ───────────────────────────────────────────────────────────

test('the block carries every section and tells the model not to invent numbers', () => {
    const input = buildBriefInput({ date: '2026-08-01', tape: 'TAPE-X', macro: 'MACRO-X', calendar: 'CAL-X' })
    assert.match(input, /TAPE-X/)
    assert.match(input, /MACRO-X/)
    assert.match(input, /CAL-X/)
    assert.match(input, /2026-08-01/)
    assert.match(input, /do not invent/i)
})

// ── One build, shared ────────────────────────────────────────────────────────

function fakeDeps(text = 'the brief', counter = { runs: 0 }) {
    return {
        counter,
        deps: {
            macro: async () => 'macro text',
            events: async () => ({ from: 'a', to: 'b', earnings: [], fed: [] }),
            quote: async () => ({ price: 1, prevClose: 1 }),
            run: async () => { counter.runs++; return text },
            now: Date.parse('2026-08-01T12:00:00Z'),
        },
    }
}

test('a second reader gets the cached brief, not a second write', async () => {
    _resetBriefCache()
    const { deps, counter } = fakeDeps()

    const first  = await getMarketBrief({}, deps)
    const second = await getMarketBrief({}, deps)

    assert.equal(counter.runs, 1, 'the brief is written once and shared')
    assert.equal(first.cached, false)
    assert.equal(second.cached, true)
    assert.equal(second.text, 'the brief')
})

test('the morning fan-out shares ONE build instead of starting one per user', async () => {
    _resetBriefCache()
    const counter = { runs: 0 }
    let release
    const gate = new Promise(res => { release = res })
    const deps = {
        ...fakeDeps('brief', counter).deps,
        run: async () => { counter.runs++; await gate; return 'brief' },
    }

    // Ten confirms land at once on a cold cache — the exact shape of the daily offer going out.
    const all = Promise.all(Array.from({ length: 10 }, () => getMarketBrief({}, deps)))
    release()
    const results = await all

    assert.equal(counter.runs, 1, 'ten concurrent readers must not start ten model turns')
    assert.ok(results.every(r => r.text === 'brief'))
})

test('refresh rewrites it; the failure does not poison the cache', async () => {
    _resetBriefCache()
    const { deps, counter } = fakeDeps()
    await getMarketBrief({}, deps)
    await getMarketBrief({ refresh: true }, deps)
    assert.equal(counter.runs, 2)

    // A build that throws must leave the next caller free to try again.
    _resetBriefCache()
    const boom = { ...deps, run: async () => { throw new Error('provider down') } }
    await assert.rejects(() => getMarketBrief({}, boom), /provider down/)
    const after = await getMarketBrief({}, deps)
    assert.equal(after.text, 'the brief')
})

test('an empty model reply is a failure, not an empty brief', async () => {
    _resetBriefCache()
    const { deps } = fakeDeps('   ')
    await assert.rejects(() => getMarketBrief({}, deps), /empty/)
})

test('a dead data source still produces a brief — only the model turn is fatal', async () => {
    _resetBriefCache()
    const { deps, counter } = fakeDeps()
    const broken = {
        ...deps,
        macro: async () => { throw new Error('FMP down') },
        events: async () => { throw new Error('calendar down') },
        quote: async () => { throw new Error('no quotes') },
    }
    const { text } = await getMarketBrief({}, broken)
    assert.equal(text, 'the brief')
    assert.equal(counter.runs, 1)
})

// ── The tool ─────────────────────────────────────────────────────────────────

test('the handler states how old the brief is, so a stale one is not relayed as fresh', async () => {
    const asOf = Date.now() - 90 * 60 * 1000
    const handlers = makeMarketBriefHandlers({ brief: async () => ({ text: 'body', asOf }) })
    const out = await handlers.get_market_brief({})
    assert.match(out, /90 minutes ago/)
    assert.match(out, /body/)
})

test('the tool takes no user input at all — the brief cannot be made personal', () => {
    // The only knob is `refresh`. Nothing on this tool can carry a user, a symbol or a position
    // into the brief, which is what keeps the broadcast a broadcast.
    assert.deepEqual(Object.keys(TOOL_SCHEMAS.get_market_brief.properties), ['refresh'])
    assert.match(MARKET_BRIEF_TOOL_SPEC.get_market_brief, /knows NOTHING about this user/)
})

test('a failed brief is reported to the model as a failure, not as silence', async () => {
    const handlers = makeMarketBriefHandlers({ brief: async () => { throw new Error('down') } })
    // makeToolHandler wraps a failure as toolError({ message }) — the model is told it failed.
    const out = await handlers.get_market_brief({})
    assert.match(out.message, /Could not write the market brief: down/)
})

test('the tool is registered and Axl carries it LAST', () => {
    assert.ok(TOOL_SCHEMAS.get_market_brief, 'the schema must be in the registry')
    // Appended, never inserted: the snapshot compares by index and the prompt cache keys off the
    // array prefix (see the note in axl.agent.service.js).
    assert.equal(AXL_TOOLS.at(-1).name, 'get_market_brief')
})

// ── The daily offer window ───────────────────────────────────────────────────

test('no offer at the weekend — there is nothing to brief', () => {
    assert.equal(_isOfferTime(Date.parse('2026-08-01T14:00:00Z')), false, 'Saturday')
    assert.equal(_isOfferTime(Date.parse('2026-08-02T14:00:00Z')), false, 'Sunday')
})

test('the offer waits for its hour, then stays open for the rest of the day', () => {
    assert.equal(_isOfferTime(Date.parse('2026-08-03T09:00:00Z'), 12), false)
    assert.equal(_isOfferTime(Date.parse('2026-08-03T12:00:00Z'), 12), true)
    // A server started in the evening still offers the day's brief rather than skipping the day.
    assert.equal(_isOfferTime(Date.parse('2026-08-03T20:00:00Z'), 12), true)
})

test('the dedupe window is the UTC day containing the tick', () => {
    assert.equal(_dayStart(Date.parse('2026-08-03T20:00:00Z')), Date.parse('2026-08-03T00:00:00Z'))
})
