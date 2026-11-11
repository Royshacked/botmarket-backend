import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'

import { scannerAgentService, TOOLS, droppedPickNote } from '../../services/agents/scanner.agent.service.js'
import {
    makeHorizonListHandlers, houseListNames, normalizeHorizon, pickableRows, bookLine, formatBookList, formatWeekList, MAX_NAMES,
} from '../../services/tools/horizonList.tools.js'

// Argus is the PICKER since 2026-11-11 (docs/design/argus-rework.md): Mentor sends a user with no name, Argus reads the
// house's list for the trade's horizon and picks ONE name from it. Replaces scannerHandoffMode.test.js — the
// list-building spine and the hand-off module that overrode it are gone.

const PROMPT = readFileSync(new URL('../../prompts/scanner_system_prompt.md', import.meta.url), 'utf8')

const ROW = (over = {}) => ({
    symbol: 'NVDA', name: 'NVIDIA', industry: 'Semiconductors', rating: 'buy', conviction: { level: 'high' },
    price: 180, target: 230, upside_pct: 27.78, target_date: '2027-03-01', state: 'live', list: 'on', timing: null, ...over,
})
const BOOK = { swing: [ROW(), ROW({ symbol: 'AMD', name: 'AMD', timing: { verdict: 'wait', wait_for: 'a pullback to 150' } })], long_term: [] }
const WEEK = { day: '2026-11-11', latest: { checkpoint: 'overnight' }, day_list: [{ symbol: 'ORCL', status: 'setting_up', cells: {} }] }
const DEPS = { book: async () => BOOK, week: async () => WEEK }

// ── the list tool ────────────────────────────────────────────────────────────

test('the horizon words: the five horizons in any spelling, nothing else', () => {
    assert.equal(normalizeHorizon('Swing'), 'swing')
    assert.equal(normalizeHorizon('long-term'), 'long term')
    assert.equal(normalizeHorizon('short_term_swing'), 'short term swing')
    assert.equal(normalizeHorizon(' intraday '), 'intraday')
    for (const v of ['scalp', 'week', '', null, undefined]) assert.equal(normalizeHorizon(v), null)
})

test('a book list is the Buys on the list that are still live — nothing off the list, hit, broken or a Hold', () => {
    const rows = [
        ROW(), ROW({ symbol: 'A', list: 'left' }), ROW({ symbol: 'B', list: null }), ROW({ symbol: 'C', state: 'hit' }),
        ROW({ symbol: 'D', state: 'broken' }), ROW({ symbol: 'E', rating: 'hold' }), ROW({ symbol: 'F', rating: 'strong_buy' }),
    ]
    assert.deepEqual(pickableRows(rows).map(r => r.symbol), ['NVDA', 'F'])
    assert.deepEqual(pickableRows(null), [])
})

test("a book line carries Prometheus's rating, the target and the timing read", () => {
    const line = bookLine(ROW({ timing: { verdict: 'now' } }))
    assert.match(line, /NVDA \(NVIDIA\) · Semiconductors · Prometheus buy, high conviction · \$180\.00 → \$230\.00 \(\+27\.8%\) by 2027-03-01 · timing: NOW/)
    assert.match(bookLine(ROW({ timing: { verdict: 'wait', wait_for: 'the report on 11-20' } })), /timing: WAIT for the report on 11-20/)
    assert.match(bookLine(ROW()), /timing: no read yet/)
    assert.match(bookLine(ROW({ rating: 'strong_buy', price: null })), /Prometheus strong buy/)
})

test('an empty book says so; a long one is capped', () => {
    assert.deepEqual(formatBookList('long term', []).names, [])
    assert.match(formatBookList('long term', []).text, /no Buys on it right now/)
    const many = Array.from({ length: MAX_NAMES + 5 }, (_, i) => ROW({ symbol: `S${i}` }))
    assert.equal(formatBookList('swing', many).names.length, MAX_NAMES)
})

test("This week reads through Axl's hotlist text (one formatter), its names handed on", () => {
    const out = formatWeekList(WEEK)
    assert.deepEqual(out.names, ['ORCL'])
    assert.match(out.text, /Hotlist for 2026-11-11/)
    // The market gate shut: the board's own reason, no names.
    const shut = formatWeekList({ day: '2026-11-11', latest: { closed: 'SPY is under its 200-day' }, day_list: [] })
    assert.deepEqual(shut.names, [])
    assert.match(shut.text, /SPY is under its 200-day/)
})

test('the handler: each horizon reads its own list and hands every name it showed to onNames', async () => {
    const seen = []
    const h = makeHorizonListHandlers({ onNames: (n) => seen.push(...n), deps: DEPS }).get_horizon_list
    assert.match(await h({ horizon: 'swing' }), /The house's swing list — 2 Buys/)
    assert.match(await h({ horizon: 'short term swing' }), /ORCL/)
    assert.match(await h({ horizon: 'long term' }), /no Buys/)
    assert.deepEqual(seen, ['NVDA', 'AMD', 'ORCL'])
})

test('the day boards are not running yet: intraday and day say so and list nothing', async () => {
    const seen = []
    const h = makeHorizonListHandlers({ onNames: (n) => seen.push(...n), deps: DEPS }).get_horizon_list
    for (const horizon of ['intraday', 'day']) assert.match(await h({ horizon }), /day boards are not running yet/)
    assert.deepEqual(seen, [])
})

test('a wrong horizon is answered, and a failed read says so in text — never a throw', async () => {
    const h = makeHorizonListHandlers({ deps: { book: async () => { throw new Error('db down') } } }).get_horizon_list
    assert.match(await h({ horizon: 'scalp' }), /Pass `horizon`/)
    const out = await h({ horizon: 'swing' })
    assert.match(typeof out === 'string' ? out : JSON.stringify(out), /db down/)
})

// ── the desk ─────────────────────────────────────────────────────────────────

test("Argus's kit: the list tool in, the market screen out, consult last", () => {
    const names = TOOLS.map(t => t.name)
    assert.ok(names.includes('get_horizon_list'))
    for (const gone of ['screen_candidates', 'get_market_movers', 'get_sector_snapshot', 'get_analyst_actions', 'get_house_industries']) {
        assert.ok(!names.includes(gone), `${gone} is still in his kit`)
    }
    assert.equal(names.at(-1), 'consult')
})

const call = (opts = {}) => {
    let got = null
    return scannerAgentService.chatStream({
        messages: [{ role: 'user', content: 'a swing, please' }],
        _venueSection: async () => null,
        _run: async (args) => { got = args; return 'ok' },
        ...opts,
    }).then(() => got)
}

// BREAKPOINT BUDGET: four per request — tools one, _stampHistoryCache one; the system prompt spends one now.
test('one cached prompt + the volatile tail; no archived mode leaks in', async () => {
    for (const opts of [{}, { handoff: true, handoffTo: 'mentor' }, { profile: 'investing' }]) {
        const got = await call(opts)
        assert.equal(got.systemPrompt.length, 2)
        assert.equal(got.systemPrompt[0].cache_control?.type, 'ephemeral')
        assert.equal(got.systemPrompt.filter(b => b.cache_control).length, 1)
        assert.match(got.systemPrompt[0].text, /get_horizon_list/)
        assert.match(got.systemPrompt[1].text, /CURRENT DATE/)
        assert.doesNotMatch(got.systemPrompt.map(b => b.text).join('\n'), /BUILD HAND-OFF MODE|RADAR CUT|EDIT MODE|<scan_list>/)
    }
})

// Play the captured tags the way the provider would; `list` first runs the list tool the way the model would.
const playing = (reply, horizon = null) => async (bag) => {
    if (horizon) await bag.toolHandlers.get_horizon_list({ horizon })
    for (const name of ['argus_pick', 'scan_list', 'phase']) {
        const m = reply.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
        const cap = bag.tagCaptures?.find(t => t.open === `<${name}>`)
        if (m && cap?.onCapture) cap.onCapture(m[1])
    }
    return reply
}
const PICK = (t) => `${t} it is.\n<argus_pick>{"ticker":" ${t.toLowerCase()} ","direction":"long","thesis":"On the swing list, timing now.","analysis":"a"}</argus_pick>`

test('a pick from the list he was shown comes back normalized', async () => {
    const out = await scannerAgentService.chatStream({ messages: [{ role: 'user', content: 'swing' }], _venueSection: async () => null,
        _listDeps: DEPS, _run: playing(PICK('NVDA'), 'swing') })
    assert.equal(out.pick.ticker, 'NVDA')
    assert.equal(out.pick.direction, 'long')
    assert.equal(out.pick.thesis, 'On the swing list, timing now.')
    assert.equal('grounding' in out.pick, false, 'the grounding ledger is gone — the list gate replaced it')
})

test('THE GATE: a pick on none of the house lists is dropped', async () => {
    // Off the list he read, and off every other list.
    const off = await scannerAgentService.chatStream({ messages: [{ role: 'user', content: 'swing' }], _venueSection: async () => null,
        _listDeps: DEPS, _run: playing(PICK('TSLA'), 'swing') })
    assert.equal('pick' in off, false)
    // No list read at all, and not on any list.
    const none = await scannerAgentService.chatStream({ messages: [{ role: 'user', content: 'swing' }], _venueSection: async () => null,
        _listDeps: DEPS, _run: playing(PICK('TSLA')) })
    assert.equal('pick' in none, false)
    // A name on a DIFFERENT horizon's list he also read is still a name he was shown.
    const other = await scannerAgentService.chatStream({ messages: [{ role: 'user', content: 'swing' }], _venueSection: async () => null,
        _listDeps: DEPS, _run: async (bag) => { await bag.toolHandlers.get_horizon_list({ horizon: 'short term swing' }); return playing(PICK('ORCL'), 'swing')(bag) } })
    assert.equal(other.pick.ticker, 'ORCL')
})

test('THE GATE, a later turn: "another one" from a list read on an earlier turn passes on the second look', async () => {
    // The history keeps text only — no list call this turn, yet AMD is on the swing list.
    const again = await scannerAgentService.chatStream({
        messages: [{ role: 'user', content: 'swing' }, { role: 'assistant', content: 'NVDA, timing now.' }, { role: 'user', content: 'another one' }],
        _venueSection: async () => null, _listDeps: DEPS, _run: playing(PICK('AMD')) })
    assert.equal(again.pick.ticker, 'AMD')
    // A This week name passes the same way.
    const week = await scannerAgentService.chatStream({ messages: [{ role: 'user', content: 'another' }], _venueSection: async () => null,
        _listDeps: DEPS, _run: playing(PICK('ORCL')) })
    assert.equal(week.pick.ticker, 'ORCL')
})

test('THE GATE: a failed second look keeps it shut — no pick, never a throw', async () => {
    const out = await scannerAgentService.chatStream({ messages: [{ role: 'user', content: 'another' }], _venueSection: async () => null,
        _listDeps: { book: async () => { throw new Error('db down') }, week: async () => WEEK }, _run: playing(PICK('NVDA')) })
    assert.equal('pick' in out, false)
})

test('a dropped pick says why under the reply — in the stream and in the saved reply', async () => {
    const streamed = []
    const out = await scannerAgentService.chatStream({ messages: [{ role: 'user', content: 'swing' }], _venueSection: async () => null,
        _listDeps: DEPS, onToken: (t) => streamed.push(t), _run: playing(PICK('TSLA'), 'swing') })
    assert.equal('pick' in out, false)
    assert.ok(out.reply.endsWith(droppedPickNote('TSLA')))
    assert.deepEqual(streamed, [droppedPickNote('TSLA')])
    assert.match(droppedPickNote('TSLA'), /TSLA is not on the house's lists today.*give Mentor the name yourself/)
    // A pick that stands adds nothing.
    const kept = await scannerAgentService.chatStream({ messages: [{ role: 'user', content: 'swing' }], _venueSection: async () => null,
        _listDeps: DEPS, onToken: (t) => streamed.push(t), _run: playing(PICK('NVDA'), 'swing') })
    assert.equal(kept.pick.ticker, 'NVDA')
    assert.equal(kept.reply.includes('house\'s lists today'), false)
    assert.equal(streamed.length, 1)
})

test('houseListNames: every horizon\'s names, the same cut as the tool, upper-cased', async () => {
    const names = await houseListNames({ ...DEPS, book: async () => ({ swing: [ROW({ symbol: 'nvda' }), ROW({ symbol: 'HOLD1', rating: 'hold' })], long_term: [ROW({ symbol: 'MSFT' })] }) })
    assert.deepEqual([...names].sort(), ['MSFT', 'NVDA', 'ORCL'])
    await assert.rejects(houseListNames({ ...DEPS, week: async () => { throw new Error('x') } }))
})

test('a stray <scan_list> is swallowed — no `scan` comes back, and the tag never reaches the reply', async () => {
    const reply = 'Here are some names.\n<scan_list>{"thesis":"semis","candidates":[{"ticker":"NVDA"}]}</scan_list>'
    const out = await scannerAgentService.chatStream({ messages: [{ role: 'user', content: 'list me semis' }], _venueSection: async () => null, _run: playing(reply) })
    assert.equal('scan' in out, false)
    assert.equal('pick' in out, false)
    assert.doesNotMatch(out.reply, /scan_list|candidates/)
})

// ── the prompt, as text ──────────────────────────────────────────────────────

test('the prompt: the picker from the list — no market screen, no angle question, no build lens, no levels', () => {
    assert.match(PROMPT, /You are Argus, the picker/)
    assert.match(PROMPT, /ONLY place you pick from/)
    assert.match(PROMPT, /<argus_pick>/)
    assert.doesNotMatch(PROMPT, /screen_candidates|get_market_movers|get_house_industries|<scan_list>|<phase>/)
    assert.match(PROMPT, /Never ask for\s+an angle, a sector or a market cap/)
    assert.match(PROMPT, /never set an entry, a stop or a target/)
    assert.doesNotMatch(PROMPT, /recommended_mode|lens/)
})

test('the prompt: an empty list in a short regime is said plainly, with no pick — we do not short yet', () => {
    assert.match(PROMPT, /does\s+not short yet/)
    assert.match(PROMPT, /give no pick/)
})

test("the prompt: a user's own name is Mentor's, not a pick", () => {
    assert.match(PROMPT, /trade a name of their own, that is Mentor's/)
    assert.doesNotMatch(PROMPT, /VALIDATE-A-NAME/)
})
