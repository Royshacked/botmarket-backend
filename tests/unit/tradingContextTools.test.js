import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTradingContext, formatBrokerSymbol, makeTradingContextHandlers } from '../../services/tradingContext.tools.js'

// THE BUG THIS FILE EXISTS FOR
// Both venue tools returned their service's OBJECT. The Anthropic provider's tool_result branch
// ended in `String(ret)`, so `{modes,accounts}` reached the model as the literal "[object Object]":
// a successful call carrying zero information. Every agent had the tool; none could read it. Asked
// "what's my P&L", Axl called get_trading_context, was handed "[object Object]", and said it didn't
// know — while the app held 7 open positions priced to the cent.
//
// So the contract asserted here is: a tool result is TEXT, and the numbers survive the trip.

const position = (over = {}) => ({ symbol: 'NVDA', direction: 'long', quantity: 119, entryPrice: 211.22112, currentPrice: 195.04, pnl: -1925.55, pnlPct: -7.66, ...over })
const account = (over = {}) => ({ id: 'paper-1-abc', broker: 'paper', mode: 'paper', name: 'Paper', balance: 100676.229289, currency: 'USD', capabilities: { trading: true, closePosition: true, nativeProtection: false }, selected: false, positions: [position()], ...over })
const ctx = (over = {}) => ({ modes: { paper: true, manual: false, live_brokers: ['ctrader'] }, accounts: [account()], unavailable: [], ...over })

// ─── the regression itself ────────────────────────────────────────────────────

test('the venue read reaches the model as text, never as [object Object]', async () => {
    const handlers = makeTradingContextHandlers('u1')
    // No userId plumbing needed: getTradingContext returns the empty shape for an unknown user,
    // which is enough to prove the RETURN TYPE. The numbers are covered by the format tests below.
    const out = await handlers.get_trading_context({})
    assert.equal(typeof out, 'string')
    assert.doesNotMatch(out, /\[object Object\]/)
})

test('the availability read reaches the model as text too', async () => {
    const handlers = makeTradingContextHandlers(null)
    const out = await handlers.check_broker_symbol({ ticker: 'NVDA' })
    assert.equal(typeof out, 'string')
    assert.doesNotMatch(out, /\[object Object\]/)
})

// ─── the numbers a P&L question actually needs ────────────────────────────────

test('every position carries its own P&L, signed', () => {
    const out = formatTradingContext(ctx())
    assert.match(out, /NVDA long 119/)
    assert.match(out, /P&L -1925\.55 \(-7\.66%\)/)
})

test('a gain is signed as a gain — the sign comes off the number, not the string', () => {
    const out = formatTradingContext(ctx({ accounts: [account({ positions: [position({ symbol: 'JPM', pnl: 878.96, pnlPct: 2.9 })] })] }))
    assert.match(out, /P&L \+878\.96 \(\+2\.90%\)/)
})

test('open P&L is totalled per account and across the book', () => {
    const out = formatTradingContext(ctx({ accounts: [account({ positions: [position({ pnl: -1925.55 }), position({ symbol: 'JPM', pnl: 878.96 })] })] }))
    assert.match(out, /2 open positions · open P&L -1046\.59 USD/)
    assert.match(out, /Total open P&L across all accounts: -1046\.59 USD/)
})

test('two currencies are never added into one meaningless number', () => {
    const out = formatTradingContext(ctx({
        accounts: [
            account({ id: 'a-usd', currency: 'USD', positions: [position({ pnl: 100 })] }),
            account({ id: 'a-eur', currency: 'EUR', positions: [position({ pnl: 50 })] }),
        ],
    }))
    assert.match(out, /Total open P&L across all accounts: \+100\.00 USD · \+50\.00 EUR/)
    assert.doesNotMatch(out, /150/)
})

test('an unpriced leg is excluded from the total and SAID, not silently dropped', () => {
    const out = formatTradingContext(ctx({ accounts: [account({ positions: [position({ pnl: -100 }), position({ symbol: 'MU', pnl: null, pnlPct: null })] })] }))
    assert.match(out, /open P&L -100\.00 USD \(1 could not be priced — not counted\)/)
    assert.match(out, /MU long 119 .* · P&L unknown/)
})

// ─── "could not ask" is never "holds nothing" ─────────────────────────────────

test('a broker whose read FAILED is flagged, not reported as flat', () => {
    // The live case that prompted this: cTrader answered RET_ACCOUNT_DISABLED, the read threw, and
    // the account came back with positions: [] — the exact shape of a flat book.
    const out = formatTradingContext(ctx({
        accounts: [account({ id: '437', broker: 'ctrader', mode: 'live', positions: [] })],
        unavailable: ['ctrader'],
    }))
    assert.match(out, /WARNING — could not read positions at: ctrader/)
    assert.match(out, /the read FAILED, not because they are flat/)
})

test('with nothing failing there is no warning to echo', () => {
    assert.doesNotMatch(formatTradingContext(ctx()), /WARNING/)
})

test('an empty account with a healthy read still reads as empty', () => {
    const out = formatTradingContext(ctx({ accounts: [account({ positions: [] })] }))
    assert.match(out, /no open positions in this account/)
})

test('no accounts at all is stated plainly', () => {
    const out = formatTradingContext({ modes: { paper: false, manual: false, live_brokers: [] }, accounts: [] })
    assert.match(out, /No trading accounts available/)
})

test('a defensive call with no argument does not throw', () => {
    assert.equal(typeof formatTradingContext(), 'string')
    assert.equal(typeof formatBrokerSymbol(), 'string')
})

// ─── venue framing the desks size against ─────────────────────────────────────

test('the account an order would actually go to is marked', () => {
    const out = formatTradingContext(ctx({ accounts: [account({ broker: 'ctrader', mode: 'live', selected: true })] }))
    assert.match(out, /SELECTED \(where a live order goes today\)/)
})

test('balance and modes survive the trip', () => {
    const out = formatTradingContext(ctx())
    assert.match(out, /paper ON · manual off · live brokers: ctrader/)
    assert.match(out, /balance 100676\.23 USD/)
})

test('only the capabilities a venue HAS are listed', () => {
    const out = formatTradingContext(ctx())
    assert.match(out, /can: trading, closePosition/)
    assert.doesNotMatch(out, /nativeProtection/)
})

// ─── tradability stays three-state in words ───────────────────────────────────

test('tradable, not listed and unreachable stay three distinct answers', () => {
    const out = formatBrokerSymbol({ ticker: 'NQ', venues: [
        { broker: 'ctrader', tradable: true, brokerSymbol: 'US100.cash', mappedFrom: 'NQ' },
        { broker: 'ibkr', tradable: false, brokerSymbol: null },
        { broker: 'other', tradable: null, brokerSymbol: null, error: 'broker unreachable — availability unknown' },
    ] })
    assert.match(out, /ctrader: TRADABLE as US100\.cash \(the app's NQ → US100\.cash there\)/)
    assert.match(out, /ibkr: NOT LISTED/)
    assert.match(out, /other: UNKNOWN/)
    // The whole point of the third state: a timeout must never be reported as "you can't trade it".
    assert.match(out, /NEVER as unavailable/)
})

test('no live venue is a different sentence from "not listed"', () => {
    const out = formatBrokerSymbol({ ticker: 'NVDA', venues: [] })
    assert.match(out, /no live trading venue is connected/)
    assert.doesNotMatch(out, /NOT LISTED/)
})
