import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildCoverageEvent, notifyCoverageEvent, notifyCoverageRefreshed } from '../../services/coverageNotify.service.js'

// Prometheus's monitor card. House coverage has no owner, so the audience is every ADMIN — derived
// at delivery time, the join tiltNotify's review offer already uses. Traders never see the feed
// (ADMIN_BOT_IDS), and the card asks for a revision only an admin can make, so a card addressed
// to a trader would be a document nobody could open.

const cov = (over = {}) => ({ id: 'cov_1', symbol: 'NVDA', price_target: { value: 180 }, ...over })

// ── the card ─────────────────────────────────────────────────────────────────

test('target hit, edge gone → a harvest nudge from Prometheus, admin-visible', () => {
    const c = buildCoverageEvent(cov(), { state: 'target_hit', reason: 'x', edge_gone: true }, 'a1')
    assert.equal(c.userId, 'a1')
    assert.equal(c.botId, 'analyst')
    assert.equal(c.type, 'coverage_event')
    assert.equal(c.visibility, 'admin')
    assert.equal(c.content, 'NVDA reached our price target (180) — the Street has caught up, so the edge is gone. Consider harvesting.')
    assert.deepEqual(c.payload, { kind: 'coverage', symbol: 'NVDA', coverageId: 'cov_1', state: 'target_hit', edge_gone: true })
    assert.equal(c.actions.primary.label, 'Open coverage')
})

test('each material state reads as itself; too-fast reads as a miss, not a win', () => {
    const say = (state, reason = 'r') => buildCoverageEvent(cov(), { state, reason }, 'a1').content
    assert.equal(say('target_hit'), 'NVDA reached our price target (180).')
    assert.match(say('target_hit_early', 'gap closed in 3 days'), /far too fast: gap closed in 3 days\. Re-modelling/)
    assert.equal(say('thesis_broken', 'guide cut'), 'NVDA thesis BROKEN: guide cut.')
    assert.equal(say('validating', 'estimates rising'), 'NVDA thesis is playing out: estimates rising.')
    assert.match(say('diverging', 'Street lifted PT'), /increasingly contrarian/)
})

test('a quiet verdict, a missing symbol, or no recipient → no card', () => {
    assert.equal(buildCoverageEvent(cov(), { state: 'stable' }, 'a1'), null)
    assert.equal(buildCoverageEvent(cov({ symbol: '' }), { state: 'thesis_broken', reason: 'r' }, 'a1'), null)
    assert.equal(buildCoverageEvent(cov(), { state: 'thesis_broken', reason: 'r' }, null), null)
    assert.equal(buildCoverageEvent(null, { state: 'thesis_broken' }, 'a1'), null)
})

test('no price target → the sentence simply omits it', () => {
    const c = buildCoverageEvent(cov({ price_target: null }), { state: 'target_hit' }, 'a1')
    assert.equal(c.content, 'NVDA reached our price target.')
})

// ── the fan-out ──────────────────────────────────────────────────────────────

function deps(ids, over = {}) {
    const posted = []
    return {
        posted,
        adminUserIds: async () => ids,
        post: async (card) => { posted.push(card); return { id: `m${posted.length}` } },
        ...over,
    }
}

test('a material verdict reaches every admin, once each, and nobody else', async () => {
    const d = deps(['a1', 'a2'])
    const n = await notifyCoverageEvent(cov(), { state: 'thesis_broken', reason: 'guide cut' }, d)
    assert.equal(n, 2)
    assert.deepEqual(d.posted.map(c => c.userId), ['a1', 'a2'])
    assert.ok(d.posted.every(c => c.visibility === 'admin' && c.botId === 'analyst'))
})

test('a quiet verdict never reads the roster', async () => {
    let read = false
    const d = deps([], { adminUserIds: async () => { read = true; return ['a1'] } })
    assert.equal(await notifyCoverageEvent(cov(), { state: 'stable' }, d), 0)
    assert.equal(read, false)
})

test('an empty roster, or a roster read that fails, posts nothing and never throws', async () => {
    assert.equal(await notifyCoverageEvent(cov(), { state: 'thesis_broken', reason: 'r' }, deps([])), 0)
    const failing = deps([], { adminUserIds: async () => { throw new Error('mongo down') } })
    assert.equal(await notifyCoverageEvent(cov(), { state: 'thesis_broken', reason: 'r' }, failing), 0)
})

test('one failed delivery does not stop the others, and is not counted', async () => {
    const d = deps(['a1', 'a2', 'a3'], { post: async (card) => card.userId === 'a2' ? null : { id: 'ok' } })
    assert.equal(await notifyCoverageEvent(cov(), { state: 'validating', reason: 'r' }, d), 2)
})

// ── the refresh card: one user, or every admin ───────────────────────────────
// Atlas's refresh-by-hop names the user who asked; the monitor's scheduled re-model has no user
// (coverage is house-owned) and the same card fans out to the admin roster instead — the audience
// the verdict card above already uses. Before 2026-09-16 the house half did not exist, which is one
// of the two reasons a scheduled re-model could never complete.

test('a user\'s refresh → one own-only card to that user, no roster read', async () => {
    let read = false
    const d = deps(['a1', 'a2'], { adminUserIds: async () => { read = true; return ['a1', 'a2'] } })
    const n = await notifyCoverageRefreshed({ userId: 'u1', ticker: 'NVDA', coverageId: 'cov_1', ok: true }, d)
    assert.equal(n, 1)
    assert.equal(read, false)
    assert.equal(d.posted[0].userId, 'u1')
    assert.equal(d.posted[0].visibility, 'own')
    assert.equal(d.posted[0].forUserId, 'u1')
    assert.match(d.posted[0].content, /Resume the review/)
})

test('a house refresh (no user) → every admin, admin-visible, and the copy stops talking about a review', async () => {
    const d = deps(['a1', 'a2'])
    const n = await notifyCoverageRefreshed({ userId: null, ticker: 'NVDA', coverageId: 'cov_1', summary: 'AI capex intact', ok: true }, d)
    assert.equal(n, 2)
    assert.deepEqual(d.posted.map(c => c.userId), ['a1', 'a2'])
    for (const c of d.posted) {
        assert.equal(c.visibility, 'admin')
        assert.equal(c.forUserId, undefined)
        assert.equal(c.payload.house, true)
        assert.equal(c.type, 'coverage_refreshed')
        assert.match(c.content, /Scheduled re-model of NVDA is in — AI capex intact/)
        assert.doesNotMatch(c.content, /review/i)
    }
})

test('a house refresh that stored nothing says so, honestly, to the same roster', async () => {
    const d = deps(['a1'])
    assert.equal(await notifyCoverageRefreshed({ userId: null, ticker: 'NVDA', ok: false }, d), 1)
    assert.match(d.posted[0].content, /produced nothing to store — the existing coverage stands/)
})

test('a house refresh with no roster, or a roster read that fails, posts nothing and never throws', async () => {
    assert.equal(await notifyCoverageRefreshed({ userId: null, ticker: 'NVDA' }, deps([])), 0)
    const failing = deps([], { adminUserIds: async () => { throw new Error('mongo down') } })
    assert.equal(await notifyCoverageRefreshed({ userId: null, ticker: 'NVDA' }, failing), 0)
})
