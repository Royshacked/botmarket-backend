import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveWorkspace, isValidWorkspace, WORKSPACES } from '../../api/workspace/workspace.model.js'
import { activeWorkspace } from '../../services/venue.resolve.service.js'
import { getTradingContext } from '../../services/tradingContext.service.js'
import { formatVenueSection, formatTradingContext, _WORKSPACE_LINE } from '../../services/tools/tradingContext.tools.js'

// THE BUG THIS FILE EXISTS FOR
// There are THREE workspaces — live, paper and manual — and the server only ever knew two.
//
// Paper and live never needed a record: paper being connected IS the switch, so the server derived
// the workspace from the broker connections. Manual is broker-LESS by definition (real money at an
// institution the app cannot reach), so it has no flag to derive itself from, and the frontend kept
// the choice in localStorage. Every server-side read therefore saw a user sitting in MANUAL as
// sitting in LIVE.
//
// Survivable while the workspace only scoped a UI list. Not survivable once the venue block started
// telling every desk, every turn, which book "my account" means — a manual user asking what they are
// risking would be answered about a live broker account they do not trade through, and a desk would
// describe orders being PLACED that the app cannot place at all.

// ─── the rule ─────────────────────────────────────────────────────────────────

test('manual is a workspace in its own right', () => {
    assert.deepEqual(WORKSPACES, ['live', 'paper', 'manual'])
    assert.ok(isValidWorkspace('manual'))
})

test('a stored manual choice resolves to manual, not to live', () => {
    assert.equal(resolveWorkspace(false, 'manual'), 'manual')
})

test('the paper flag outranks anything stored', () => {
    // The paper toggle is a real server-side flag the profile screen can flip on its own, so it wins
    // over a remembered choice that may predate it. Identical to the frontend's resolveWorkspace —
    // if these two disagree the user sees one workspace while the desks discuss another.
    assert.equal(resolveWorkspace(true, 'manual'), 'paper')
    assert.equal(resolveWorkspace(true, null), 'paper')
})

test('no stored choice is live, exactly as before the record existed', () => {
    assert.equal(resolveWorkspace(false, null), 'live')
    assert.equal(resolveWorkspace(false, 'live'), 'live')
})

test('activeWorkspace with no stored value degrades to the old two-way answer', () => {
    // Every caller that has not been taught to pass the choice keeps working, and keeps being right
    // about paper — the failure mode is losing the manual distinction, never inventing a wrong one.
    assert.equal(activeWorkspace({ paper: true }), 'paper')
    assert.equal(activeWorkspace({ ctrader: true }), 'live')
    assert.equal(activeWorkspace({ manual: true }, 'manual'), 'manual')
})

// ─── the read ─────────────────────────────────────────────────────────────────

const fakeBroker = (connections, accounts = {}) => ({
    listConnections: async () => connections,
    getTradingAccounts: async (b) => ({ accounts: accounts[b] ?? [], selectedAccountId: null }),
    getPositions: async () => [],
    capabilities: () => ({ trading: false }),
})

test('the venue read reports manual as the workspace the user is in', async () => {
    const ctx = await getTradingContext('u1', {
        broker: fakeBroker({ paper: false, manual: true, ctrader: true },
            { manual: [{ id: 'ma_1', name: 'Bank', currency: 'USD', balance: 40000, freeMargin: 25000 }] }),
        storedWorkspace: async () => 'manual',
    })
    assert.equal(ctx.workspace, 'manual')
})

test('without the stored read the same user still reads as live — the old bug, pinned', async () => {
    // Kept as a test rather than deleted: it is what every caller that does not pass the choice sees,
    // and it documents exactly what the record buys.
    const ctx = await getTradingContext('u1', {
        broker: fakeBroker({ paper: false, manual: true, ctrader: true }),
        storedWorkspace: async () => null,
    })
    assert.equal(ctx.workspace, 'live')
})

test('a failed workspace read costs the manual distinction, never the turn', async () => {
    const ctx = await getTradingContext('u1', {
        broker: fakeBroker({ paper: true }),
        storedWorkspace: async () => { throw new Error('mongo down') },
    })
    // The whole read gives up and returns the empty shape rather than throwing at the caller.
    assert.equal(typeof ctx.workspace, 'string')
    assert.deepEqual(ctx.accounts, [])
})

// ─── what the desks are told ──────────────────────────────────────────────────

const manualCtx = {
    modes: { paper: false, manual: true, live_brokers: ['ctrader'] },
    workspace: 'manual',
    accounts: [
        { id: 'ma_1', broker: 'manual', mode: 'manual', name: 'Bank', balance: 40000, freeMargin: 25000, currency: 'USD', positions: [] },
        { id: '437', broker: 'ctrader', mode: 'live', name: 'cTrader', balance: 9000, freeMargin: 9000, currency: 'USD', selected: true, positions: [] },
    ],
    unavailable: [],
}

test('manual is named as its own workspace, never folded into live', () => {
    const out = formatVenueSection(manualCtx)
    assert.match(out, /CURRENT WORKSPACE: MANUAL/)
    assert.doesNotMatch(out, /CURRENT WORKSPACE: LIVE/)
})

test('manual carries all three of the things that make it manual', () => {
    // They pull in different directions, which is why one sentence has to hold them together:
    //   1. the money is REAL — softening the risk would be wrong;
    //   2. the app places NOTHING — implying it will fill an order would be false;
    //   3. it is otherwise paper's twin — same account, marks, monitoring and journal — so it must
    //      not read as some alien third thing the app barely participates in.
    const out = formatVenueSection(manualCtx)
    assert.match(out, /REAL money/)
    assert.match(out, /never say the app will place, fill or close an order/)
    assert.match(out, /BUILT AND MONITORED EXACTLY LIKE PAPER/)
    assert.match(out, /only EXECUTION differs/)
})

test('manual says the numbers are the user’s word, not a broker read', () => {
    // The one thing that separates manual from LIVE, as opposed to from paper. A manual book may
    // have been adopted whole from a bank, and nothing has verified it since the user stated it — so
    // a desk leaning on an exact balance has to know that is what it is leaning on.
    const out = formatVenueSection(manualCtx)
    assert.match(out, /USER'S OWN/)
    assert.match(out, /nothing has verified them since/)
})

test('the live account is stamped as out of scope while the user sits in manual', () => {
    const out = formatVenueSection(manualCtx)
    assert.match(out, /\[live · ctrader\] 437.*NOT the current workspace \(user is in manual\)/)
})

test('the block and the tool answer give the SAME workspace line', () => {
    // The tool used to hold its own two-way ternary, which is precisely how a third workspace could
    // be added to the app and rendered as live on this one surface.
    for (const w of WORKSPACES) {
        const ctx = { ...manualCtx, workspace: w }
        assert.ok(formatVenueSection(ctx).includes(_WORKSPACE_LINE[w]), `venue block, ${w}`)
        assert.ok(formatTradingContext(ctx).includes(_WORKSPACE_LINE[w]), `tool answer, ${w}`)
    }
})

test('an unknown workspace falls back to the live framing, not to silence', () => {
    // Real money is the safe direction to be wrong in: it can only over-warn.
    const out = formatVenueSection({ ...manualCtx, workspace: 'nonsense' })
    assert.match(out, /CURRENT WORKSPACE: LIVE/)
})
