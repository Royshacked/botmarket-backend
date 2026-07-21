import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildOrderPlan } from '../../services/orderPlan.service.js'
import { ideaToEnvelope } from '../../services/entity/toEnvelope.js'

// P1a of the entity split (ENTITY_MODEL.md): the order-plan builder now reads the shared
// Envelope's execution binding + sizing, so an idea/call/portfolio_item plan identically.
// The account-resolver is injected so the scaling math is testable without live brokers.

const RESOLVED = new Map([
    ['a1', { id: 'a1', login: 'L1', broker: 'ctrader', balance: 1000 }],
    ['a2', { id: 'a2', login: 'L2', broker: 'ctrader', balance: 500 }],
])
const fakeResolve = async () => RESOLVED

function envelope(over = {}) {
    return {
        id: 'e1', userId: 'u1',
        execution: { accounts: ['a1', 'a2'], mainAccountId: 'a1' },
        sizing: { resolvedQty: 100, requested: 100 },
        ...over,
    }
}

test('main account trades raw qty; others scale by balance ratio', async () => {
    const plan = await buildOrderPlan(envelope(), { resolveAccounts: fakeResolve })
    assert.deepEqual(plan, [
        { broker: 'ctrader', accountId: 'a1', accountNo: 'L1', quantity: 100, type: 'market' },
        { broker: 'ctrader', accountId: 'a2', accountNo: 'L2', quantity: 50,  type: 'market' }, // 500/1000
    ])
})

test('reads accounts/mainAccountId from execution and qty from sizing', async () => {
    // resolvedQty absent → falls back to requested
    const plan = await buildOrderPlan(
        envelope({ sizing: { resolvedQty: null, requested: 40 } }),
        { resolveAccounts: fakeResolve },
    )
    assert.equal(plan.find(p => p.accountId === 'a1').quantity, 40)
    assert.equal(plan.find(p => p.accountId === 'a2').quantity, 20)
})

test('accepts object-form accounts [{id}]', async () => {
    const plan = await buildOrderPlan(
        envelope({ execution: { accounts: [{ id: 'a1' }, { id: 'a2' }], mainAccountId: 'a1' } }),
        { resolveAccounts: fakeResolve },
    )
    assert.deepEqual(plan.map(p => p.accountId), ['a1', 'a2'])
})

test('unresolved account is dropped (Marce multi-account guard preserved)', async () => {
    const onlyMain = async () => new Map([['a1', RESOLVED.get('a1')]])
    const plan = await buildOrderPlan(envelope(), { resolveAccounts: onlyMain })
    assert.deepEqual(plan.map(p => p.accountId), ['a1'])
})

test('empty accounts → empty plan', async () => {
    const plan = await buildOrderPlan(
        envelope({ execution: { accounts: [], mainAccountId: null } }),
        { resolveAccounts: fakeResolve },
    )
    assert.deepEqual(plan, [])
})

test('resolver throwing → empty plan (fail-safe, no partial orders)', async () => {
    const boom = async () => { throw new Error('broker down') }
    const plan = await buildOrderPlan(envelope(), { resolveAccounts: boom })
    assert.deepEqual(plan, [])
})

test('idea-shim path (ideaToEnvelope) plans identically to a hand-built envelope', async () => {
    const idea = { id: 'i1', userId: 'u1', asset: 'X', accounts: ['a1', 'a2'], mainAccountId: 'a1', quantity: 100 }
    const viaIdea = await buildOrderPlan(ideaToEnvelope(idea), { resolveAccounts: fakeResolve })
    const viaEnv  = await buildOrderPlan(envelope(),           { resolveAccounts: fakeResolve })
    assert.deepEqual(viaIdea, viaEnv)
})
