import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSize, riskPerUnit, SIZE_UNITS } from '../../services/positionSize.util.js'
import { summarizeTrade, summarizeBatch, expectedGain, summaryEntry } from '../../services/mentorSummary.util.js'
import { normalizeSetup } from '../../services/setup.schema.js'
import { _mainBalance, _buildMoneySection } from '../../services/agents/mentor.agent.service.js'

// Money arithmetic on a real account. Every test here is a number a user would act on, which is
// exactly why none of it is left to the model.

const SETUP = normalizeSetup({
    asset: 'NVDA', direction: 'long', type: 'swing', trade_mode: 'smc', timeframe: '1hr',
    scenarios: [{
        id: 's1',
        entry_legs:  [{ price: 200, quantity: 100 }],
        stop_legs:   [{ price: 196 }],
        target_legs: [{ price: 210, quantity: 100 }],
    }],
})

// ─── The five units ───────────────────────────────────────────────────────────

test('all five units resolve to the same position when they describe the same one', () => {
    assert.deepEqual(SIZE_UNITS, ['risk_cash', 'risk_pct', 'size_cash', 'size_pct', 'shares'])
    const at = (unit, value) => resolveSize({ unit, value, entry: 200, stop: 196, balance: 50000 }).quantity

    // $4 of risk per share: $500 of risk and 1% of a $50k account are both 125 shares.
    assert.equal(at('risk_cash', 500), 125)
    assert.equal(at('risk_pct', 1), 125)
    // $25k of stock at $200 and 50% of a $50k account are both 125 shares.
    assert.equal(at('size_cash', 25000), 125)
    assert.equal(at('size_pct', 50), 125)
    assert.equal(at('shares', 125), 125)
})

test('a resolved size says what it means in the other units', () => {
    const out = resolveSize({ unit: 'risk_cash', value: 500, entry: 200, stop: 196, balance: 50000 })
    assert.equal(out.quantity, 125)
    assert.equal(out.riskCash, 500)
    assert.equal(out.riskPct, 1)
    assert.equal(out.notional, 25000)
    assert.equal(out.notionalPct, 50)
    assert.equal(out.problem, null)
})

test('the contract multiplier is the difference between a position and a wrong one', () => {
    assert.equal(riskPerUnit(200, 196, 1), 4)
    assert.equal(riskPerUnit(200, 196, 50), 200)
    // Same $500 budget, a 50x contract: two units, not 125.
    assert.equal(resolveSize({ unit: 'risk_cash', value: 500, entry: 200, stop: 196, multiplier: 50 }).quantity, 2)
})

test('a percentage with no balance is refused, not guessed', () => {
    const out = resolveSize({ unit: 'risk_pct', value: 1, entry: 200, stop: 196, balance: null })
    assert.equal(out.quantity, null)
    assert.match(out.problem, /cannot see/)
})

test('sizing by risk needs a stop that is a different price', () => {
    const out = resolveSize({ unit: 'risk_cash', value: 500, entry: 200, stop: 200 })
    assert.equal(out.quantity, null)
    assert.match(out.problem, /entry and a stop that are different prices/)
})

test('a budget smaller than one unit is said out loud, never floored to a silent zero', () => {
    const out = resolveSize({ unit: 'risk_cash', value: 3, entry: 200, stop: 196 })
    assert.equal(out.quantity, null)
    assert.match(out.problem, /smaller than the risk on a single unit \(4 per unit/)
})

test('nonsense in, a reason out', () => {
    assert.match(resolveSize({ unit: 'vibes', value: 1 }).problem, /unknown sizing unit/)
    assert.match(resolveSize({ unit: 'shares', value: -5 }).problem, /positive number/)
    assert.match(resolveSize({ unit: 'size_cash', value: 1000, entry: 0 }).problem, /needs an entry price/)
})

// ─── What it pays, what it costs ──────────────────────────────────────────────

test('the summary is the two outcomes, in cash and as a share of the account', () => {
    const s = summarizeTrade(SETUP, { quantity: 125, balance: 50000 })
    assert.equal(s.rr, 2.5)
    assert.equal(s.lossCash, 500)      // 125 x $4
    assert.equal(s.lossPct, 1)
    assert.equal(s.gainCash, 1250)     // 125 x $10
    assert.equal(s.gainPct, 2.5)
    assert.equal(s.estimated, false)
})

test('a ladder that does not cover the position is priced to the NEAREST target, never flattered', () => {
    // The plan was drawn at 100 and the user sized 125: 25 units have no authored exit. Scaling the
    // legs up or leaving the remainder unsold both invent a plan nobody agreed to.
    assert.equal(expectedGain(SETUP, 125, 200), 1250)
})

test('a laddered target pays per leg, at each leg\'s own price', () => {
    const laddered = normalizeSetup({
        ...SETUP,
        scenarios: [{
            id: 's1',
            entry_legs:  [{ price: 200, quantity: 100 }],
            stop_legs:   [{ price: 196 }],
            target_legs: [{ price: 210, quantity: 50 }, { price: 220, quantity: 50 }],
        }],
    })
    // 50 x $10 + 50 x $20 = $1500, not 100 x the furthest.
    assert.equal(expectedGain(laddered, 100, 200), 1500)
})

test('an entry with no authored price is estimated off the live price, and SAYS so', () => {
    const noPrice = { ...SETUP, entry_legs: [], scenarios: SETUP.scenarios }
    assert.deepEqual(summaryEntry(noPrice, 203), { entry: 203, estimated: true })
    assert.deepEqual(summaryEntry(noPrice, null), { entry: null, estimated: true })
    assert.deepEqual(summaryEntry(SETUP, 203), { entry: 200, estimated: false })
})

test('no size means no money — which is why sizing cannot be waived', () => {
    const s = summarizeTrade(SETUP, { quantity: null, balance: 50000 })
    assert.equal(s.quantity, 100, 'falls back to the size already on the scenario')

    const bare = summarizeTrade({ ...SETUP, scenarios: [{ ...SETUP.scenarios[0], quantity: null }] }, { balance: 50000 })
    assert.equal(bare.lossCash, null)
    assert.equal(bare.gainCash, null)
})

test('the batch line is what is at risk across the whole build', () => {
    const one = summarizeTrade(SETUP, { quantity: 125, balance: 50000 })
    const batch = summarizeBatch([one, one, one], 50000)
    assert.equal(batch.trades, 3)
    assert.equal(batch.riskCash, 1500)
    assert.equal(batch.riskPct, 3, '1% each across three names is three percent')
    assert.equal(summarizeBatch([], 50000), null)
})

// ─── Into the prompt ──────────────────────────────────────────────────────────

test('the balance is the MAIN account\'s, and several unmarked accounts resolve to none', () => {
    assert.equal(_mainBalance([{ id: 1, balance: 50000 }]), 50000)
    assert.equal(_mainBalance([{ id: 1, balance: 50000, freeMargin: 30000 }]), 30000, 'deployable cash wins')
    assert.equal(_mainBalance([{ id: 1, balance: 10 }, { id: 2, balance: 99999 }], 2), 99999)
    assert.equal(_mainBalance([{ id: 1, balance: 10 }, { id: 2, balance: 99999 }]), null, 'ambiguous is not a number')
    assert.equal(_mainBalance([]), null)
})

test('the money reaches the model as figures to read out, not arithmetic to do', () => {
    const text = _buildMoneySection({ summary: summarizeTrade(SETUP, { quantity: 125, balance: 50000 }) })
    assert.match(text, /pays 1250 \(2\.5% of the account\)/)
    assert.match(text, /costs 500 \(1% of the account\)/)
    assert.match(text, /never recompute them/)
    assert.doesNotMatch(text, /ESTIMATED/)
})

test('an estimated summary is labelled where the model will read it', () => {
    const noPrice = normalizeSetup({ ...SETUP, scenarios: [{ ...SETUP.scenarios[0], entry_legs: [] }] })
    const text = _buildMoneySection({ summary: { ...summarizeTrade(noPrice, { quantity: 125, balance: 50000, livePrice: 203 }), lossCash: 875 } })
    assert.match(text, /ESTIMATED/)
    assert.match(text, /computed at the fill/)
})

test('no money yet, no section', () => {
    assert.equal(_buildMoneySection(null), '')
    assert.equal(_buildMoneySection({ summary: { rr: 2.5 } }), '')
})

// ─── Sizing through the desk ──────────────────────────────────────────────────

import { applySizing } from '../../services/mentorSummary.util.js'
import { mentorAgentService } from '../../services/agents/mentor.agent.service.js'
import { sanitizeBuildOps } from '../../services/mentorBuild.util.js'

const ACCOUNT = [{ id: 1, balance: 50000, isLive: false, broker: 'paper' }]

const sized = (raw, chatState) => mentorAgentService.chatStream({
    messages: [{ role: 'user', content: 'hi' }], chatState, accounts: ACCOUNT, _run: async () => raw,
})

test('the sizing op is taken off the wire by unit and number, and nothing else', () => {
    assert.deepEqual(sanitizeBuildOps({ size: { unit: 'risk_pct', value: 1 } }).size, { unit: 'risk_pct', value: 1 })
    assert.equal(sanitizeBuildOps({ size: { unit: 'vibes', value: 1 } }), null)
    assert.equal(sanitizeBuildOps({ size: { unit: 'risk_pct', value: 'one percent' } }), null)
    assert.equal(sanitizeBuildOps({ size: { unit: 'risk_pct', value: -1 } }), null)
})

test('each premise is sized against ITS OWN stop, not the first one in the trade', () => {
    const two = normalizeSetup({
        asset: 'NVDA', direction: 'long', type: 'swing',
        scenarios: [
            { id: 's1', entry_legs: [{ price: 200 }], stop_legs: [{ price: 196 }], target_legs: [{ price: 210 }] },
            { id: 's2', entry_legs: [{ price: 200 }], stop_legs: [{ price: 190 }], target_legs: [{ price: 210 }] },
        ],
    })
    const { quantities } = applySizing(two, { unit: 'risk_cash', value: 500 }, { balance: 50000 })
    // $4 wide → 125 shares; $10 wide → 50. Sizing both together would over-risk the wider one.
    assert.deepEqual(quantities.map(q => q.quantity), [125, 50])
})

test('a size the server cannot resolve comes back as a refusal, and the stage stays open', async () => {
    const noBalance = mentorAgentService.chatStream({
        messages: [{ role: 'user', content: 'hi' }],
        chatState: { active_asset: 'NVDA', draft: SETUP, coverage: [] },
        accounts: [],
        _run: async () => '<build>{"size":{"unit":"risk_pct","value":1}}</build>',
    })
    const out = await noBalance
    assert.match(out.build.refused[0].reason, /cannot see/)
})

test('the quantity lands on the worksheet, and the money follows from it', async () => {
    const out = await sized('<build>{"size":{"unit":"risk_cash","value":500}}</build>',
        { active_asset: 'NVDA', draft: SETUP, coverage: [] })
    assert.equal(out.setup.scenarios[0].quantity, 125)
    assert.equal(out.setup.scenarios[0].entry_legs[0].quantity, 125, 'one way in takes the whole position')
    assert.equal(out.setup.summary.lossCash, 500)
    assert.equal(out.setup.summary.lossPct, 1)
})

// ─── Size is DERIVED, not a one-off ───────────────────────────────────────────
// Found in a live build: the ledger said the size stage was settled while the worksheet carried no
// quantity at all, because the arithmetic only ran on the turn the op arrived.

test('a size settled on an EARLIER turn still produces a quantity', async () => {
    const first = await sized('<build>{"size":{"unit":"risk_cash","value":500},"settle":["size"]}</build>',
        { active_asset: 'NVDA', draft: SETUP, coverage: [] })
    assert.equal(first.setup.scenarios[0].quantity, 125)

    // The next turn says nothing about size. The quantity must still be there.
    const later = await sized('What about the target?',
        { active_asset: 'NVDA', draft: first.setup, coverage: [] })
    assert.equal(later.setup.scenarios[0].quantity, 125)
    assert.equal(later.setup.summary.lossCash, 500)
})

test('a stop that MOVES re-sizes the position — the same risk is a different share count', async () => {
    const first = await sized('<build>{"size":{"unit":"risk_cash","value":500},"settle":["size"]}</build>',
        { active_asset: 'NVDA', draft: SETUP, coverage: [] })
    assert.equal(first.setup.scenarios[0].quantity, 125)   // $4 wide

    // Mentor widens the stop to 190: $10 of risk per share, so 50 shares for the same $500.
    const wider = normalizeSetup({ ...SETUP, scenarios: [{ ...SETUP.scenarios[0], stop_legs: [{ price: 190 }] }] })
    wider.build = first.setup.build
    const after = await sized(`<setup>${JSON.stringify(wider)}</setup>`,
        { active_asset: 'NVDA', draft: wider, coverage: [] })
    assert.equal(after.setup.scenarios[0].quantity, 50, 'a stale count looks identical on the page')
})

test('a quantity the plan already carries is left alone — there is nothing to resolve', async () => {
    const out = await sized('<build>{"claim":{"size":100},"settle":["size"]}</build>',
        { active_asset: 'NVDA', draft: SETUP, coverage: [] })
    assert.equal(out.setup.scenarios[0].quantity, 100)
})
