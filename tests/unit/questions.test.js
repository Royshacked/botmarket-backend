import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { traderQuestions, portfolioQuestions, analystQuestions, questionsFor, needsQuestions, checkAnswers, answersText, isShown } from '../../services/desks/questions.js'
import { makeAsking, CARD_LINE, coverNote } from '../../services/desks/asking.js'
import { makeModes } from '../../services/desks/modes.js'
import { makeBuilds } from '../../services/desks/builds.js'

// Questions up front (docs/design/modes-and-builders.md M5/M6, step 4): one card, built by code, answered once.

const user = { _id: 'u1', role: 'user' }

test("the trader's card: the name (the one they came with first), the account, the THREE numbers each asked (last time's under its own), the scenarios, the breaking rule, the policy", () => {
    const q = traderQuestions({ symbol: 'nvda', size: { unit: 'risk_pct', value: 1 } })
    const by = Object.fromEntries(q.map(x => [x.id, x]))
    assert.deepEqual(q.map(x => x.id), ['name', 'account', 'size', 'risk', 'rr', 'scenarios', 'invalidation', 'surprises'])
    assert.deepEqual(by.name.options.map(o => o.label), ['NVDA', 'Find one for me'])
    assert.equal(by.account.kind, 'account'); assert.equal(by.account.multiSelect, false)
    // Last time was a RISK — offered under Risk, never as the whole answer (the drive, 2026-11-20: "$10,000 in the
    // position" alone sent the build back for the risk and the R:R).
    assert.deepEqual(by.size.options, [])
    assert.deepEqual(by.risk.options.map(o => o.label), ['As last time: 1% of the account at risk', '0.5% of the account', '1% of the account', '2% of the account'])
    assert.deepEqual(by.rr.options.map(o => o.label), ['1.5', '2', '3'])
    assert.deepEqual(traderQuestions({ size: { unit: 'size_cash', value: 10000 } }).find(x => x.id === 'size').options.map(o => o.label), ['As last time: $10,000 in the position'])
    assert.deepEqual(by.scenarios.options.map(o => o.label), ['Both (recommended)', 'A only', 'B only'])
    assert.deepEqual(by.invalidation.options.map(o => o.label), ['Redraw it', 'Close it', 'Ask me'])
    assert.ok(q.every(x => x.header.length <= 12), 'headers fit the chip')
    assert.deepEqual(traderQuestions()[0].options.map(o => o.label), ['Find one for me'])
})

test("the portfolio manager's card: the mandate, the account(s) — several allowed — and the policy", () => {
    assert.deepEqual(portfolioQuestions().map(x => x.id), ['objective', 'horizon', 'drawdown', 'capital', 'constraints', 'account', 'surprises'])
    assert.equal(portfolioQuestions().find(x => x.id === 'account').multiSelect, true)
    assert.equal(questionsFor('axl'), null)
})

test('a card is due only for a NEW build', () => {
    assert.equal(needsQuestions('mentor', null, 'user'), true)
    assert.equal(needsQuestions('mentor', { active_asset: 'NVDA' }, 'opening'), true)
    assert.equal(needsQuestions('portfolio', {}, 'mode'), true)
    assert.equal(needsQuestions('analyst', null, 'mode'), true, 'the analyst asks too since 2026-11-21')
    for (const [why, args] of [
        ['a trade on the table', ['mentor', { draft: {} }, 'user']],
        ['a chain step', ['mentor', null, 'chain']],
        ['editing a saved item', ['mentor', { editing: { kind: 'setup' } }, 'user']],
        ['working for a chain', ['mentor', { chainId: 'c' }, 'user']],
        ['a card already open', ['mentor', { asking: { seq: 3 } }, 'user']],
        ['already asked — the user talking on', ['mentor', { asked: true }, 'user']],
        ['the answers\' own turn', ['mentor', { asked: true }, 'opening', { answered: true }]],
        ['a press', ['mentor', null, 'user', { ops: [{}] }]],
        ['a book in review', ['portfolio', { reviewMode: true }, 'user']],
        ['a mandate already given', ['portfolio', { mandate: {} }, 'user']],
        ['a coverage draft on the table', ['analyst', { draft: {} }, 'user']],
        ['a coverage build running', ['analyst', { build: { status: 'building' } }, 'mode']],
    ]) assert.equal(needsQuestions(...args), false, why)
    assert.equal(needsQuestions('mentor', { asked: true }, 'opening'), true, 'a new route after a build that ended with nothing asks again')
})

test('the answers are checked: every question, an option or Other, an account by id — one where one is asked', () => {
    const q = traderQuestions({ symbol: 'NVDA' })
    const full = {
        name: { choice: 'NVDA' }, account: { accountId: 'a1', accountLabel: 'Paper main' }, size: { other: '$10,000' }, risk: { choice: '1% of the account' }, rr: { choice: '1.5' },
        scenarios: { choice: 'Both (recommended)' }, invalidation: { choice: 'Redraw it' }, surprises: { choice: 'Decide for me' },
    }
    const ok = checkAnswers(q, full)
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.answers.account, { accountIds: ['a1'], accountLabel: 'Paper main' })
    assert.equal(checkAnswers(q, { ...full, size: {} }).reason, 'unanswered:size')
    assert.equal(checkAnswers(q, { ...full, scenarios: { choice: 'Something else' } }).reason, 'unanswered:scenarios', 'not an option, and no Other here')
    assert.equal(checkAnswers(q, { ...full, account: { accountIds: ['a1', 'a2'] } }).reason, 'one_account:account')
    assert.equal(checkAnswers(q, null).reason, 'invalid_answers')

    const text = answersText('mentor', q, ok.answers)
    assert.match(text, /^My answers to the build questions \(asked up front — do not ask them again\):/)
    assert.match(text, /- Which stock\? NVDA\n- Which account does it go to\? Paper main\n- How big is the position\? \$10,000\n- How much do you lose if the stop is hit\? 1% of the account\n- The least reward-to-risk worth taking\? 1\.5/)
    assert.match(text, /Take it all the way: build it and generate it/)
})

// The house's coverage book, for the analyst's card: TSLA covered, nothing else.
const BOOK = { listSymbols: async () => ['TSLA'], getCoverageBySymbol: async (s) => (s === 'TSLA' ? { id: 'cov-tsla', symbol: 'TSLA', rating: 'hold' } : null) }

function rig() {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const turns = []
    const runTurn = async (x) => { turns.push(x) }
    const builds = makeBuilds({ sessions, depth: () => 0, runTurn })
    const asks = makeAsking({ sessions, profiles: { read: async () => ({ notes: [], size: { unit: 'risk_pct', value: 1 } }) }, runTurn, builds, coverage: BOOK })
    return { sessions, asks, turns, builds, modes: makeModes({ sessions, asks }) }
}
// A card opened from the picker has no name to offer: the name arrives as Other.
const answersFor = (over = {}) => ({
    name: { other: 'NVDA' }, account: { accountId: 'a1', accountLabel: 'Paper main' }, size: { other: '$10,000' }, risk: { choice: 'As last time: 1% of the account at risk' }, rr: { choice: '2' },
    scenarios: { choice: 'Both (recommended)' }, invalidation: { choice: 'Ask me' }, surprises: { choice: 'Ask me' }, ...over,
})

test('picking Trader posts the card; answering it marks it, picks the account, and runs the trader on the answers', async () => {
    const { sessions, asks, turns, modes } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    const r = await modes.setMode({ user, sessionId: s.sessionId, mode: 'mentor' })
    const { card } = await r.done
    const [row] = await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })
    assert.deepEqual([row.seq, row.kind, row.agent, row.content, row.ref.state], [card, 'questions', 'mentor', CARD_LINE, 'open'])
    assert.equal((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState.mentor.asking.seq, card)

    const accounts = [{ id: 'a1', broker: 'paper', name: 'Paper main' }, { id: 'a2', broker: 'paper' }]
    const out = await asks.answer({ user, sessionId: s.sessionId, seq: card, answers: answersFor(), accounts, mainAccountId: 'a2' })
    assert.equal(out.agent, 'mentor')
    assert.equal(turns.length, 1)
    assert.equal(turns[0].origin, 'opening')
    assert.deepEqual(turns[0].input.accounts, [accounts[0]], 'only the account picked on the card')
    assert.equal(turns[0].input.mainAccountId, 'a1', 'a main the user did not pick is not kept')
    assert.equal(turns[0].input.answered, true)
    assert.match(turns[0].text, /Which stock\? NVDA/)
    const after = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    // The build goes to the background (step 5b): the chat is Axl's again, and the trader builds.
    assert.equal(after.floor, 'axl')
    assert.equal(after.agentState.mentor.asked, true)
    assert.deepEqual([after.agentState.mentor.build.status, after.agentState.mentor.build.title], ['building', 'NVDA trade'])
    assert.equal(out.build, after.agentState.mentor.build.id)
    const [answered] = await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })
    assert.equal(answered.ref.state, 'answered')
    assert.equal(answered.ref.answers.name.other, 'NVDA')
    assert.equal((await asks.answer({ user, sessionId: s.sessionId, seq: card, answers: answersFor(), accounts })).reason, 'already_answered', 'twice → once')
})

test('refused: unanswered questions, an account not offered, another card, another user', async () => {
    const { sessions, asks, modes } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    const { card } = await (await modes.setMode({ user, sessionId: s.sessionId, mode: 'mentor' })).done
    const accounts = [{ id: 'a1', broker: 'paper' }]
    assert.equal((await asks.answer({ user, sessionId: s.sessionId, seq: card, answers: answersFor({ size: {} }), accounts })).reason, 'unanswered:size')
    assert.equal((await asks.answer({ user, sessionId: s.sessionId, seq: card, answers: answersFor(), accounts: [] })).reason, 'unknown_account')
    assert.equal((await asks.answer({ user, sessionId: s.sessionId, seq: card + 5, answers: answersFor(), accounts })).reason, 'not_found')
    assert.equal((await asks.answer({ user: { _id: 'u2' }, sessionId: s.sessionId, seq: card, answers: answersFor(), accounts })).reason, 'not_found')
    const [row] = await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })
    assert.equal(row.ref.state, 'open', 'nothing refused changed the card')
})

test('picking a builder with work on its table posts no card', async () => {
    const { sessions, modes } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'AMD' } } })
    assert.equal((await (await modes.setMode({ user, sessionId: s.sessionId, mode: 'mentor' })).done).card, undefined)
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'analyst', state: { draft: { symbol: 'AMD' } } })
    assert.equal((await (await modes.setMode({ user, sessionId: s.sessionId, mode: 'analyst' })).done).card, undefined)
    assert.deepEqual(await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 }), [])
})

test("a route's ticker is the card's first name (Axl's <route>assist NVDA</route> — the drive, 2026-11-20)", async () => {
    const { sessions, asks } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await asks.post({ user, sessionId: s.sessionId, agent: 'mentor', state: null, input: { routeSymbol: 'NVDA' } })
    const [row] = await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })
    assert.deepEqual(row.ref.questions[0].options.map(o => o.label), ['NVDA', 'Find one for me'])
})

// Build trade off the Hotlist (Roy, 2026-11-20): Trader, the card, the name filled in, the build on the Hotlist's context.
test('a hand-off: the card starts on its name, asks again after an earlier build, and keeps its facts only for its own name', async () => {
    const name = traderQuestions({ symbol: 'nvda' })[0]
    assert.equal(name.default, 'NVDA', 'picked already')
    assert.equal(traderQuestions()[0].default, undefined)
    assert.equal(needsQuestions('mentor', { asked: true }, 'user', { seed: { ticker: 'NVDA' } }), true, 'a hand-off is a new build')
    assert.equal(needsQuestions('mentor', { draft: {} }, 'user', { seed: { ticker: 'NVDA' } }), false, 'but not over a trade on the table')

    const { sessions, asks, turns } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    const seed = { ticker: 'NVDA', hotlist: { board: 'hb_1', column: 'mid' } }
    const accounts = [{ id: 'a1', broker: 'paper', name: 'Paper main' }]
    const same = await asks.post({ user, sessionId: s.sessionId, agent: 'mentor', state: null, input: { seed } })
    await asks.answer({ user, sessionId: s.sessionId, seq: same.seq, answers: answersFor({ name: { choice: 'NVDA' } }), accounts })
    assert.deepEqual(turns[0].input.seed, seed, 'the build reads the Hotlist board')

    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: null })
    const other = await asks.post({ user, sessionId: s.sessionId, agent: 'mentor', state: null, input: { seed } })
    await asks.answer({ user, sessionId: s.sessionId, seq: other.seq, answers: answersFor({ name: { other: 'amd' } }), accounts })
    assert.equal(turns.at(-1).input.seed, undefined, "another name picked builds without NVDA's facts")
})

// ── THE ANALYST'S CARD (Roy, 2026-11-21: "when choosing analyst mode — open the questions window like in trader and
// portfolio; the user clicks a name; if the name exists the user decides whether to update; after send we are back in
// Axl's chat — without remnants of the analyst chat or the user's choices") ──
test("the analyst's card: the company (the one they came with first), and 'update it?' only for a name the house covers", () => {
    const q = analystQuestions({ symbol: 'tsla', covered: ['tsla', 'NVDA'] })
    assert.deepEqual(q.map(x => x.id), ['name', 'update'])
    assert.deepEqual(q[0].options, [{ label: 'TSLA', description: 'Covered already' }])
    assert.equal(q[0].default, 'TSLA')
    assert.equal(q[0].other, true, 'any name can be typed')
    assert.deepEqual(q[1].when, { id: 'name', in: ['TSLA', 'NVDA'] })
    assert.deepEqual(q[1].options.map(o => o.label), ['Update it', 'Leave it as is'])
    assert.deepEqual(analystQuestions().find(x => x.id === 'name').options, [], 'from the picker: a name typed')
    assert.equal(isShown(q[1], { name: { choice: 'TSLA' } }), true)
    assert.equal(isShown(q[1], { name: { other: 'nvda' } }), true, 'a typed name, any case')
    assert.equal(isShown(q[1], { name: { other: 'AMD' } }), false)
    // Checked as shown: a name not covered needs no "update?"; a covered one does.
    assert.deepEqual(checkAnswers(q, { name: { other: 'AMD' } }), { ok: true, answers: { name: { choice: null, other: 'AMD' } } })
    assert.equal(checkAnswers(q, { name: { choice: 'TSLA' } }).reason, 'unanswered:update')
    assert.equal(checkAnswers(q, { name: { choice: 'TSLA' }, update: { choice: 'Update it' } }).ok, true)
    assert.ok(q.every(x => x.header.length <= 12), 'headers fit the chip')
})

async function analystCard(over = {}) {
    const r = rig(over)
    const s = await r.sessions.getActive({ userId: 'u1' })
    const { card } = await (await r.modes.setMode({ user, sessionId: s.sessionId, mode: 'analyst' })).done
    return { ...r, s, card }
}
const rowsOf = (sessions, s) => sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })

test("picking Analyst posts its card, with the house's book; a NEW name → a coverage build in the background, the card leaves nothing, Axl's chat", async () => {
    const { sessions, asks, turns, s, card } = await analystCard()
    assert.ok(Number.isInteger(card), 'the card is posted on the pick')
    const [row] = await rowsOf(sessions, s)
    assert.deepEqual(row.ref.questions.find(q => q.id === 'update').when.in, ['TSLA'])
    const out = await asks.answer({ user, sessionId: s.sessionId, seq: card, answers: { name: { other: 'amd' } } })
    assert.equal(out.agent, 'analyst')
    assert.equal(turns.length, 1)
    assert.deepEqual([turns[0].agent, turns[0].origin, turns[0].text, turns[0].input.answered], ['analyst', 'opening', coverNote('AMD'), true])
    const after = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(after.floor, 'axl', 'back in Axl\'s chat')
    assert.deepEqual([after.agentState.analyst.build.status, after.agentState.analyst.build.title, after.agentState.analyst.active_symbol], ['building', 'AMD coverage', 'AMD'])
    const [answered] = await rowsOf(sessions, s)
    assert.deepEqual([answered.ref.state, answered.ref.hidden], ['answered', true], 'no "Your answers" left in the chat')
})

test("a COVERED name with 'Update it' → its revision runs in the background, editing the coverage — no reopened line in the chat", async () => {
    const { sessions, asks, turns, s, card } = await analystCard()
    await asks.answer({ user, sessionId: s.sessionId, seq: card, answers: { name: { other: 'TSLA' }, update: { choice: 'Update it' } } })
    // builds.begin runs the turn itself (fire-and-forget) — let it land.
    await new Promise(r => setTimeout(r, 0))
    assert.equal(turns.length, 1)
    assert.match(turns[0].text, /REVISE the TSLA thesis/)
    const after = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(after.floor, 'axl')
    assert.deepEqual(after.agentState.analyst.editing, { kind: 'coverage', entityId: 'cov-tsla' })
    assert.deepEqual([after.agentState.analyst.build.status, after.agentState.analyst.build.title], ['building', 'TSLA revision'])
    const rows = await rowsOf(sessions, s)
    assert.deepEqual(rows.map(r => [r.kind, r.ref?.hidden ?? false]), [['questions', true]], 'only the hidden card — no "Analyst · TSLA" line')
})

test("a COVERED name left as is → nothing runs, nothing stays; a non-ticker is refused", async () => {
    const { sessions, asks, turns, s, card } = await analystCard()
    assert.equal((await asks.answer({ user, sessionId: s.sessionId, seq: card, answers: { name: { other: 'not a ticker' } } })).reason, 'bad_symbol')
    const out = await asks.answer({ user, sessionId: s.sessionId, seq: card, answers: { name: { other: 'TSLA' }, update: { choice: 'Leave it as is' } } })
    assert.deepEqual(out, { agent: 'analyst', none: true })
    assert.equal(turns.length, 0)
    const after = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(after.floor, 'axl')
    assert.equal(after.agentState.analyst.build, undefined)
    assert.equal(after.agentState.analyst.asking, undefined)
    const [row] = await rowsOf(sessions, s)
    assert.equal(row.ref.hidden, true)
})
