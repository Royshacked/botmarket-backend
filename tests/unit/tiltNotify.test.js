import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildTiltEvent, audienceBySector, notifyTiltChanged } from '../../services/tiltNotify.service.js'
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
