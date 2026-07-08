import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _deriveMode, _firstAccountId, _accountLabel } from '../../api/portfolio/portfolioChat.service.js'

// The portfolio_review notification carries the workspace mode (live/paper/manual) and a
// friendly account label so the user knows WHICH book Atlas wants reviewed. These pure
// derivers mirror the frontend ideaWorkspace() logic; keep the two in sync.

test('_firstAccountId: bare-string, {id}-object, and empty accounts', () => {
    assert.equal(_firstAccountId(['paper-u1-abc']),        'paper-u1-abc')
    assert.equal(_firstAccountId([{ id: 'manual-u1-xy' }]), 'manual-u1-xy')
    assert.equal(_firstAccountId([]),   null)
    assert.equal(_firstAccountId(null), null)
    assert.equal(_firstAccountId(undefined), null)
})

test('_deriveMode: broker field is primary', () => {
    assert.equal(_deriveMode('paper',  '12345678'), 'paper')
    assert.equal(_deriveMode('manual', '12345678'), 'manual')
    assert.equal(_deriveMode('ctrader', '12345678'), 'live')
    assert.equal(_deriveMode('ibkr',    '12345678'), 'live')
})

test('_deriveMode: virtual-account prefix is the legacy fallback when broker is absent', () => {
    assert.equal(_deriveMode(null, 'paper-u1-abc'),  'paper')
    assert.equal(_deriveMode(null, 'manual-u1-abc'), 'manual')
    assert.equal(_deriveMode(undefined, '12345678'), 'live')
    assert.equal(_deriveMode(undefined, null),       'live')
})

test('_accountLabel: virtual accounts show the resolved user name', () => {
    const names = { 'paper-u1-abc': 'Swing Book', 'manual-u1-xy': 'IBKR Manual' }
    assert.equal(_accountLabel('paper',  'paper-u1-abc',  names), 'Swing Book')
    assert.equal(_accountLabel('manual', 'manual-u1-xy',  names), 'IBKR Manual')
})

test('_accountLabel: virtual account with no resolved name falls back to the mode word', () => {
    assert.equal(_accountLabel('paper',  'paper-u1-zzz', {}), 'Paper')
    assert.equal(_accountLabel('manual', 'manual-u1-zz', {}), 'Manual')
})

test('_accountLabel: live account shows "<Broker> #<login>"', () => {
    assert.equal(_accountLabel('live', '12345678', {}, 'ctrader'), 'cTrader #12345678')
    assert.equal(_accountLabel('live', '87654321', {}, 'ibkr'),    'IBKR #87654321')
})

test('_accountLabel: live with unknown/absent broker still shows an id', () => {
    assert.equal(_accountLabel('live', '12345678', {}, 'somebroker'), 'somebroker #12345678')
    assert.equal(_accountLabel('live', '12345678', {}, null),         'Live #12345678')
})

test('_accountLabel: missing account id falls back to the mode word', () => {
    assert.equal(_accountLabel('paper',  null, {}), 'Paper')
    assert.equal(_accountLabel('manual', null, {}), 'Manual')
    assert.equal(_accountLabel('live',   null, {}, 'ctrader'), 'Live account')
})
