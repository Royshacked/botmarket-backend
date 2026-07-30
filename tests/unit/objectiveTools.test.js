import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeObjectiveHandlers, OBJECTIVE_TOOL_SPEC } from '../../services/objective.tools.js'
import { TOOL_SCHEMAS } from '../../services/agentTools.registry.js'

// save_objective is the one WRITE Axl has. These tests pin the two things that make it safe:
// the FLAT tool args map onto the nested record correctly, and a risk number the user never gave
// cannot appear on the way through.

const NOW = new Date('2026-07-30T12:00:00Z')

function fakeDb() {
    const docs = []
    return {
        docs,
        collection: () => ({
            insertOne: async (doc) => { docs.push(doc); return { acknowledged: true } },
            updateMany: async () => ({ modifiedCount: 0 }),
        }),
    }
}

const handlerWith = (db, userId = 'u1') => makeObjectiveHandlers(userId, { db, now: NOW }).save_objective

test('the flat tool args land on the nested record', async () => {
    // Models fill flat schemas more reliably than nested ones, so the shape the model sees and the
    // shape we store are deliberately different. This is the only place that mapping exists.
    const db = fakeDb()
    const out = await handlerWith(db)({
        target_pct: 5, horizon_days: 7, risk_max_drawdown_pct: 2, scope: 'single', symbol: 'nvda',
    })

    assert.equal(out.saved, true)
    assert.equal(out.deadline, '2026-08-06')
    assert.equal(out.risk_stated, true)

    const [doc] = db.docs
    assert.equal(doc.target.pct, 5)
    assert.equal(doc.horizon.days, 7)
    assert.equal(doc.risk.maxDrawdownPct, 2)
    assert.equal(doc.scope, 'single')
    assert.equal(doc.symbol, 'NVDA')
})

test('a cash target and currency survive the mapping', async () => {
    const db = fakeDb()
    const out = await handlerWith(db)({ target_amount: 2000, target_currency: 'usd', horizon_days: 30 })
    assert.equal(out.saved, true)
    assert.equal(db.docs[0].target.amount, 2000)
    assert.equal(db.docs[0].target.currency, 'USD')
})

test('an unstated risk is reported as unstated, not quietly defaulted', async () => {
    // risk_stated is what the reply reads back to the user, and what tells the desk to ask. If this
    // ever came back true on a goal with no risk number, the question would never get asked.
    const db = fakeDb()
    const out = await handlerWith(db)({ target_pct: 5, horizon_days: 7 })
    assert.equal(out.risk_stated, false)
    assert.equal(db.docs[0].risk.maxDrawdownPct, null)
    assert.equal(db.docs[0].risk.amount, null)
})

test('a half-stated goal comes back as a tool error the model can act on', async () => {
    // No target. The model needs to learn WHY nothing was saved so it can ask for the missing half,
    // rather than carrying on as though the intake succeeded.
    const db = fakeDb()
    const out = await handlerWith(db)({ horizon_days: 7 })
    assert.match(JSON.stringify(out), /target needs a pct or an amount/)
    assert.equal(db.docs.length, 0)
})

test('a signed-out caller gets an honest refusal rather than a crash', async () => {
    const out = await makeObjectiveHandlers(null).save_objective({ target_pct: 5, horizon_days: 7 })
    assert.equal(out.saved, false)
})

// ─── The schema the model actually sees ───────────────────────────────────────

test('the schema teaches the risk rule where the model will read it', () => {
    // The guard is enforced in code, but a model that believes it SHOULD supply a default will keep
    // trying. The parameter description is where that gets settled.
    const desc = TOOL_SCHEMAS.save_objective.properties.risk_max_drawdown_pct.description
    assert.match(desc, /[Nn]ever derive it from the target/)
    assert.match(desc, /never fill it with a sensible default/)
})

test('the model is told not to supply the deadline it cannot compute', () => {
    assert.match(TOOL_SCHEMAS.save_objective.properties.horizon_days.description, /computed for you/)
})

test('scope offers exactly the two shapes that decide the desk', () => {
    assert.deepEqual(TOOL_SCHEMAS.save_objective.properties.scope.enum, ['single', 'basket'])
})

test('the tool description keeps saving an objective inside the read-only boundary', () => {
    // Axl refusing to record a goal because it looks like "doing a trade" would break intake
    // outright, so the description says plainly which side of the line this is on.
    assert.match(OBJECTIVE_TOOL_SPEC.save_objective, /not placing or planning a trade/)
})
