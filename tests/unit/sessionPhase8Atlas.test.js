import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeActRig, shapeOf, TRADER } from '../helpers/actRig.js'
import { makePortfolioActions, makePortfolioApplyEdit, settleAvoid, avoidRefused, PORTFOLIO_REASONS } from '../../services/desks/actions/portfolio.actions.js'
import { portfolioDesk, portfolioNextState } from '../../services/desks/portfolio.desk.js'
import { makePortfolioCommit } from '../../api/portfolio/portfolioCommit.service.js'
import { _markAvoidAdds } from '../../services/agents/portfolio.agent.service.js'

// Unified-chat phase 8a, Atlas: the plan and the review proposal are committed FROM THE SESSION through the same
// service the portfolio routes use (portfolioCommit), with the AVOID ask as one refusal → repeat.

const user = TRADER
const PLAN = { name: 'Quality', ideas: [{ asset: 'MSFT', allocationRatio: 0.5, quantity: 10 }, { asset: 'XOM', allocationRatio: 0.5, quantity: 40 }] }
const ADD_XOM  = { action: 'add_item', item: { asset: 'XOM', allocationRatio: 0.1 }, avoid: { industry: 'Oil & Gas' } }
const TRIM_AAA = { action: 'trim_item', itemId: 'i1', fraction: 0.5 }
const ACCOUNTS = [{ id: 'a1', broker: 'paper' }]

// ─── the commit service ───────────────────────────────────────────────────────

function commitRig({ avoid = [], items = [], deleteFails = [], saveChat = { ok: true } } = {}) {
    const calls = { save: [], del: [], upd: [], card: [], snap: [], complete: [], rebalance: [], rebalanceOpts: [], lifecycle: [], chatState: [], thesis: [] }
    const commit = makePortfolioCommit({
        ideas: {
            saveBatchIdeas: async (plan, uid, opts) => { calls.save.push({ plan, uid, opts }); return { ok: true, ideas: plan.ideas.map((i, k) => ({ id: `n${k}`, asset: i.asset })), failed: [], portfolioId: opts.portfolioId ?? 'p_new' } },
            deleteIdea:     async (id) => { calls.del.push(id); return deleteFails.includes(id) ? { ok: false, reason: 'error' } : { ok: true } },
            updateIdea:     async (id, patch) => { calls.upd.push({ id, patch }); return { ok: true } },
        },
        avoid:      async () => avoid,
        items:      async () => items,
        chat:       {
            completeReview: async (pid) => { calls.complete.push(pid); return { nextReviewAt: 99 } },
            setPortfolioLifecycle: async (pid, uid, p) => { calls.lifecycle.push(p) },
            recordBook: async (pid, uid, mandate) => { calls.chatState.push({ pid, mandate }); return saveChat },
            setThesis: async (pid, uid, thesis, reason) => { calls.thesis.push({ pid, thesis, reason }) },
        },
        rebalance:  async (pid, uid, update, o) => { calls.rebalance.push(update); calls.rebalanceOpts.push(o); return { ok: true, results: [], nextReviewAt: 77 } },
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

test('recordConstruction writes the mandate and the construction thesis onto the new book — and no messages (phase 9)', async () => {
    const { commit, calls } = commitRig()
    assert.deepEqual(await commit.recordConstruction('p1', 'u1', { mandate: { goal: 'g' }, thesis: { strategy: 's' } }), { ok: true })
    assert.deepEqual(calls.chatState[0], { pid: 'p1', mandate: { goal: 'g' } })
    assert.deepEqual(calls.thesis[0], { pid: 'p1', thesis: { strategy: 's' }, reason: 'construction' })
    const failing = commitRig({ saveChat: { ok: false } })
    assert.deepEqual(await failing.commit.recordConstruction('p1', 'u1', { thesis: { strategy: 's' } }), { ok: false })
    assert.equal(failing.calls.thesis.length, 0)
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

test('closeReview flips the card; acceptRebalance closes the review only in a review; a failed rebalance flips nothing', async () => {
    const { commit, calls } = commitRig()
    assert.deepEqual(await commit.closeReview('p1', 'u1', { outcome: 'reviewed', reviewCadence: 'monthly' }), { ok: true, nextReviewAt: 99 })
    assert.deepEqual(calls.lifecycle, [{ reviewCadence: 'monthly' }])
    assert.deepEqual(calls.card[0], { nextReviewAt: 99, outcome: 'reviewed' })
    await commit.closeReview('p1', 'u1', { outcome: 'anything' })
    assert.equal(calls.card[1].outcome, 'dismissed')
    await commit.acceptRebalance('p1', 'u1', { changes: [TRIM_AAA] })
    assert.deepEqual(calls.rebalanceOpts[0], { closeReview: true }, 'the route closes the review, as before')
    assert.deepEqual(calls.card[2], { nextReviewAt: 77, outcome: 'updated' })
    await commit.acceptRebalance('p1', 'u1', { changes: [TRIM_AAA] }, { closeReview: false })
    assert.deepEqual(calls.rebalanceOpts[1], { closeReview: false })
    assert.equal(calls.card.length, 3, 'no review card flips outside a review')

    const bad = makePortfolioCommit({ rebalance: async () => ({ ok: false, reason: 'nothing_applied' }), resolveCard: async () => { throw new Error('must not flip') } })
    assert.equal((await bad.acceptRebalance('p1', 'u1', { changes: [TRIM_AAA] })).reason, 'nothing_applied')
})

// ─── the state rules ──────────────────────────────────────────────────────────

test('a review turn without an update WITHDRAWS the proposal; a same-turn thesis rides on it; a fold keeps it', () => {
    const prev = { portfolioId: 'p1', reviewMode: true, reviewUpdate: { changes: [TRIM_AAA] } }
    assert.equal(portfolioNextState(prev, { reply: 'on reflection, hold' }).reviewUpdate, null)
    assert.deepEqual(portfolioNextState(prev, { update: { changes: [ADD_XOM] }, thesis: { strategy: 's' } }).reviewUpdate, { changes: [ADD_XOM], thesis: { strategy: 's' } })
    assert.deepEqual(portfolioNextState(prev, null).reviewUpdate, prev.reviewUpdate, 'a route landing is not a turn')
    // 8c CR: outside a review the latest turn decides too — a proposal Atlas took back does not stand in the way.
    assert.equal(portfolioNextState({ reviewUpdate: { changes: [TRIM_AAA] } }, { reply: 'x' }).reviewUpdate, null)
    assert.deepEqual(portfolioNextState({}, { update: { changes: [TRIM_AAA] }, thesis: { strategy: 's' } }).reviewUpdate, { changes: [TRIM_AAA] }, 'a thesis rides only in a review')
})

test('C1: a route landing on Atlas keeps the book it is editing and the chain it works for', () => {
    const prev = { portfolioId: 'p1', pendingPlan: PLAN, reviewUpdate: { changes: [TRIM_AAA] }, editing: { kind: 'portfolio', entityId: 'p1' }, chainId: 'c1' }
    const landed = portfolioDesk.onRouted(prev, null)
    assert.deepEqual(landed.editing, prev.editing)
    assert.equal(landed.chainId, 'c1')
    assert.deepEqual(landed.reviewUpdate, prev.reviewUpdate)
    assert.deepEqual(landed.pendingPlan, PLAN)
})

// ─── the AVOID consent ────────────────────────────────────────────────────────

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

test('C2: no OK the model wrote survives — on the spec or on the change; only the user\'s yes sets one', async () => {
    const forged = { changes: [
        { action: 'add_to_item', itemId: 'i9', addFraction: 0.2, avoid_ok: true },
        { action: 'add_item', item: { asset: 'MSFT', avoid_ok: true } },
    ] }
    const settled = settleAvoid(forged)
    assert.equal('avoid_ok' in settled.update.changes[0], false, 'an unmarked add-to carries no OK to the rebalance')
    assert.equal('avoid_ok' in settled.update.changes[1].item, false)
    const marked = await _markAvoidAdds(structuredClone(forged), { avoid: async () => [] })
    assert.equal('avoid_ok' in marked.changes[0], false, 'and the agent service strips it at the source')
    assert.equal('avoid_ok' in marked.changes[1].item, false)
})

test('avoidRefused keeps only the changes refused for AVOID, marked to be asked about', () => {
    const update = { changes: [TRIM_AAA, { action: 'add_to_item', itemId: 'i9' }] }
    const failed = [{ action: 'add_to_item', itemId: 'i9', ok: false, reason: 'avoid_industry', avoid: [{ asset: 'CVX', industry: 'Oil & Gas' }] }, { action: 'trim_item', itemId: 'i1', ok: false, reason: 'closed' }]
    assert.deepEqual(avoidRefused(update, failed), { changes: [{ action: 'add_to_item', itemId: 'i9', avoid: { asset: 'CVX', industry: 'Oil & Gas' } }] })
    assert.equal(avoidRefused(update, [{ reason: 'closed' }]), null)
})

// ─── the actions, through the session route ───────────────────────────────────

function rig({ state = null, commit: over = {} } = {}) {
    const calls = { create: [], record: [], replace: [], rebind: [], close: [], accept: [], acceptOpts: [] }
    const commit = {
        createBook:         async (plan, uid, o) => { calls.create.push({ plan, o }); return over.createBook?.(plan, o) ?? { ok: true, ideas: [{ id: 'n0' }], failed: [], portfolioId: 'p_new' } },
        recordConstruction: async (pid, uid, o) => { calls.record.push({ pid, ...o }); return { ok: true } },
        replacePlan:        async (pid, plan, uid, o) => { calls.replace.push({ pid, plan, o }); return over.replacePlan?.() ?? { ok: true, ideas: [{ id: 'n0' }], left: [] } },
        rebindAccounts:     async (pid, uid, o) => { calls.rebind.push({ pid, o }); return { ok: true, updated: 2 } },
        closeReview:        async (pid, uid, o = {}) => { calls.close.push({ pid, ...o }); return { ok: true, nextReviewAt: 5 } },
        acceptRebalance:    async (pid, uid, update, o) => { calls.accept.push(update); calls.acceptOpts.push(o); return over.acceptRebalance?.(update) ?? { ok: true, results: [], applied: update.changes.length, failed: [] } },
    }
    const r = makeActRig({ agent: 'portfolio', desk: { ...portfolioDesk, actions: makePortfolioActions({ commit }) }, state })
    return { ...r, calls }
}
const REVIEW = { portfolioId: 'p1', reviewMode: true, editing: { kind: 'portfolio', entityId: 'p1' } }

test('generate saves the plan FROM THE SESSION, records the mandate and thesis on the book, and seals onto it', async () => {
    const r = rig({ state: { portfolioId: null, pendingPlan: PLAN, mandate: { goal: 'g' }, thesis: { strategy: 's' } } })
    const { s, press, stateOf } = await r.start(user)
    const out = await press('generate', { accounts: [...ACCOUNTS, 'raw-id', { broker: 'x' }], mainAccountId: 'a1', plan: { ideas: [{ asset: 'EVIL' }] } })
    assert.deepEqual(shapeOf(out), { result: { portfolio: { portfolioId: 'p_new', ideas: [{ id: 'n0' }] }, failed: [] } })
    assert.deepEqual(r.calls.create[0].plan, PLAN, 'the session plan — a plan in the args is ignored')
    assert.deepEqual(r.calls.create[0].o.accounts, ['a1'], 'the account objects every desk sends, mapped to ids')
    assert.deepEqual(r.calls.record[0], { pid: 'p_new', mandate: { goal: 'g' }, thesis: { strategy: 's' } })
    assert.deepEqual(r.seals[0], { userId: 'u1', sessionId: s.sessionId, agent: 'portfolio', kind: 'portfolio', entityIds: ['p_new'], name: 'the Quality book' })
    assert.equal(await stateOf(), null)
})

test('generate: the AVOID refusal carries the names; every leg refused is a refusal; both keep the plan', async () => {
    const r = rig({ state: { pendingPlan: PLAN }, commit: { createBook: (p, o) => (o.avoidOk.length ? { ok: true, ideas: [], failed: [{ asset: 'MSFT' }], portfolioId: 'p_x' } : { ok: false, reason: 'avoid_needs_ok', avoid: [{ asset: 'XOM' }] }) } })
    const { press, stateOf } = await r.start(user)
    assert.deepEqual(await press('generate'), { reason: 'avoid_needs_ok', extra: { avoid: [{ asset: 'XOM' }] } })
    assert.deepEqual(await press('generate', { avoidOk: ['XOM'] }), { reason: 'nothing_saved', extra: { failed: [{ asset: 'MSFT' }] } })
    assert.equal(r.seals.length + r.calls.record.length, 0, 'nothing was created — nothing recorded, nothing sealed')
    assert.deepEqual((await stateOf()).pendingPlan, PLAN)
})

test('generate refuses on an existing book and with nothing on the table', async () => {
    assert.equal((await (await rig({ state: { portfolioId: 'p1', pendingPlan: PLAN } }).start(user)).press('generate')).reason, 'not_new')
    assert.equal((await (await rig({ state: { pendingPlan: { ideas: [] } } }).start(user)).press('generate')).reason, 'nothing_to_commit')
})

test('update re-plans in place, or rebinds the accounts with no plan; an edit from a review closes it', async () => {
    const r = rig({ state: { ...REVIEW, pendingPlan: PLAN } })
    const { press } = await r.start(user)
    assert.deepEqual(shapeOf(await press('update', { accounts: ACCOUNTS })), { result: { portfolio: { portfolioId: 'p1', ideas: [{ id: 'n0' }] }, left: [] } })
    assert.equal(r.calls.replace[0].pid, 'p1')
    assert.deepEqual(r.calls.close, [{ pid: 'p1' }])
    assert.equal(r.seals[0].onlyIfEditing, true)

    const r2 = rig({ state: { portfolioId: 'p2', editing: { kind: 'portfolio', entityId: 'p2' } } })
    assert.deepEqual(shapeOf(await (await r2.start(user)).press('update', { accounts: ACCOUNTS })), { result: { portfolio: { portfolioId: 'p2' }, rebound: 2 } })
    assert.equal(r2.calls.close.length, 0, 'not a review — the clock is not touched')
})

test('update answers a live book with the count and keeps the work', async () => {
    const r = rig({ state: { portfolioId: 'p1', pendingPlan: PLAN }, commit: { replacePlan: () => ({ ok: false, reason: 'book_live', live: 2 }) } })
    const { press, stateOf } = await r.start(user)
    assert.deepEqual(await press('update'), { reason: 'book_live', extra: { live: 2 } })
    assert.deepEqual((await stateOf()).pendingPlan, PLAN)
})

test('accept with no proposal accepts the HOLD; outside a review it has nothing to accept', async () => {
    const r = rig({ state: { ...REVIEW, reviewUpdate: null } })
    assert.deepEqual(shapeOf(await (await r.start(user)).press('accept')), { result: { portfolio: { portfolioId: 'p1' }, held: true, nextReviewAt: 5 } })
    assert.deepEqual(r.calls.close, [{ pid: 'p1', outcome: 'reviewed' }])
    assert.equal((await (await rig({ state: { portfolioId: 'p1' } }).start(user)).press('accept')).reason, 'nothing_to_commit')
})

test('accept asks about an AVOID add, applies it with the OK, closes the review, and seals it onto the book', async () => {
    const r = rig({ state: { ...REVIEW, reviewUpdate: { changes: [ADD_XOM, TRIM_AAA], thesis: { strategy: 's' } } } })
    const { press, stateOf } = await r.start(user)
    assert.deepEqual(await press('accept'), { reason: 'avoid_needs_ok', extra: { avoid: [{ asset: 'XOM', industry: 'Oil & Gas' }] } })
    assert.equal(r.calls.accept.length, 0)
    const out = await press('accept', { avoidOk: ['XOM'] })
    assert.equal(out.result.rebalance.applied, 2)
    assert.equal('ok' in out.result.rebalance, false, 'no service bookkeeping in the result')
    assert.equal(r.calls.accept[0].changes[0].item.avoid_ok, true)
    assert.deepEqual(r.calls.accept[0].thesis, { strategy: 's' }, 'the same-turn thesis goes with the changes')
    assert.deepEqual(r.calls.acceptOpts[0], { closeReview: true })
    assert.equal(r.seals.length, 1)
    assert.equal(await stateOf(), null)
})

test('accept outside a review applies the changes and leaves a due review due', async () => {
    const r = rig({ state: { portfolioId: 'p1', editing: REVIEW.editing, reviewUpdate: { changes: [TRIM_AAA] } } })
    await (await r.start(user)).press('accept')
    assert.deepEqual(r.calls.acceptOpts[0], { closeReview: false })
})

test('accept: a change refused for a verdict that turned stays on the table, marked; the review is closed once', async () => {
    const refused = { action: 'add_item', itemId: null, asset: 'CVX', ok: false, reason: 'avoid_industry', avoid: [{ asset: 'CVX', industry: 'Oil & Gas' }] }
    const addCvx  = { action: 'add_item', item: { asset: 'CVX' } }
    const r = rig({ state: { ...REVIEW, reviewUpdate: { changes: [addCvx, TRIM_AAA] } }, commit: { acceptRebalance: () => ({ ok: true, results: [{ ok: true }, refused], applied: 1, failed: [] }) } })
    const { press, stateOf } = await r.start(user)
    assert.equal((await press('accept')).result.rebalance.applied, 1)
    assert.equal(r.seals.length, 0, 'still work on the book — not sealed yet')
    const left = await stateOf()
    assert.deepEqual(left.reviewUpdate.changes, [{ ...addCvx, avoid: { asset: 'CVX', industry: 'Oil & Gas' } }])
    assert.deepEqual(left.editing, REVIEW.editing, 'still editing the book')
    assert.equal(left.reviewMode, false, 'C5: the review closed — a second Accept must not close it again')
    await press('accept', { avoidOk: ['CVX'] })
    assert.deepEqual(r.calls.acceptOpts[1], { closeReview: false })
})

test('accept: nothing applied answers the refusal with the failures, and narrows the table to the AVOID ones', async () => {
    const refused = { action: 'add_item', asset: 'CVX', ok: false, reason: 'avoid_industry', avoid: [{ asset: 'CVX', industry: 'x' }] }
    const r = rig({ state: { ...REVIEW, reviewUpdate: { changes: [{ action: 'add_item', item: { asset: 'CVX' } }] } }, commit: { acceptRebalance: () => ({ ok: false, reason: 'nothing_applied', results: [refused], failed: [refused] }) } })
    const { press, stateOf } = await r.start(user)
    assert.deepEqual(await press('accept'), { reason: 'nothing_applied', extra: { failed: [refused] } })
    const left = await stateOf()
    assert.equal(left.reviewUpdate.changes[0].avoid.asset, 'CVX')
    assert.equal(left.reviewMode, true, 'nothing applied — the review is still open')
})

test('dismiss closes the review as dismissed; later leaves without touching the clock', async () => {
    const r = rig({ state: { ...REVIEW, reviewUpdate: { changes: [TRIM_AAA] } } })
    assert.deepEqual(shapeOf(await (await r.start(user)).press('dismiss')), { result: { portfolio: { portfolioId: 'p1' }, nextReviewAt: 5 } })
    assert.deepEqual(r.calls.close, [{ pid: 'p1', outcome: 'dismissed' }])
    assert.equal(r.calls.accept.length, 0)

    const r2 = rig({ state: { ...REVIEW } })
    const { press, stateOf } = await r2.start(user)
    assert.deepEqual(shapeOf(await press('later')), { result: {} })
    assert.equal(r2.calls.close.length, 0)
    assert.equal(await stateOf(), null)
    assert.equal((await (await rig({ state: { portfolioId: 'p1' } }).start(user)).press('dismiss')).reason, 'nothing_to_commit')
})

test('Atlas refusals answer in its own words, the rebalance ones shared with the route', () => {
    assert.equal(PORTFOLIO_REASONS.avoid_needs_ok[0], 409)
    assert.equal(PORTFOLIO_REASONS.book_live[0], 409)
    assert.equal(PORTFOLIO_REASONS.nothing_applied[0], 409)
    assert.equal(portfolioDesk.reasons, PORTFOLIO_REASONS)
})

// ─── phase 8c: the surface's state ────────────────────────────────────────────

test('8c: a review is REVIEWED once Atlas has spoken in it — a fold is not a pass, and outside a review there is none', () => {
    const opened = portfolioDesk.stateFromEntity({ portfolioId: 'p1', thesis: { strategy: 's' } }, { reviewMode: true })
    assert.equal(opened.reviewed, false, 'just opened: nothing has been looked at')
    assert.deepEqual(opened.thesis, { strategy: 's' }, "the book's standing thesis rides for the card")
    assert.equal(portfolioNextState(opened, null).reviewed, false)
    const passed = portfolioNextState(opened, { reply: 'hold' })
    assert.equal(passed.reviewed, true)
    assert.equal(portfolioNextState(passed, null).reviewed, true, 'a fold keeps it')
    assert.equal(portfolioNextState({ portfolioId: 'p1' }, { reply: 'x' }).reviewed, false)
})

test('8c: adopt mode stages ONE draft under the lock, hands it back when asked again, and ends without discarding it', async () => {
    const made = []
    const adopt = {
        createDraft:  async (o) => { made.push(o); return { ok: true, draft: { draftId: `d${made.length}` } } },
        refreshDraft: async ({ draftId }) => ({ ok: true, draft: { draftId } }),
    }
    const r = makeActRig({ agent: 'portfolio', desk: { ...portfolioDesk, applyEdit: makePortfolioApplyEdit({ adopt, clean: () => portfolioNextState(null, null) }) }, state: { adopt: true } })
    const { edit, stateOf } = await r.start(user)
    assert.equal((await edit({ adopt: 'start' })).ok, true)
    assert.deepEqual(made, [{ userId: 'u1', name: 'My bank book' }], 'staged as the user, empty')
    assert.equal((await stateOf()).adoptDraftId, 'd1')
    await edit({ adopt: 'start' })
    assert.equal(made.length, 1, 'asked twice → the same draft')
    await edit({ adopt: 'end' })
    const st = await stateOf()
    assert.equal(st.adopt, false)
    assert.equal(st.adoptDraftId, null)
    assert.deepEqual(await edit({ adopt: 'sideways' }), { reason: 'invalid_edit' })
})

test('8c: a failed stage is a refusal, and ending with nothing on the table has nothing to edit', async () => {
    const apply = makePortfolioApplyEdit({ adopt: { createDraft: async () => ({ ok: false, error: new Error('db') }) } })
    assert.deepEqual(await apply(null, { adopt: 'start' }, { user }), { reason: 'adopt_failed' })
    assert.deepEqual(await apply(null, { adopt: 'end' }, { user }), { reason: 'nothing_to_edit' })
    assert.equal(PORTFOLIO_REASONS.adopt_failed[0], 500)
})

// ─── phase 8c CR ──────────────────────────────────────────────────────────────

test('8c CR: an unsized plan is never saved — not by Generate, and not by an Update that would rebind instead', async () => {
    const UNSIZED = { name: 'Q', ideas: [{ asset: 'MSFT', allocationRatio: 1 }] }
    const g = rig({ state: { pendingPlan: UNSIZED } })
    assert.equal((await (await g.start(user)).press('generate', { accounts: ACCOUNTS })).reason, 'plan_not_ready')
    assert.equal(g.calls.create.length, 0)
    const u = rig({ state: { portfolioId: 'p1', editing: { kind: 'portfolio', entityId: 'p1' }, pendingPlan: UNSIZED } })
    assert.equal((await (await u.start(user)).press('update', { accounts: ACCOUNTS })).reason, 'plan_not_ready')
    assert.equal(u.calls.replace.length + u.calls.rebind.length, 0)
    assert.equal(PORTFOLIO_REASONS.plan_not_ready[0], 409)
})

test('8c CR: a review whose every change was declined closes as held, not a loop on nothing', async () => {
    const r = rig({ state: { ...REVIEW, reviewed: true, reviewUpdate: { changes: [ADD_XOM] } } })
    const { press, stateOf } = await r.start(user)
    const out = shapeOf(await press('accept', { dropAvoid: true }))
    assert.equal(out.result.held, true)
    assert.deepEqual(r.calls.close[0], { pid: 'p1', outcome: 'reviewed' })
    assert.equal(r.calls.accept.length, 0)
    assert.equal(await stateOf(), null)
})

test('8c CR: Axl\'s adopt lands on a CLEAN table; over unsaved work it waits for the yes; any other route ends it', () => {
    const editing = { portfolioId: 'p1', editing: { kind: 'portfolio', entityId: 'p1' }, mandate: { goal: 'g' }, chainId: 'c1' }
    const clean = portfolioDesk.onRouted(editing, { adopt: true })
    assert.equal(clean.adopt, true)
    assert.equal(clean.portfolioId, null, 'not the book being edited')
    assert.equal(clean.editing, undefined)
    const over = portfolioDesk.onRouted({ ...editing, pendingPlan: PLAN }, { adopt: true })
    assert.equal(over.adopt, true)
    assert.deepEqual(over.pendingPlan, PLAN, 'unsaved work is never dropped unasked')
    const away = portfolioDesk.onRouted({ adopt: true, adoptDraftId: 'd1' }, null)
    assert.equal(away.adopt, false)
    assert.equal(away.adoptDraftId, null)
})

test('8c CR: start refuses over unsaved work until the yes; it replaces a committed draft; it clears the book being edited', async () => {
    const made = []
    const adopt = {
        createDraft:  async () => { made.push(1); return { ok: true, draft: { draftId: `n${made.length}` } } },
        refreshDraft: async ({ draftId }) => (draftId === 'dead' ? { ok: false, reason: 'already_committed' } : { ok: true, draft: { draftId } }),
    }
    const apply = makePortfolioApplyEdit({ adopt, clean: () => portfolioNextState(null, null) })
    assert.deepEqual(await apply({ pendingPlan: PLAN }, { adopt: 'start' }, { user }), { reason: 'adopt_over_work' })
    const yes = await apply({ pendingPlan: PLAN, portfolioId: 'p1' }, { adopt: 'start', fresh: true }, { user })
    assert.equal(yes.dropMarkers, true)
    assert.equal(yes.state.pendingPlan, null)
    assert.equal(yes.state.portfolioId, null)
    const replaced = await apply({ adopt: true, adoptDraftId: 'dead' }, { adopt: 'start' }, { user })
    assert.equal(replaced.state.adoptDraftId, 'n2', 'a committed draft is not reused')
    const kept = await apply({ adopt: true, adoptDraftId: 'live' }, { adopt: 'start' }, { user })
    assert.equal(kept.state.adoptDraftId, 'live')
    assert.equal(made.length, 2)
})
