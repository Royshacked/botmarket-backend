import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { setupService } from '../../api/setups/setups.service.js'

// GENERATE ALL — one press, N names (docs/design/mentor-flow-intent.md #15, step 6).
//
// The contract worth testing is the partial one: three of four saving is a SUCCESS with news, not a
// failure. Rolling back three finished setups because a fourth had no size would throw away work
// the user did, and saying nothing about the fourth would be worse.
//
// On the SERVICE since phase 9 (2026-10-20): the old `/api/setups/generate-all` route went with Mentor's panel — Mentor's
// session action (`generateAll`, services/desks/actions/mentor.actions.js) calls this service, and the contract is its.

const opts = { userId: 'u1', accounts: [{ id: 'a1' }], mainAccountId: 'a1' }

const withGenerate = async (impl, run) => {
    const spy = mock.method(setupService, 'generateSetup', impl)
    try { return await run() } finally { spy.mock.restore() }
}

test('every setup that passes is saved, and each refusal says which one and why', async () => {
    const out = await withGenerate(
        async (setup) => (setup.asset === 'AMD'
            ? { ok: false, reason: 'missing_quantity' }
            : { ok: true, doc: { id: `id-${setup.asset}`, asset: setup.asset } }),
        () => setupService.generateSetups([{ asset: 'NVDA' }, { asset: 'AMD' }, { asset: 'TSLA' }], opts),
    )
    assert.deepEqual(out.saved.map(d => d.asset), ['NVDA', 'TSLA'])
    assert.deepEqual(out.failed, [{ index: 1, asset: 'AMD', reason: 'missing_quantity' }])
    assert.equal(out.reason, undefined, 'a batch that did something is not a refusal')
})

test('the good ones STAND when one fails — nothing is rolled back', async () => {
    const out = await withGenerate(
        async (setup) => (setup.asset === 'TSLA'
            ? { ok: false, reason: 'missing_stop' }
            : { ok: true, doc: { id: `id-${setup.asset}`, asset: setup.asset } }),
        () => setupService.generateSetups([{ asset: 'NVDA' }, { asset: 'AMD' }, { asset: 'TSLA' }], opts),
    )
    assert.equal(out.saved.length, 2)
    assert.equal(out.failed.length, 1)
})

test('all of them failing still carries every reason', async () => {
    const out = await withGenerate(
        async () => ({ ok: false, reason: 'no_account' }),
        () => setupService.generateSetups([{ asset: 'NVDA' }, { asset: 'AMD' }], opts),
    )
    assert.deepEqual(out.saved, [])
    assert.deepEqual(out.failed.map(f => f.reason), ['no_account', 'no_account'])
})

test('they are generated in SEQUENCE — a burst of broker checks is how you get rate-limited', async () => {
    const order = []
    await withGenerate(
        async (setup) => {
            order.push(`start:${setup.asset}`)
            await new Promise(resolve => setImmediate(resolve))
            order.push(`end:${setup.asset}`)
            return { ok: true, doc: { asset: setup.asset } }
        },
        () => setupService.generateSetups([{ asset: 'NVDA' }, { asset: 'AMD' }], opts),
    )
    assert.deepEqual(order, ['start:NVDA', 'end:NVDA', 'start:AMD', 'end:AMD'])
})

test('junk in the list is refused by position, not by crashing the batch', async () => {
    const out = await withGenerate(
        async (setup) => ({ ok: true, doc: { asset: setup.asset } }),
        () => setupService.generateSetups([{ asset: 'NVDA' }, null, 'AMD'], opts),
    )
    assert.deepEqual(out.saved.map(d => d.asset), ['NVDA'])
    assert.deepEqual(out.failed.map(f => f.index), [1, 2])
})

test('an oversized batch is refused before anything is written', async () => {
    let calls = 0
    const out = await withGenerate(
        async () => { calls++; return { ok: true, doc: {} } },
        () => setupService.generateSetups(Array.from({ length: 11 }, (_, i) => ({ asset: `X${i}` })), opts),
    )
    assert.deepEqual([out.reason, out.max, calls], ['too_many', 10, 0])
})
