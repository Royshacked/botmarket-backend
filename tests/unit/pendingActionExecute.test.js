import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STATES, ACTIONS, transitionFilter } from '../../services/pendingAction/pendingAction.repo.js'

// Executing a queued action — the state machine, which is the only thing standing between a
// double-clicked Execute and the same trim going to the broker twice.
//
// The controller's shape: RELEASED --claim--> EXECUTING --> DONE, and on any failure back to
// RELEASED (a refusal is not a reason to lose the decision — the user may fix the cause and retry).
// Every hop is guarded on the state it expects, so the loser of a race finds the move already made.

test('the lifecycle is a line, and both ends are terminal', () => {
    assert.deepEqual(
        Object.values(STATES).sort(),
        ['cancelled', 'done', 'executing', 'expired', 'queued', 'released'],
    )
})

test('the execute claim moves ONLY from released', () => {
    // The guard that makes a double-click safe: the second caller's updateOne matches nothing,
    // transition returns false, and the controller answers 409 instead of placing a second order.
    const f = transitionFilter('q1', 'u1', STATES.RELEASED)
    assert.deepEqual(f.state.$in, ['released'])
    assert.ok(!f.state.$in.includes(STATES.EXECUTING), 'an in-flight row must not be claimable again')
    assert.ok(!f.state.$in.includes(STATES.QUEUED), 'a row whose market has not opened is not runnable')
})

test('the unwind moves ONLY from executing', () => {
    // Narrow on purpose: a broad unwind could drag a row someone else has already finished (DONE)
    // or dropped (CANCELLED) back into the list.
    const f = transitionFilter('q1', 'u1', STATES.EXECUTING)
    assert.deepEqual(f.state.$in, ['executing'])
})

test('cancel is the one transition that means "from wherever it is now"', () => {
    // Queued (market still shut) and released (open, not yet run) are both the user's to drop.
    // EXECUTING is deliberately NOT in that set — an order already at the broker is not cancellable
    // by forgetting about it, and the controller answers 409.
    const f = transitionFilter('q1', 'u1')
    assert.deepEqual(f.state.$in.sort(), ['queued', 'released'])
    assert.ok(!f.state.$in.includes(STATES.EXECUTING))
    assert.ok(!f.state.$in.includes(STATES.DONE))
})

test('the action verbs the queue can carry are the ones the registry can run', async () => {
    // A verb with no branch in _executePortfolioItem would queue fine and then refuse forever at
    // the open, which is the worst place to discover it.
    const { originRegistry } = await import('../../services/pendingAction/originRegistry.js')
    assert.deepEqual(Object.values(ACTIONS).sort(), ['add_to', 'entry', 'exit', 'trim'])
    assert.ok(typeof originRegistry.executeOrigin === 'function')
    assert.ok(typeof originRegistry.cancelOrigin === 'function')
})

test('every queueable origin can both RUN and CANCEL its items', async () => {
    // The registry guard, extended: phase 1 only needed cancel, because nothing could be executed
    // yet. An origin that can be queued and released but not run would strand the row in the list.
    const { ORIGIN_KINDS, hasOriginHandler } = await import('../../services/pendingAction/originRegistry.js')
    const { executeOrigin } = await import('../../services/pendingAction/originRegistry.js')

    assert.ok(ORIGIN_KINDS.length > 0)
    for (const kind of ORIGIN_KINDS) assert.ok(hasOriginHandler(kind))

    // An unregistered origin refuses loudly rather than silently doing nothing.
    const res = await executeOrigin({ id: 'x', origin: { kind: 'weather_desk' }, action: { type: 'trim' } })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'no_origin_handler')
})

test('an unknown VERB on a known origin refuses rather than guessing', async () => {
    const { executeOrigin } = await import('../../services/pendingAction/originRegistry.js')
    const res = await executeOrigin({
        id: 'x', userId: 'u1',
        origin: { kind: 'portfolio_item', entityId: 'h1' },
        action: { type: 'teleport' },
    })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'unknown_action')
})

// ── Phase 4: monitor exits ───────────────────────────────────────────────────
// A stop or target that trips while the venue is shut queues like anything else — a real broker
// would reject the close, and the paper venue would "fill" it at the last close, a price nobody
// could have traded. But it is NOT the same animal as a review's exit, and conflating the two is
// the trap this section exists for.

test('WHO decided is the dispatch — the verb alone cannot tell them apart', async () => {
    const { executeOrigin } = await import('../../services/pendingAction/originRegistry.js')
    const record = (over) => ({ id: 'q1', userId: 'u1', origin: { kind: 'portfolio_item', entityId: 'h1' }, ...over })

    // The monitor path handles exactly one verb. A `trim` reaching it is proof the dispatch went
    // by `queuedBy` — the review path accepts trim happily.
    const asMonitor = await executeOrigin(record({ queuedBy: 'monitor', action: { type: 'trim', reduceFraction: 0.3 } }))
    assert.equal(asMonitor.reason, 'unknown_action', 'a monitor row only ever carries an exit')

    // The same verb on a user row is ACCEPTED — it gets past the verb check and on towards the
    // broker (which is why it does not answer 'unknown_action' here).
    const asUser = await executeOrigin(record({ queuedBy: 'user', action: { type: 'trim', reduceFraction: 0.3 } }))
    assert.notEqual(asUser.reason, 'unknown_action', 'a review\'s trim is the review path\'s to run')
})

test('the default decider is the USER — a row with no flag is a discretionary decision', async () => {
    const { executeOrigin } = await import('../../services/pendingAction/originRegistry.js')
    // Rows written before `queuedBy` existed were all review decisions. Defaulting them to the
    // monitor path would refuse every one of them as 'unknown_action'.
    const res = await executeOrigin({
        id: 'q1', userId: 'u1', origin: { kind: 'portfolio_item', entityId: 'h1' },
        action: { type: 'trim', reduceFraction: 0.3 },
    })
    assert.notEqual(res.reason, 'unknown_action')
})

test('the execution kinds only ever queue an exit', async () => {
    const { executeOrigin } = await import('../../services/pendingAction/originRegistry.js')
    for (const kind of ['call', 'setup', 'idea']) {
        const res = await executeOrigin({
            id: 'q1', userId: 'u1', origin: { kind, entityId: 'e1' }, action: { type: 'trim' },
        })
        assert.equal(res.reason, 'unknown_action', `${kind} has no discretionary verbs — only a monitor exit`)
    }
})

test('every registered origin can run AND cancel — including the three added in phase 4', async () => {
    const { ORIGIN_KINDS, hasOriginHandler, deskForOrigin } = await import('../../services/pendingAction/originRegistry.js')
    assert.deepEqual([...ORIGIN_KINDS].sort(), ['call', 'idea', 'portfolio_item', 'setup'])
    for (const kind of ORIGIN_KINDS) {
        assert.ok(hasOriginHandler(kind))
        assert.ok(deskForOrigin(kind), `${kind} has no desk — its row would carry no tag`)
    }
    // The archived Idea desk speaks as Axl, the same fallback its cards take.
    assert.equal(deskForOrigin('idea'),  'axl')
    assert.equal(deskForOrigin('call'),  'kairos')
    assert.equal(deskForOrigin('setup'), 'mentor')
})
