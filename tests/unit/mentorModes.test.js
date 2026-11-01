import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    mentorAgentService, MENTOR_TOOLS, _buildModeSection, _withoutLevels,
} from '../../services/agents/mentor.agent.service.js'
import { TRADING_TOOLS } from '../../services/tools/trading.tools.js'
import {
    kitFor, lensOf, resolveMode, makeSetupReader, _userText, THESIS_DROPPED, MODE_THESIS, MODE_USER,
} from '../../services/mentorMode.service.js'
import {
    emptyBuild, upsertName, activeName, putName, switchLens, applyBuildOps, sanitizeBuildOps,
} from '../../services/mentorBuild.util.js'
import { normalizeSetup } from '../../services/setup.schema.js'

// Mentor's two modes (docs/design/mentor-modes.md): risk-based when the user brought no setup, the user's setup
// when they did; the kit follows the mode, and a switch rebuilds the trades under the new one.

const names = (tools) => tools.map(t => t.name)

// ─── The kit ──────────────────────────────────────────────────────────────────

test('the risk-based kit drops exactly the pattern and indicator tools, and keeps what Roy kept', () => {
    const kit = names(kitFor(MODE_THESIS, MENTOR_TOOLS, TRADING_TOOLS.length))
    for (const t of THESIS_DROPPED) assert.ok(!kit.includes(t), `${t} is dropped`)
    for (const t of ['get_quote', 'get_candles', 'get_chart', 'get_price_action', 'get_price_structure', 'get_entry_level',
        'get_news', 'get_earnings', 'get_earnings_calendar', 'get_fundamentals', 'get_sec_filings', 'get_analyst_actions',
        'get_short_interest', 'get_options_context', 'flip_test', 'size_position', 'get_trading_context',
        'check_broker_symbol', 'get_market_hours', 'web_search', 'consult']) {
        assert.ok(kit.includes(t), `${t} is kept`)
    }
    assert.equal(kit.length, MENTOR_TOOLS.length - THESIS_DROPPED.size, 'every dropped name is a real Mentor tool')
    assert.equal(kit.at(-1), 'consult', 'the sidecar stays last')
})

test('the risk-based kit keeps ONE tools-cache breakpoint, on the last shared tool it kept — and mutates nothing', () => {
    const kit = kitFor(MODE_THESIS, MENTOR_TOOLS, TRADING_TOOLS.length)
    const stamped = kit.filter(t => t.cache_control).map(t => t.name)
    assert.deepEqual(stamped, ['get_market_hours'])
    assert.ok(MENTOR_TOOLS.find(t => t.name === 'get_derivatives_context').cache_control, 'the full kit keeps its breakpoint')
    assert.equal(MENTOR_TOOLS.filter(t => t.cache_control).length, 1)
})

test("the user's-setup kit is the whole kit, untouched", () => {
    assert.equal(kitFor(MODE_USER, MENTOR_TOOLS), MENTOR_TOOLS)
    assert.equal(kitFor(null, MENTOR_TOOLS), MENTOR_TOOLS, 'undecided = the whole kit')
})

// ─── The mode ─────────────────────────────────────────────────────────────────

const nameWith = (settled = {}, claimed = {}) => ({ asset: 'NVDA', settled, claimed })
const never = async () => { throw new Error('the read must not run') }

test('the mode is the lens: thesis is risk-based, any other lens is the user\'s setup', async () => {
    assert.deepEqual(await resolveMode({ name: nameWith({ lens: 'thesis' }), read: never }), { mode: MODE_THESIS, source: 'ledger' })
    assert.deepEqual(await resolveMode({ name: nameWith({}, { lens: { value: 'smc', source: 'mentor' } }), read: never }), { mode: MODE_USER, source: 'ledger' })
    assert.equal(lensOf(nameWith({ lens: 'smc' }, { lens: { value: 'thesis', source: 'mentor' } })), 'smc', 'settled wins over the claim')
})

test('a hand-off (no lens yet) is risk-based without a read', async () => {
    assert.deepEqual(await resolveMode({ seed: { ticker: 'MTG' }, read: never }), { mode: MODE_THESIS, source: 'seed' })
})

test('a typed build with no lens is read; a failed read leaves it undecided', async () => {
    const messages = [{ role: 'user', content: 'long NVDA on a pullback to the 50-day' }]
    assert.deepEqual(await resolveMode({ messages, read: async () => MODE_USER }), { mode: MODE_USER, source: 'read' })
    assert.deepEqual(await resolveMode({ messages, read: async () => null }), { mode: null, source: 'read' })
})

test('the setup read: SETUP → the user\'s, NONE → risk-based, anything else or a failure → undecided', async () => {
    const messages = [{ role: 'user', content: 'build NVDA' }]
    const reader = (reply) => makeSetupReader({ once: async () => reply, record: async () => {} })
    assert.equal(await reader('SETUP')({ messages }), MODE_USER)
    assert.equal(await reader(' none.')({ messages }), MODE_THESIS)
    assert.equal(await reader('maybe')({ messages }), null)
    assert.equal(await makeSetupReader({ once: async () => { throw new Error('down') } })({ messages }), null)
    let called = false
    assert.equal(await makeSetupReader({ once: async () => { called = true; return 'SETUP' } })({ messages: [] }), null)
    assert.equal(called, false, 'no user words, no call')
})

test('the read sees the last three user messages, text blocks included', () => {
    const messages = [
        { role: 'user', content: 'one' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'two' },
        { role: 'user', content: [{ type: 'text', text: 'three' }, { type: 'image' }] }, { role: 'user', content: 'four' },
    ]
    assert.equal(_userText(messages), 'two\n---\nthree\n---\nfour')
})

test('the turn context says the mode, and how to switch out of it', () => {
    assert.match(_buildModeSection(MODE_THESIS), /RISK-BASED/)
    assert.match(_buildModeSection(MODE_THESIS), /"switch_lens"/)
    assert.match(_buildModeSection(MODE_USER), /THE USER'S SETUP/)
    assert.match(_buildModeSection(MODE_USER), /"switch_lens":"thesis"/)
    assert.match(_buildModeSection(null), /UNDECIDED/)
    assert.equal(_buildModeSection(undefined), '', 'a caller that did not say gets nothing')
})

// ─── The switch, in the ledger ────────────────────────────────────────────────

/** A build settled through sizing on a risk-based NVDA long. */
const settledBuild = () => {
    const b = upsertName(emptyBuild(), 'NVDA')
    const size = { unit: 'risk_cash', value: 500 }
    return putName({ ...b, delegated: ['spans'] }, {
        ...activeName(b),
        settled: { direction: 'long', horizon: 'swing', lens: 'thesis', spans: ['t1'], entries: ['t1:o1'], size },
        claimed: {
            direction: { value: 'long', source: 'mentor' }, horizon: { value: 'swing', source: 'mentor' },
            lens: { value: 'thesis', source: 'mentor' }, spans: { value: ['t1'], source: 'mentor' },
            entries: { value: ['t1:o1'], source: 'mentor' }, size: { value: size, source: 'user' },
        },
    })
}

test('a switch keeps the direction and the horizon, swaps the lens, reopens the trades and holds the size', () => {
    const { name, cleared, switched } = switchLens(activeName(settledBuild()), 'smc')
    assert.equal(switched, true)
    assert.deepEqual(name.settled, { direction: 'long', horizon: 'swing', lens: 'smc' })
    assert.equal(name.claimed.lens.value, 'smc', 'claimed too, so a later re-settle is a no-op, not a refusal')
    assert.deepEqual(name.claimed.size, { value: { unit: 'risk_cash', value: 500 }, source: 'user' })
    assert.ok(!('spans' in name.claimed) && !('entries' in name.claimed))
    assert.deepEqual(cleared.sort(), ['entries', 'size', 'spans'])
})

test('the same lens again is no switch', () => {
    const before = activeName(settledBuild())
    const r = switchLens(before, 'thesis')
    assert.equal(r.switched, false)
    assert.equal(r.name, before)
})

test('the tag: switch_lens takes a known lens only, and the ledger applies it with the gates handed back cleared', () => {
    assert.deepEqual(sanitizeBuildOps({ switch_lens: 'smc', source: 'user' }), { switchLens: 'smc', source: 'user' })
    assert.equal(sanitizeBuildOps({ switch_lens: 'yolo' }), null)
    const r = applyBuildOps(settledBuild(), { ...sanitizeBuildOps({ switch_lens: 'smc', settle: ['lens'], source: 'user' }), asset: 'NVDA' })
    assert.equal(r.switched, true)
    assert.deepEqual(r.refused, [], 're-settling the new lens in the same tag is not refused')
    assert.equal(activeName(r.build).settled.lens, 'smc')
    assert.deepEqual(r.build.delegated, [], 'a reopened gate is the user\'s again')
})

// ─── The switch, through a turn ───────────────────────────────────────────────

const PLAN = {
    asset: 'NVDA', direction: 'long', type: 'swing', trade_mode: 'thesis', timeframe: '1day',
    scenarios: [{ id: 's1', entry_legs: [{ price: 238 }], stop_legs: [{ price: 230 }], target_legs: [{ price: 260 }] }],
}

test('the levels go with the old mode, and do not come back from the flat projection', () => {
    const plan = normalizeSetup(PLAN)
    const out = _withoutLevels(plan, 'smc')
    assert.equal(out.trade_mode, 'smc')
    assert.deepEqual(out.scenarios, [])
    // A plan with no scenarios round-trips to one EMPTY implicit scenario (setup.schema's flat shape) — no level in it.
    const back = normalizeSetup(out).scenarios.flatMap(sc => [...sc.entry_legs, ...sc.stop_legs, ...sc.target_legs])
    assert.deepEqual(back, [], 'a round trip rebuilds no level')
    assert.equal(out.direction, 'long')
})

const turn = ({ raw = '', chatState = { active_asset: '', draft: null, coverage: [] }, seed = null, read = async () => null } = {}) => {
    let tools = null
    return mentorAgentService.chatStream({
        messages: [{ role: 'user', content: 'hi' }], chatState, seed,
        _run: async (args) => { tools = args.tools; return raw },
        _readSetup: read,
        _venueSection: async () => '',
    }).then(out => ({ out, tools: names(tools) }))
}

test('a hand-off turn runs on the risk-based kit; a typed setup on the whole kit', async () => {
    const seeded = await turn({ seed: { ticker: 'MTG' }, read: never })
    assert.ok(!seeded.tools.includes('get_orderblocks') && seeded.tools.includes('get_price_structure'))
    const typed = await turn({ read: async () => MODE_USER })
    assert.ok(typed.tools.includes('get_orderblocks'))
})

test('a switch turn with no worksheet: the plan carries the new lens and no old levels', async () => {
    const draft = { ...normalizeSetup(PLAN), build: settledBuild() }
    const { out, tools } = await turn({
        raw: 'Rebuilding it on your order block.\n<build>{"switch_lens":"smc","source":"user"}</build>',
        chatState: { active_asset: 'NVDA', draft, coverage: [] },
    })
    assert.ok(!tools.includes('get_orderblocks'), 'the switch turn itself ran on the old mode\'s kit')
    assert.equal(out.setup.trade_mode, 'smc')
    assert.deepEqual(out.setup.scenarios, [])
    assert.equal(activeName(out.build).settled.lens, 'smc')
    assert.ok(!('spans' in activeName(out.build).settled))
    assert.ok(!out.build.refused.some(r => r.field === 'lens'), 'the switch is not reported as a conflict')
})

test('a switch turn that draws new levels keeps them', async () => {
    const draft = { ...normalizeSetup(PLAN), build: settledBuild() }
    const next = { ...PLAN, trade_mode: 'smc', scenarios: [{ id: 's1', entry_legs: [{ price: 241 }], stop_legs: [{ price: 236 }], target_legs: [{ price: 255 }] }] }
    const { out } = await turn({
        raw: `New levels.\n<build>{"switch_lens":"smc","source":"user"}</build>\n<setup>${JSON.stringify(next)}</setup>`,
        chatState: { active_asset: 'NVDA', draft, coverage: [] },
    })
    assert.equal(out.setup.trade_mode, 'smc')
    assert.equal(out.setup.scenarios[0].entry_legs[0].price, 241)
})
