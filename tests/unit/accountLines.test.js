import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAccountLines, resolveMainAccountId } from '../../services/agentUtils.js'

// buildAccountLines renders the marked trading accounts (shared by the Idea, Kairos + Atlas
// agents). `mainAccountId` tags which account the trade binds to as MAIN — mirroring
// resolveMainAccountId (explicit main, else first) so the prompt matches what save resolves.

const A = { id: 'a', broker: 'ctrader', isLive: true,  login: '111', currency: 'USD', balance: 10000, equity: 10500 }
const B = { id: 'b', broker: 'paper',   isLive: false, login: '222', currency: 'USD', balance: 5000 }
const C = { id: 'c', broker: 'ctrader', isLive: false, login: '333', currency: 'EUR' }

test('resolveMainAccountId: explicit marked main wins', () => {
    assert.equal(resolveMainAccountId([A, B, C], 'b'), 'b')
})

test('resolveMainAccountId: falls back to first when unmarked or main not in list', () => {
    assert.equal(resolveMainAccountId([A, B, C], null),      'a')
    assert.equal(resolveMainAccountId([A, B, C], 'missing'), 'a')
})

test('resolveMainAccountId: numeric ids compared as strings', () => {
    assert.equal(resolveMainAccountId([{ id: 1 }, { id: 2 }], 2), '2')
})

test('resolveMainAccountId: empty / id-less list yields null', () => {
    assert.equal(resolveMainAccountId([], 'a'),          null)
    assert.equal(resolveMainAccountId(null, 'a'),        null)
    assert.equal(resolveMainAccountId([{ foo: 1 }], 'a'), null)
})

test('single account: never tagged (unambiguous)', () => {
    const lines = buildAccountLines([A], 'a')
    assert.equal(lines.length, 1)
    assert.ok(!lines[0].includes('MAIN'), 'a lone account should not carry the MAIN tag')
})

test('multiple accounts: the explicit main is tagged, others are not', () => {
    const lines = buildAccountLines([A, B, C], 'b')
    assert.ok(!lines[0].includes('← MAIN'))
    assert.ok(lines[1].includes('← MAIN'), 'the marked main (b) should be tagged')
    assert.ok(!lines[2].includes('← MAIN'))
})

test('multiple accounts, no explicit main: first is tagged (matches save fallback)', () => {
    const lines = buildAccountLines([A, B, C], null)
    assert.ok(lines[0].includes('← MAIN'))
    assert.ok(!lines[1].includes('← MAIN'))
})

test('renders broker, LIVE/DEMO, login, currency, and money fields', () => {
    const [line] = buildAccountLines([A])
    assert.ok(line.includes('CTRADER LIVE'))
    assert.ok(line.includes('login: 111'))
    assert.ok(line.includes('currency: USD'))
    assert.ok(line.includes('balance: $10,000'))
    assert.ok(line.includes('equity: $10,500'))
})

test('DEMO flag + missing money fields render without crashing', () => {
    const [line] = buildAccountLines([C])
    assert.ok(line.includes('CTRADER DEMO'))
    assert.ok(!line.includes('balance:'))
})

test('id-less accounts render but are never tagged', () => {
    const lines = buildAccountLines([{ broker: 'paper', login: '1' }, { broker: 'paper', login: '2' }], null)
    assert.ok(lines.every(l => !l.includes('MAIN')))
})
