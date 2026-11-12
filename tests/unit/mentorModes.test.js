import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    mentorAgentService, MENTOR_TOOLS, _buildModeSection, _forNewLens,
} from '../../services/agents/mentor.agent.service.js'
import { TRADING_TOOLS } from '../../services/tools/trading.tools.js'
import {
    kitFor, handlersFor, lensOf, resolveMode, THESIS_DROPPED, MODE_THESIS, MODE_USER,
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

test('the risk-based kit drops the HANDLERS too — a call to an undeclared tool cannot run (CR #8)', () => {
    const handlers = { get_quote: () => 'q', get_orderblocks: () => 'ob', get_key_levels: () => 'kl' }
    assert.deepEqual(Object.keys(handlersFor(MODE_THESIS, handlers)), ['get_quote'])
    assert.equal(handlersFor(MODE_USER, handlers), handlers)
})

test("the user's-setup kit is the whole kit, untouched", () => {
    assert.equal(kitFor(MODE_USER, MENTOR_TOOLS), MENTOR_TOOLS)
    assert.equal(kitFor(null, MENTOR_TOOLS), MENTOR_TOOLS, 'undecided = the whole kit')
})

// ─── The mode ─────────────────────────────────────────────────────────────────

const nameWith = (settled = {}, claimed = {}) => ({ asset: 'NVDA', settled, claimed })
const never = async () => { throw new Error('the read must not run') }

test('ONE WAY (argus-rework.md §2.3, 2026-11-12): every build is the thesis build — even one that carries another lens', async () => {
    assert.deepEqual(await resolveMode({ name: nameWith({ lens: 'thesis' }), read: never }), { mode: MODE_THESIS, source: 'ledger' })
    assert.deepEqual(await resolveMode({ name: nameWith({}, { lens: { value: 'smc', source: 'mentor' } }), read: never }), { mode: MODE_THESIS, source: 'ledger' })
    assert.equal(lensOf(nameWith({ lens: 'smc' }, { lens: { value: 'thesis', source: 'mentor' } })), 'smc', 'settled wins over the claim')
})

test('a SAVED setup on its own lens, opened for an edit, keeps it — and the whole kit (CR 2026-11-12: no restore loop)', async () => {
    const smc = nameWith({ lens: 'smc' })
    assert.deepEqual(await resolveMode({ name: smc, editing: true }), { mode: MODE_USER, source: 'ledger', lens: 'smc' })
    assert.deepEqual(await resolveMode({ name: smc }), { mode: MODE_THESIS, source: 'ledger' }, 'not editing: the one way')
    assert.deepEqual(await resolveMode({ name: nameWith({ lens: 'thesis' }), editing: true }), { mode: MODE_THESIS, source: 'ledger' })
    const section = _buildModeSection(MODE_USER, 'smc')
    assert.match(section, /keep `trade_mode: "smc"`/)
    assert.doesNotMatch(section, /trade_mode: "thesis"/)
    assert.ok(names(kitFor(MODE_USER, MENTOR_TOOLS)).includes('get_orderblocks'))
})

test('a hand-off (no lens yet) is risk-based without a read', async () => {
    assert.deepEqual(await resolveMode({ seed: { ticker: 'MTG' }, read: never }), { mode: MODE_THESIS, source: 'seed' })
})

test('a typed build is the one way — no read of the user\'s words, no model call (2026-11-12)', async () => {
    const messages = [{ role: 'user', content: 'long NVDA on a pullback to the 50-day' }]
    assert.deepEqual(await resolveMode({ messages, read: never }), { mode: MODE_THESIS, source: 'one' })
})

test('the turn context: the one way, never named — no mode, no switch (2026-11-12)', () => {
    assert.match(_buildModeSection(MODE_THESIS), /BUILD: the one way/)
    assert.match(_buildModeSection(MODE_THESIS), /never say it,\s+nor "lens", "risk-based" or "mode"/)
    assert.doesNotMatch(_buildModeSection(MODE_THESIS), /switch_lens/)
    assert.equal(_buildModeSection(MODE_USER), _buildModeSection(MODE_THESIS), 'an old caller passing the user mode gets the one way')
    assert.equal(_buildModeSection(null), _buildModeSection(MODE_THESIS))
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

test('a switch to their setup keeps the direction and the horizon, RECOMMENDS the lens, reopens the trades and holds the size', () => {
    const { name, cleared, switched } = switchLens(activeName(settledBuild()), 'smc')
    assert.equal(switched, true)
    assert.deepEqual(name.settled, { direction: 'long', horizon: 'swing' }, 'the lens waits on their yes (CR #1)')
    assert.deepEqual(name.claimed.lens, { value: 'smc', source: 'mentor' }, 'Mentor recommended it — the user did not choose it')
    assert.deepEqual(name.claimed.size, { value: { unit: 'risk_cash', value: 500 }, source: 'user' })
    assert.ok(!('spans' in name.claimed) && !('entries' in name.claimed))
    assert.deepEqual(cleared.sort(), ['entries', 'size', 'spans'])
})

test('a switch to thesis is their yes — the lens stays settled', () => {
    const b = settledBuild()
    const smc = putName(b, { ...activeName(b), settled: { ...activeName(b).settled, lens: 'smc' }, claimed: { ...activeName(b).claimed, lens: { value: 'smc', source: 'user' } } })
    const { name } = switchLens(activeName(smc), 'thesis')
    assert.equal(name.settled.lens, 'thesis')
    assert.deepEqual(name.claimed.lens, { value: 'thesis', source: 'user' })
})

test('the same lens again is no switch', () => {
    const before = activeName(settledBuild())
    const r = switchLens(before, 'thesis')
    assert.equal(r.switched, false)
    assert.equal(r.name, before)
})

test('the tag: switch_lens is no longer read (one way, 2026-11-12); the ledger\'s switch itself still clears the gates handed back', () => {
    assert.equal(sanitizeBuildOps({ switch_lens: 'smc', source: 'user' })?.switchLens, undefined)
    assert.equal(sanitizeBuildOps({ switch_lens: 'yolo' }), null)
    const r = applyBuildOps(settledBuild(), { switchLens: 'smc', settle: ['lens'], source: 'user', asset: 'NVDA' })
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

test('a switch takes the old mode\'s pace, conditions and rejects with it, and the new lens gets its own pace (CR #3 #4)', () => {
    const plan = normalizeSetup({ ...PLAN, trade_mode: 'discretionary', pace_rungs: ['1day', '2hr'],
        conditions: [{ text: 'holds VWAP on the 15m', mode: 'judgment' }], alternatives: [{ archetype: 'pullback', why_not: 'the old reject' }] })
    assert.ok(plan.conditions.length && plan.alternatives.length, 'the fixture carries them')
    const out = _forNewLens(plan, 'thesis')
    assert.deepEqual(out.pace_rungs.slice().sort(), ['1hr', '4hr'], 'thesis reads on 1h / 4h, not the old ladder')
    assert.deepEqual(out.conditions, [])
    assert.deepEqual(out.alternatives, [])
    const kept = _forNewLens(plan, 'thesis', { scenarios: plan.scenarios, conditions: plan.conditions })
    assert.equal(kept.scenarios.length, 1, 'what this turn drew again is kept')
    assert.equal(kept.conditions.length, 1)
})

test('the levels go with the old mode, and do not come back from the flat projection', () => {
    const plan = normalizeSetup(PLAN)
    const out = _forNewLens(plan, 'smc')
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

test('every turn runs on the one way\'s kit — a hand-off and a typed build alike (2026-11-12)', async () => {
    const seeded = await turn({ seed: { ticker: 'MTG' }, read: never })
    assert.ok(!seeded.tools.includes('get_orderblocks') && seeded.tools.includes('get_price_structure'))
    const typed = await turn({ read: never })
    assert.ok(!typed.tools.includes('get_orderblocks') && typed.tools.includes('get_price_structure'))
})

test('a turn carrying the old switch_lens tag switches nothing (2026-11-12)', async () => {
    const draft = { ...normalizeSetup(PLAN), build: settledBuild() }
    const { out } = await turn({
        raw: 'Rebuilding it.\n<build>{"switch_lens":"smc","source":"user"}</build>',
        chatState: { active_asset: 'NVDA', draft, coverage: [] },
    })
    assert.equal(out.setup.trade_mode, 'thesis')
    assert.notEqual(lensOf(activeName(out.build)), 'smc')
})

test('a hand-off claims thesis on the ledger on turn one, even when the turn drew no worksheet (CR #6)', async () => {
    const { out } = await turn({ seed: { ticker: 'MTG' }, read: never, raw: 'Reading MTG.' })
    assert.equal(activeName(out.build).asset, 'MTG')
    assert.equal(lensOf(activeName(out.build)), 'thesis')
    assert.equal(out.setup.trade_mode, 'thesis', 'the stub worksheet carries the ledger\'s lens, not the schema default')
})

test('a risk-based turn runs with the pattern handlers gone (CR #8)', async () => {
    let handlers = null
    await mentorAgentService.chatStream({
        messages: [{ role: 'user', content: 'hi' }], seed: { ticker: 'MTG' },
        _run: async (args) => { handlers = args.toolHandlers; return '' }, _readSetup: never, _venueSection: async () => '',
    })
    assert.ok(!('get_orderblocks' in handlers) && 'get_price_structure' in handlers)
})

