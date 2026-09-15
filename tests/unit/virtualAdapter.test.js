import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PaperAdapter }  from '../../api/broker/adapters/paper.adapter.js'
import { ManualAdapter } from '../../api/broker/adapters/manual.adapter.js'
import { VirtualAdapter } from '../../api/broker/adapters/virtual.adapter.js'
import { paperBrokerService } from '../../api/broker/paperBroker.service.js'

// Paper and manual share one virtual store and one set of READS (VirtualAdapter), scoped by
// `brokerType`; each keeps its own trading half. This pins what the split promised: the reads
// see only their own mode, a read never creates an account, and manual no longer inherits paper's
// answers to questions that are only true of paper.

const paper  = new PaperAdapter()
const manual = new ManualAdapter()

const real = {
    listAccounts: paperBrokerService.listAccounts, getAccount: paperBrokerService.getAccount, isEnabled: paperBrokerService.isEnabled,
    listPositions: paperBrokerService.listPositions, createAccount: paperBrokerService.createAccount,
    getOrCreateDefaultAccount: paperBrokerService.getOrCreateDefaultAccount,
}
afterEach(() => Object.assign(paperBrokerService, real))

const ACCTS = [
    { accountId: 'paper-u1-aaaa',  mode: 'paper',  name: 'Swing',  currency: 'USD', cashBalance: 1000, settings: { maxLeverage: 0 } },
    { accountId: 'manual-u1-bbbb', mode: 'manual', name: 'Bank',   currency: 'EUR', cashBalance: 500,  settings: { maxLeverage: 0 } },
]
function stubStore({ accounts = ACCTS, positions = [] } = {}) {
    const created = []
    paperBrokerService.listAccounts  = async (userId, { mode } = {}) => accounts.filter(a => !mode || a.mode === mode)
    paperBrokerService.getAccount    = async (userId, id) => accounts.find(a => a.accountId === String(id)) ?? null
    paperBrokerService.isEnabled     = async () => accounts.some(a => a.mode === 'paper' && a.enabled)
    paperBrokerService.listPositions = async (userId, { status, accountId } = {}) =>
        positions.filter(p => (!status || p.status === status) && (!accountId || p.accountId === String(accountId)))
    paperBrokerService.createAccount = async (...a) => { created.push(a); return ACCTS[0] }
    paperBrokerService.getOrCreateDefaultAccount = async (...a) => { created.push(a); return ACCTS[0] }
    return created
}

test('both venues are one VirtualAdapter; neither is the other', () => {
    assert.ok(paper instanceof VirtualAdapter)
    assert.ok(manual instanceof VirtualAdapter)
    assert.ok(!(manual instanceof PaperAdapter), 'manual is not a kind of paper')
})

test('getTradingAccounts sees only its own mode — and labels by venue', async () => {
    stubStore()
    const p = await paper.getTradingAccounts('u1')
    const m = await manual.getTradingAccounts('u1')
    assert.deepEqual(p.map(a => a.id), ['paper-u1-aaaa'])
    assert.deepEqual(m.map(a => a.id), ['manual-u1-bbbb'])
    assert.equal(p[0].broker, 'Paper')
    assert.equal(m[0].broker, 'Manual')
    assert.equal(m[0].currency, 'EUR', 'each account reports its own currency')
})

test('a read never creates an account: no accounts → empty list / 404, not a fresh default', async () => {
    const created = stubStore({ accounts: [] })
    assert.deepEqual(await paper.getTradingAccounts('u1'), [])
    assert.equal(await paper.isConnected('u1'), false)
    await assert.rejects(() => paper.getAccount('u1'), err => err.status === 404)
    await assert.rejects(() => manual.getAccount('u1'), err => err.status === 404)
    assert.equal(created.length, 0, 'nothing was minted by a read')
})

test('getPositions with no accountId is scoped to the venue; with one it is scoped to the account', async () => {
    const positions = [
        { positionId: 'p1', accountId: 'paper-u1-aaaa',  symbol: 'AAPL', direction: 'long', qty: 1, avgPrice: 100, currentPrice: 110, markedAt: Date.now(), status: 'open' },
        { positionId: 'm1', accountId: 'manual-u1-bbbb', symbol: 'MSFT', direction: 'long', qty: 1, avgPrice: 100, currentPrice: 105, markedAt: Date.now(), status: 'open' },
    ]
    stubStore({ positions })
    assert.deepEqual((await paper.getPositions('u1')).map(p => p.id),  ['p1'])
    assert.deepEqual((await manual.getPositions('u1')).map(p => p.id), ['m1'])
    assert.deepEqual((await paper.getPositions('u1', 'manual-u1-bbbb')).map(p => p.id), ['m1'], 'a named account wins over the mode filter')
    const m = (await manual.getPositions('u1'))[0]
    assert.equal(m.accountName, 'Bank')
    assert.equal(m.currency, 'EUR')
})

test('the leverage readout is paper\'s alone', async () => {
    const positions = [{ positionId: 'p1', accountId: 'paper-u1-aaaa', symbol: 'AAPL', direction: 'long', qty: 2, avgPrice: 100, currentPrice: 110, markedAt: Date.now(), status: 'open' }]
    stubStore({ positions })
    const p = await paper.getAccount('u1', 'paper-u1-aaaa')
    assert.equal(p.marginLevel, 510, '(equity 1020 / marginUsed 200) × 100 — paper reports it against exposure')
    assert.equal(p.leverage, null, 'cap off → null')
    const m = await manual.getAccount('u1', 'manual-u1-bbbb')
    assert.equal(m.marginLevel, null)
    assert.equal(m.leverage, null)
    assert.equal(m.broker, 'Manual')
})

// `connections.paper` is what resolveWorkspace keys on, and it means paper MODE — the toggle —
// not "owns a paper account". Manual has no toggle: owning an account is the connection.
test('paper is connected by the toggle; manual by owning an account', async () => {
    stubStore({ accounts: [{ ...ACCTS[0], enabled: false }, ACCTS[1]] })
    assert.equal(await paper.isConnected('u1'),  false, 'a paper account with the mode OFF is not "connected"')
    assert.equal(await manual.isConnected('u1'), true)
    stubStore({ accounts: [{ ...ACCTS[0], enabled: true }] })
    assert.equal(await paper.isConnected('u1'),  true)
    assert.equal(await manual.isConnected('u1'), false)
})

test('only paper has an execution feed — manual used to inherit paper\'s "true"', async () => {
    assert.equal(await paper.startExecutionFeed('u1', 'paper-u1-aaaa'), true)
    assert.equal(await manual.startExecutionFeed('u1', 'manual-u1-bbbb'), false)
})

test('manual guards every trading op; the shared reads still answer', async () => {
    stubStore()
    for (const op of ['placeOrder', 'closePosition', 'cancelOrder', 'amendOrder', 'setProtection']) {
        await assert.rejects(() => manual[op]('u1', 'manual-u1-bbbb', {}), /manual mode/, op)
    }
    assert.deepEqual(await manual.listOrders('u1', 'manual-u1-bbbb'), [])
    assert.deepEqual(await manual.resolveSymbol('u1', 'manual-u1-bbbb', 'NQ'), { symbol: 'NQ', found: true })
    assert.equal(manual.capabilities().selfExecuted, true)
    assert.equal(paper.capabilities().selfExecuted, false)
})

// A stray maxLeverage on a MANUAL account (the settings PATCH is mode-agnostic) must not become
// leveraged free cash on the account list while the summary says "no leverage".
test('leveraged buying power is paper\'s alone on the account list too', async () => {
    stubStore({ accounts: [{ ...ACCTS[0], settings: { maxLeverage: 4 } }, { ...ACCTS[1], settings: { maxLeverage: 4 } }] })
    assert.equal((await paper.getTradingAccounts('u1'))[0].freeMargin,  4000, 'cash 1000 × 4')
    assert.equal((await manual.getTradingAccounts('u1'))[0].freeMargin, 500,  'cash, no cap — whatever settings say')
})
