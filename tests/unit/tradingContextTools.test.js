import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTradingContext, formatBrokerSymbol, makeTradingContextHandlers, buildVenueSection, formatVenueSection, _accountHead, _WORKSPACE_LINE } from '../../services/tools/tradingContext.tools.js'

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

// ─── which book the user is actually looking at ───────────────────────────────
// A user sat in the paper workspace asked Axl about trading and was told about their live cTrader
// account. Nothing was wrong with the numbers — the context listed every account the user HAS, one
// of them flagged SELECTED, with no signal about which one they were standing in front of.

const bothBooks = (workspace) => ({
    modes: { paper: true, manual: false, live_brokers: ['ctrader'] },
    workspace,
    accounts: [
        account({ id: 'paper-1-abc', broker: 'paper',   mode: 'paper', currency: 'USD', positions: [position({ pnl: -100 })] }),
        account({ id: '437',         broker: 'ctrader', mode: 'live',  currency: 'USD', selected: true, positions: [position({ symbol: 'JPM', pnl: 900 })] }),
    ],
    unavailable: [],
})

test('in paper, the context says so before it says anything else', () => {
    const out = formatTradingContext(bothBooks('paper'))
    assert.match(out, /CURRENT WORKSPACE: PAPER \(simulated money\)/)
    assert.match(out, /"My account", "my positions" and "my P&L" mean the PAPER account/)
})

test('each account is stamped with which side of the workspace line it sits on', () => {
    const out = formatTradingContext(bothBooks('paper'))
    assert.match(out, /\[paper\] paper-1-abc.*CURRENT WORKSPACE/)
    assert.match(out, /\[live · ctrader\] 437.*NOT the current workspace \(user is in paper\)/)
})

test('the live account stays visible — it is out of scope, not hidden', () => {
    // Hiding it would make "do I have a live account?" unanswerable, and the model would have to
    // guess. The fix is framing, not omission.
    const out = formatTradingContext(bothBooks('paper'))
    assert.match(out, /\[live · ctrader\] 437/)
    assert.match(out, /JPM/)
})

test('P&L in paper does not quietly fold in the live book', () => {
    const out = formatTradingContext(bothBooks('paper'))
    assert.match(out, /Total open P&L in the paper workspace: -100\.00 USD/)
    assert.doesNotMatch(out, /Total open P&L.*\+800/)   // -100 + 900 across both books
})

test('in live the framing flips, and the live book is the one totalled', () => {
    const out = formatTradingContext(bothBooks('live'))
    assert.match(out, /CURRENT WORKSPACE: LIVE \(real money at a connected broker\)/)
    assert.match(out, /Total open P&L in the live workspace: \+900\.00 USD/)
    assert.match(out, /\[paper\] paper-1-abc.*NOT the current workspace \(user is in live\)/)
})

test('a context with no workspace behaves exactly as before', () => {
    // Every existing caller keeps working: no line, no per-account stamp, total across all accounts.
    const out = formatTradingContext(ctx())
    assert.doesNotMatch(out, /CURRENT WORKSPACE/)
    assert.match(out, /Total open P&L across all accounts/)
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

// ─── the venue block every desk carries, whether it asks or not ───────────────
// THE BUG THIS SECTION EXISTS FOR: the tool above was wired into all seven agents in July and desks
// STILL opened turns with "are we in paper or live?" — because a tool is an invitation, and a model
// mid-thought about a chart declines it. Mode, broker, accounts and free cash are facts the app
// holds, so they are now PUSHED into every turn instead of waited for.

test('the block answers all four questions a desk kept asking', async () => {
    const out = await buildVenueSection('u1', { read: () => ctx({ workspace: 'paper' }) })
    assert.match(out, /CURRENT WORKSPACE: PAPER/,        '1. which mode')
    assert.match(out, /live brokers connected: ctrader/, '2. which broker, when live')
    assert.match(out, /Every account connected \(1\)/, '3. which accounts')
    assert.match(out, /available to deploy/,             '4. how much free cash')
})

test('the block forbids asking for what it just handed over', async () => {
    const out = await buildVenueSection('u1', { read: () => ctx({ workspace: 'paper' }) })
    assert.match(out, /never ask the user which mode/)
})

test('free cash is stated as MISSING rather than silently dropped', () => {
    // The dangerous silence: with no free-cash clause the line carries only `balance`, and balance
    // is the number that already contains whatever the open positions tie up. A desk sizing against
    // it spends the same money twice — so an absent figure has to be as loud as a present one.
    const out = formatVenueSection(ctx({ workspace: 'paper', accounts: [account({ freeMargin: null })] }))
    assert.match(out, /available to deploy NOT REPORTED/)
    assert.match(out, /do not size against it/)
})

test('positions and P&L stay OUT of the block — that is what the tool is still for', async () => {
    // Deliberate. They move every tick (so they would blow the turn cache for every desk) and they
    // are the bulk of the tokens. The block carries the four facts; the tool carries the book.
    const out = await buildVenueSection('u1', { read: () => ctx({ workspace: 'paper' }) })
    assert.doesNotMatch(out, /NVDA/)
    assert.match(out, /call get_trading_context/)
})

test('a failed venue read says so — it never renders as a flat, confident book', async () => {
    const out = await buildVenueSection('u1', { read: () => { throw new Error('ctrader auth failed') } })
    assert.match(out, /could not read/)
    assert.match(out, /ctrader auth failed/)
    assert.match(out, /Do NOT guess/)
    // And it must not push the gap back onto the user — "which mode are you in?" is the exact
    // question this whole mechanism exists to stop.
    assert.match(out, /do not ask the user to tell you/)
})

test('a hung broker socket cannot hold a chat turn open', async () => {
    // getTradingContext is best-effort and catches its own failures, but a cTrader WS that never
    // answers hangs rather than throws — and this now runs on EVERY turn, so an unbounded await
    // would stall the whole chat instead of just one tool call.
    const out = await buildVenueSection('u1', { read: () => new Promise(() => {}), timeoutMs: 20 })
    assert.match(out, /timed out/)
})

test('no user means no block at all, not an empty one', async () => {
    // A headless run has no venue to report. An empty block would tell the model "you have no
    // accounts", which is a different and worse statement than saying nothing.
    assert.equal(await buildVenueSection(null), null)
})

test('the block and the tool answer render an account through the SAME line', () => {
    // The whole reason _accountHead is shared: two renderers for one set of numbers is two chances
    // for a desk to be told a different balance depending on which surface it read.
    const a = account({ freeMargin: 4212.5, currency: 'USD' })
    const head = _accountHead(a, 'paper')
    assert.ok(formatVenueSection(ctx({ workspace: 'paper', accounts: [a] })).includes(head))
    assert.ok(formatTradingContext(ctx({ workspace: 'paper', accounts: [a] })).includes(head))
})

// ─── the third workspace ──────────────────────────────────────────────────────
// Manual is REAL money at an institution the app cannot reach. It is paper's TWIN in everything the
// app actually does — same virtual account store, same marks off live prices, same condition
// monitoring, same journal — and differs in exactly two ways: the money is real, and execution
// happens at the user's bank. Describing it as either neighbour costs the user something concrete:
// collapsed into live, a desk says the app placed an order nobody placed; collapsed into paper, it
// discusses real money as practice.

const manualCtx = (over = {}) => ({
    modes: { paper: false, manual: true, live_brokers: ['ctrader'] },
    workspace: 'manual',
    accounts: [account({ id: 'ma_1', broker: 'manual', mode: 'manual', name: 'Bank', freeMargin: 4000 })],
    unavailable: [],
    ...over,
})

test('manual is named as its own workspace, not folded into live', async () => {
    const out = await buildVenueSection('u1', { read: () => manualCtx() })
    assert.match(out, /CURRENT WORKSPACE: MANUAL/)
    assert.match(out, /REAL money/)
})

test('manual says it is built and monitored exactly like paper', () => {
    // The correction that prompted this wording: manual is not a mode the app barely participates
    // in. It inherits paper's whole Layer A — only the fill engine is swapped for a confirmation.
    const out = formatVenueSection(manualCtx())
    assert.match(out, /BUILT AND MONITORED EXACTLY LIKE PAPER/)
    assert.match(out, /same condition monitoring/)
})

test('manual never promises an order the app cannot place', () => {
    const out = formatVenueSection(manualCtx())
    assert.match(out, /only EXECUTION differs/)
    assert.match(out, /never say the app will place, fill or close an order/)
})

test("manual flags its numbers as the USER'S word, adopted book included", () => {
    // A manual account can START from a book the user already held at their bank, and either way
    // nothing has verified the holdings since they stated them — the same fact the review ritual
    // re-confirms on every broker-less book (_buildUnreadableVenueSection).
    const out = formatVenueSection(manualCtx())
    assert.match(out, /adopted whole from their bank rather than built here/)
    assert.match(out, /nothing has verified them since/)
    // And NO invented "last confirmed" date: there is no verified-at stamp to read one from, so a
    // date here would be a number the app made up about the user's own book.
    assert.doesNotMatch(out, /last confirmed on/i)
})

test('the tool answer frames manual the same way the block does', () => {
    // One line, both surfaces. The tool used to hold its own two-way paper-or-live ternary, which is
    // exactly how manual came to render as live on that surface.
    const out = formatTradingContext(manualCtx())
    assert.ok(out.includes(_WORKSPACE_LINE.manual))
})

test('in manual, a live account is stamped as NOT the current workspace', () => {
    const out = formatVenueSection(manualCtx({
        accounts: [
            account({ id: 'ma_1', broker: 'manual', mode: 'manual', freeMargin: 4000 }),
            account({ id: '437', broker: 'ctrader', mode: 'live', selected: true, freeMargin: 900 }),
        ],
    }))
    assert.match(out, /\[manual\] ma_1.*CURRENT WORKSPACE/)
    assert.match(out, /\[live · ctrader\] 437.*NOT the current workspace \(user is in manual\)/)
})
