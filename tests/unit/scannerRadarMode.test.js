import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'

import { scannerAgentService } from '../../services/agents/scanner.agent.service.js'

// RADAR CUT is Argus's second mode, and the mirror image of the build hand-off: hand-off replaces
// the LIST half of the spine (it converges on one name), radar replaces the DISCOVERY half (the
// universe is given, and it converges on a short list). Both are modes of the trading profile
// rather than profiles of their own, for the same reason — the screening spine is shared and only
// the ends differ.
//
// WHAT THIS FILE GUARDS. Three things, each of which has a way of going quietly wrong:
//   - an ordinary list turn must not see either module, or Argus reads a page telling it the pool
//     already exists when the user just asked it to find one;
//   - the two modes must never both be live, because one ends in <kairos_pick> and the other in
//     <scan_list> and a turn cannot do both;
//   - the module must not carry the universe. It is a cached block, so interpolating a hundred
//     names into it would give every board its own cache entry — the same rule that keeps the
//     hand-off's destination desk out of its module.

const RADAR = readFileSync(new URL('../../prompts/scanner_mode_radar.md', import.meta.url), 'utf8')

const call = (opts) => {
    let got = null
    return scannerAgentService.chatStream({
        messages: [{ role: 'user', content: 'cut this board' }],
        _run: async (args) => { got = args; return 'ok' },
        ...opts,
    }).then(() => got)
}

test('an ordinary list turn never sees the radar module', async () => {
    const got = await call({})
    assert.equal(got.systemPrompt.length, 2, 'spine + dynamic tail only')
    const all = got.systemPrompt.map(b => b.text).join('\n')
    assert.doesNotMatch(all, /RADAR CUT/)
})

test('a radar turn gets the module as its own cached block, after the spine', async () => {
    const got = await call({ radar: true })
    assert.equal(got.systemPrompt.length, 3, 'spine + mode module + dynamic tail')
    assert.match(got.systemPrompt[1].text, /RADAR CUT MODE — a given universe/)
    assert.equal(got.systemPrompt[1].cache_control?.type, 'ephemeral')
    assert.match(got.systemPrompt[2].text, /ACTIVE MODE: RADAR CUT/)
})

test('hand-off WINS when a caller sets both — one ends in a pick, the other in a list', async () => {
    const got = await call({ radar: true, handoff: true })
    assert.equal(got.systemPrompt.length, 3, 'exactly one mode module, never two')
    assert.match(got.systemPrompt[1].text, /BUILD HAND-OFF MODE/)
    assert.doesNotMatch(got.systemPrompt.map(b => b.text).join('\n'), /RADAR CUT/)
})

test('radar is a trading-profile path — the investing screen never enters it', async () => {
    const got = await call({ radar: true, profile: 'investing' })
    assert.equal(got.systemPrompt.length, 2)
    assert.doesNotMatch(got.systemPrompt.map(b => b.text).join('\n'), /RADAR CUT/)
})

test('the breakpoint budget holds: at most two cached system blocks', async () => {
    for (const opts of [{}, { radar: true }, { handoff: true }, { radar: true, handoff: true }]) {
        const got = await call(opts)
        const cached = got.systemPrompt.filter(b => b.cache_control?.type === 'ephemeral').length
        assert.ok(cached <= 2, `${JSON.stringify(opts)} produced ${cached} cached blocks`)
    }
})

// ── the module itself ────────────────────────────────────────────────────────

// The two batch calls are GONE — the dates and the price ride on the board (aetherScanUniverse), so
// the first pass is free and cannot fail. What the ordering still has to prevent is per-name tools
// over a hundred names, and liquidity is now a question about the shortlist.
test('the module opens on the board itself, not on a batch call', () => {
    assert.doesNotMatch(RADAR, /get_earnings_calendar/,
        'the calendar is attached server-side now; teaching the call back invites the failure it replaced')
    assert.match(RADAR, /get_quotes/)
    assert.ok(RADAR.indexOf('get_quotes') > RADAR.indexOf('FIRST PASS'),
        'quotes are for the shortlist, so they come after the free board pass')
    assert.match(RADAR, /shortlist/)
})

// ── the three passes, and the order that is the point ─────────────────────────
// The tape makes the cut and the catalyst question comes LAST. Before this, the catalyst gate ran
// first and per-name tools were forbidden until after it — so a strong chart could never rescue a
// name, because no chart was ever read. Nothing about the order is incidental.
test('the three passes appear in order, with the tape making the cut', () => {
    const one   = RADAR.indexOf('## FIRST PASS')
    const two   = RADAR.indexOf('## SECOND PASS')
    const three = RADAR.indexOf('## THIRD PASS')
    assert.ok(one > 0 && two > one && three > two, 'the passes must read in order')
    assert.match(RADAR.slice(two, three), /the tape decides. This is the cut/)
    assert.match(RADAR.slice(three), /the catalyst question, on the names the tape already likes/)
})

test('the first pass is explicitly NOT the cut, and is barred from the two filters that broke it', () => {
    const first = RADAR.slice(RADAR.indexOf('## FIRST PASS'), RADAR.indexOf('## SECOND PASS'))
    assert.match(first, /Free, no tools, and NOT the cut/)
    // The calendar as a triage filter is the exact failure being undone, and the side was never a filter.
    assert.match(first, /Do not filter on the earnings calendar in this pass, and do not use HELPED \/ HURT at all/)
})

test('the third pass may order and drop, but the module says what it must never do', () => {
    const third = RADAR.slice(RADAR.indexOf('## THIRD PASS'))
    assert.match(third, /orders/)
    assert.match(third, /run FIRST, on the earnings calendar alone/)
})

// Ten tool rounds is the real budget (DEFAULT_MAX_CONTINUATIONS). Twenty names one call per round is
// the budget gone before a chart is read, and the turn lands on TOOL_BUDGET_LANDING half-finished.
test('the module names the tool budget and tells Argus to call in parallel', () => {
    assert.match(RADAR, /ten rounds/)
    assert.match(RADAR, /CALL IN PARALLEL/)
    assert.match(RADAR, /in a single round/)
    // A NUMBER, and it tracks MAX_PARALLEL_TOOLS: the transport paces a round anyway, so telling the
    // model to ask for twenty at once only buys it a queue it cannot see.
    assert.match(RADAR, /five\s+or six is right/)
    assert.match(RADAR, /paced anyway/)
    // …and what to give up when it runs short: depth over breadth. Whitespace-agnostic, because the
    // phrase is bold-wrapped in the markdown and the line break moves with any edit around it.
    assert.match(RADAR, /narrow\s+the\s+shortlist\s+rather\s+than\s+skimping/)
})

test('the funnel is stated as a shape, so a pass run out of order is nameable', () => {
    assert.match(RADAR, /116 → ~20 → 8-12/)
    assert.match(RADAR, /A pass run out of order is the one failure mode/)
})

// A calendar that could not be read must not read as a company with no catalyst. That confusion is
// exactly what emptied a 116-name board down to one name.
test('the module tells Argus that an UNKNOWN earnings date is not the absence of a catalyst', () => {
    assert.match(RADAR, /UNKNOWN/)
    assert.match(RADAR, /do not read this as|never leave a name off for a fact nobody established/i)
})

// THE CATALYST GATE. Four things count, and the earnings print is only the first — the whole reason a
// mid-quarter board used to collapse to its one off-cycle reporter.
test('the module counts four kinds of catalyst, and demotes earnings to a flag and a tiebreak', () => {
    assert.match(RADAR, /FOUR THINGS COUNT/)
    for (const re of [
        /scheduled print/i,          // 1
        /claim's own deadline/i,      // 2
        /scheduled macro print/i,     // 3
        /move has not happened yet/i, // 4
    ]) assert.match(RADAR, re)
    assert.match(RADAR, /RISK FLAG and a TIEBREAK, not the entrance/)
    // …and the absolute rule it replaced is gone: a claim deadline dates a name on its own.
    assert.doesNotMatch(RADAR, /Without a date, a name does not belong here/)
})

// Twelve is the read's own ceiling (aetherBatchRead BATCH_MAX), not a style preference: past it a
// name ships unread.
test('the module names the list size it is aiming at, and why twelve is real', () => {
    assert.match(RADAR, /eight to twelve/)
    assert.match(RADAR, /unread/)
})

test('the module tells Argus the stated side is context, never a filter or a rank', () => {
    assert.match(RADAR, /HELPED/)
    assert.match(RADAR, /HURT/)
    assert.match(RADAR, /never a filter and never a rank/)
})

test('the module starts at phase 3 and drops the gate before 4', () => {
    assert.match(RADAR, /Phase 3/)
    assert.match(RADAR, /No phase gate between 3 and 4/)
})

test('the module carries no universe of its own — it is a cached block', () => {
    // A ticker in the module would mean a board baked into the cache prefix. The only capitals
    // allowed are the vocabulary; no ticker-shaped literal belongs here.
    assert.doesNotMatch(RADAR, /<scan_universe>/)
    assert.doesNotMatch(RADAR, /\bNVDA\b|\bAAPL\b|\bTSLA\b/)
})

// ── the board in the tail ────────────────────────────────────────────────────

const BOARD = {
    runs: 16,
    held: 12,
    candidates: [
        { ticker: 'NUE', company: 'Nucor', thesis: 'HURT by Canada (2026-09-20) — imports steel',
          earnings: { date: '2026-10-22', epsEstimate: 1.4 }, expires: '2026-11-01', price: 148.2, priceAsOf: '2026-09-25' },
        { ticker: 'XOM', company: 'Exxon', thesis: 'HELPED by Hormuz', returning: true,
          earnings: null, expires: '2026-11-06', price: 118, priceAsOf: '2026-09-25' },
    ],
}

test('the board rides in the VOLATILE tail, never the cached module', async () => {
    const got = await call({ radar: true, radarBoard: BOARD })
    const tail = got.systemPrompt[2].text
    assert.match(tail, /THE BOARD — 2 names Aether's events reached across 16 events/)
    assert.match(tail, /12 more held back/)
    assert.match(tail, /- NUE \(Nucor\)/)
    // Never in the cached block: a board baked into the prefix gives every day its own cache entry.
    assert.doesNotMatch(got.systemPrompt[1].text, /\bNUE\b/)
})

test('a returning name is flagged in the board, so Argus can say why it is back', async () => {
    const got = await call({ radar: true, radarBoard: BOARD })
    assert.match(got.systemPrompt[2].text, /XOM \(Exxon\) \[BACK — a new event named it since your last list\]/)
    assert.doesNotMatch(got.systemPrompt[2].text, /NUE \(Nucor\) \[BACK/)
})

test('the board repeats the side rule where the names are, not only in the module', async () => {
    const got = await call({ radar: true, radarBoard: BOARD })
    assert.match(got.systemPrompt[2].text, /context only — not a filter, not a rank/)
})

// EVERY ROW ARRIVES DATED. These were two tool calls over the whole board — the ones that failed and
// left the cut with no dates for anything — and they are facts on the row now.
test('each row carries its dated facts: the print, the claim deadline and the price', async () => {
    const tail = (await call({ radar: true, radarBoard: BOARD })).systemPrompt[2].text
    assert.match(tail, /- NUE \(Nucor\) — earnings 2026-10-22 · board window to 2026-11-01 · \$148\.2 \(2026-09-25\)/)
    // A name the calendar answered about with nothing scheduled says so in those words.
    assert.match(tail, /XOM .*— no print in the next 30 days · board window to 2026-11-06/)
    assert.match(tail, /You do not need a batch call to get any of them/)
})

// The one distinction the old failure turned on: a calendar that could not be read is NOT a company
// with no catalyst, and the row has to say which it is.
test('an unread calendar renders as UNKNOWN, never as "no print"', async () => {
    const board = { runs: 1, candidates: [{ ticker: 'MU', thesis: 'HELPED by India' }] }   // no `earnings` key at all
    const tail  = (await call({ radar: true, radarBoard: board })).systemPrompt[2].text
    assert.match(tail, /earnings date UNKNOWN/)
    assert.match(tail, /do not read this as "no catalyst"/)
    assert.doesNotMatch(tail, /no print in the next 30 days/)
})

test('a radar turn with NO board is a later turn of the cut — the tail carries no board', async () => {
    const got = await call({ radar: true })
    assert.match(got.systemPrompt[2].text, /ACTIVE MODE: RADAR CUT/)
    assert.doesNotMatch(got.systemPrompt[2].text, /THE BOARD/)
})

test('an empty board is treated as no board rather than as "the radar found nothing"', async () => {
    const got = await call({ radar: true, radarBoard: { candidates: [], runs: 0 } })
    assert.doesNotMatch(got.systemPrompt[2].text, /THE BOARD/)
})

test('a board without the radar flag is never rendered — the mode is what admits it', async () => {
    const got = await call({ radarBoard: BOARD })
    // \bNUE\b rather than /NUE/: VENUE_RULE is appended to the spine, so a loose match always hits.
    assert.doesNotMatch(got.systemPrompt.map(b => b.text).join('\n'), /THE BOARD|\bNUE\b/)
})
