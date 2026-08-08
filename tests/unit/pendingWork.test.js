import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SOURCES, WAITING_ORDER_STATES } from '../../services/pendingAction/pendingWork.service.js'

// "What is waiting on me" — the ONE read behind both the market-open card's count and the queued
// list. Waiting work lives in two stores and neither is going away: a QUEUED ACTION owns no entity
// (the record is the intent), and an ENTITY awaiting confirmation has no queue row (the entity is
// the intent). Copying one into the other would give the same order two states to drift apart, so
// the union is a read, and this pins the row shape everything downstream speaks.
//
// The normalizers are exercised through listWaiting's own deps in the sweep tests; here we pin the
// contract itself — the shape, and the two rules that are easy to break silently.

test('the two sources are named, and nothing else is waiting work', () => {
    assert.deepEqual(Object.values(SOURCES).sort(), ['entity', 'queue'])
})

test('only awaiting_confirm counts as an entity waiting on the user', () => {
    // NOT awaiting_market: that one is still parked for a venue that has not opened, and the sweep
    // is what promotes it. Listing it here would put un-executable rows in a list whose whole
    // promise is "press this and it happens".
    assert.deepEqual(WAITING_ORDER_STATES, ['awaiting_confirm'])
    assert.ok(!WAITING_ORDER_STATES.includes('awaiting_market'))
    assert.ok(!WAITING_ORDER_STATES.includes('placed'))
})

// ── the transition guard ─────────────────────────────────────────────────────
// The whole correctness of a state change lives in this filter, so it is pure and tested here.

test('a transition is guarded on id, OWNER and the expected from-state', async () => {
    const { transitionFilter, STATES } = await import('../../services/pendingAction/pendingAction.repo.js')

    // Ownership rides IN the filter rather than a lookup-then-write, which would leave a window for
    // another request to move the row between the two statements.
    const f = transitionFilter('q1', 'u1', STATES.QUEUED)
    assert.deepEqual(f, { id: 'q1', userId: 'u1', state: { $in: ['queued'] } })
})

test('the sweep\'s release narrows to QUEUED — a released row must not wake twice', async () => {
    const { transitionFilter, STATES } = await import('../../services/pendingAction/pendingAction.repo.js')

    // The bug this prevents: the default `from` is every OPEN state, and RELEASED is open. Two
    // overlapping ticks would each move the same row and each post a market-open card.
    const release = transitionFilter('q1', 'u1', STATES.QUEUED)
    assert.ok(!release.state.$in.includes(STATES.RELEASED))

    // A cancel genuinely means "from wherever it is now" — queued OR already released.
    const cancel = transitionFilter('q1', 'u1')
    assert.deepEqual(cancel.state.$in.sort(), ['queued', 'released'])
})

test('ids are coerced, so a non-string id cannot silently match nothing', async () => {
    const { transitionFilter } = await import('../../services/pendingAction/pendingAction.repo.js')
    const f = transitionFilter(42, 7, 'queued')
    assert.equal(f.id, '42')
    assert.equal(f.userId, '7')
})
