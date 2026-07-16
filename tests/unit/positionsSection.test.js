import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPositionsSection, positionPnlPct } from '../../services/agentUtils.js'

// buildPositionsSection renders the user's open book (shared by the Idea + Kairos agents) — a
// workspace line per connected broker, each position's P&L in $ AND %, and the book's total.

test('positionPnlPct: long = price move, short = sign-flipped', () => {
    assert.equal(positionPnlPct({ direction: 'long',  entryPrice: 100, currentPrice: 110 }), 10)
    assert.equal(positionPnlPct({ direction: 'short', entryPrice: 200, currentPrice: 190 }), 5)
    assert.equal(positionPnlPct({ direction: 'short', entryPrice: 200, currentPrice: 210 }), -5)
})

test('positionPnlPct: null when prices missing or entry is zero', () => {
    assert.equal(positionPnlPct({ direction: 'long', entryPrice: 0,   currentPrice: 110 }), null)
    assert.equal(positionPnlPct({ direction: 'long', entryPrice: 100 }), null)
    assert.equal(positionPnlPct({}), null)
    assert.equal(positionPnlPct(null), null)
})

test('empty / missing broker context yields no block', () => {
    assert.equal(buildPositionsSection(null), '')
    assert.equal(buildPositionsSection({}), '')
    assert.equal(buildPositionsSection({ ctrader: {} }), '')   // no account → skipped
})

test('live broker: workspace line, per-position $ and %, and total', () => {
    const out = buildPositionsSection({
        ctrader: {
            account: { id: '12345', login: '12345', currency: 'USD', balance: 10000, equity: 10500, freeMargin: 9000 },
            positions: [
                { symbol: 'AAPL', direction: 'long',  volume: 10, entryPrice: 100, currentPrice: 110, pnl: 100 },
                { symbol: 'TSLA', direction: 'short', volume: 5,  entryPrice: 200, currentPrice: 190, pnl: 50 },
            ],
        },
    })
    assert.ok(out.includes('Workspace: LIVE · Broker: cTrader · Account: cTrader #12345'), out)
    assert.ok(out.includes('AAPL long 10 @ 100 → 110  P&L +$100 (+10.0%)'), out)
    assert.ok(out.includes('TSLA short 5 @ 200 → 190  P&L +$50 (+5.0%)'), out)   // short profit
    assert.ok(out.includes('Total P&L: +$150 (+7.5%)'), out)                     // 150 / (100*10 + 200*5) = 7.5%
    assert.ok(out.includes('Balance $10,000 | Equity $10,500 | Free margin $9,000'), out)
})

test('live book spanning two accounts: both listed + per-position account tag', () => {
    const out = buildPositionsSection({
        ctrader: {
            account: { id: '111', login: '111', balance: 20000, equity: 20500, freeMargin: 18000 },
            positions: [
                { symbol: 'AAPL', direction: 'long', volume: 10, entryPrice: 100, currentPrice: 110, pnl: 100, accountNo: '111' },
                { symbol: 'MSFT', direction: 'long', volume: 5,  entryPrice: 400, currentPrice: 420, pnl: 100, accountNo: '222' },
            ],
        },
    })
    assert.ok(out.includes('Accounts: cTrader #111, cTrader #222'), out)   // pluralised, both accounts
    assert.ok(out.includes('AAPL long 10 @ 100 → 110  P&L +$100 (+10.0%) [acct 111]'), out)
    assert.ok(out.includes('MSFT long 5 @ 400 → 420  P&L +$100 (+5.0%) [acct 222]'), out)
})

test('single-account book has no account tag on position lines', () => {
    const out = buildPositionsSection({
        ctrader: {
            account: { id: '111', login: '111', balance: 20000, equity: 20500, freeMargin: 18000 },
            positions: [{ symbol: 'AAPL', direction: 'long', volume: 10, entryPrice: 100, currentPrice: 110, pnl: 100, accountNo: '111' }],
        },
    })
    assert.ok(out.includes('Account: cTrader #111'), out)   // singular
    assert.ok(!out.includes('[acct'), out)                  // no per-position tag on a single-account book
})

test('paper workspace with no positions', () => {
    const out = buildPositionsSection({
        paper: {
            account: { id: 'paper-u1-abc', login: 'paper-u1-abc', balance: 5000, equity: 5000, freeMargin: 5000 },
            positions: [],
        },
    })
    assert.ok(out.includes('Workspace: PAPER'), out)
    assert.ok(out.includes('No open positions'), out)
    assert.ok(!out.includes('Total P&L'), out)   // no total line without positions
})

test('losing position shows negative $ and %', () => {
    const out = buildPositionsSection({
        manual: {
            account: { id: 'manual-u1-xy', balance: 1000, equity: 900, freeMargin: 900 },
            positions: [{ symbol: 'NVDA', direction: 'long', volume: 2, entryPrice: 500, currentPrice: 450, pnl: -100 }],
        },
    })
    assert.ok(out.includes('Workspace: MANUAL'), out)
    assert.ok(out.includes('P&L -$100 (-10.0%)'), out)
    assert.ok(out.includes('Total P&L: -$100 (-10.0%)'), out)
})
