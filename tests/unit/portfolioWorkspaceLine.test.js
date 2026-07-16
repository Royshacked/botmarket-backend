import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatWorkspaceLine } from '../../api/portfolio/portfolioMode.util.js'

// formatWorkspaceLine renders the one-line "where this book trades" header injected into
// Atlas's position/P&L context so the agent knows the workspace mode + broker + account(s).

test('live book: shows LIVE + broker + single account', () => {
    const line = formatWorkspaceLine({
        mode: 'live', broker: 'ctrader', brokerLabel: 'cTrader',
        accounts: [{ id: '123', label: 'cTrader #123' }],
    })
    assert.equal(line, 'Workspace: LIVE · Broker: cTrader · Account: cTrader #123')
})

test('live book with more than one account pluralises "Accounts"', () => {
    const line = formatWorkspaceLine({
        mode: 'live', broker: 'ctrader', brokerLabel: 'cTrader',
        accounts: [{ id: '123', label: 'cTrader #123' }, { id: '456', label: 'cTrader #456' }],
    })
    assert.equal(line, 'Workspace: LIVE · Broker: cTrader · Accounts: cTrader #123, cTrader #456')
})

test('paper book: mode word, no broker, resolved account name', () => {
    const line = formatWorkspaceLine({
        mode: 'paper', broker: null, brokerLabel: null,
        accounts: [{ id: 'paper-u1-abc', label: 'Swing Book' }],
    })
    assert.equal(line, 'Workspace: PAPER · Account: Swing Book')
})

test('manual book renders its mode word', () => {
    const line = formatWorkspaceLine({
        mode: 'manual', broker: null, brokerLabel: null,
        accounts: [{ id: 'manual-u1-xy', label: 'IBKR Manual' }],
    })
    assert.equal(line, 'Workspace: MANUAL · Account: IBKR Manual')
})

test('no accounts falls back to an em dash', () => {
    assert.equal(
        formatWorkspaceLine({ mode: 'live', brokerLabel: 'IBKR', accounts: [] }),
        'Workspace: LIVE · Broker: IBKR · Account: —',
    )
})

test('missing brokerLabel on a live book shows an em dash', () => {
    assert.equal(
        formatWorkspaceLine({ mode: 'live', accounts: [{ id: '9', label: 'Live #9' }] }),
        'Workspace: LIVE · Broker: — · Account: Live #9',
    )
})

test('null workspace returns null (header line is simply omitted)', () => {
    assert.equal(formatWorkspaceLine(null), null)
})
