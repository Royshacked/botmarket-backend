import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _buildAdoptSection, _buildStagedBook, _buildUnreadableVenueSection } from '../../services/agents/portfolio.agent.service.js'
import { refreshDraft, partitionHoldings, _setDeps } from '../../api/portfolio/adoptBook.service.js'
import { reconcileAccount } from '../../services/bookValuation.util.js'

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

test('an unpriceable line is EXCLUDED, not carried as a holding', () => {
    // Superseded a "tracked, not marked" row: being in the book means being priced, weighted,
    // researched and reviewed, and a line we cannot price gets none of that — so carrying it would put
    // a number in the book that no gate can ever read.
    const s = _buildStagedBook({
        ...DRAFT,
        holdings: [],
        excluded: [{ symbol: 'BANKFUND', quantity: 10, avgCost: 1000, mark: null, reason: 'no_price' }],
        reconciliation: { problems: ['cash_not_derivable_unpriced'] },
    })
    assert.match(s, /NOT IN THE BOOK/)
    assert.match(s, /BANKFUND: we could not price it at all/)
    assert.ok(!/1 holding\(s\)/.test(s), 'it is not counted as a holding')
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

// ─── Exclusion: only a US-listed holding can be IN the book ──────────────────────
// Being in the book means being priced, weighted, researched and reviewed. None of that exists for a
// foreign listing, so it is excluded and NAMED — never carried as a row no gate can read, and never
// silently dropped either.

test('a foreign listing is excluded; an ADR is not', () => {
    const { included, excluded } = partitionHoldings([
        { symbol: 'AAPL',    mark: 200 },
        { symbol: 'NESN.SW', mark: 95 },    // priceable, still unmanageable
        { symbol: 'NSRGY',   mark: 105 },   // the US line for the same company
        { symbol: 'BRK.B',   mark: 410 },   // a share CLASS, not an exchange
    ])
    assert.deepEqual(included.map(h => h.symbol), ['AAPL', 'NSRGY', 'BRK.B'])
    assert.deepEqual(excluded.map(h => [h.symbol, h.reason]), [['NESN.SW', 'non_us_listing']])
})

test('an unpriceable line is excluded as a QUESTION, not a verdict', () => {
    // Most often a mis-typed ticker, which is why it carries its own reason.
    const { excluded } = partitionHoldings([{ symbol: 'BANKFUND', mark: null }])
    assert.deepEqual(excluded.map(h => h.reason), ['no_price'])
})

test('an excluded line stops cash being DERIVED from the stated total', () => {
    // The stated total covers the whole bank account including what we are not adopting, so
    // subtracting only the adopted market value would hand the excluded holding's value to "cash" —
    // the double-count error arriving from the other side.
    const r = reconcileAccount({
        holdings: [{ symbol: 'AAPL', quantity: 100, avgCost: 150, mark: 200 }],
        statedTotal: 100_000, excluded: 1,
    })
    assert.deepEqual(r.problems, ['cash_not_derivable_excluded'])
    assert.equal(r.startingBalance, null)

    // Stated cash needs no derivation, so the same book commits fine.
    const ok = reconcileAccount({
        holdings: [{ symbol: 'AAPL', quantity: 100, avgCost: 150, mark: 200 }],
        freeCash: 5_000, excluded: 1,
    })
    assert.deepEqual(ok.problems, [])
    assert.equal(ok.startingBalance, 20_000)
})

test('the staged book gives each exclusion its own sentence', () => {
    const s = _buildStagedBook({
        holdings: [{ symbol: 'AAPL', quantity: 100, avgCost: 150, mark: 200, direction: 'long', why: 'x' }],
        excluded: [
            { symbol: 'NESN.SW', reason: 'non_us_listing' },
            { symbol: 'BANKFUND', reason: 'no_price' },
        ],
        reconciliation: { problems: ['cash_not_derivable_excluded'] },
    })
    assert.match(s, /NOT IN THE BOOK/)
    assert.match(s, /NESN\.SW: listed outside the US/)
    assert.match(s, /Offer the US line \(an ADR\)/)
    assert.match(s, /BANKFUND: we could not price it at all — check the ticker/)
    assert.match(s, /the cash balance directly/)
})

test('the instruction tells Atlas to say it, and how the two reasons differ', () => {
    const s = _buildAdoptSection()
    assert.match(s, /Only a US-listed holding can be in it/)
    assert.match(s, /SAY SO PLAINLY/)
    assert.match(s, /an ADR, e\.g\. NSRGY/)
    assert.match(s, /MIS-TYPED TICKER/)
    assert.match(s, /ask for the CASH balance directly/)
})

// ─── The drift ritual: keyed on the VENUE, not on how the book arrived ───────────
//
// An adopted book behaves exactly like any other once it is set up — so nothing may special-case it
// for the life of the book. What drifts is a book at a venue we cannot READ: the user sells, buys,
// takes a dividend or receives a split at their bank and none of it reaches us. That is equally true
// of a manual book this desk built leg by leg, which an `adopted` gate would have missed entirely.

const MANUAL_BOOK = {
    workspace: { mode: 'manual' },
    ideas: [{ asset: 'AAPL', actualWeight: 0.5 }, { asset: 'MSFT', actualWeight: 0.5 }],
}

test('a review of a broker-less book opens by confirming it', () => {
    const s = _buildUnreadableVenueSection(MANUAL_BOOK)
    assert.match(s, /CANNOT READ — CONFIRM IT BEFORE YOU READ IT/)
    assert.match(s, /2 open holding\(s\) are recorded on the user's word/)
})

test('a manual book built HERE gets the ritual too — the venue is what drifts', () => {
    // The whole point of re-keying it: an `adopted` gate would have skipped this book, which has the
    // identical problem.
    assert.notEqual(_buildUnreadableVenueSection(MANUAL_BOOK), '')
})

test('paper and live books get nothing — we placed and watched those fills', () => {
    assert.equal(_buildUnreadableVenueSection({ ...MANUAL_BOOK, workspace: { mode: 'paper' } }), '')
    assert.equal(_buildUnreadableVenueSection({ ...MANUAL_BOOK, workspace: { mode: 'live' } }), '')
    assert.equal(_buildUnreadableVenueSection(null), '')
})

test('a book with nothing open yet has nothing to confirm', () => {
    assert.equal(_buildUnreadableVenueSection({ workspace: { mode: 'manual' }, ideas: [{ asset: 'AAPL' }] }), '')
})

test('the ritual says WHY, so it cannot be optimised away as a pleasantry', () => {
    const s = _buildUnreadableVenueSection(MANUAL_BOOK)
    assert.match(s, /rests on quantities nobody has checked/)
    assert.match(s, /a weight computed from it is fiction/)
    assert.match(s, /easy "yes, unchanged"/)
})

test('a dividend is named as cash, never as P&L', () => {
    assert.match(_buildUnreadableVenueSection(MANUAL_BOOK), /CASH movement, not a trade/)
})
