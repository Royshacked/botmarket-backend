import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeAct } from '../../services/desks/act.js'
import { makePortfolioActions, settleAvoid, avoidRefused, portfolioReason } from '../../services/desks/actions/portfolio.actions.js'
import { portfolioDesk, portfolioNextState } from '../../services/desks/portfolio.desk.js'
import { makePortfolioCommit } from '../../api/portfolio/portfolioCommit.service.js'

// Unified-chat phase 8a, Atlas: the plan and the review proposal are committed FROM THE SESSION through the same
// service the portfolio routes use (portfolioCommit), with the AVOID ask as one refusal → repeat.

const user = { _id: 'u1', role: 'trader' }
const PLAN = { name: 'Quality', ideas: [{ asset: 'MSFT', allocationRatio: 0.5 }, { asset: 'XOM', allocationRatio: 0.5 }] }
const ADD_XOM  = { action: 'add_item', item: { asset: 'XOM', allocationRatio: 0.1 }, avoid: { industry: 'Oil & Gas' } }
const TRIM_AAA = { action: 'trim_item', itemId: 'i1', fraction: 0.5 }

// ─── the commit service ───────────────────────────────────────────────────────

function commitRig({ avoid = [], items = [], deleteFails = [] } = {}) {
    const calls = { save: [], del: [], upd: [], card: [], snap: [], complete: [], rebalance: [], lifecycle: [] }
    const commit = makePortfolioCommit({
        ideas: {
            saveBatchIdeas: async (plan, uid, opts) => { calls.save.push({ plan, uid, opts }); return { ok: true, ideas: plan.ideas.map((i, k) => ({ id: `n${k}`, asset: i.asset })), failed: [], portfolioId: opts.portfolioId ?? 'p_new' } },
            deleteIdea:     async (id) => { calls.del.push(id); return deleteFails.includes(id) ? { ok: false, reason: 'error' } : { ok: true } },
            updateIdea:     async (id, patch) => { calls.upd.push({ id, patch }); return { ok: true } },
        },
        avoid:      async () => avoid,
        items:      async () => items,
        chat:       { completeReview: async (pid) => { calls.complete.push(pid); return { nextReviewAt: 99 } }, setPortfolioLifecycle: async (pid, uid, p) => { calls.lifecycle.push(p) } },
        rebalance:  async (pid, uid, update, o) => { calls.rebalance.push(update); calls.rebalanceOpts = (calls.rebalanceOpts ?? []).concat([o]); return { ok: true, results: [], nextReviewAt: 77 } },
        snapshot:   async (pid) => { calls.snap.push(pid) },
        resolveCard: async (uid, pid, o) => { calls.card.push(o) },
        invalidate: () => {},
    })
    return { commit, calls }
}

test('createBook refuses an AVOID name the OK does not cover, and saves once it does', async () => {
    const { commit, calls } = commitRig({ avoid: [{ asset: 'XOM', industry: 'Oil & Gas' }] })
    assert.deepEqual(await commit.createBook(PLAN, 'u1'), { ok: false, reason: 'avoid_needs_ok', avoid: [{ asset: 'XOM', industry: 'Oil & Gas' }] })
    assert.equal(calls.save.length, 0)
    const out = await commit.createBook(PLAN, 'u1', { accounts: ['a1', 7, null], avoidOk: ['xom'] })
    assert.equal(out.ok, true)
    assert.deepEqual(calls.save[0].opts.accounts, ['a1'], 'only string account ids reach the batch')
})

test('replacePlan saves FIRST, then retires the old legs and says which stayed; refused while a leg is live', async () => {
    const live = commitRig({ items: [{ id: 'o1', status: 'long' }, { id: 'o2', status: 'waiting' }] })
    assert.deepEqual(await live.commit.replacePlan('p1', PLAN, 'u1'), { ok: false, reason: 'book_live', live: 1 })
    assert.equal(live.calls.save.length, 0)

    const { commit, calls } = commitRig({ items: [{ id: 'o1', asset: 'AAPL', status: 'waiting' }, { id: 'o2', asset: 'KO', status: 'hit' }], deleteFails: ['o2'] })
    const out = await commit.replacePlan('p1', PLAN, 'u1')
    assert.equal(calls.save[0].opts.portfolioId, 'p1', 'the same book id')
    assert.deepEqual(calls.del, ['o1', 'o2'])
    assert.deepEqual(out.left, [{ id: 'o2', asset: 'KO' }])

    const avoid = commitRig({ avoid: [{ asset: 'XOM', industry: 'x' }], items: [{ id: 'o1', status: 'waiting' }] })
    assert.equal((await avoid.commit.replacePlan('p1', PLAN, 'u1')).reason, 'avoid_needs_ok')
    assert.equal(avoid.calls.del.length, 0, 'a refused save deletes nothing')
})

test('rebindAccounts pushes the selection only onto legs with no order placed, and never an empty one', async () => {
    const { commit, calls } = commitRig({ items: [{ id: 'w', status: 'waiting' }, { id: 'h', status: 'hit' }, { id: 'l', status: 'long' }] })
    assert.deepEqual(await commit.rebindAccounts('p1', 'u1', { accounts: [] }), { ok: true, updated: 0 })
    await commit.rebindAccounts('p1', 'u1', { accounts: ['a1'], mainAccountId: 'zzz' })
    assert.deepEqual(calls.upd, [{ id: 'w', patch: { accounts: ['a1'], mainAccountId: null } }], 'a main account outside the selection is dropped')
})

test('closeReview and acceptRebalance flip the card; a failed rebalance flips nothing', async () => {
    const { commit, calls } = commitRig()
    assert.deepEqual(await commit.closeReview('p1', 'u1', { outcome: 'reviewed', reviewCadence: 'monthly' }), { ok: true, nextReviewAt: 99 })
    assert.deepEqual(calls.lifecycle, [{ reviewCadence: 'monthly' }])
    assert.deepEqual(calls.card[0], { nextReviewAt: 99, outcome: 'reviewed' })
    await commit.closeReview('p1', 'u1', { outcome: 'anything' })
    assert.equal(calls.card[1].outcome, 'dismissed')
    await commit.acceptRebalance('p1', 'u1', { changes: [TRIM_AAA] })
    assert.deepEqual(calls.card[2], { nextReviewAt: 77, outcome: 'updated' })

    const bad = makePortfolioCommit({ rebalance: async () => ({ ok: false, reason: 'nothing_applied' }), resolveCard: async () => { throw new Error('must not flip') } })
    assert.equal((await bad.acceptRebalance('p1', 'u1', { changes: [TRIM_AAA] })).reason, 'nothing_applied')
})

// ─── the review rule in the state ─────────────────────────────────────────────

test('a review turn without an update WITHDRAWS the proposal; a same-turn thesis rides on it; a fold keeps it', () => {
    const prev = { portfolioId: 'p1', reviewMode: true, reviewUpdate: { changes: [TRIM_AAA] } }
    assert.equal(portfolioNextState(prev, { reply: 'on reflection, hold' }).reviewUpdate, null)
    assert.deepEqual(portfolioNextState(prev, { update: { changes: [ADD_XOM] }, thesis: { strategy: 's' } }).reviewUpdate, { changes: [ADD_XOM], thesis: { strategy: 's' } })
    assert.deepEqual(portfolioNextState(prev, null).reviewUpdate, prev.reviewUpdate, 'a route landing is not a turn')
    assert.deepEqual(portfolioDesk.onRouted(prev, {}).reviewUpdate, prev.reviewUpdate)
    // Outside a review the latest update still carries, as before.
    assert.deepEqual(portfolioNextState({ reviewUpdate: { changes: [TRIM_AAA] } }, { reply: 'x' }).reviewUpdate, { changes: [TRIM_AAA] })
})

test('settleAvoid asks about unanswered AVOID adds, marks the OK, and drops the declined', () => {
    const update = { changes: [ADD_XOM, TRIM_AAA] }
    assert.deepEqual(settleAvoid(update), { ask: [{ asset: 'XOM', industry: 'Oil & Gas' }] })
    assert.equal(settleAvoid(update, { avoidOk: ['xom'] }).update.changes[0].item.avoid_ok, true)
    assert.deepEqual(settleAvoid(update, { dropAvoid: true }).update.changes, [TRIM_AAA])
    assert.equal(settleAvoid({ changes: [ADD_XOM] }, { dropAvoid: true }).update, null)
    // A refused add-to (no spec) is asked about by the asset the refusal named, and its OK sits on the change.
    const addTo = { action: 'add_to_item', itemId: 'i9', avoid: { asset: 'CVX', industry: 'Oil & Gas' } }
    assert.equal(settleAvoid({ changes: [addTo] }, { avoidOk: ['CVX'] }).update.changes[0].avoid_ok, true)
})

test('avoidRefused keeps only the changes refused for AVOID, marked to be asked about', () => {
    const update = { changes: [TRIM_AAA, { action: 'add_to_item', itemId: 'i9' }] }
    const failed = [{ action: 'add_to_item', itemId: 'i9', ok: false, reason: 'avoid_industry', avoid: [{ asset: 'CVX', industry: 'Oil & Gas' }] }, { action: 'trim_item', itemId: 'i1', ok: false, reason: 'closed' }]
    assert.deepEqual(avoidRefused(update, failed), { changes: [{ action: 'add_to_item', itemId: 'i9', avoid: { asset: 'CVX', industry: 'Oil & Gas' } }] })
    assert.equal(avoidRefused(update, [{ reason: 'closed' }]), null)
})

// ─── the actions, through the session route ───────────────────────────────────

function rig({ atlas = null, commit: over = {}, chat: chatOver = {} } = {}) {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const calls = { create: [], replace: [], rebind: [], close: [], accept: [], acceptOpts: [], seal: [], chatState: [], thesis: [] }
    const commit = {
        createBook:      async (plan, uid, o) => { calls.create.push({ plan, o }); return over.createBook?.(plan, o) ?? { ok: true, ideas: [{ id: 'n0' }], failed: [], portfolioId: 'p_new' } },
        replacePlan:     async (pid, plan, uid, o) => { calls.replace.push({ pid, plan, o }); return over.replacePlan?.() ?? { ok: true, ideas: [{ id: 'n0' }], left: [] } },
        rebindAccounts:  async (pid, uid, o) => { calls.rebind.push({ pid, o }); return { ok: true, updated: 2 } },
        closeReview:     async (pid, uid, o = {}) => { calls.close.push({ pid, ...o }); return { ok: true, nextReviewAt: 5 } },
        acceptRebalance: async (pid, uid, update, o) => { calls.accept.push(update); calls.acceptOpts.push(o); return over.acceptRebalance?.(update) ?? { ok: true, results: [], applied: update.changes.length } },
    }
    const chat = {
        saveChatState: async (pid, messages, uid, mandate) => { calls.chatState.push({ pid, messages, mandate }); return { ok: true } },
        setThesis:     async (pid, uid, thesis, reason) => { calls.thesis.push({ pid, thesis, reason }) },
        ...chatOver,
    }
    const desks = { portfolio: { ...portfolioDesk, actions: makePortfolioActions({ commit, chat }) } }
    const sealing = { sealFromSession: async (args) => { calls.seal.push(args); await sessions.setAgentState({ sessionId: args.sessionId, userId: args.userId, agent: args.agent, state: null }); return { sealed: 1 } } }
    const { act } = makeAct({ sessions, desks, sealing, lock: (_id, fn) => fn() })
    return { sessions, calls, async start() {
        const s = await sessions.getActive({ userId: 'u1', scope: 'main' })
        if (atlas) await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'portfolio', state: atlas })
        return { s, press: (action, args) => act({ user, sessionId: s.sessionId, agent: 'portfolio', action, args }) }
    } }
}
const stateOf = async (r, s) => (await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState?.portfolio ?? null
const REVIEW = { portfolioId: 'p1', reviewMode: true, editing: { kind: 'portfolio', entityId: 'p1' } }

test('generatePlan saves the plan FROM THE SESSION, writes the mandate and thesis onto the book, and seals onto it', async () => {
    const r = rig({ atlas: { portfolioId: null, pendingPlan: PLAN, mandate: { goal: 'g' }, thesis: { strategy: 's' } } })
    const { s, press } = await r.start()
    const out = await press('generatePlan', { accounts: [{ id: 'a1', broker: 'paper' }, 'raw-id'], mainAccountId: 'a1', plan: { ideas: [{ asset: 'EVIL' }] } })
    assert.deepEqual(out.result.portfolioId, 'p_new')
    assert.deepEqual(r.calls.create[0].plan, PLAN, 'the session plan — a plan in the args is ignored')
    assert.deepEqual(r.calls.chatState[0], { pid: 'p_new', messages: [], mandate: { goal: 'g' } })
    assert.deepEqual(r.calls.thesis[0], { pid: 'p_new', thesis: { strategy: 's' }, reason: 'construction' })
    assert.deepEqual(r.calls.seal[0], { userId: 'u1', sessionId: s.sessionId, agent: 'portfolio', kind: 'portfolio', entityIds: ['p_new'], name: 'the Quality book' })
    assert.equal(await stateOf(r, s), null)
})

test('generatePlan: the AVOID refusal carries the names and keeps the plan; an empty batch keeps it too', async () => {
    const r = rig({ atlas: { pendingPlan: PLAN }, commit: { createBook: (p, o) => (o.avoidOk.length ? { ok: true, ideas: [], failed: [{ asset: 'MSFT' }], portfolioId: 'p_x' } : { ok: false, reason: 'avoid_needs_ok', avoid: [{ asset: 'XOM' }] }) } })
    const { s, press } = await r.start()
    assert.deepEqual(await press('generatePlan', {}), { reason: 'avoid_needs_ok', extra: { avoid: [{ asset: 'XOM' }] } })
    const out = await press('generatePlan', { avoidOk: ['XOM'] })
    assert.deepEqual(out.result, { ideas: [], failed: [{ asset: 'MSFT' }], portfolioId: null })
    assert.equal(r.calls.seal.length, 0, 'nothing was created — nothing to seal onto')
    assert.deepEqual((await stateOf(r, s)).pendingPlan, PLAN)
})

test('generatePlan refuses on an existing book and with nothing on the table', async () => {
    assert.equal((await (await rig({ atlas: { portfolioId: 'p1', pendingPlan: PLAN } }).start()).press('generatePlan')).reason, 'not_new_book')
    assert.equal((await (await rig({ atlas: { pendingPlan: { ideas: [] } } }).start()).press('generatePlan')).reason, 'nothing_to_commit')
})

test('updatePlan re-plans in place, or rebinds the accounts with no plan; an edit from a review closes it', async () => {
    const r = rig({ atlas: { ...REVIEW, pendingPlan: PLAN } })
    const { press } = await r.start()
    const out = await press('updatePlan', { accounts: [{ id: 'a1' }] })
    assert.deepEqual(out.result, { ideas: [{ id: 'n0' }], left: [] })
    assert.equal(r.calls.replace[0].pid, 'p1')
    assert.deepEqual(r.calls.close, [{ pid: 'p1' }])
    assert.equal(r.calls.seal[0].onlyIfEditing, true)

    const r2 = rig({ atlas: { portfolioId: 'p2', editing: { kind: 'portfolio', entityId: 'p2' } } })
    const { press: press2 } = await r2.start()
    assert.deepEqual((await press2('updatePlan', { accounts: [{ id: 'a1' }] })).result, { ok: true, updated: 2 })
    assert.equal(r2.calls.close.length, 0, 'not a review — the clock is not touched')
})

test('updatePlan answers a live book with the count and keeps the work', async () => {
    const r = rig({ atlas: { portfolioId: 'p1', pendingPlan: PLAN }, commit: { replacePlan: () => ({ ok: false, reason: 'book_live', live: 2 }) } })
    const { s, press } = await r.start()
    assert.deepEqual(await press('updatePlan'), { reason: 'book_live', extra: { live: 2 } })
    assert.deepEqual((await stateOf(r, s)).pendingPlan, PLAN)
})

test('acceptReview with no proposal accepts the HOLD; outside a review it has nothing to accept', async () => {
    const r = rig({ atlas: { ...REVIEW, reviewUpdate: null } })
    const { press } = await r.start()
    assert.deepEqual((await press('acceptReview')).result, { held: true, nextReviewAt: 5 })
    assert.deepEqual(r.calls.close, [{ pid: 'p1', outcome: 'reviewed' }])
    assert.equal((await (await rig({ atlas: { portfolioId: 'p1' } }).start()).press('acceptReview')).reason, 'nothing_to_commit')
})

test('acceptReview asks about an AVOID add, applies it with the OK, and seals the review onto the book', async () => {
    const r = rig({ atlas: { ...REVIEW, reviewUpdate: { changes: [ADD_XOM, TRIM_AAA], thesis: { strategy: 's' } } } })
    const { s, press } = await r.start()
    assert.deepEqual(await press('acceptReview'), { reason: 'avoid_needs_ok', extra: { avoid: [{ asset: 'XOM', industry: 'Oil & Gas' }] } })
    assert.equal(r.calls.accept.length, 0)
    await press('acceptReview', { avoidOk: ['XOM'] })
    assert.equal(r.calls.accept[0].changes[0].item.avoid_ok, true)
    assert.deepEqual(r.calls.accept[0].thesis, { strategy: 's' }, 'the same-turn thesis goes with the changes')
    assert.equal(r.calls.seal.length, 1)
    assert.equal(await stateOf(r, s), null)
})

test('acceptReview: a change refused for a verdict that turned stays on the table, marked, and nothing is sealed yet', async () => {
    const refused = { action: 'add_item', itemId: null, asset: 'CVX', ok: false, reason: 'avoid_industry', avoid: [{ asset: 'CVX', industry: 'Oil & Gas' }] }
    const addCvx  = { action: 'add_item', item: { asset: 'CVX' } }
    const r = rig({ atlas: { ...REVIEW, reviewUpdate: { changes: [addCvx, TRIM_AAA] } }, commit: { acceptRebalance: () => ({ ok: true, results: [{ ok: true }, refused], applied: 1 }) } })
    const { s, press } = await r.start()
    const out = await press('acceptReview')
    assert.equal(out.result.applied, 1)
    assert.equal(r.calls.seal.length, 0)
    const left = await stateOf(r, s)
    assert.deepEqual(left.reviewUpdate.changes, [{ ...addCvx, avoid: { asset: 'CVX', industry: 'Oil & Gas' } }])
    assert.deepEqual(left.editing, REVIEW.editing, 'still editing the book')
})

test('acceptReview: nothing applied answers the refusal with the failures, and narrows the table to the AVOID ones', async () => {
    const refused = { action: 'add_item', asset: 'CVX', ok: false, reason: 'avoid_industry', avoid: [{ asset: 'CVX', industry: 'x' }] }
    const r = rig({ atlas: { ...REVIEW, reviewUpdate: { changes: [{ action: 'add_item', item: { asset: 'CVX' } }] } }, commit: { acceptRebalance: () => ({ ok: false, reason: 'nothing_applied', results: [refused], failed: [refused] }) } })
    const { s, press } = await r.start()
    const out = await press('acceptReview')
    assert.equal(out.reason, 'nothing_applied')
    assert.deepEqual(out.extra.failed, [refused])
    assert.equal((await stateOf(r, s)).reviewUpdate.changes[0].avoid.asset, 'CVX')
})

test('dismissReview closes the review as dismissed; Later leaves without touching the clock', async () => {
    const r = rig({ atlas: { ...REVIEW, reviewUpdate: { changes: [TRIM_AAA] } } })
    const { s, press } = await r.start()
    await press('dismissReview')
    assert.deepEqual(r.calls.close, [{ pid: 'p1', outcome: 'dismissed' }])
    assert.equal(r.calls.accept.length, 0)

    const r2 = rig({ atlas: { ...REVIEW } })
    const { s: s2, press: press2 } = await r2.start()
    assert.deepEqual(await press2('later'), { result: {} })
    assert.equal(r2.calls.close.length, 0)
    assert.equal(await stateOf(r2, s2), null)
    assert.equal((await (await rig({ atlas: { portfolioId: 'p1' } }).start()).press('dismissReview')).reason, 'nothing_to_commit')
    void s
})

test('Atlas refusals answer in its own words, the rebalance ones shared with the route', () => {
    assert.equal(portfolioReason('avoid_needs_ok')[0], 409)
    assert.equal(portfolioReason('book_live')[0], 409)
    assert.equal(portfolioReason('nothing_applied')[0], 409)
    assert.equal(portfolioReason('whatever'), null)
    assert.equal(portfolioDesk.reasons, portfolioReason)
})

// ─── phase 8a bug hunt ────────────────────────────────────────────────────────

test('#5: Atlas takes the account OBJECTS every desk sends, and hands the book their ids', async () => {
    const r = rig({ atlas: { pendingPlan: PLAN } })
    await (await r.start()).press('generatePlan', { accounts: [{ id: 'a1', broker: 'paper' }, 'raw-id', { broker: 'x' }] })
    assert.deepEqual(r.calls.create[0].o.accounts, ['a1'])
})

test("#3: only a review's Accept closes the review — an edit's changes leave a due review due", async () => {
    const r = rig({ atlas: { ...REVIEW, reviewUpdate: { changes: [TRIM_AAA] } } })
    await (await r.start()).press('acceptReview')
    assert.deepEqual(r.calls.acceptOpts[0], { closeReview: true })
    const e = rig({ atlas: { portfolioId: 'p1', editing: REVIEW.editing, reviewUpdate: { changes: [TRIM_AAA] } } })
    await (await e.start()).press('acceptReview')
    assert.deepEqual(e.calls.acceptOpts[0], { closeReview: false })

    const { commit, calls } = commitRig()
    await commit.acceptRebalance('p1', 'u1', { changes: [TRIM_AAA] }, { closeReview: false })
    assert.deepEqual(calls.rebalanceOpts[0], { closeReview: false })
    assert.equal(calls.card.length, 0, 'no review card flips outside a review')
    await commit.acceptRebalance('p1', 'u1', { changes: [TRIM_AAA] })
    assert.deepEqual(calls.rebalanceOpts[1], { closeReview: true }, 'the route closes the review, as before')
})
