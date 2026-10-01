import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateDraft } from '../../api/setups/setups.controller.js'
import { emptyBuild, upsertName, applyBuildOps } from '../../services/mentorBuild.util.js'

// A REOPENED Mentor conversation used to land with no verdict and no gate — Generate dark with
// nothing said, no entries table to press — until the user sent another message. The panel now asks
// once on restore, and this is the answer it reads (driven live, 2026-10-01).

const res = () => {
    const out = { code: 200, body: null }
    return { out, status(c) { out.code = c; return this }, send(b) { out.body = b; return this } }
}
const ask = async (body) => { const r = res(); await validateDraft({ user: { _id: 'u1' }, body }, r); return r.out }

const PLAN = {
    asset: 'INTC', direction: 'long', type: 'swing', trade_mode: 'discretionary', entry_mode: 'limit',
    scenarios: [{ id: 's1', entry_legs: [{ price: 116, quantity: 200 }], stop_legs: [{ price: 112.8 }], target_legs: [{ price: 127.44 }], quantity: 200 }],
}

test('a reopened Mentor draft gets back the gate open on its ledger, beside the verdict', async () => {
    let build = upsertName(emptyBuild(), 'INTC')
    build = applyBuildOps(build, { claim: { direction: 'long', horizon: 'swing', lens: 'discretionary' }, settle: ['direction', 'horizon', 'lens'], source: 'user' }).build
    build = applyBuildOps(build, { derived: { spans: ['t1', 't2'] } }).build

    const out = await ask({ setup: { ...PLAN, build }, accounts: [{ id: 'a1' }] })
    assert.equal(out.code, 200)
    assert.equal(out.body.gate.stage, 'spans', 'the span table comes back up')
    assert.equal(out.body.gate.awaiting, true)
    assert.equal(out.body.readiness.ready, true, 'and Generate reads the same gate a turn does')
})

test('a draft with no ledger answers as it always did — no gate', async () => {
    const out = await ask({ setup: PLAN, accounts: [] })
    assert.equal(out.body.gate, undefined)
    assert.deepEqual(out.body.readiness.missing, ['trading account'])
})
