import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildObjectiveDoc, sanitizeObjectiveSymbol, addDaysISO } from '../../api/objectives/objective.model.js'
import { createObjective, getOpenObjective, markRouted } from '../../services/objective.service.js'

// THE OBJECTIVE — what the user told Axl they were here for, so a desk stops asking for it again.
//
// Two rules carry real weight and both are tested hard below:
//   1. risk is USER-STATED, never inferred. A 5% target says nothing about drawdown tolerance, and
//      a helpful-looking default here would become the number a desk sizes a real order against.
//   2. the deadline is computed in CODE. The model is given a day count; asking it for a date is
//      how a scheduled thing ends up firing on the wrong day.

const NOW = new Date('2026-07-30T12:00:00Z')

// Minimal Mongo stand-in: an array of docs plus the four calls the service actually makes. Update
// operators are applied by hand so a test can assert on the resulting documents, not on call shapes.
function fakeDb(docs = []) {
    const calls = []
    const match = (doc, q) => Object.entries(q).every(([k, v]) => {
        const actual = k.split('.').reduce((o, part) => o?.[part], doc)
        if (v && typeof v === 'object' && '$lt' in v) return actual < v.$lt
        return actual === v
    })
    return {
        docs, calls,
        collection: () => ({
            insertOne: async (doc) => { calls.push('insertOne'); docs.push(doc); return { acknowledged: true } },
            updateMany: async (q, u) => {
                calls.push('updateMany')
                let n = 0
                for (const d of docs) if (match(d, q)) { Object.assign(d, u.$set); n++ }
                return { modifiedCount: n }
            },
            updateOne: async (q, u) => {
                calls.push('updateOne')
                const d = docs.find(x => match(x, q))
                if (d) Object.assign(d, u.$set)
                return { modifiedCount: d ? 1 : 0 }
            },
            findOne: async (q, opts = {}) => {
                calls.push('findOne')
                const found = docs.filter(d => match(d, q))
                if (opts.sort?.createdAt === -1) found.sort((a, b) => b.createdAt - a.createdAt)
                return found[0] ?? null
            },
        }),
    }
}

const validFields = {
    target: { pct: 5 },
    horizon: { days: 7 },
    risk: { maxDrawdownPct: 2 },
    scope: 'single',
    symbol: 'nvda',
}

// ─── buildObjectiveDoc: what counts as a stated goal ──────────────────────────

test('a percent target and a horizon are enough to state a goal', () => {
    const doc = buildObjectiveDoc('u1', { target: { pct: 5 }, horizon: { days: 7 } }, NOW)
    assert.equal(doc.target.pct, 5)
    assert.equal(doc.horizon.days, 7)
    assert.equal(doc.status, 'open')
})

test('a cash target works too — "I want to make $2,000" is a goal, not a percentage', () => {
    const doc = buildObjectiveDoc('u1', { target: { amount: 2000, currency: 'usd' }, horizon: { days: 30 } }, NOW)
    assert.equal(doc.target.amount, 2000)
    assert.equal(doc.target.currency, 'USD')
    assert.equal(doc.target.pct, null)
})

test('no target at all is not a goal — refuse rather than store an empty intake', () => {
    assert.throws(() => buildObjectiveDoc('u1', { horizon: { days: 7 } }, NOW), /target needs a pct or an amount/)
})

test('a horizon is required, and an absurd one is refused', () => {
    const t = { target: { pct: 5 } }
    assert.throws(() => buildObjectiveDoc('u1', t, NOW), /horizon.days/)
    assert.throws(() => buildObjectiveDoc('u1', { ...t, horizon: { days: 0 } }, NOW), /horizon.days/)
    assert.throws(() => buildObjectiveDoc('u1', { ...t, horizon: { days: 4000 } }, NOW), /horizon.days/)
    assert.throws(() => buildObjectiveDoc('u1', { ...t, horizon: { days: 7.5 } }, NOW), /horizon.days/)
})

test('the deadline is computed from the day count, never taken from the model', () => {
    const doc = buildObjectiveDoc('u1', { target: { pct: 5 }, horizon: { days: 7 } }, NOW)
    assert.equal(doc.horizon.until, '2026-08-06')
    // Whatever the model may have sent for a date is not consulted at all.
    const ignored = buildObjectiveDoc('u1', { target: { pct: 5 }, horizon: { days: 7, until: '2030-01-01' } }, NOW)
    assert.equal(ignored.horizon.until, '2026-08-06')
})

test('an unstated risk stays null — it is NEVER back-filled from the target', () => {
    // The whole reason the field exists. A 5% target does not imply a 5% drawdown tolerance, and a
    // default here would silently become the number a desk sizes a real order against.
    const doc = buildObjectiveDoc('u1', { target: { pct: 5 }, horizon: { days: 7 } }, NOW)
    assert.equal(doc.risk.maxDrawdownPct, null)
    assert.equal(doc.risk.amount, null)
})

test('a stated risk is kept exactly as given', () => {
    const doc = buildObjectiveDoc('u1', validFields, NOW)
    assert.equal(doc.risk.maxDrawdownPct, 2)
})

test('nonsense numbers are dropped rather than stored', () => {
    // The model emits JSON; a string or a negative here means it guessed, and a guessed risk number
    // is worse than none at all.
    const doc = buildObjectiveDoc('u1', {
        target: { pct: 5, amount: -100 },
        horizon: { days: 7 },
        risk: { maxDrawdownPct: '2', amount: NaN },
    }, NOW)
    assert.equal(doc.target.amount, null)
    assert.equal(doc.risk.maxDrawdownPct, null)
    assert.equal(doc.risk.amount, null)
})

test('scope is one of the two shapes, or nothing', () => {
    assert.equal(buildObjectiveDoc('u1', validFields, NOW).scope, 'single')
    assert.equal(buildObjectiveDoc('u1', { ...validFields, scope: 'sideways' }, NOW).scope, null)
})

test('the symbol is uppercased, and a company name is dropped rather than routed on', () => {
    assert.equal(buildObjectiveDoc('u1', validFields, NOW).symbol, 'NVDA')
    assert.equal(sanitizeObjectiveSymbol('Nvidia Corp'), null)
    assert.equal(sanitizeObjectiveSymbol('brk.b'), 'BRK.B')
    assert.equal(sanitizeObjectiveSymbol(null), null)
})

test('addDaysISO crosses a month boundary correctly', () => {
    assert.equal(addDaysISO(7, new Date('2026-07-30T12:00:00Z')), '2026-08-06')
    assert.equal(addDaysISO(1, new Date('2026-12-31T23:00:00Z')), '2027-01-01')
})

// ─── createObjective: one open objective per user ─────────────────────────────

test('saving a new goal supersedes the old one instead of editing it', async () => {
    // Restating the goal is a new statement. Keeping the old row makes the trail readable later,
    // and mutating in place would lose it for no gain.
    const db = fakeDb([{ id: 'old', userId: 'u1', status: 'open', createdAt: 1 }])
    await createObjective('u1', validFields, { db, now: NOW })

    assert.equal(db.docs[0].status, 'superseded')
    assert.equal(db.docs.length, 2)
    assert.equal(db.docs[1].status, 'open')
    // Supersede must land BEFORE the insert, or a crash between them leaves two open objectives.
    assert.deepEqual(db.calls, ['updateMany', 'insertOne'])
})

test("another user's open objective is untouched", async () => {
    const db = fakeDb([{ id: 'theirs', userId: 'u2', status: 'open', createdAt: 1 }])
    await createObjective('u1', validFields, { db, now: NOW })
    assert.equal(db.docs[0].status, 'open')
})

test('an unstated goal never reaches the database', async () => {
    const db = fakeDb()
    await assert.rejects(() => createObjective('u1', { horizon: { days: 7 } }, { db, now: NOW }))
    assert.deepEqual(db.calls, [])
})

// ─── getOpenObjective: lazy expiry ────────────────────────────────────────────

test('a goal whose deadline has passed is expired on read, not served once more', async () => {
    const db = fakeDb([{ id: 'stale', userId: 'u1', status: 'open', createdAt: 1, horizon: { until: '2026-07-01' } }])
    const got = await getOpenObjective('u1', { db, now: NOW })
    assert.equal(got, null)
    assert.equal(db.docs[0].status, 'expired')
})

test("a goal whose deadline is today still counts — it is the user's last day, not their first missed one", async () => {
    const db = fakeDb([{ id: 'live', userId: 'u1', status: 'open', createdAt: 1, horizon: { until: '2026-07-30' } }])
    const got = await getOpenObjective('u1', { db, now: NOW })
    assert.equal(got?.id, 'live')
})

test('the newest open goal wins when more than one somehow survives', async () => {
    const db = fakeDb([
        { id: 'older', userId: 'u1', status: 'open', createdAt: 1, horizon: { until: '2026-09-01' } },
        { id: 'newer', userId: 'u1', status: 'open', createdAt: 2, horizon: { until: '2026-09-01' } },
    ])
    assert.equal((await getOpenObjective('u1', { db, now: NOW }))?.id, 'newer')
})

test('a database problem degrades to "no objective" rather than failing the desk turn', async () => {
    // Every desk calls this on every turn. A read that throws must never be what stops a user
    // getting an answer.
    const broken = { collection: () => ({ updateMany: async () => { throw new Error('mongo down') } }) }
    assert.equal(await getOpenObjective('u1', { db: broken, now: NOW }), null)
})

test('no signed-in user means no objective, without touching the database', async () => {
    assert.equal(await getOpenObjective(null), null)
})

// ─── markRouted ───────────────────────────────────────────────────────────────

test('routing stamps the desk but leaves the goal open — they are there to work on it', async () => {
    const db = fakeDb([{ id: 'o1', userId: 'u1', status: 'open', createdAt: 1 }])
    await markRouted('o1', 'trade', { db, now: NOW })
    assert.equal(db.docs[0].routedTo, 'trade')
    assert.equal(db.docs[0].status, 'open')
})
