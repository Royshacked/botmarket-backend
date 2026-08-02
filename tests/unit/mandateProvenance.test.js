// Two live-verification bugs, both about a number the agent stated as fact when it wasn't one.
// Node's built-in harness:  node --test tests/unit/mandateProvenance.test.js
//
// 1. A goal set in an EARLIER session arrived wearing the "already established — do not re-ask"
//    header, so Atlas built on a target the user never confirmed this session.
// 2. Balance was the only capital figure any agent could see, so a new book was sized against money
//    already sitting in open positions.
import test from 'node:test'
import assert from 'node:assert/strict'

import { mandateFromObjective } from '../../api/portfolio/portfolioChat.service.js'
import { _buildAccountsSection, _buildMandateSection } from '../../services/portfolio.agent.service.js'
import { buildAccountLines } from '../../services/agentUtils.js'
import { formatTradingContext } from '../../services/tradingContext.tools.js'

const OBJECTIVE = {
    createdAt: Date.parse('2026-07-26T09:00:00Z'),
    target: { pct: 5 },
    horizon: { days: 90, until: '2026-10-24' },
    risk: { maxDrawdownPct: 5 },
}

// ── the carried-over goal ─────────────────────────────────────────────────────

test('a mandate derived from an objective is TAGGED with when it was set', () => {
    const m = mandateFromObjective(OBJECTIVE)
    assert.equal(m._fromObjective.setAt, OBJECTIVE.createdAt)
    assert.match(m.objective, /5%/)
})

test('it is rendered as a PROPOSAL to confirm, never as established', () => {
    const out = _buildMandateSection(mandateFromObjective(OBJECTIVE))
    assert.match(out, /CARRIED-OVER GOAL/)
    assert.match(out, /2026-07-26/)                       // the user can be told WHEN they said it
    assert.match(out, /still the plan\?/)
    assert.match(out, /PROPOSAL, not an established mandate/)
    assert.ok(!out.includes('already established'), 'must not claim the user settled this')
    assert.ok(!out.includes('Do not re-ask for mandate details'), 'that is the established-mandate line')
})

test('a mandate the user actually stated keeps the established wording', () => {
    const out = _buildMandateSection({ objective: 'growth', horizon: 'swing', riskTolerance: '20% drawdown' })
    assert.match(out, /already established/)
    assert.match(out, /Do not re-ask for mandate details/)
    assert.ok(!out.includes('CARRIED-OVER'))
})

test('no objective, or one with nothing stated → nothing carried', () => {
    assert.equal(mandateFromObjective(null), null)
    assert.equal(mandateFromObjective({ target: {}, horizon: {}, risk: {} }), null)
})

// ── deployable cash ───────────────────────────────────────────────────────────

test('account lines show what is available to deploy, not just the balance', () => {
    const [line] = buildAccountLines([
        { id: '1', broker: 'ctrader', isLive: true, login: '77', currency: 'USD', balance: 50000, equity: 52000, freeMargin: 12000 },
    ])
    assert.match(line, /balance: /)
    assert.match(line, /available to deploy: /)
    assert.match(line, /12,?000/)
})

test('a broker that reports no available figure shows none — no invented number', () => {
    const [line] = buildAccountLines([
        { id: '1', broker: 'ctrader', isLive: true, balance: 50000, freeMargin: null },
    ])
    assert.ok(!line.includes('available to deploy'))
    assert.match(line, /balance: /)
})

test('zero available is shown, not swallowed as missing', () => {
    // The fully-invested account is exactly the case this bug produced — it must not read as
    // "no data, fall back to balance", which is how the user got a book sized on money in positions.
    const [line] = buildAccountLines([{ id: '1', broker: 'paper', balance: 50000, freeMargin: 0 }])
    assert.match(line, /available to deploy/)
})

test('the sizing instruction points at deployable cash, not balance', () => {
    const section = _buildAccountsSection([{ id: '1', broker: 'paper', balance: 10000, freeMargin: 4000 }])
    assert.match(section, /Size against "available to deploy", NOT balance/)
})

test('get_trading_context carries the buying power its description promises', () => {
    const out = formatTradingContext({
        modes: { paper: true, manual: false, live_brokers: [] }, workspace: 'paper',
        accounts: [{ id: 'p1', broker: 'paper', mode: 'paper', balance: 50000, freeMargin: 12000, currency: 'USD', positions: [] }],
    })
    assert.match(out, /available to deploy 12000/)
})

// ── the number has to EXIST, not just have a renderer ─────────────────────────
// The first pass at this fix taught the agents to size against "available to deploy" and rendered it
// on every surface — while NO adapter put it on the accounts list at all. The renderer had nothing
// to render, the prompt silently fell back to balance, and nothing failed. So assert the SOURCE: the
// list is the only account shape the agents ever see (the richer per-account read carrying freeMargin
// is a call they never make).
import { _normaliseTradingAccount } from '../../api/broker/adapters/ctrader.adapter.js'

test('cTrader carries deployable cash onto the accounts LIST', () => {
    // cTrader reports money in hundredths; freeMargin must go through the SAME conversion as
    // balance, or the two numbers sit side by side in different units and the smaller one wins.
    const a = _normaliseTradingAccount({ id: '1', balance: 5_000_000, freeMargin: 1_200_000 })
    assert.equal(a.balance, 50_000)
    assert.equal(a.freeMargin, 12_000)
})

test('a payload without it yields null, never a fabricated figure', () => {
    const a = _normaliseTradingAccount({ id: '1', balance: 5_000_000 })
    assert.equal(a.freeMargin, null)
    assert.equal(a.balance, 50_000)
})
