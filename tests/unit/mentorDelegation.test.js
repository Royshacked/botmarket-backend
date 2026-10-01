import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    emptyBuild, upsertName, activeName, applyBuildOps, sanitizeBuildOps, sanitizeUserOps, applyUserOps,
    stageOf, isWaived, heldAnswers, delegationPicks, normalizeSpans, normalizeEntries, buildComplete,
    resolveEntryTrades,
} from '../../services/mentorBuild.util.js'
import {
    mentorAgentService, emptyMentorState, SIZE_TOOL, _sizingReport, _buildGenerateSection,
    _buildLedgerSection, _buildPressSection,
} from '../../services/agents/mentor.agent.service.js'
import { normalizeSetup } from '../../services/setup.schema.js'
import { cashFit } from '../../services/mentorSummary.util.js'

// The three ways a Mentor build asked the same thing twice, replayed from Marce's builds on
// 2026-10-01 (prod `threads`, INTC + PACB):
//
//   1. "Decide and let me generate" — the entry gate handed back. Nothing in the ledger could record
//      it, so the entries stayed open and the size he gave next was REFUSED for being out of order.
//   2. The size refused, so Mentor asked for it again.
//   3. "Confirm this summary, then it will be ready" — while the Generate button was already lit.

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SPANS = { candidates: [
    { id: 't1', label: 'breakout-base pullback', from: 'the 2.15 base', to: 'the 2.46 high', from_price: 2.2, to_price: 2.46 },
] }
const ENTRIES = { trades: [{ id: 't1', semantics: 'alternatives', options: [
    { id: 't1e1', label: 'limit pullback', trigger: 'buy at 2.20 on the retest', timeframe: '30min', recommended: true },
    { id: 't1e2', label: 'reclaim trigger', trigger: 'a 30m close back above 2.25', timeframe: '30min' },
] }] }

/** A plan Generate accepts once it is sized — one scenario, priced, with a condition and a range answer. */
const PLAN = {
    asset: 'PACB', direction: 'long', type: 'day', trade_mode: 'discretionary', timeframe: '30min',
    entry_mode: 'limit',
    scenarios: [{
        id: 's1', name: 'breakout-base pullback',
        entry_legs:  [{ price: 2.2 }],
        stop_legs:   [{ price: 2.14 }],
        target_legs: [{ price: 2.46 }],
        validity: { lower: 2.14, upper: 2.4, approach: 2.46, timeframe: '30min', on_break: 'revise', on_away: 'pass' },
    }],
}

/** A ledger with the opening and spans settled — where PACB stood when the entries menu went up. */
function atEntries({ entriesShown = true } = {}) {
    let b = upsertName(emptyBuild(), 'PACB')
    b = applyBuildOps(b, { claim: { direction: 'long', horizon: 'day', lens: 'discretionary' }, settle: ['direction', 'horizon', 'lens'], source: 'user' }).build
    b = applyBuildOps(b, { claim: { spans: ['t1'] }, settle: ['spans'], source: 'user' }).build
    if (entriesShown) b = applyBuildOps(b, { derived: { entries: ['t1:t1e1', 't1:t1e2'] } }).build
    return b
}

const draftAt = (build) => ({
    ...normalizeSetup(PLAN), spans: normalizeSpans(SPANS), entries: normalizeEntries(ENTRIES, ['t1']), build,
})

const ACCOUNTS = [{ id: 'raz', balance: 22624.59, freeMargin: 22624.59 }]

const turn = (raw, chatState = emptyMentorState(), { accounts = ACCOUNTS, run = null } = {}) =>
    mentorAgentService.chatStream({
        messages: [{ role: 'user', content: 'hi' }], chatState, accounts,
        _run: run ?? (async () => raw),
    })

// ─── The ledger: handing a gate back ──────────────────────────────────────────

test('only a GATE can be handed back — the opening, sizing and summary stay the user\'s', () => {
    assert.deepEqual(sanitizeBuildOps({ delegate: 'entries' }), { delegate: ['entries'] })
    assert.deepEqual(sanitizeBuildOps({ delegate: ['spans', 'entries', 'spans'] }), { delegate: ['spans', 'entries'] })
    assert.equal(sanitizeBuildOps({ delegate: 'sizing' }), null)
    assert.equal(sanitizeBuildOps({ delegate: 'opening' }), null)
})

test('what a hand-back settles on is never taken off the wire', () => {
    // A client or a model asserting "the pick was X" would be settling for the user by assertion.
    assert.equal(sanitizeBuildOps({ picks: { entries: ['t1:t1e2'] } }), null)
    assert.equal(sanitizeUserOps([{ delegate: 'entries', picks: { entries: ['t1:t1e2'] } }])[0].picks, undefined)
})

test('Mentor\'s pick is the option it marked — one per trade — and every span it would build', () => {
    const spans = normalizeSpans({ candidates: [
        { id: 't1', label: 'a', from: 'x', to: 'y', recommended: true },
        { id: 't2', label: 'b', from: 'x', to: 'y' },
        { id: 't3', label: 'c', from: 'x', to: 'y', recommended: true },
    ] })
    const entries = normalizeEntries(ENTRIES, ['t1'])
    assert.deepEqual(delegationPicks({ spans, entries }), { spans: ['t1', 't3'], entries: ['t1:t1e1'] })

    // Nothing marked at the span gate → the whole table: everything Mentor left on it, it judged
    // worth building (the rest went to `discarded`).
    const unmarked = normalizeSpans({ candidates: [{ id: 't1', label: 'a', from: 'x', to: 'y' }, { id: 't2', label: 'b', from: 'x', to: 'y' }] })
    assert.deepEqual(delegationPicks({ spans: unmarked }).spans, ['t1', 't2'])
    assert.deepEqual(delegationPicks({}), {}, 'nothing on the table → no pick, and the gate stays open')
})

test('"you decide" at the entries gate settles it on Mentor\'s pick — the PACB loop, closed', () => {
    const { build, refused } = applyBuildOps(atEntries(), {
        delegate: ['entries'],
        picks: delegationPicks({ entries: normalizeEntries(ENTRIES, ['t1']) }),
    })
    assert.deepEqual(refused, [])
    assert.deepEqual(activeName(build).settled.entries, ['t1:t1e1'], 'the recommended way in, not the whole menu')
    assert.equal(stageOf(activeName(build)), 'sizing')
    assert.equal(isWaived(build, 'entries'), true)
    assert.equal(isWaived(build, 'spans'), false, 'handing back one gate hands back that gate only')
})

test('a hand-back never overrides a choice someone wrote out explicitly in the same turn', () => {
    const { build } = applyBuildOps(atEntries(), {
        delegate: ['entries'],
        claim: { entries: ['t1:t1e2'] },
        picks: { entries: ['t1:t1e1'] },
    })
    assert.deepEqual(activeName(build).settled.entries, ['t1:t1e2'])
})

test('a REOPENED gate is the user\'s again — the delegation does not survive it', () => {
    let { build } = applyBuildOps(atEntries(), { delegate: ['entries'], picks: { entries: ['t1:t1e1'] } })
    build = applyBuildOps(build, { unsettle: 'entries' }).build
    assert.equal(isWaived(build, 'entries'), false)
    assert.equal(stageOf(activeName(build)), 'entries')
})

test('the build-wide waiver settles a gate on Mentor\'s pick in the same turn it is shown', () => {
    let b = upsertName(emptyBuild(), 'PACB')
    b = applyBuildOps(b, { claim: { direction: 'long', horizon: 'day', lens: 'discretionary' }, settle: ['direction', 'horizon', 'lens'], source: 'user', waiver: true }).build
    // "Go all the way": the spans go up and settle without a stop — it used to need a `settle` the
    // model had to remember, which is the step these builds kept missing.
    const { build } = applyBuildOps(b, { derived: { spans: ['t1'] }, picks: { spans: ['t1'] } })
    assert.deepEqual(activeName(build).settled.spans, ['t1'])
})

test('Mentor narrowing its own menu replaces the menu; a user\'s claim is never displaced by it', () => {
    let b = atEntries()
    b = applyBuildOps(b, { derived: { entries: ['t1:t1e2'] } }).build
    assert.deepEqual(activeName(b).claimed.entries.value, ['t1:t1e2'], 'the newer content wins over Mentor\'s older one')

    b = applyBuildOps(b, { claim: { entries: ['t1:t1e1'] }, source: 'user' }).build
    b = applyBuildOps(b, { derived: { entries: ['t1:t1e2'] } }).build
    assert.deepEqual(activeName(b).claimed.entries.value, ['t1:t1e1'], 'what the user said stands')
})

// ─── The ledger: a size given early is HELD, not refused ──────────────────────

test('a size given while a gate is open is HELD — no refusal, and nothing to ask again', () => {
    const { build, refused } = applyBuildOps(atEntries(), {
        size: { unit: 'size_cash', value: 20000 }, settle: ['size'],
    })
    assert.deepEqual(refused, [], 'refused is what made Mentor ask for the size a second time')
    assert.deepEqual(heldAnswers(build, activeName(build)), ['size'])
    assert.equal(activeName(build).settled.size, undefined, 'still out of order — it waits its turn')
})

test('…and settles by itself the moment its turn comes, with nobody asking to', () => {
    let b = applyBuildOps(atEntries(), { size: { unit: 'size_cash', value: 20000 } }).build
    b = applyBuildOps(b, { claim: { entries: ['t1:t1e1'] }, settle: ['entries'], source: 'user' }).build
    assert.deepEqual(activeName(b).settled.size, { unit: 'size_cash', value: 20000 })
    assert.equal(stageOf(activeName(b)), 'summary')
})

test('the order a model lists its settles in does not matter', () => {
    let b = applyBuildOps(atEntries(), { claim: { entries: ['t1:t1e1'] }, source: 'user' }).build
    const { build, refused } = applyBuildOps(b, { size: { unit: 'risk_cash', value: 500 }, settle: ['size', 'entries'] })
    assert.deepEqual(refused, [])
    assert.ok(activeName(build).settled.entries && activeName(build).settled.size)
})

test('sizing settles on the USER\'s answer only — never on the worksheet\'s own share count', () => {
    let b = applyBuildOps(atEntries(), { claim: { entries: ['t1:t1e1'] }, settle: ['entries'], source: 'user' }).build
    // The worksheet carried 9090 shares; claimsFromDraft records that as Mentor's.
    const { build, refused } = applyBuildOps(b, { derived: { size: 9090 }, settle: ['size'] })
    assert.equal(activeName(build).settled.size, undefined)
    assert.match(refused[0].reason, /user's answer/)
})

test('the summary settles once its figures exist — there is no "yes" to wait for', () => {
    let b = applyBuildOps(atEntries(), { claim: { entries: ['t1:t1e1'] }, settle: ['entries'], source: 'user' }).build
    b = applyBuildOps(b, { size: { unit: 'risk_cash', value: 500 } }).build
    const { build } = applyBuildOps(b, { derived: { summary: { rr: 4.3, gain: 2363, loss: 545, estimated: false } } })
    assert.equal(stageOf(activeName(build)), null)
    assert.equal(buildComplete(build), true)
})

// ─── Through the desk: Marce's two builds, replayed ───────────────────────────

test('PACB in WORDS: "decide and let me generate" closes the gate, the held size, and the build', async () => {
    // Turn 12 of the real thread: entries open with a two-way menu, his $20K already given and held.
    const held = applyBuildOps(atEntries(), { size: { unit: 'size_cash', value: 20000 } }).build
    const out = await turn(
        'I\'ve chosen the resting limit pullback.\n<build>{"delegate":"entries"}</build>',
        { active_asset: 'PACB', draft: draftAt(held), coverage: [] },
    )
    const name = activeName(out.build)
    assert.deepEqual(name.settled.entries, ['t1:t1e1'], 'settled on the recommended way in')
    assert.deepEqual(name.settled.size, { unit: 'size_cash', value: 20000 }, 'the size he gave is not asked for again')
    assert.ok(name.settled.summary, 'and the summary settled on the figures from this very turn')
    assert.equal(stageOf(name), null)
    assert.equal(out.readiness.ready, true, 'Generate is lit, and the ledger agrees')
    assert.deepEqual(out.build.refused, [])
})

test('PACB by PRESS: "you pick" settles before the model reads a word, and it is told what it picked', async () => {
    let seen = null
    const out = await turn('', {
        active_asset: 'PACB', draft: draftAt(atEntries()), coverage: [],
        ops: [{ delegate: 'entries' }],
    }, { run: async ({ messages }) => { seen = JSON.stringify(messages); return 'Limit pullback it is.' } })

    assert.deepEqual(activeName(out.build).settled.entries, ['t1:t1e1'])
    assert.match(seen, /handed you the entries gate/)
    assert.match(seen, /server settled YOUR recommendation/)
    assert.match(seen, /Your job this turn is the NEXT stage — sizing/)
})

test('the press applies the pick to what the user was LOOKING AT, not a guess', () => {
    const r = applyUserOps(atEntries(), sanitizeUserOps([{ delegate: 'entries' }]), { entries: ['t1:t1e1'] })
    assert.deepEqual(r.delegated, ['entries'])
    assert.deepEqual(r.settled, ['entries'])
    assert.deepEqual(r.refused, [])
})

test('INTC: the sizing turn reads its figures in that turn, and the build finishes on it', async () => {
    // Opening, spans and entries settled; the user says "1K risk". The model calls the tool, reads
    // the result, and the stage — and the summary — close without another turn.
    let b = applyBuildOps(atEntries(), { claim: { entries: ['t1:t1e1'] }, settle: ['entries'], source: 'user' }).build
    let report = null
    const out = await turn('', { active_asset: 'PACB', draft: draftAt(b), coverage: [] }, {
        run: async ({ toolHandlers }) => {
            report = await toolHandlers[SIZE_TOOL]({ unit: 'risk_cash', value: 300 })
            return 'Sized at $300 of risk. Generate is lit.'
        },
    })
    assert.match(report, /Recorded as the USER's size/)
    assert.match(report, /5000 unit\(s\)/, 'the server\'s quantity: $300 / $0.06 per share')
    assert.match(report, /GENERATE: the button is now LIT/)

    const name = activeName(out.build)
    assert.deepEqual(name.settled.size, { unit: 'risk_cash', value: 300 })
    assert.ok(name.settled.summary)
    assert.equal(out.setup.scenarios[0].quantity, 5000)
    assert.equal(out.build.reads?.[SIZE_TOOL], undefined, 'an action, not a read — a changed size is never declined as "already fetched"')
})

test('the sizing tool refuses a size that is not the user\'s shape, and records nothing', async () => {
    let report = null
    const out = await turn('', { active_asset: 'PACB', draft: draftAt(atEntries()), coverage: [] }, {
        run: async ({ toolHandlers }) => { report = await toolHandlers[SIZE_TOOL]({ unit: 'lots', value: 3 }); return '' },
    })
    assert.match(report, /Not recorded/)
    assert.equal(activeName(out.build).claimed.size, undefined)
})

// ─── The money: does it fit ───────────────────────────────────────────────────

test('the $1,000 risk on PACB is a position the account cannot pay for — and the server says so', () => {
    // The real numbers: $1k at $0.06 a share is 16,666 shares, ~$36.7k, against $22,624 free.
    const report = _sizingReport(normalizeSetup(PLAN), { unit: 'risk_cash', value: 1000 }, { balance: 22624.59, hasAccount: true })
    assert.match(report, /DOES NOT FIT/)
    assert.match(report, /The most that fits is 10283 unit\(s\)/)
})

test('an account with NOTHING free fits nothing — zero is a balance, not an unknown', () => {
    const fit = cashFit({ notional: 5000 }, { entry: 2.2, stop: 2.14, balance: 0 })
    assert.equal(fit.available, 0)
    assert.equal(fit.maxQuantity, null, 'no "most that fits" to offer')
    const report = _sizingReport(normalizeSetup(PLAN), { unit: 'risk_cash', value: 300 }, { balance: 0, hasAccount: true })
    assert.match(report, /DOES NOT FIT: the position is \$11000 and the account has \$0 to deploy\. On a cash account/)
})

test('a position that fits says nothing about fitting', () => {
    assert.equal(cashFit({ notional: 20000 }, { entry: 2.2, stop: 2.14, balance: 22624.59 }), null)
    assert.equal(cashFit({ notional: 20000 }, { entry: 2.2, stop: 2.14, balance: null }), null, 'no balance → no judgment, not a guess')
})

test('the sizing tool with no plan on the table records the answer and says there is nothing to size yet', () => {
    const report = _sizingReport(null, { unit: 'risk_pct', value: 1 }, { balance: 50000, hasAccount: true })
    assert.match(report, /Recorded as the USER's size/)
    assert.match(report, /nothing to size/)
})

// ─── One answer to "is it ready?" ─────────────────────────────────────────────

test('when the button is lit the model is TOLD it is lit, so it cannot say otherwise', () => {
    const sized = { ...normalizeSetup(PLAN) }
    sized.scenarios[0].quantity = 5000
    sized.scenarios[0].entry_legs[0].quantity = 5000
    const text = _buildGenerateSection({ draft: sized }, true)
    assert.match(text, /GENERATE: the button is LIT/)
    assert.match(text, /never ask them to confirm anything first/)
})

test('while stages are still open, an unfinished plan is not recited as a list of gaps', () => {
    assert.equal(_buildGenerateSection({ draft: draftAt(atEntries()) }, true), '')
    assert.equal(_buildGenerateSection({ draft: draftAt(atEntries()) }, null), '', 'and nothing is claimed when the caller did not say')
})

test('a held size is shown as ANSWERED, never as a claim still to put to the user', () => {
    const held = applyBuildOps(atEntries(), { size: { unit: 'size_cash', value: 20000 } }).build
    const text = _buildLedgerSection({ draft: draftAt(held) })
    assert.match(text, /ANSWERED by the user and HELD/)
    assert.doesNotMatch(text, /CLAIMED but NOT settled[^\n]*size=/)
})

test('an open gate tells the model what to do when the choice is handed back', () => {
    const text = _buildLedgerSection({ draft: draftAt(atEntries()) })
    assert.match(text, /"delegate":"entries"/)
})

test('the sizing stage never tells the model to "settle it now" — it tells it to call the tool', () => {
    let b = applyBuildOps(atEntries(), { claim: { entries: ['t1:t1e1'] }, settle: ['entries'], source: 'user' }).build
    b = applyBuildOps(b, { derived: { size: 9090 } }).build
    const text = _buildLedgerSection({ draft: draftAt(b) })
    assert.match(text, /YOU ARE AT: sizing/)
    assert.match(text, new RegExp(`call ${SIZE_TOOL}`))
    assert.doesNotMatch(text, /"settle":\["size"\]/)
})

// ─── The entries gate came out EMPTY ──────────────────────────────────────────
// Live, the model keyed its ways in by SCENARIO id: `"id": "s1"` for span `t1`. Every trade was
// dropped as belonging to no span — no table to press, nothing for "you decide" to settle on.

const LIVE_ENTRIES = { trades: [{ id: 's1', semantics: 'alternatives', options: [
    { id: 's1e1', label: 'Resting retest limit', trigger: 'price reaches $1.84', timeframe: 'day', recommended: true },
    { id: 's1e2', label: 'Confirmed retest', trigger: 'a 4-hour close back above $1.84', timeframe: '4hr' },
] }] }

test('a trade keyed by scenario id is read as the span it numbers — the live emit, replayed', () => {
    const r = resolveEntryTrades(LIVE_ENTRIES, ['t1'])
    assert.deepEqual(r.remapped, [{ from: 's1', to: 't1' }])
    assert.deepEqual(r.unresolved, [])
    const out = normalizeEntries(r.entries, ['t1'])
    assert.equal(out.trades[0].id, 't1')
    assert.deepEqual(delegationPicks({ entries: out }).entries, ['t1:s1e1'], 'and there is a pick to settle on')
})

test('one scenario-keyed trade and one span left: it can only be that span', () => {
    // The spans gate narrowed to t2 alone; the model still wrote s1.
    const r = resolveEntryTrades(LIVE_ENTRIES, ['t2'])
    assert.equal(r.entries.trades[0].id, 't2')
})

test('a stranger that is NOT the scenario slip is never hung under another trade\'s label', () => {
    const r = resolveEntryTrades({ trades: [{ id: 't7', options: [] }] }, ['t1'])
    assert.deepEqual(r.unresolved, ['t7'])
    assert.equal(r.entries.trades[0].id, 't7', 'left as written, for normalizeEntries to drop')
})

test('two scenario-keyed trades map by number, never crosswise', () => {
    const r = resolveEntryTrades({ trades: [{ id: 's2', options: [] }, { id: 's1', options: [] }] }, ['t1', 't2'])
    assert.deepEqual(r.entries.trades.map(t => t.id), ['t2', 't1'])
})

test('a dropped way in is TOLD to the model by name, never left as a silently empty gate', async () => {
    const out = await turn(`<entries>${JSON.stringify({ trades: [{ id: 't7', options: LIVE_ENTRIES.trades[0].options }] })}</entries>`,
        { active_asset: 'PACB', draft: draftAt(atEntries({ entriesShown: false })), coverage: [] })
    const said = out.build.refused.find(r => r.field === 'entries')?.reason ?? ''
    assert.match(said, /"t7" name no trade on the table/)
    assert.match(said, /by its span id \(t1\)/)
})

test('through the desk: the live scenario-keyed emit puts a real table on the screen', async () => {
    const out = await turn(`<entries>${JSON.stringify(LIVE_ENTRIES)}</entries>`,
        { active_asset: 'PACB', draft: { ...draftAt(atEntries({ entriesShown: false })), entries: undefined }, coverage: [] })
    assert.equal(out.setup.entries.trades[0].id, 't1')
    assert.equal(out.setup.entries.trades[0].options.length, 2)
})

// ─── A held size is not refused while the plan is still being drawn ───────────

test('a size given in the opening turn is not reported as refused before there is a stop', async () => {
    // The live run: "sizing by risk needs an entry and a stop" came back as REFUSED on every turn of
    // the gates — the signal that sends a model back to ask for the size again.
    const out = await turn('<build>{"size":{"unit":"risk_cash","value":1000}}</build>',
        { active_asset: 'PACB', draft: { ...normalizeSetup({ asset: 'PACB', direction: 'long', type: 'day' }) }, coverage: [] })
    assert.equal(out.build.refused.filter(r => r.field === 'size').length, 0)
    assert.deepEqual(activeName(out.build).claimed.size, { value: { unit: 'risk_cash', value: 1000 }, source: 'user' })
})

test('the pacing line rides the opening confirm only', () => {
    const b = atEntries()
    assert.doesNotMatch(_buildPressSection(['entries'], { draft: draftAt(b) }), /pacing question/)
    assert.match(_buildPressSection(['direction', 'horizon', 'lens'], { draft: draftAt(b) }), /pacing question/)
})

test('"decide and let me generate" at the spans gate hands back BOTH gates — and the later one settles when it arrives', () => {
    let b = upsertName(emptyBuild(), 'PACB')
    b = applyBuildOps(b, { claim: { direction: 'long', horizon: 'day', lens: 'discretionary' }, settle: ['direction', 'horizon', 'lens'], source: 'user' }).build
    // The span gate is handed back along with the one after it, before the entries even exist.
    b = applyBuildOps(b, { delegate: ['spans', 'entries'], derived: { spans: ['t1'] }, picks: { spans: ['t1'] } }).build
    assert.equal(stageOf(activeName(b)), 'entries')
    // Next turn Mentor puts the ways in up — and the gate closes on its pick, with no question asked.
    b = applyBuildOps(b, { derived: { entries: ['t1:t1e1', 't1:t1e2'] }, picks: { entries: ['t1:t1e1'] } }).build
    assert.deepEqual(activeName(b).settled.entries, ['t1:t1e1'])
    assert.equal(stageOf(activeName(b)), 'sizing')
})

test('the spans gate tells the model how to hand back the rest of the build', () => {
    let b = upsertName(emptyBuild(), 'PACB')
    b = applyBuildOps(b, { claim: { direction: 'long', horizon: 'day', lens: 'discretionary' }, settle: ['direction', 'horizon', 'lens'], source: 'user' }).build
    const text = _buildLedgerSection({ draft: { ...normalizeSetup(PLAN), build: b } })
    assert.match(text, /"delegate":\["spans","entries"\]/)
})
