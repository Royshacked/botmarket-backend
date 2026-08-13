import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTradingContext } from '../../services/tradingContext.service.js'

// THE BUG THIS FILE EXISTS FOR
// "How much free cash do I have?" was unanswerable in paper and manual — the two modes most users
// are actually sitting in — and nothing failed to say so.
//
// The live branch read accounts through `brokerService.getTradingAccounts`, which goes through the
// adapter. The virtual branch reached PAST the adapter into `paperBrokerService.listAccounts`, which
// returns the raw account DOCUMENTS. A virtual account document has no `freeMargin` field at all:
// cash is never debited when a virtual position opens, so deployable cash is cash MINUS what open
// positions already committed, and only the adapter derives it. Reading the store directly meant the
// field was always null, the renderer had nothing to render, and every desk silently fell back to
// `balance` — the number that already contains the open positions. Sizing on it spends the same
// money twice.
//
// So the contract here is one accessor for every venue: paper and manual go through the same call as
// live, and free cash survives the trip.

const fakeBroker = ({ connections, accounts = {}, positions = {} } = {}) => ({
    listConnections: async () => connections,
    getTradingAccounts: async (broker) => ({ accounts: accounts[broker] ?? [], selectedAccountId: null }),
    getPositions: async (broker) => positions[broker] ?? [],
    capabilities: () => ({ trading: true }),
})

test('a paper account reports what is actually deployable, not just its balance', async () => {
    const svc = fakeBroker({
        connections: { paper: true, manual: false, ctrader: false },
        // The adapter shape: cash minus what the open position already committed.
        accounts: { paper: [{ id: 'pa_1', name: 'Paper', currency: 'USD', balance: 50000, freeMargin: 12000 }] },
    })
    const { accounts } = await getTradingContext('u1', { broker: svc })

    assert.equal(accounts.length, 1)
    assert.equal(accounts[0].balance, 50000)
    assert.equal(accounts[0].freeMargin, 12000, 'the whole point: it is NOT null in paper')
    assert.equal(accounts[0].mode, 'paper')
})

test('manual accounts come through the same door', async () => {
    const svc = fakeBroker({
        connections: { paper: false, manual: true, ctrader: false },
        accounts: { manual: [{ id: 'ma_1', name: 'Manual', currency: 'USD', balance: 8000, freeMargin: 3000 }] },
    })
    const { accounts, modes } = await getTradingContext('u1', { broker: svc })
    assert.equal(modes.manual, true)
    assert.equal(accounts[0].freeMargin, 3000)
})

test('virtual accounts are never marked SELECTED — they are picked per artifact', async () => {
    // A live venue has one account an order goes to today; a virtual one does not, and marking one
    // would tell a desk an order is already destined somewhere it is not.
    const svc = fakeBroker({
        connections: { paper: true },
        accounts: { paper: [{ id: 'pa_1', balance: 100, freeMargin: 100 }] },
    })
    const { accounts } = await getTradingContext('u1', { broker: svc })
    assert.equal(accounts[0].selected, false)
})

test('a broker whose account read fails drops out — it never blanks the others', async () => {
    const svc = {
        ...fakeBroker({
            connections: { paper: true, ctrader: true },
            accounts: { paper: [{ id: 'pa_1', balance: 100, freeMargin: 90 }] },
        }),
        getTradingAccounts: async (broker) => {
            if (broker === 'ctrader') throw new Error('RET_ACCOUNT_DISABLED')
            return { accounts: [{ id: 'pa_1', balance: 100, freeMargin: 90 }], selectedAccountId: null }
        },
    }
    const { accounts } = await getTradingContext('u1', { broker: svc })
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0].broker, 'paper')
})

test('a broker whose POSITION read fails is named, not rendered flat', async () => {
    // An empty book and an unanswered one are the same shape and opposite facts.
    const svc = {
        ...fakeBroker({ connections: { paper: true }, accounts: { paper: [{ id: 'pa_1', balance: 1, freeMargin: 1 }] } }),
        getPositions: async () => { throw new Error('socket closed') },
    }
    const { unavailable } = await getTradingContext('u1', { broker: svc })
    assert.deepEqual(unavailable, ['paper'])
})

test('no user, no reads at all', async () => {
    let touched = false
    const svc = { ...fakeBroker({ connections: {} }), listConnections: async () => { touched = true; return {} } }
    const out = await getTradingContext(null, { broker: svc })
    assert.equal(touched, false)
    assert.deepEqual(out.accounts, [])
})
