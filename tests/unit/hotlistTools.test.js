import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitShow, validateShow, showFor, routeFields, SHOW_LISTS } from '../../services/routing.util.js'
import { showLine } from '../../services/desks/sessionTurn.js'
import { formatHotlist, makeHotlistHandlers, HOTLIST_TOOL_SPEC } from '../../services/tools/hotlist.tools.js'
import { TOOLS as AXL_TOOLS } from '../../services/agents/axl.agent.service.js'
import { isToolError, toolErrorText } from '../../services/toolResult.util.js'

// Every Floor list opens in the detail window, and Axl can present each one (Roy, 2026-10-22: "I want
// axl to be able to present them all if user asks" — open it + a one-line summary).

// ─── The show kinds ───────────────────────────────────────────────────────────

test('each list is a screen Axl can show — no ref, like the calendar', () => {
    // Every list (Roy, 2026-10-22: "the user should be able to see all lists through Axl").
    assert.deepEqual([...SHOW_LISTS], ['positions', 'orders', 'trades', 'portfolios', 'watchlists', 'hotlist', 'board', 'research'])
    for (const kind of SHOW_LISTS) {
        assert.deepEqual(splitShow(kind), { kind, ref: null }, kind)
        assert.deepEqual(validateShow({ kind, ref: 'ignored junk' }), { kind, ref: null }, `${kind}: a list takes no ref`)
    }
    assert.deepEqual(splitShow('Trades'), { kind: 'trades', ref: null }, 'case-blind')
    assert.equal(validateShow({ kind: 'everything' }), null, 'an unknown kind opens nothing')
    // The existing kinds are untouched.
    assert.deepEqual(validateShow({ kind: 'heatmap', ref: 'nvda' }), { kind: 'heatmap', ref: 'NVDA' })
    assert.equal(validateShow({ kind: 'setup' }), null, 'a setup still needs its handle')
})

test("the research queue is an admin's list — a trader's show of it is dropped; every other list is anyone's", () => {
    assert.deepEqual(showFor('admin', { kind: 'research' }), { kind: 'research', ref: null })
    assert.equal(showFor('user', { kind: 'research' }), null)
    assert.equal(routeFields({ show: { kind: 'research' } }, 'user').show, null, 'through the controller too')
    assert.deepEqual(showFor('user', { kind: 'board' }), { kind: 'board', ref: null })
    assert.deepEqual(showFor('user', { kind: 'positions' }), { kind: 'positions', ref: null })
})

test('a show-only reply says which list it opened', () => {
    assert.equal(showLine({ kind: 'trades' }), 'Here are your trades.')
    assert.equal(showLine({ kind: 'hotlist' }), "Here's today's hotlist.")
    assert.equal(showLine({ kind: 'orders' }), "Here's what's awaiting orders.")
    assert.equal(showLine({ kind: 'calendar' }), "Here's the calendar.")
    assert.equal(showLine({ kind: 'positions' }), 'Here are your positions.')
    assert.equal(showLine({ kind: 'board' }), "Here's Pythia's forecast board.")
})

// ─── The hotlist read ─────────────────────────────────────────────────────────

const TODAY = {
    day: '2026-10-22',
    latest: { checkpoint: 'mid', argus: { summary: 'Breadth is fine; the room is in EPAM.' } },
    day_list: [
        { symbol: 'EPAM', name: 'EPAM Systems', status: 'in_play', price: 180.5, gap_pct: 1.6,
          cells: { mid: { grade: 'A', why: ['1.56× normal volume, above the open'], range: { pct: 2.4, atr_mult: 0.8 } } },
          pick: { rank: 1, column: 'mid', why: 'Volume behind a clean open.' } },
        { symbol: 'DXC', status: 'setting_up', price: 20.5,
          cells: { week: { grade: 'B', why: ['NR7 · earnings in 7 days — a run-up: out before the report'], range: { pct: 7.3, atr_mult: 2.3 } } } },
        { symbol: 'TSCO', status: 'in_play', avoid: 'Volume with no story.', cells: { mid: { grade: 'C', range: { open_sky: true } } } },
    ],
}

test('the hotlist reads as counts, Argus\'s read, then one line per name with its reason', () => {
    const t = formatHotlist(TODAY)
    assert.match(t, /^Hotlist for 2026-10-22 — 3 names \(2 in play, 1 setting up\)\. Prices as of each name's checkpoint, not live\./)
    assert.match(t, /Argus on the mid board: Breadth is fine/)
    assert.match(t, /EPAM \(EPAM Systems\) · in play · mid-day, 2\.4% room · \$180\.50 \(\+1\.6%\) · ARGUS PICK #1\n {6}1\.56× normal volume, above the open\n {6}Argus: Volume behind a clean open\./)
    assert.match(t, /DXC · setting up · this week, 7\.3% room · \$20\.50\n {6}NR7 · earnings in 7 days — a run-up: out before the report/)
    assert.match(t, /TSCO · in play · mid-day, open sky · Argus: avoid\n {6}Argus \(avoid\): Volume with no story\./)
})

test('the hotlist caps the names it lists, and says how many more', () => {
    const t = formatHotlist(TODAY, 1)
    assert.match(t, /EPAM/)
    assert.doesNotMatch(t, /DXC/)
    assert.match(t, /…and 2 more on the list\./)
})

test('no board yet, or a board with nothing on it, is said plainly', () => {
    assert.match(formatHotlist({ day: null, day_list: [] }), /^No hotlist yet/)
    assert.equal(formatHotlist({ day: '2026-10-22', day_list: [] }), 'Hotlist for 2026-10-22: no names on the list.')
    // The week board's own reason when the market gate is shut (hotlist.week, 2026-10-25).
    assert.match(formatHotlist({ day: '2026-10-26', day_list: [], latest: { closed: 'SPY is under its 200-day' } }), /no names — SPY is under its 200-day/)
})

test('the handler is unbound and never throws — a failed read is an error line, not data', async () => {
    const ok = makeHotlistHandlers({ read: async () => TODAY })
    assert.match(await ok.get_hotlist({ limit: 2 }), /…and 1 more/)
    const bad = makeHotlistHandlers({ read: async () => { throw new Error('db down') } })
    const err = await bad.get_hotlist({})
    assert.ok(isToolError(err), 'flagged as an error, so it is never read as data')
    assert.match(toolErrorText(err), /Could not read today's hotlist: db down/)
})

test('Axl carries get_hotlist, appended last; its description says the run-up rule and never sells a name', () => {
    assert.equal(AXL_TOOLS.at(-1).name, 'get_hotlist')
    assert.match(HOTLIST_TOOL_SPEC.get_hotlist, /run-up names/)
    assert.match(HOTLIST_TOOL_SPEC.get_hotlist, /last three reports all beat/)
    assert.match(HOTLIST_TOOL_SPEC.get_hotlist, /never present a name as a reason a stock will rise/)
})
