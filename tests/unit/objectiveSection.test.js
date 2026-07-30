import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildObjectiveSection } from '../../services/agentUtils.js'
import { mandateFromObjective, portfolioChatService } from '../../api/portfolio/portfolioChat.service.js'

// How the captured goal is rendered for a desk. This block is the entire payoff of persisting an
// objective: the user states the job once, and whichever desk they land at reads it instead of
// asking again. Two things it must never do — imply a risk number nobody gave, and read as an
// instruction to trade right now.

const full = {
    target: { pct: 5, amount: null, currency: null },
    horizon: { days: 7, until: '2026-08-06' },
    risk: { maxDrawdownPct: 2, amount: null },
    scope: 'single',
    symbol: 'NVDA',
}

test('no objective renders nothing at all, so callers can push conditionally', () => {
    assert.equal(buildObjectiveSection(null), null)
    assert.equal(buildObjectiveSection(undefined), null)
})

test('a full goal renders every field the user stated', () => {
    const s = buildObjectiveSection(full)
    assert.match(s, /Target return: 5%/)
    assert.match(s, /Horizon: 7 days — by 2026-08-06/)
    assert.match(s, /Most they are willing to lose: 2% of the account/)
    assert.match(s, /one position/)
    assert.match(s, /NVDA/)
})

test('the block tells the desk the goal is settled — that is the whole point', () => {
    assert.match(buildObjectiveSection(full), /do not re-ask/i)
})

test('the block is context, not a green light to act', () => {
    // A desk that reads "target 5% by Friday" as an order would start building before the user has
    // said anything about how. The closing line is what keeps it as background.
    assert.match(buildObjectiveSection(full), /not an instruction to act now/)
})

test('a MISSING risk is stated out loud, and names who should ask', () => {
    // A silent gap reads as "no constraint" and the desk sizes against nothing. Naming it puts the
    // question exactly where sizing happens.
    const s = buildObjectiveSection({ ...full, risk: { maxDrawdownPct: null, amount: null } })
    assert.match(s, /NOT STATED/)
    assert.match(s, /never infer it from the target/)
    assert.doesNotMatch(s, /5% of the account/, 'the target must not leak into the risk line')
})

test('fields the user never gave are simply absent', () => {
    const s = buildObjectiveSection({
        target: { pct: null, amount: 2000, currency: 'USD' },
        horizon: { days: 1, until: '2026-07-31' },
        risk: {}, scope: null, symbol: null,
    })
    assert.match(s, /Target return: 2000 USD/)
    assert.match(s, /Horizon: 1 day —/, 'one day, not "1 days"')
    assert.doesNotMatch(s, /Shape:/)
    assert.doesNotMatch(s, /Name they came for/)
})

// ─── Objective → Atlas mandate ────────────────────────────────────────────────

test('the goal becomes mandate fields so Atlas does not re-ask for them', () => {
    const m = mandateFromObjective(full)
    assert.match(m.objective, /5%/)
    assert.match(m.horizon, /7 days — by 2026-08-06/)
    assert.match(m.riskTolerance, /max drawdown 2%/)
})

test('an unstated risk produces no riskTolerance field rather than an invented one', () => {
    const m = mandateFromObjective({ ...full, risk: {} })
    assert.equal('riskTolerance' in m, false)
})

test('no objective means no mandate — the existing carry-forward is unaffected', () => {
    assert.equal(mandateFromObjective(null), null)
})

test('a DERIVED mandate feeds the prompt but never counts as an established one', async () => {
    // The split that keeps the draft-thread floor intact. isSubstantive gates a construction draft
    // on mandateReady, so if the derived mandate came back as `statedMandate` a thread would be
    // persisted the moment anyone with an open goal opened Atlas — precisely the junk that floor
    // exists to keep out. No portfolioId and no threadId means this touches no database.
    const ctx = await portfolioChatService.loadStreamContext({
        userId: 'u1', portfolioId: null, threadId: null, isReviewMode: false, bodyMandate: null,
        objective: full,
    })
    assert.ok(ctx.mandate, 'the prompt still reads the goal')
    assert.equal(ctx.statedMandate, null, 'nothing was established with Atlas yet')
})

test('a mandate the user actually gave Atlas outranks the intake goal', async () => {
    const ctx = await portfolioChatService.loadStreamContext({
        userId: 'u1', portfolioId: null, threadId: null, isReviewMode: false,
        bodyMandate: { objective: 'income' }, objective: full,
    })
    assert.equal(ctx.mandate.objective, 'income')
    assert.equal(ctx.statedMandate.objective, 'income')
})

test('the mandate says where the numbers came from', () => {
    // Atlas is entitled to know a mandate field was taken from an intake conversation it never saw,
    // rather than stated to it directly.
    assert.match(mandateFromObjective(full).objective, /stated by the user at intake/)
})
