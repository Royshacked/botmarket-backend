import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    buildTiltEvent, audienceBySector, notifyTiltChanged,
    buildTiltReviewOffer, notifyTiltReviewDue, REVIEW_CARD_TYPE,
} from '../../services/tiltNotify.service.js'
import { diffStances } from '../../monitoring/tilt.assess.js'

// Pythia's cards. A pure builder + the audience join, mirroring coverageNotify. The desk posts
// through the ONE shared transport and owns only its own copy — never a router.

const tilt = (over = {}) => ({
    id: 'tilt_SPX_1', benchmark: 'SPX', balanced: true,
    regime: { name: 'late-cycle disinflation' }, ...over,
})
const change = (over = {}) => ({ sector: 'Energy', from: 'neutral', to: 'under', from_bp: 0, to_bp: -150, ...over })

// ── the card ─────────────────────────────────────────────────────────────────
test('one moved sector → a strategy card with the regime as the reason', () => {
    const c = buildTiltEvent(tilt(), [change()], 'u1')
    assert.equal(c.botId, 'strategy')
    assert.equal(c.type, 'tilt_event')
    assert.equal(c.userId, 'u1')
    assert.equal(c.content, 'Sector view changed: late-cycle disinflation — Energy neutral → underweight (-150bp).')
    assert.deepEqual(c.payload.sectors, ['Energy'])
    assert.equal(c.payload.tiltId, 'tilt_SPX_1')
    assert.ok(c.actions, 'the card is actionable — it opens the view')
})

test('tilt_event is admin-only — only the Pythia pipeline produces these', () => {
    assert.equal(buildTiltEvent(tilt(), [change()], 'u1').visibility, 'admin')
})

test('several moved sectors are counted in the head and listed in the body', () => {
    const c = buildTiltEvent(tilt(), [change(), change({ sector: 'Technology', from: 'over', to: 'neutral', to_bp: 0 })], 'u1')
    assert.match(c.content, /^2 sector views changed:/)
    assert.match(c.content, /Energy neutral → underweight \(-150bp\)/)
    assert.match(c.content, /Technology overweight → neutral \(\+0bp\)/)
})

test('a withdrawn stance reads as "no view", never as silence', () => {
    const c = buildTiltEvent(tilt(), [change({ from: 'under', to: null, to_bp: null })], 'u1')
    assert.match(c.content, /Energy underweight → no view\./)
})

test('an unbalanced table is admitted in the payload — it is not directly allocatable', () => {
    assert.equal(buildTiltEvent(tilt({ balanced: false }), [change()], 'u1').payload.balanced, false)
    assert.equal(buildTiltEvent(tilt(), [change()], 'u1').payload.balanced, true)
})

test('no user or nothing moved → no card, and that is not an error', () => {
    assert.equal(buildTiltEvent(tilt(), [change()], null), null)
    assert.equal(buildTiltEvent(tilt(), [], 'u1'), null)
    assert.equal(buildTiltEvent(tilt(), null, 'u1'), null)
    assert.equal(buildTiltEvent(tilt(), [{}], 'u1'), null, 'a change with no sector is not a change')
})

test('a regime with no name simply drops the clause', () => {
    const c = buildTiltEvent(tilt({ regime: null }), [change()], 'u1')
    assert.equal(c.content, 'Sector view changed: Energy neutral → underweight (-150bp).')
})

// ── the audience join ────────────────────────────────────────────────────────
const COVERAGE = [
    { userId: 'u1', symbol: 'XOM',  sector: 'Energy' },
    { userId: 'u1', symbol: 'NVDA', sector: 'Technology' },
    { userId: 'u2', symbol: 'CVX',  sector: 'Energy' },
]
const deps = { listActiveBySector: async () => COVERAGE }

test('the audience is whoever RESEARCHES the moved sector', async () => {
    const by = await audienceBySector(['Energy'], deps)
    assert.deepEqual([...by.keys()].sort(), ['u1', 'u2'])
    assert.deepEqual([...by.get('u1')], ['Energy'], 'only the sector that moved')
})

test('each user hears about THEIR sectors and no one else’s', async () => {
    // u2 covers no Technology, so a Technology move is not their news.
    const by = await audienceBySector(['Technology'], deps)
    assert.deepEqual([...by.keys()], ['u1'])
})

test('nobody covering the sector → nobody told', async () => {
    const by = await audienceBySector(['Utilities'], deps)
    assert.equal(by.size, 0)
})

// ── posting ──────────────────────────────────────────────────────────────────
test('a user covering two moved sectors gets ONE card naming both', async () => {
    const changes = [change(), change({ sector: 'Technology', from: 'over', to: 'neutral', to_bp: 0 })]
    const posted = []
    const spy = { listActiveBySector: async () => COVERAGE.filter(c => c.userId === 'u1'), _posted: posted }
    // buildTiltEvent is pure and already covered; here we only assert the narrowing per user.
    const by = await audienceBySector(changes.map(c => c.sector), spy)
    const card = buildTiltEvent(tilt(), changes.filter(c => by.get('u1').has(c.sector)), 'u1')
    assert.deepEqual(card.payload.sectors, ['Energy', 'Technology'])
})

test('nothing moved → no lookup, no cards, and 0 returned', async () => {
    let looked = false
    const n = await notifyTiltChanged(tilt(), [], { listActiveBySector: async () => { looked = true; return [] } })
    assert.equal(n, 0)
    assert.equal(looked, false, 'a reaffirming republish must not even query')
})

test('an audience lookup that fails degrades to "nobody told", never a throw', async () => {
    const n = await notifyTiltChanged(tilt(), [change()], {
        listActiveBySector: async () => { throw new Error('mongo down') },
    })
    assert.equal(n, 0)   // the view is already published; delivery failing must not undo that
})

// ── the review OFFER ─────────────────────────────────────────────────────────
// The other card: the monitor found the view past its clock and is ASKING for a re-author, because
// running one unattended would supersede the house view everyone reads.

const DAY = 24 * 60 * 60 * 1000
const T0  = Date.parse('2026-01-01T00:00:00.000Z')
const view = (over = {}) => tilt({
    created_at: '2026-01-01T00:00:00.000Z',
    revisions: [{ at: '2026-01-01T00:00:00.000Z', kind: 'publish' }],
    tilts: [
        { sector: 'Energy', stance: 'under', active_bp: -150, state: 'matured' },
        { sector: 'Technology', stance: 'over', active_bp: 150, state: 'open' },
    ],
    ...over,
})

test('the offer names the trigger — a card that only says "review due" sends you looking', () => {
    const c = buildTiltReviewOffer(view(), { reason: 'stance matured: Energy', userId: 'u1' })
    assert.equal(c.type, REVIEW_CARD_TYPE)
    assert.equal(c.botId, 'strategy')
    assert.match(c.content, /stance matured: Energy/)
    assert.match(c.content, /2 stances standing/)
    assert.match(c.content, /late-cycle disinflation/, 'the regime is the reason the view exists')
    assert.equal(c.actions.primary.label, 'Run the review')
})

test('tilt_review offer is admin-only — only the admin runs the Pythia review', () => {
    assert.equal(buildTiltReviewOffer(view(), { reason: 'x', userId: 'u1' }).visibility, 'admin')
})

test('the payload separates what is DUE from what is merely standing', () => {
    const p = buildTiltReviewOffer(view(), { reason: 'x', userId: 'u1' }).payload
    assert.deepEqual(p.sectors, ['Energy', 'Technology'])
    assert.deepEqual(p.matured, ['Energy'], 'a closed call the review has to grade, not just restate')
    assert.equal(p.stances, 2)
    assert.equal(p.tiltId, 'tilt_SPX_1')
})

test('no user → no card, and a triggerless offer still reads as a sentence', () => {
    assert.equal(buildTiltReviewOffer(view(), { userId: null }), null)
    const c = buildTiltReviewOffer(view(), { userId: 'u1' })
    assert.match(c.content, /^Sector view due for review\. /)
})

// The fan-out is a BROADCAST: a tilt has no owner, and re-examining the house view is not a fact
// about anyone's book.
function offerHarness({ users = ['u1', 'u2', 'u3'], already = new Set() } = {}) {
    const posted = [], asked = []
    return {
        posted, asked,
        deps: {
            allUserIds:      async () => users,
            recipientsSince: async (type, since) => { asked.push({ type, since }); return already },
            post:            async (card) => { if (!card) return null; posted.push(card); return card },
        },
    }
}

test('everyone who has not been asked about THIS view gets the card', async () => {
    const h = offerHarness()
    const n = await notifyTiltReviewDue(view(), { reason: 'no review in 34 days', nowMs: T0 + 34 * DAY }, h.deps)
    assert.equal(n, 3)
    assert.deepEqual(h.posted.map(c => c.userId), ['u1', 'u2', 'u3'])
})

test('a user already asked about this view is not asked again', async () => {
    const h = offerHarness({ already: new Set(['u2']) })
    const n = await notifyTiltReviewDue(view(), { reason: 'x', nowMs: T0 + 34 * DAY }, h.deps)
    assert.equal(n, 2)
    assert.deepEqual(h.posted.map(c => c.userId), ['u1', 'u3'])
})

test('the dedupe window opens at the last PUBLISH — one ask per user per published view', async () => {
    const h = offerHarness()
    // A stance matured 10 days after the publish: inside the review cadence, so the publish is what
    // bounds the window.
    await notifyTiltReviewDue(view(), { reason: 'stance matured: Energy', nowMs: T0 + 10 * DAY }, h.deps)
    assert.equal(h.asked[0].type, REVIEW_CARD_TYPE)
    assert.equal(h.asked[0].since, T0, 'a card posted since the publish means this user was asked')
})

test('…but a view left stale for months is asked about again rather than forgotten', async () => {
    const h = offerHarness()
    const now = T0 + 200 * DAY
    await notifyTiltReviewDue(view(), { reason: 'x', nowMs: now }, h.deps)
    assert.equal(h.asked[0].since, now - 30 * DAY, 'the window is floored at the review cadence')
})

test('everyone already asked → no cards, and that is the steady state, not a failure', async () => {
    const h = offerHarness({ already: new Set(['u1', 'u2', 'u3']) })
    assert.equal(await notifyTiltReviewDue(view(), { reason: 'x', nowMs: T0 + 34 * DAY }, h.deps), 0)
    assert.equal(h.posted.length, 0)
})

test('a roster or dedupe read that fails degrades to "nobody asked", never a throw', async () => {
    const h = offerHarness()
    h.deps.allUserIds = async () => { throw new Error('mongo down') }
    assert.equal(await notifyTiltReviewDue(view(), { reason: 'x' }, h.deps), 0)
    // The view is still due; the next tick asks again.
    assert.equal(h.posted.length, 0)
})

test('a view with no id is not offered — there is nothing to review', async () => {
    const h = offerHarness()
    assert.equal(await notifyTiltReviewDue({ }, { reason: 'x' }, h.deps), 0)
    assert.equal(h.asked.length, 0, 'and no read is made for it either')
})

// ── the diff is what separates news from noise ───────────────────────────────
test('republishing an unchanged view notifies nobody', () => {
    const rows = [{ sector: 'Energy', stance: 'under', active_bp: -150 }]
    assert.deepEqual(diffStances({ tilts: rows }, { tilts: [...rows] }), [])
})

test('diffStances reports a changed weight even when the stance word is the same', () => {
    const d = diffStances(
        { tilts: [{ sector: 'Energy', stance: 'under', active_bp: -150 }] },
        { tilts: [{ sector: 'Energy', stance: 'under', active_bp: -300 }] },
    )
    assert.deepEqual(d, [{ sector: 'Energy', from: 'under', to: 'under', from_bp: -150, to_bp: -300 }])
})

test('diffStances reports sectors that appear and sectors that drop out', () => {
    const d = diffStances(
        { tilts: [{ sector: 'Energy', stance: 'under', active_bp: -150 }] },
        { tilts: [{ sector: 'Technology', stance: 'over', active_bp: 150 }] },
    )
    assert.deepEqual(d, [
        { sector: 'Energy',     from: 'under', to: null,   from_bp: -150, to_bp: null },
        { sector: 'Technology', from: null,    to: 'over', from_bp: null, to_bp: 150 },
    ])
})
