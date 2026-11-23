import { test } from 'node:test'
import assert from 'node:assert/strict'

import { gate, postOverride } from '../../api/situation/situation.controller.js'

const res = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r }; r.json = (b) => { r.body = b; return r }; return r }

test('the gate: off the allow-list the board does not exist (404); on it, through', () => {
    const keep = process.env.SITUATION_USERS
    try {
        process.env.SITUATION_USERS = '1779968319268,1780034546842'
        let passed = 0
        const r1 = res(); gate({ user: { id: '1780034546842', role: 'trader' } }, r1, () => passed++)
        assert.equal(passed, 1)
        const r2 = res(); gate({ user: { id: 'other', role: 'admin' } }, r2, () => passed++)
        assert.equal(r2.code, 404, 'the admin role alone does not open it')
        const r3 = res(); gate({}, r3, () => passed++)
        assert.equal(r3.code, 404)
        assert.equal(passed, 1)
    } finally { if (keep === undefined) delete process.env.SITUATION_USERS; else process.env.SITUATION_USERS = keep }
})

test("an override is the admin's: a trader on the list is refused", async () => {
    let err = null
    await postOverride({ method: 'POST', originalUrl: '/api/situation/nodes/x/override', user: { id: '1780034546842', role: 'trader' }, params: { id: 'node_x' }, body: { p: { a: 1 } } }, res(), (e) => { err = e })
    assert.equal(err?.status, 403, 'the refusal goes to the one error handler')
})
