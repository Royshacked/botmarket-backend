import { mentorAgentService } from '../../services/agents/mentor.agent.service.js'
import { makeSetupCommit } from '../../api/setups/setupCommit.service.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mentorStateFromEntity, mentorNextState, mentorDesk, redrawOf } from '../../services/desks/mentor.desk.js'
import { _buildRedrawSection, _buildTurnContext } from '../../services/agents/mentor.agent.service.js'
import { emptyBuild, upsertName, activeName, putName, reopenForRedraw, stageOf, normalizeBuild } from '../../services/mentorBuild.util.js'

// THE RE-DRAW (Roy, 2026-11-03: "when Mentor asks 'should I revise?' and the user says yes — is the revising really
// happening?"). The redraw drive: the card, the push and the button worked, and Mentor opened on a finished ledger and
// asked whether the direction still stood. A setup Talos says ran away or broke now reopens with its levels open, and
// the turn is told what it is for.

const CARD = { redraw: true }
const SIZE = { unit: 'risk_cash', value: 200 }
const VALS = { direction: 'long', horizon: 'swing', lens: 'thesis', spans: ['t1'], entries: ['t1:o1'], size: SIZE, summary: true }
const finished = () => {
    const b = upsertName(emptyBuild(), 'GNRC')
    const claimed = Object.fromEntries(Object.entries(VALS).map(([k, v]) => [k, { value: v, source: k === 'size' ? 'user' : 'mentor' }]))
    return putName(b, { ...activeName(b), settled: VALS, claimed })
}
const SETUP = (over = {}) => ({
    id: 'setup_GNRC_1', asset: 'GNRC', direction: 'long', trade_mode: 'thesis', status: 'looking',
    scenarios: [{ id: 's1', name: 'Pullback to the level' }, { id: 's2', name: 'Break, then pullback' }],
    chat_state: { draft: { asset: 'GNRC', trade_mode: 'thesis', build: finished() }, coverage: ['structure'] },
    ...over,
})
const ran = { monitor_state: { scenarios: { s1: { invalidation_status: 'drifting', invalidation_reason: 'price ran to 214.6 — past the upper edge' } } } }

test('reopenForRedraw: the span and below reopen, its target with it; the opening and the user\'s size stand', () => {
    const { name, cleared } = reopenForRedraw(activeName(finished()))
    assert.deepEqual(cleared.sort(), ['entries', 'size', 'spans', 'summary'])
    assert.deepEqual(Object.keys(name.settled).sort(), ['direction', 'horizon', 'lens'])
    assert.deepEqual(name.claimed.size, { value: SIZE, source: 'user' }, 'their size is held again, never asked twice')
    assert.equal(stageOf(name), 'spans')
    assert.deepEqual(reopenForRedraw(null), { name: null, cleared: [] })
})

test('redrawOf: what Talos latched — a miss, a break (which outranks it), or nothing', () => {
    assert.deepEqual(redrawOf(SETUP(ran)), { event: 'ran_away', reason: 'price ran to 214.6 — past the upper edge', scenarios: ['Pullback to the level'] })
    const both = SETUP({ monitor_state: { scenarios: { s1: { invalidation_status: 'drifting' }, s2: { invalidation_status: 'fired', invalidation_reason: 'closed at 170' } } } })
    assert.deepEqual(redrawOf(both), { event: 'broken', reason: 'closed at 170', scenarios: ['Break, then pullback'] })
    assert.equal(redrawOf(SETUP()), null, 'nothing latched: an ordinary edit')
    assert.equal(redrawOf(SETUP({ ...ran, invalidation_edge: 'time', invalidation_reason: 'the map moved' })).event, 'stale', 'its card asks for a re-draw too')
    assert.deepEqual(redrawOf({ id: 'x', status: 'looking', invalidation_status: 'fired', invalidation_reason: 'gone' }), { event: 'broken', reason: 'gone', scenarios: [] }, 'an older doc: the roll-up alone')
    assert.equal(redrawOf(null), null)
})

test('the reopened state: a missed setup comes back at SPANS with the marker; an ordinary edit is untouched', () => {
    const state = mentorStateFromEntity(SETUP(ran), CARD)
    assert.equal(stageOf(activeName(normalizeBuild(state.draft.build))), 'spans')
    assert.equal(state.redraw.event, 'ran_away')
    const plain = mentorStateFromEntity(SETUP())
    assert.equal(stageOf(activeName(normalizeBuild(plain.draft.build))), null, 'every stage still settled')
    assert.equal('redraw' in plain, false)
    const flat = mentorStateFromEntity({ id: 'x', asset: 'GNRC', status: 'looking', ...ran, scenarios: [{ id: 's1' }] })
    assert.equal(flat.redraw.event, 'ran_away', 'no stored draft: the marker still tells the turn')
})

test('the re-draw section: a miss redrawn with the lens on today\'s chart, a break asked whether it stands', () => {
    const miss = _buildRedrawSection({ event: 'ran_away', reason: 'price ran to 214.6', scenarios: ['Pullback to the level'] }, { trade_mode: 'thesis' })
    assert.match(miss, /it RAN AWAY without filling \(Pullback to the level\) — price ran to 214\.6\. The read was not wrong/)
    assert.match(miss, /The span and the entries are reopened for it; the direction, the horizon and their size stand/)
    assert.match(miss, /CHECK THE WHOLE TRADE AGAIN/)
    assert.match(miss, /Do not ask them whether the direction and the horizon still stand/)
    assert.match(miss, /the entry, the stop, every target, the reward to risk and the validity range, in every scenario/)
    assert.match(miss, /the target read again/)
    assert.match(miss, /call close_setup when they say yes/)
    assert.match(_buildRedrawSection({ event: 'stale', reason: 'the map moved' }, { trade_mode: 'thesis' }), /the map has DRIFTED — the map moved/)
    assert.match(miss, /read get_price_structure, the stop under the NEW higher low, the target read again, the user's same risk limit/)
    assert.match(miss, /new level from get_entry_level, a new validity range/)
    assert.match(miss, /say plainly there is no trade here and they let it go — never a chase/)
    const broke = _buildRedrawSection({ event: 'broken', reason: null, scenarios: [] }, { trade_mode: 'smc' })
    assert.match(broke, /its premise BROKE\./)
    assert.match(broke, /the way they were drawn — read the structure again, never the old levels/)
    assert.match(broke, /First say whether the trade still stands at all/)
    assert.equal(_buildRedrawSection(null, {}), '')
})

test('the turn carries the re-draw section from the reopened state', () => {
    const state = mentorStateFromEntity(SETUP(ran), CARD)
    const ctx = _buildTurnContext({ ...state, build: normalizeBuild(state.draft.build) })
    assert.match(ctx, /THE RE-DRAW — the user opened this setup from Talos's card/)
    assert.doesNotMatch(_buildTurnContext(mentorStateFromEntity(SETUP())), /THE RE-DRAW/)
})

// ─── The code review (2026-11-03) ─────────────────────────────────────────────

test('CR: only BEFORE entry — a live position, a hit or a closed setup is never told it ran away', () => {
    for (const status of ['long', 'short', 'hit', 'closed']) assert.equal(redrawOf(SETUP({ ...ran, status })), null, status)
    for (const status of ['waiting', 'looking', 'resting']) assert.equal(redrawOf(SETUP({ ...ran, status }))?.event, 'ran_away', status)
    const live = mentorStateFromEntity(SETUP({ ...ran, status: 'long' }), CARD)
    assert.equal(stageOf(activeName(normalizeBuild(live.draft.build))), null, 'its ledger untouched')
    assert.equal('redraw' in live, false)
})

test('CR: a miss the user said to let go is no re-draw — nor is its roll-up', () => {
    const passed = SETUP({ ...ran, invalidation_status: 'drifting', scenarios: [{ id: 's1', name: 'A', validity: { on_away: 'pass' } }, { id: 's2', name: 'B' }] })
    assert.equal(redrawOf(passed), null)
    const other = SETUP({ invalidation_status: 'drifting', scenarios: [{ id: 's1', name: 'A', validity: { on_away: 'pass' } }, { id: 's2', name: 'B', validity: { on_away: 'revise' } }],
        monitor_state: { scenarios: { s1: { invalidation_status: 'drifting' }, s2: { invalidation_status: 'drifting', invalidation_reason: 'B ran' } } } })
    assert.deepEqual(redrawOf(other), { event: 'ran_away', reason: 'B ran', scenarios: ['B'] })
})

test('CR: the turn is told the entries reopened only when they were; every old scenario is judged again', () => {
    assert.equal(mentorStateFromEntity(SETUP(ran), CARD).redraw.reopened, true)
    const old = mentorStateFromEntity({ id: 'x', asset: 'GNRC', status: 'looking', ...ran, scenarios: [{ id: 's1' }] })
    assert.equal(old.redraw.reopened, false)
    assert.doesNotMatch(_buildRedrawSection(old.redraw, old.draft), /are reopened for it/)
    assert.match(_buildRedrawSection({ event: 'ran_away', reopened: true }, { trade_mode: 'thesis' }), /are reopened for it/)
    const two = _buildRedrawSection({ event: 'ran_away', reopened: true }, { trade_mode: 'thesis', scenarios: [{ id: 's1' }, { id: 's2' }] })
    assert.match(two, /Every scenario on the worksheet was drawn on the old chart — the break scenario too/)
    assert.match(two, /drop B if the break no longer changes the stop/)
    assert.doesNotMatch(_buildRedrawSection({ event: 'ran_away' }, { trade_mode: 'thesis', scenarios: [{ id: 's1' }] }), /Every scenario/)
})

// ─── Closing it from the chat (Roy, 2026-11-05) ───────────────────────────────

const closeTurn = (chatState, say, closeSetup) => mentorAgentService.chatStream({
    messages: [{ role: 'user', content: 'close it' }], chatState, userId: 'u1', accounts: [{ id: 'a', balance: 1000 }], mainAccountId: 'a',
    _closeSetup: closeSetup, _listSetups: async () => [],
    _run: async ({ toolHandlers }) => { say.report = await toolHandlers.close_setup({}); return 'Closed.' },
})

test('the tool closes the setup being edited, and the turn leaves nothing on the table', async () => {
    const say = {}, calls = []
    const out = await closeTurn({ draft: { asset: 'GNRC' }, coverage: [], editing: { kind: 'setup', entityId: 'setup_1' } }, say, async (...a) => { calls.push(a); return { ok: true, closed: true } })
    assert.deepEqual(calls, [['setup_1', 'u1']])
    assert.match(say.report, /^Closed/)
    assert.deepEqual(out.closedSetup, { id: 'setup_1', asset: 'GNRC' })
    assert.equal(mentorNextState({ draft: { asset: 'GNRC' } }, out), null)
    assert.deepEqual(mentorDesk.sealAfterTurn(out), { kind: 'setup', entityIds: ['setup_1'], name: 'GNRC setup' })
    assert.equal(mentorDesk.sealAfterTurn({ reply: 'x' }), null)
})

test('nothing open, or the card\'s own opening turn, closes nothing', async () => {
    let calls = 0
    const closeSetup = async () => { calls++; return { ok: true } }
    const none = {}
    const a = await closeTurn({ draft: { asset: 'GNRC' }, coverage: [] }, none, closeSetup)
    assert.match(none.report, /^Not closed: no saved setup/)
    assert.equal(a.closedSetup, undefined)
    const card = {}
    await closeTurn({ draft: { asset: 'GNRC' }, coverage: [], editing: { kind: 'setup', entityId: 's' }, redraw: { event: 'broken' } }, card, closeSetup)
    assert.match(card.report, /has not answered yet/)
    assert.equal(calls, 0)
})

test('a refused close is said as refused, and the setup stays on the table', async () => {
    const say = {}
    const out = await closeTurn({ draft: { asset: 'GNRC' }, coverage: [], editing: { kind: 'setup', entityId: 's' } }, say, async () => ({ ok: false, reason: 'not_closable' }))
    assert.match(say.report, /an order is working or the position is filled/)
    assert.equal(out.closedSetup, undefined)
})

test('setupCommit.closeSetup resolves the cards only when it closed', async () => {
    const resolved = []
    const resolveCards = async (subject, opts) => { resolved.push([subject, opts]) }
    const yes = makeSetupCommit({ setups: {}, resolveCards, close: async () => ({ ok: true }) })
    assert.equal((await yes.closeSetup('s1', 'u')).ok, true)
    assert.deepEqual(resolved, [[{ kind: 'setup', id: 's1' }, { outcome: 'closed' }]])
    const no = makeSetupCommit({ setups: {}, resolveCards, close: async () => ({ ok: false, reason: 'not_closable' }) })
    assert.equal((await no.closeSetup('s1', 'u')).ok, false)
    assert.equal(resolved.length, 1)
})

// ─── The reopen lasts the turn (NXST, 2026-11-05) ─────────────────────────────

const WAIVED = () => SETUP({ ...ran, chat_state: { coverage: [], draft: {
    asset: 'GNRC', trade_mode: 'thesis', build: { ...finished(), waiver: true, delegated: ['spans', 'entries'] },
    spans: [{ id: 't1', from: 'here', to: 'there' }], entries: [{ trade: 't1', options: [{ id: 'o1', label: 'old way in' }] }],
} } })
const redrawTurn = (state, reply) => mentorAgentService.chatStream({
    messages: [{ role: 'user', content: 'redraw it' }], chatState: state, userId: 'u1', accounts: [{ id: 'a', balance: 1000 }], mainAccountId: 'a',
    _listSetups: async () => [], _thesisFacts: async () => null, _run: async () => reply,
})

test('the reopened draft has no old gates and no "go all the way"; the plan and the user\'s size stay', () => {
    const { draft } = mentorStateFromEntity(WAIVED(), CARD)
    assert.equal('spans' in draft, false)
    assert.equal('entries' in draft, false)
    const build = normalizeBuild(draft.build)
    assert.equal(build.waiver, false)
    assert.deepEqual(build.delegated, [])
    assert.equal(activeName(build).claimed.size.source, 'user')
    assert.equal(draft.trade_mode, 'thesis')
    const ordinary = mentorStateFromEntity({ ...SETUP(), chat_state: { coverage: [], draft: { asset: 'GNRC', build: { ...finished(), waiver: true } } } })
    assert.equal(normalizeBuild(ordinary.draft.build).waiver, true, 'an ordinary edit keeps it')
})

test('a redraw turn that draws nothing leaves the build open, on a build that once said "go all the way"', async () => {
    const state = mentorStateFromEntity(WAIVED(), CARD)
    const out = await redrawTurn(state, 'Do the direction and the horizon still stand?')
    const name = activeName(normalizeBuild(mentorNextState(state, out).draft.build))
    assert.equal(stageOf(name), 'spans')
    assert.deepEqual(Object.keys(name.settled).sort(), ['direction', 'horizon', 'lens'])
})

test('new gates on a redraw wait for an answer: they are claimed, not settled by the old "go all the way"', async () => {
    const state = mentorStateFromEntity(WAIVED(), CARD)
    const out = await redrawTurn(state, 'Here is the new span.\n<spans>{"candidates":[{"id":"t2","label":"the new pullback","from":"here","to":"the new high"}]}</spans>')
    const name = activeName(normalizeBuild(mentorNextState(state, out).draft.build))
    assert.equal(stageOf(name), 'spans')
    assert.deepEqual(name.claimed.spans?.value, ['t2'])
})

// ─── The pencil is not the card (Roy, 2026-11-05) ─────────────────────────────

test('the pencil on a flagged setup opens it as it is, with the redraw offered', () => {
    const state = mentorStateFromEntity(WAIVED())
    const build = normalizeBuild(state.draft.build)
    assert.equal(stageOf(activeName(build)), null, 'nothing reopened')
    assert.equal(build.waiver, true)
    assert.ok(state.draft.spans)
    assert.equal(state.redraw.offer, true)
    const text = _buildRedrawSection(state.redraw, state.draft)
    assert.match(text, /TALOS FLAGGED THIS SETUP/)
    assert.match(text, /nothing is reopened/)
    assert.match(text, /"unsettle":"spans","waiver":false/)
    assert.doesNotMatch(text, /THE RE-DRAW/)
})

test('the offer stands until they take it; taking it reopens the trade and it stays open', async () => {
    const state = mentorStateFromEntity(WAIVED())
    const stay = await redrawTurn(state, 'Talos flagged it. Want a redraw?')
    const kept = mentorNextState(state, stay)
    assert.equal(kept.redraw?.offer, true)
    const took = await redrawTurn(kept, 'Redrawing.<build>{"unsettle":"spans","waiver":false}</build>')
    const open = mentorNextState(kept, took)
    assert.equal(open.redraw, undefined)
    assert.equal(stageOf(activeName(normalizeBuild(open.draft.build))), 'spans')
    const after = await redrawTurn(open, 'What limit do you want?')
    assert.equal(stageOf(activeName(normalizeBuild(mentorNextState(open, after).draft.build))), 'spans', 'the old gates do not settle it again')
})

test('close on the pencil\'s first turn is the user\'s own answer; the card\'s opening turn still closes nothing', async () => {
    let calls = 0
    const closeSetup = async () => { calls++; return { ok: true } }
    const say = {}
    const pencil = { ...mentorStateFromEntity(SETUP(ran)), editing: { kind: 'setup', entityId: 'setup_GNRC_1' } }
    await closeTurn(pencil, say, closeSetup)
    assert.match(say.report, /^Closed GNRC/)
    assert.equal(calls, 1)
    const card = {}
    await closeTurn({ ...mentorStateFromEntity(SETUP(ran), CARD), editing: { kind: 'setup', entityId: 'setup_GNRC_1' } }, card, closeSetup)
    assert.match(card.report, /has not answered yet/)
    assert.equal(calls, 1)
})

test('close refuses a saved setup the talk has left, and names what it closed', async () => {
    let calls = 0
    const closeSetup = async () => { calls++; return { ok: true } }
    const say = {}
    await closeTurn({ draft: { asset: 'AMD' }, coverage: [], editing: { kind: 'setup', entityId: 's', asset: 'GNRC' } }, say, closeSetup)
    assert.match(say.report, /the saved setup open here is GNRC, and the talk has moved to AMD/)
    assert.equal(calls, 0)
    const out = await closeTurn({ draft: { asset: 'gnrc' }, coverage: [], editing: { kind: 'setup', entityId: 's', asset: 'GNRC' } }, say, closeSetup)
    assert.equal(out.closedSetup.asset, 'GNRC')
})

test('a scenario that broke outranks Talos\'s stale map; stale still reads without one', () => {
    const fired = { monitor_state: { scenarios: { s1: { invalidation_status: 'fired', invalidation_reason: 'closed under the stop' } } } }
    const out = redrawOf(SETUP({ ...fired, invalidation_edge: 'time', invalidation_reason: 'the map moved' }))
    assert.equal(out.event, 'broken')
    assert.deepEqual(out.scenarios, ['Pullback to the level'])
    assert.equal(redrawOf(SETUP({ invalidation_edge: 'time', invalidation_reason: 'the map moved' })).event, 'stale')
})

