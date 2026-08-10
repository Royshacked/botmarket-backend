import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _buildAdoptSection, _buildStagedBook } from '../../services/agents/portfolio.agent.service.js'
import { refreshDraft, _setDeps } from '../../api/portfolio/adoptBook.service.js'

// Atlas's ADOPT mode (docs/design/adopted-book.md §3). Two halves, split by how volatile they are:
// the instruction is stable and rides the cached system tail; the staged book changes every time a row
// is corrected, so it rides the user turn instead.

// ─── The instruction ────────────────────────────────────────────────────────────

test('the instruction states the phase order and refuses to let it be merged', () => {
    const s = _buildAdoptSection()
    assert.match(s, /Do not reorder these and do not merge them/)
    // The order itself is the thing: holdings, mandate, reason, confirm.
    assert.ok(s.indexOf('THE HOLDINGS') < s.indexOf('THE MANDATE'))
    assert.ok(s.indexOf('THE MANDATE') < s.indexOf('THE REASON'))
    assert.ok(s.indexOf('THE REASON') < s.indexOf('CONFIRM'))
})

test('the anchoring rule is stated with its reason, not just as a rule', () => {
    // A rule with no reason gets optimised away by a model under pressure to be helpful.
    const s = _buildAdoptSection()
    assert.match(s, /ANCHORING RULE/)
    assert.match(s, /never justify a mandate with what is already held/)
    assert.match(s, /DESCRIPTION of the book instead of a yardstick/)
})

test('the model is told it does not read the numbers, and does not commit', () => {
    const s = _buildAdoptSection()
    assert.match(s, /YOU DO NOT READ THE NUMBERS/)
    assert.match(s, /You never commit anything/)
})

test('no verdicts before research — and the honest answer is named', () => {
    const s = _buildAdoptSection()
    assert.match(s, /No target weights, no conviction, no verdict/)
    assert.match(s, /cannot say yet/)
})

test('a user with no view gets a proposal, not a dead end', () => {
    // The most likely arrival for someone holding a bank book.
    assert.match(_buildAdoptSection(), /PROPOSE a mandate from the account size/)
})

// ─── The staged book ────────────────────────────────────────────────────────────

const DRAFT = {
    holdings: [
        { symbol: 'AAPL', quantity: 100, avgCost: 150.25, mark: 200, direction: 'long', why: 'compounder' },
        { symbol: 'MSFT', quantity: 50,  avgCost: 300,    mark: 400, direction: 'long', why: null },
    ],
    reconciliation: { costBasis: 30_025, marketValue: 40_000, freeCash: 10_000, unpriced: [], problems: [] },
    mandate: { objective: 'growth' },
    warnings: [],
}

test('every staged row is shown with what we actually hold for it', () => {
    const s = _buildStagedBook(DRAFT)
    assert.match(s, /AAPL: 100 @ 150\.25 — "compounder"/)
    assert.match(s, /MSFT: 50 @ 300/)
    assert.match(s, /Account \(USD\): cost basis 30025 · market value 40000 · cash 10000/)
})

test('what is STILL NEEDED is stated, so the model asks for the next thing', () => {
    const s = _buildStagedBook(DRAFT)
    assert.match(s, /STILL NEEDED: a reason for 1 name\(s\)/)
})

test('an unpriceable line is named as tracked, not dropped', () => {
    const s = _buildStagedBook({
        ...DRAFT,
        holdings: [{ symbol: 'BANKFUND', quantity: 10, avgCost: 1000, mark: null, direction: 'long', why: null }],
        reconciliation: { problems: ['cash_not_derivable_unpriced'] },
    })
    assert.match(s, /BANKFUND: 10 @ 1000 \(unpriceable — tracked, not marked\)/)
    assert.match(s, /UNRESOLVED/)
    assert.match(s, /the cash balance/, 'and it says what to ask for instead of the derivation')
})

test('a missing quantity is surfaced as a question about that row', () => {
    const s = _buildStagedBook({
        holdings: [{ symbol: 'TSLA', quantity: null, avgCost: 210, mark: 300, direction: 'long', why: null }],
        reconciliation: { problems: ['bad_quantity:TSLA'] },
    })
    assert.match(s, /TSLA: \? @ 210/)
    assert.match(s, /quantity for 1 row\(s\)/)
})

test('a foreign stated currency shows its rate, so the model can show its arithmetic', () => {
    const s = _buildStagedBook({ ...DRAFT, statedCurrency: 'ILS', fxToUsd: 0.27 })
    assert.match(s, /stated in ILS \(rate 0\.27 to USD\)/)
})

test('an assumed column is advisory, and reads differently from a problem', () => {
    const s = _buildStagedBook({ ...DRAFT, warnings: ['assumed_columns:AAPL'] })
    assert.match(s, /READ, BUT WORTH A LOOK/)
    assert.ok(!/UNRESOLVED/.test(s), 'a warning must not read as a blocker')
})

test('a complete book says so, rather than inventing an outstanding item', () => {
    const s = _buildStagedBook({
        ...DRAFT,
        holdings: DRAFT.holdings.map(h => ({ ...h, why: 'stated' })),
    })
    assert.match(s, /NOTHING OUTSTANDING/)
})

test('no draft means no block at all — the mode is invisible outside adoption', () => {
    assert.equal(_buildStagedBook(null), '')
})

// ─── Refresh: a paste mid-conversation lands on the SAME book ────────────────────

function stubs(draft, over = {}) {
    const calls = { patched: [] }
    const deps = {
        quotes: async (syms) => new Map(syms.map(s => [s, 100])),
        store: {
            getDraft:   async () => draft,
            patchDraft: async (_d, _u, patch) => { calls.patched.push(patch) },
        },
        ...over,
    }
    return { deps, calls }
}

test('a second paste MERGES into the staged book rather than replacing it', async () => {
    // Otherwise a user who pastes the rest of their book in a second message adopts two half-books.
    const { deps, calls } = stubs({ draftId: 'd1', status: 'draft', holdings: DRAFT.holdings, statedTotal: 50_000 })
    const restore = _setDeps(deps)
    try {
        const res = await refreshDraft({ draftId: 'd1', userId: 'u1', paste: 'NVDA 20 800' })
        assert.equal(res.ok, true)
        assert.deepEqual(calls.patched[0].holdings.map(h => h.symbol), ['AAPL', 'MSFT', 'NVDA'])
    } finally { restore() }
})

test('a correction overwrites one row and keeps the reason gathered later', async () => {
    const { deps, calls } = stubs({ draftId: 'd1', status: 'draft', holdings: DRAFT.holdings, statedTotal: 50_000 })
    const restore = _setDeps(deps)
    try {
        await refreshDraft({ draftId: 'd1', userId: 'u1', paste: 'AAPL 90 151' })
        const aapl = calls.patched[0].holdings.find(h => h.symbol === 'AAPL')
        assert.equal(aapl.quantity, 90)
        assert.equal(aapl.avgCost, 151)
        assert.equal(aapl.why, 'compounder', 'a re-pasted row must not wipe the reason')
    } finally { restore() }
})

test('ordinary conversation leaves the draft alone', async () => {
    const draft = { draftId: 'd1', status: 'draft', holdings: DRAFT.holdings }
    const { deps, calls } = stubs(draft)
    const restore = _setDeps(deps)
    try {
        const res = await refreshDraft({ draftId: 'd1', userId: 'u1', paste: 'I want to retire in about ten years' })
        assert.equal(res.ok, true)
        assert.equal(res.draft, draft)
        assert.equal(calls.patched.length, 0, 'no write for a turn that parsed to nothing')
    } finally { restore() }
})

test('a committed book is not a draft any more', async () => {
    const { deps } = stubs({ draftId: 'd1', status: 'committed', holdings: [] })
    const restore = _setDeps(deps)
    try {
        assert.equal((await refreshDraft({ draftId: 'd1', userId: 'u1', paste: 'AAPL 1 2' })).reason, 'already_committed')
    } finally { restore() }
})
