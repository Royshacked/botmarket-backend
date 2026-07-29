import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveMode, resolveBroker, resolveAccountIds, knownVenue } from '../../services/venue.resolve.service.js'

// The venue chain — mode → broker → accounts — is the answer to "is this real money?", so it is
// the highest-consequence shared resolver in the app. It replaced five divergent copies that did
// NOT agree; these tests pin the behaviour they disagreed about.

// ─── resolveMode: the workspace question ──────────────────────────────────────

test('the stamped broker is authoritative when present', () => {
    assert.equal(resolveMode({ broker: 'paper' }), 'paper')
    assert.equal(resolveMode({ broker: 'manual' }), 'manual')
    assert.equal(resolveMode({ broker: 'ctrader' }), 'live')
    assert.equal(resolveMode({ broker: 'ibkr' }), 'live')
})

test('REGRESSION: a legacy doc with NO broker resolves by its account prefix', () => {
    // This is the bug the consolidation fixed. tradeCapture used a broker-only deriver, so a
    // legacy paper fill (written before the `broker` field existed) was stamped `live` on the
    // canonical trades ledger — mixing simulated fills into the real-money track record.
    assert.equal(resolveMode({ broker: null, accountId: 'paper-u1-abc' }), 'paper')
    assert.equal(resolveMode({ accountId: 'manual-u1-abc' }), 'manual')
    assert.equal(resolveMode({ broker: undefined, mainAccountId: 'paper-u1' }), 'paper')
})

test('the prefix is searched across every account shape the codebase stores', () => {
    assert.equal(resolveMode({ accounts: ['paper-u1'] }), 'paper')
    assert.equal(resolveMode({ accounts: [{ id: 'manual-u1' }] }), 'manual')
    assert.equal(resolveMode({ accounts: [{ accountId: 'paper-u1' }] }), 'paper')
})

test('an unknown venue defaults to LIVE — the safe direction', () => {
    // Over-warning is harmless; labelling real money as simulated is not.
    assert.equal(resolveMode({}), 'live')
    assert.equal(resolveMode(), 'live')
    assert.equal(resolveMode({ broker: 'nope', accountId: '12345678' }), 'live')
})

test('a real broker-account id is never mistaken for a virtual one', () => {
    assert.equal(resolveMode({ broker: 'ctrader', accountId: '12345678' }), 'live')
    // 'papertrade-…' must not match the 'paper-' prefix.
    assert.equal(resolveMode({ accountId: 'papertrade-9' }), 'live')
})

test('resolveMode never returns null — every trade lives somewhere', () => {
    for (const src of [{}, { broker: null }, { accounts: [] }, { accounts: [null] }, undefined]) {
        assert.ok(['live', 'paper', 'manual'].includes(resolveMode(src)), JSON.stringify(src))
    }
})

// ─── resolveBroker ────────────────────────────────────────────────────────────

test('the broker is only meaningful in the live workspace', () => {
    assert.equal(resolveBroker({ broker: 'ctrader' }), 'ctrader')
    // "paper" names a workspace, not a venue that fills orders.
    assert.equal(resolveBroker({ broker: 'paper' }), null)
    assert.equal(resolveBroker({ broker: 'manual' }), null)
    assert.equal(resolveBroker({ accountId: 'paper-u1' }), null)
})

// ─── resolveAccountIds ────────────────────────────────────────────────────────

test('accounts come back main-first, coerced to strings', () => {
    assert.deepEqual(
        resolveAccountIds({ mainAccountId: 'a1', accounts: [{ id: 'a2' }, 'a3'] }),
        ['a1', 'a2', 'a3'],
    )
    assert.deepEqual(resolveAccountIds({ accounts: [123] }), ['123'])
})

test('empty and malformed account entries are dropped, not stringified', () => {
    // String(null) === 'null' would silently become a lookup key that matches nothing.
    assert.deepEqual(resolveAccountIds({ accounts: [null, undefined, '', { }] }), [])
    assert.deepEqual(resolveAccountIds({}), [])
    assert.deepEqual(resolveAccountIds(), [])
})

// ─── knownVenue: the VALIDITY question ────────────────────────────────────────

test('knownVenue refuses to guess — that is what makes it different from resolveMode', () => {
    assert.equal(knownVenue('ctrader'), 'live')
    assert.equal(knownVenue('paper'), 'paper')
    assert.equal(knownVenue('manual'), 'manual')
    // Kairos gates execution binding on this null; resolveMode would have said 'live'.
    assert.equal(knownVenue('nope'), null)
    assert.equal(knownVenue(undefined), null)
    assert.equal(knownVenue(null), null)
})

test('the two questions genuinely differ for an unsupported broker', () => {
    assert.equal(knownVenue('robinhood'), null)     // "I cannot bind execution here"
    assert.equal(resolveMode({ broker: 'robinhood' }), 'live')   // "…but it is real money"
})

// ─── SHARED CASE TABLE — keep in lockstep with the frontend ───────────────────
//
// The frontend derives the workspace too, as a fallback for documents saved before `mode` was
// stamped. Neither repo can import the other, so this table is the seam: the SAME cases are
// asserted in botmarket-frontend/src/cmps/TradeIdeas/tradeIdea.workspace.test.js. Change the rule
// on one side and the other fails loudly.
//
// It exists only for the transition. Once a backfill migration stamps `mode` on the old docs, the
// frontend fallback is deleted and this table goes with it.
const CASES = [
    // [ description,                          input,                                        expected ]
    ['stamped mode wins outright',             { mode: 'paper', broker: 'ctrader' },          'paper'],
    ['stamped live is honoured',               { mode: 'live', mainAccountId: 'paper-u1' },   'live'],
    ['broker paper',                           { broker: 'paper' },                           'paper'],
    ['broker manual',                          { broker: 'manual' },                          'manual'],
    ['broker ctrader',                         { broker: 'ctrader' },                         'live'],
    ['broker ibkr',                            { broker: 'ibkr' },                            'live'],
    ['legacy: no broker, paper account',       { accountId: 'paper-u1-abc' },                 'paper'],
    ['legacy: no broker, manual account',      { accountId: 'manual-u1-abc' },                'manual'],
    ['legacy: paper mainAccountId',            { mainAccountId: 'paper-u1' },                 'paper'],
    ['legacy: paper in accounts[]',            { accounts: ['paper-u1'] },                    'paper'],
    ['legacy: manual as { id } object',        { accounts: [{ id: 'manual-u1' }] },           'manual'],
    ['real broker account is not virtual',     { broker: 'ctrader', accountId: '12345678' },  'live'],
    ['"papertrade-" must not match "paper-"',  { accountId: 'papertrade-9' },                 'live'],
    ['unknown venue defaults to live',         { broker: 'nope', accountId: '12345678' },     'live'],
    ['empty object',                           {},                                            'live'],
]

test('workspace mode matches the frontend case-for-case', () => {
    for (const [what, input, expected] of CASES) {
        assert.equal(resolveMode(input), expected, what)
    }
})

test('a garbage stamped mode is not trusted — it falls through to derivation', () => {
    // Mirrors the frontend guard: only a known workspace short-circuits.
    assert.equal(resolveMode({ mode: 'sandbox', broker: 'paper' }), 'paper')
    assert.equal(resolveMode({ mode: '', accountId: 'manual-u1' }), 'manual')
})
