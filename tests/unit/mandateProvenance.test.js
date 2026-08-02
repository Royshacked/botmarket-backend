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

// ── virtual accounts: cash does NOT drop when a position opens ────────────────
// The correction that mattered. adjustBalance moves cash by the COMMISSION on open and by the
// realized amount on CLOSE — so cashBalance is starting-balance + realized P&L and still counts
// every dollar sitting in an open holding. A paper account with equities showed its full balance
// as spendable, which is what the user hit. Deployable = cash MINUS committed cost basis.
import { deployable } from '../../api/broker/paperExecution.service.js'

test('deployable subtracts what open positions already committed', () => {
    // $50k started, $30k of it now in equities → $20k left to allocate, not $50k.
    assert.equal(deployable({ cashBalance: 50_000, marginUsed: 30_000 }), 20_000)
})

test('fully invested reads as zero, not as the whole balance', () => {
    assert.equal(deployable({ cashBalance: 50_000, marginUsed: 50_000 }), 0)
})

test('equity is NOT the answer — it counts the holdings as spendable', () => {
    // The old no-leverage fallback returned equity (cash + unrealized). With $30k invested and a
    // $2k gain that reported $52k deployable on an account with $20k of actual room.
    const eq = { cashBalance: 50_000, marginUsed: 30_000, unrealized: 2_000, equity: 52_000, buyingPower: null }
    assert.equal(deployable(eq), 20_000)
    assert.notEqual(deployable(eq), eq.equity)
})

test('with leverage on, buying power replaces cash as the base', () => {
    assert.equal(deployable({ cashBalance: 50_000, marginUsed: 30_000, buyingPower: 100_000 }), 70_000)
})

test('never negative — an over-committed account reports nothing to deploy', () => {
    assert.equal(deployable({ cashBalance: 10_000, marginUsed: 25_000 }), 0)
})

// ── the empty-coverage message is an INSTRUCTION ──────────────────────────────
// It used to end "or screen directly", and that is what Atlas did: it read fundamentals, picked
// names and allocated, skipping both the screening desk and the research desk. A tool result lands
// late in the context, right where the model decides what to do next, so it outranks a rule written
// hundreds of lines earlier in the system prompt. It must not offer a route the prompt forbids.
import { _formatCoverage } from '../../services/portfolio.agent.service.js'

test('empty coverage tells Atlas to hand off and stop — never to screen itself', () => {
    const out = _formatCoverage([])
    assert.ok(!/screen directly/i.test(out), 'this phrase is what caused Atlas to self-source')
    assert.match(out, /<screen_request>/)
    assert.match(out, /END THE TURN/)
    assert.match(out, /NO screener of your own/)
})

test('coverage that exists is offered as the thing to build from', () => {
    const out = _formatCoverage([{ symbol: 'AVGO', rating: 'buy', status: 'active', price_target: { value: 400 } }])
    assert.match(out, /AVGO/)
    assert.ok(!/END THE TURN/.test(out), 'the hand-off instruction belongs only to the empty case')
})

// ── the benchmark the prompt proposes must be one the code can price ──────────
// The same mandate was producing a different benchmark every run: benchmark is not in the
// minimum-to-proceed, so it never reached <portfolio_mandate>, so it was re-decided from scratch on
// every turn — and nothing constrained the choice. The prompt now names defaults per objective; if
// any of them can't resolve to a tradeable proxy, the review has nothing to compute against and the
// over/underweights of Phase 3 measure against a number that doesn't exist.
import { benchmarkTicker } from '../../services/portfolioReview.util.js'
import { readFileSync } from 'fs'
import { fileURLToPath as _fu } from 'url'
import { dirname as _dn, join } from 'path'
const ROOT_MD = join(_dn(_fu(import.meta.url)), '../../')

test('every benchmark the prompt names resolves to a proxy the app can price', () => {
    for (const [name, expected] of [
        ['S&P 500', 'SPY'], ['60/40', 'AOR'], ['Russell 2000', 'IWM'],
        ['Nasdaq 100', 'QQQ'], ['MSCI World', 'ACWI'],
    ]) {
        assert.equal(benchmarkTicker(name), expected, `${name} must resolve`)
    }
    // "absolute return" is deliberately un-priceable — it means measure against zero, not an index.
    assert.equal(benchmarkTicker('absolute return'), null)
})

test('the prompt does not offer a benchmark the code cannot resolve', () => {
    const prompt = readFileSync(join(ROOT_MD, 'portfolio_system_prompt.md'), 'utf8')
    const line = prompt.split('\n').find(l => l.includes('Default by objective'))
    assert.ok(line !== undefined || prompt.includes('growth → S&P 500'), 'the default table is still there')
    for (const name of ['S&P 500', '60/40', 'Russell 2000', 'Nasdaq 100', 'MSCI World']) {
        if (prompt.includes(name)) assert.ok(benchmarkTicker(name), `prompt offers ${name} but it resolves to null`)
    }
})
