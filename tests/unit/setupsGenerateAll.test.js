import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { generateSetups } from '../../api/setups/setups.controller.js'
import { setupService } from '../../api/setups/setups.service.js'

// GENERATE ALL — one press, N names (docs/design/mentor-flow-intent.md #15, step 6).
//
// The contract worth testing is the partial one: three of four saving is a SUCCESS with news, not a
// failure. Rolling back three finished setups because a fourth had no size would throw away work
// the user did, and saying nothing about the fourth would be worse.

const res = () => {
    const out = { code: 200, body: null }
    return {
        out,
        status(c) { out.code = c; return this },
        send(b) { out.body = b; return this },
    }
}

const req = (setups) => ({ user: { _id: 'u1' }, body: { setups, accounts: [{ id: 'a1' }], mainAccountId: 'a1' } })

const withGenerate = async (impl, run) => {
    const spy = mock.method(setupService, 'generateSetup', impl)
    try { return await run() } finally { spy.mock.restore() }
}

test('every setup that passes is saved, and each refusal says which one and why', async () => {
    const r = res()
    await withGenerate(
        async (setup) => (setup.asset === 'AMD'
            ? { ok: false, reason: 'missing_quantity' }
            : { ok: true, doc: { id: `id-${setup.asset}`, asset: setup.asset } }),
        () => generateSetups(req([{ asset: 'NVDA' }, { asset: 'AMD' }, { asset: 'TSLA' }]), r),
    )

    assert.equal(r.out.code, 200, 'a batch that did something is not an error')
    assert.deepEqual(r.out.body.saved.map(d => d.asset), ['NVDA', 'TSLA'])
    assert.deepEqual(r.out.body.failed, [{ index: 1, asset: 'AMD', reason: 'missing_quantity' }])
})

test('the good ones STAND when one fails — nothing is rolled back', async () => {
    const r = res()
    await withGenerate(
        async (setup) => (setup.asset === 'TSLA'
            ? { ok: false, reason: 'missing_stop' }
            : { ok: true, doc: { id: `id-${setup.asset}`, asset: setup.asset } }),
        () => generateSetups(req([{ asset: 'NVDA' }, { asset: 'AMD' }, { asset: 'TSLA' }]), r),
    )
    assert.equal(r.out.body.saved.length, 2)
    assert.equal(r.out.body.failed.length, 1)
})

test('all of them failing is still a 200 carrying the reasons', async () => {
    const r = res()
    await withGenerate(
        async () => ({ ok: false, reason: 'no_account' }),
        () => generateSetups(req([{ asset: 'NVDA' }, { asset: 'AMD' }]), r),
    )
    assert.equal(r.out.code, 200)
    assert.deepEqual(r.out.body.saved, [])
    assert.deepEqual(r.out.body.failed.map(f => f.reason), ['no_account', 'no_account'])
})

test('they are generated in SEQUENCE — a burst of broker checks is how you get rate-limited', async () => {
    const r = res()
    const order = []
    await withGenerate(
        async (setup) => {
            order.push(`start:${setup.asset}`)
            await new Promise(resolve => setImmediate(resolve))
            order.push(`end:${setup.asset}`)
            return { ok: true, doc: { asset: setup.asset } }
        },
        () => generateSetups(req([{ asset: 'NVDA' }, { asset: 'AMD' }]), r),
    )
    assert.deepEqual(order, ['start:NVDA', 'end:NVDA', 'start:AMD', 'end:AMD'])
})

test('junk in the list is refused by position, not by crashing the batch', async () => {
    const r = res()
    await withGenerate(
        async (setup) => ({ ok: true, doc: { asset: setup.asset } }),
        () => generateSetups(req([{ asset: 'NVDA' }, null, 'AMD']), r),
    )
    assert.deepEqual(r.out.body.saved.map(d => d.asset), ['NVDA'])
    assert.deepEqual(r.out.body.failed.map(f => f.index), [1, 2])
})

test('an empty or oversized batch is refused before anything is written', async () => {
    const empty = res()
    await generateSetups(req([]), empty)
    assert.equal(empty.out.code, 400)

    const huge = res()
    await generateSetups(req(Array.from({ length: 11 }, (_, i) => ({ asset: `X${i}` }))), huge)
    assert.equal(huge.out.code, 400)
    assert.match(huge.out.body.error, /no more than 10/)
})
