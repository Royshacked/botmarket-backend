// The Atlas review of 2026-10-03, and the two things it got wrong.
//   node --test tests/unit/reviewWithdrawnProposal.test.js
//
// 1. A WITHDRAWN PROPOSAL STILL EXECUTED. Atlas proposed six trims, the user asked "are you sure?",
//    Atlas backed off in prose — and "Accept changes" sent all six, because the panel held the first
//    turn's <portfolio_update> forever. The panels now keep only the LATEST turn's block; the model's
//    half of that contract is buildStandingProposalRule, carried by every desk whose review ends in a
//    one-shot proposal plus a commit button (Atlas, Pythia, Prometheus).
//
// 2. THE ACCOUNT'S $0 WAS READ AS THE BOOK'S. Two books shared one $100k paper account (~$145k of
//    positions), so "available to deploy" was correctly $0 — and Atlas, shown no equity and nothing
//    about the other book, trimmed to "raise cash" while its own book sat under budget. Equity now
//    rides on every virtual account, and the review state names what else is in the account.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { buildStandingProposalRule } from '../../services/agentUtils.js'
import { PaperAdapter } from '../../api/broker/adapters/paper.adapter.js'
import { paperBrokerService } from '../../api/broker/paperBroker.service.js'
import { getTradingContext } from '../../services/tradingContext.service.js'
import { _accountHead } from '../../services/tools/tradingContext.tools.js'
import { sharedAccountExposure } from '../../services/portfolioState.service.js'
import { _buildPortfolioStateSection, _sharedAccountLine, _stampPortfolioId } from '../../services/agents/portfolio.agent.service.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../')
const read = (p) => readFileSync(join(ROOT, p), 'utf-8')

// ─── 1. the latest turn decides ───────────────────────────────────────────────

test('the rule says a turn without the block WITHDRAWS it, and how to keep one standing', () => {
    const rule = buildStandingProposalRule('portfolio_update', 'Accept changes')
    assert.match(rule, /<portfolio_update>/)
    assert.match(rule, /Accept changes acts on that one and nothing older/)
    assert.match(rule, /A turn without the block WITHDRAWS/)
    assert.match(rule, /Re-emit the FULL block, unchanged/)
    assert.match(rule, /The button does not read your prose/)
})

test('a scope narrows it — Atlas\'s copy is review-only, because outside a review the block is applied on emit', () => {
    assert.doesNotMatch(buildStandingProposalRule('tilt', 'Publish'), /\(/, 'no scope, no parenthesis')
    const portfolio = read('services/agents/portfolio.agent.service.js')
    assert.match(portfolio, /buildStandingProposalRule\('portfolio_update', 'Accept changes', 'IN A REVIEW ONLY/)
})

test('every one-shot-proposal desk carries the rule; Mentor (re-emits every turn) does not', () => {
    // Ahead of BREVITY_RULE, which stays last on purpose (brevityRule.test.js).
    assert.match(read('services/agents/portfolio.agent.service.js'), /\+ buildStandingProposalRule\('portfolio_update', [^)]*\) \+ BREVITY_RULE\)/)
    assert.match(read('services/agents/strategy.agent.service.js'),  /\+ buildStandingProposalRule\('tilt', 'Publish'\) \+ BREVITY_RULE\)/)
    assert.match(read('services/agents/analyst.agent.service.js'),   /\+ buildStandingProposalRule\('coverage', [^)]*\) \+ BREVITY_RULE\)/)
    assert.doesNotMatch(read('services/agents/mentor.agent.service.js'), /buildStandingProposalRule/)
})

// ─── 2. equity beside the $0 ──────────────────────────────────────────────────

const real = { listAccounts: paperBrokerService.listAccounts, listPositions: paperBrokerService.listPositions }
afterEach(() => Object.assign(paperBrokerService, real))

function stubStore(accounts, positions) {
    paperBrokerService.listAccounts  = async (userId, { mode } = {}) => accounts.filter(a => !mode || a.mode === mode)
    paperBrokerService.listPositions = async (userId, { status } = {}) => positions.filter(p => !status || p.status === status)
}

test('a fully invested paper account reports $0 free AND its equity — invested, not missing', async () => {
    stubStore(
        [{ accountId: 'pa', mode: 'paper', name: 'Paper', currency: 'USD', cashBalance: 1000, settings: { maxLeverage: 0 } }],
        [
            { accountId: 'pa', status: 'open', direction: 'long',  avgPrice: 10, qty: 80, currentPrice: 12 },   // +160
            { accountId: 'pa', status: 'open', direction: 'short', avgPrice: 20, qty: 10, currentPrice: 21 },   // −10
        ],
    )
    const [a] = await new PaperAdapter().getTradingAccounts('u1')
    assert.equal(a.balance, 1000)
    assert.equal(a.freeMargin, 0, 'committed 800 + 200 = all of the cash — unchanged by this fix')
    assert.equal(a.equity, 1150, 'cash + unrealized (+160 − 10), off the stored marks')
})

test('an account with nothing open: equity is its cash', async () => {
    stubStore([{ accountId: 'pb', mode: 'paper', name: 'Empty', currency: 'USD', cashBalance: 500, settings: {} }], [])
    const [a] = await new PaperAdapter().getTradingAccounts('u1')
    assert.equal(a.equity, 500)
    assert.equal(a.freeMargin, 500)
})

test('equity survives the trading-context trip and is printed on the venue line', async () => {
    const svc = {
        listConnections: async () => ({ paper: true, manual: false }),
        getTradingAccounts: async () => ({ accounts: [{ id: 'pa', name: 'Paper', currency: 'USD', balance: 100112, equity: 99303, freeMargin: 0 }] }),
        getPositions: async () => [],
        capabilities: () => ({ trading: true }),
    }
    const { accounts } = await getTradingContext('u1', { broker: svc })
    assert.equal(accounts[0].equity, 99303)
    const head = _accountHead(accounts[0], 'paper')
    assert.match(head, /balance 100112\.00 USD · equity 99303\.00 USD · available to deploy 0\.00 USD/)
})

test('a venue that reports no equity prints none — never a guessed one', () => {
    assert.doesNotMatch(_accountHead({ id: 'x', mode: 'live', broker: 'ctrader', balance: 5, freeMargin: 5 }), /equity/)
})

// ─── 2b. what else is in the account ──────────────────────────────────────────

test('positions in the book\'s account that are not the book\'s are counted; matched ones and other accounts are not', () => {
    const positionsByBroker = {
        paper: [
            { id: 'p1', accountId: 'A', symbol: 'MSFT', volume: 10, currentPrice: 500 },   // this book
            { id: 'p2', accountId: 'A', symbol: 'jpm',  volume: 100, currentPrice: 300 },  // other book, same account
            { id: 'p3', accountId: 'A', symbol: 'MU',   volume: 10, entryPrice: 100 },     // unmarked → entry price
            { id: 'p4', accountId: 'B', symbol: 'SPY',  volume: 5,  currentPrice: 700 },   // another account
        ],
    }
    const shared = sharedAccountExposure(positionsByBroker, new Set(['paper|A']), new Set(['paper|A|p1']))
    assert.deepEqual(shared, { positions: 2, notional: 31000, symbols: ['JPM', 'MU'] })
})

test('nothing else in the account → null, and the review renders no SHARED line', () => {
    assert.equal(sharedAccountExposure({ paper: [{ id: 'p1', accountId: 'A' }] }, new Set(['paper|A']), new Set(['paper|A|p1'])), null)
    assert.equal(sharedAccountExposure({}, new Set(), new Set()), null)
    assert.equal(_sharedAccountLine(null), '')
})

const reviewState = (sharedAccount) => ({
    portfolioName: 'Core', computedAt: 0,
    workspace: { mode: 'paper', accounts: [] },
    totalNotional: 56541, totalPnl: -809, totalPnlPct: -1.4,
    ideas: [{ ideaId: 'i1', asset: 'MSFT', direction: 'long', status: 'long', allocationRatio: 0.24, actualWeight: 0.27, drift: 0.022, pnl: 610, pnlPct: 4.2 }],
    sectors: [],
    sharedAccount,
})

test('the review state says the $0 is the ACCOUNT\'s, and that it is no reason to trim', () => {
    const out = _buildPortfolioStateSection(reviewState({ positions: 8, notional: 88483.4, symbols: ['JPM', 'MU'] }), true, null)
    assert.match(out, /SHARED ACCOUNT: .* also hold 8 position\(s\) worth \$88483 that are NOT in this book \(JPM, MU\)/)
    assert.match(out, /it is the ACCOUNT's free cash, not this book's/)
    assert.match(out, /never by itself a reason to trim this book/)
    assert.doesNotMatch(_buildPortfolioStateSection(reviewState(null), true, null), /SHARED ACCOUNT/)
})

test('a long symbol list is capped, not dumped', () => {
    const symbols = Array.from({ length: 15 }, (_, i) => `S${i}`)
    const line = _sharedAccountLine({ positions: 15, notional: 1, symbols })
    assert.match(line, /S11, …\)/)
    assert.doesNotMatch(line, /S12/)
})

// ─── 3. the book's id ─────────────────────────────────────────────────────────
// Found driving the fix live: asked for a trim, Atlas refused — "the portfolio ID isn't present in the
// context". It wasn't: the schema said "<portfolioId from context>" and nothing had carried it since
// the EDIT MODE block was deleted (2026-09-15). And an edit's add_item lands in whatever id the model
// wrote. Shown to the model, and stamped by the server regardless.

test('the state block names the book\'s id', () => {
    const out = _buildPortfolioStateSection({ ...reviewState(null), portfolioId: 'portfolio_1786030441286', portfolioName: 'Quality-Value Swing' }, true, null)
    assert.match(out, /^Portfolio id: portfolio_1786030441286 \("Quality-Value Swing"\)$/m)
    assert.doesNotMatch(_buildPortfolioStateSection(reviewState(null), true, null), /Portfolio id:/)
})

test('the server\'s id overwrites the model\'s — a guessed or missing one never survives', () => {
    const changes = [{ action: 'add_item', item: { asset: 'JPM' } }]
    assert.deepEqual(_stampPortfolioId({ portfolioId: 'portfolio_GUESSED', changes }, 'portfolio_real'), { portfolioId: 'portfolio_real', changes })
    assert.deepEqual(_stampPortfolioId({ changes }, 'portfolio_real'), { portfolioId: 'portfolio_real', changes })
    // Construction has no open book — nothing to stamp, and a malformed block passes through untouched.
    assert.deepEqual(_stampPortfolioId({ portfolioId: 'x', changes }, null), { portfolioId: 'x', changes })
    assert.equal(_stampPortfolioId(null, 'portfolio_real'), null)
    assert.deepEqual(_stampPortfolioId([1], 'portfolio_real'), [1])
})

test('the prompt points at the id line, not at a block that no longer exists', () => {
    const prompt = read('prompts/portfolio_system_prompt.md')
    assert.doesNotMatch(prompt, /EDIT MODE/)
    assert.doesNotMatch(prompt, /portfolioId from context/)
    assert.match(prompt, /"portfolioId": "<the Portfolio id line>"/)
})

test('Atlas\'s review prompt: account cash is not a trigger', () => {
    const prompt = read('prompts/portfolio_system_prompt.md')
    assert.match(prompt, /\*\*Account cash is NOT a trigger\.\*\*/)
    assert.match(prompt, /Never trim this book to "raise cash"/)
})
