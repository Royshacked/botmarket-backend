import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    isForex, sessionFor, isAssetOpen, getMarketStatus,
    isMarketOpen, isForexOpen, isFuturesOpen, nextMarketOpenMs,
} from '../../services/market.service.js'
import { formatMarketStatus, withMarketStatus } from '../../services/marketHours.tools.js'
import { toolError } from '../../services/toolResult.util.js'

// The market-hours engine had NO direct unit coverage — only sessionPhase and a paper-gate
// regression test. These cover the classifier (which grew forex), the gate, and the agent-facing
// formatter that now rides on every get_quote.
//
// All instants are fixed and passed in, so nothing here depends on when the suite runs.
// Reference dates (ET is UTC-4 in July/August, i.e. EDT):
//   2026-07-15 is a Wednesday · 2026-07-18 a Saturday · 2026-07-19 a Sunday
const WED_1400_ET = new Date('2026-07-15T18:00:00Z')   // 14:00 ET — equity RTH open
const WED_0300_ET = new Date('2026-07-15T07:00:00Z')   // 03:00 ET — equity shut, FX open
const SAT_1200_ET = new Date('2026-07-18T16:00:00Z')   // Saturday — everything but crypto shut

// ─── The forex classifier (the gap that made EURUSD read as a stock) ──────────

test('a fiat pair is forex, in every shape the feeds hand us', () => {
    for (const s of ['EURUSD', 'eurusd', 'EUR/USD', 'EURUSD=X', 'GBPJPY', 'USDCHF', 'AUDNZD']) {
        assert.equal(isForex(s), true, s)
    }
})

test('crypto quoted in fiat is NOT forex — order of classification is load-bearing', () => {
    // BTCUSD is six characters of "two codes" if you forget BTC is not a currency. isCrypto is
    // asked first, and BTC/ETH are deliberately absent from the fiat table as a second guard.
    assert.equal(isForex('BTCUSD'), false)
    assert.equal(sessionFor('BTCUSD'), 'crypto')
    assert.equal(sessionFor('ETHEUR'), 'crypto')
})

test('equities, index futures and their broker aliases keep their own sessions', () => {
    assert.equal(isForex('AAPL'), false)
    assert.equal(sessionFor('AAPL'), 'equity')
    assert.equal(sessionFor('NQ'), 'futures')
    assert.equal(sessionFor('US100'), 'futures')      // cTrader cash-CFD alias
    assert.equal(sessionFor('US100.cash'), 'futures') // with the broker suffix
    assert.equal(sessionFor('NQ=F'), 'futures')       // Yahoo futures suffix
})

test('an explicit asset_class always beats the symbol heuristic', () => {
    // A ticker that LOOKS like an equity but was authored as forex must trade the forex calendar.
    assert.equal(sessionFor('SOMETHING', 'forex'), 'forex')
    assert.equal(sessionFor('EURUSD', 'stock'), 'equity')
    assert.equal(sessionFor('AAPL', 'crypto'), 'crypto')
})

// ─── The gate ─────────────────────────────────────────────────────────────────

test('at 03:00 ET on a weekday forex trades and equities do not', () => {
    assert.equal(isMarketOpen(WED_0300_ET), false)
    assert.equal(isForexOpen(WED_0300_ET), true)
    assert.equal(isFuturesOpen(WED_0300_ET), true)

    // This is the regression: classless EURUSD used to fall through to the equity session and
    // report CLOSED here, which is what the get_quote rider would have told every desk.
    assert.equal(isAssetOpen('EURUSD', null, WED_0300_ET), true)
    assert.equal(isAssetOpen('AAPL', null, WED_0300_ET), false)
    assert.equal(isAssetOpen('BTCUSD', null, WED_0300_ET), true)
})

test('Saturday shuts everything except crypto', () => {
    assert.equal(isAssetOpen('AAPL', null, SAT_1200_ET), false)
    assert.equal(isAssetOpen('EURUSD', null, SAT_1200_ET), false)
    assert.equal(isAssetOpen('NQ', null, SAT_1200_ET), false)
    assert.equal(isAssetOpen('BTCUSD', null, SAT_1200_ET), true)
})

test('getMarketStatus carries the session and phase alongside the verdict', () => {
    const st = getMarketStatus('AAPL', 'stock', WED_1400_ET)
    assert.equal(st.open, true)
    assert.equal(st.session, 'equity')
    assert.equal(st.isCrypto, false)
    assert.equal(st.nextOpenMs, null, 'an open market has no next open to report')
    assert.ok(st.phase, 'a phase label is always present')
})

test('a closed market reports when it next opens, and it is in the future', () => {
    const st = getMarketStatus('AAPL', 'stock', SAT_1200_ET)
    assert.equal(st.open, false)
    assert.ok(st.nextOpenMs > SAT_1200_ET.getTime(), 'next open must be ahead of the instant asked about')
    assert.equal(st.nextOpenMs, nextMarketOpenMs(SAT_1200_ET), 'same answer as the underlying helper')
})

test('crypto is open at every instant and never reports a next open', () => {
    for (const at of [WED_1400_ET, WED_0300_ET, SAT_1200_ET]) {
        const st = getMarketStatus('BTCUSD', null, at)
        assert.equal(st.open, true)
        assert.equal(st.isCrypto, true)
        assert.equal(st.nextOpenMs, null)
    }
})

// ─── The formatter (what a model actually reads) ──────────────────────────────

test('an open market says so, and names the calendar', () => {
    const line = formatMarketStatus('AAPL', 'stock', WED_1400_ET)
    assert.match(line, /^AAPL: market is OPEN/)
    assert.match(line, /09:30–16:00 ET/)
    assert.doesNotMatch(line, /cannot be filled/)
})

test('a closed market says when it reopens and what that means for an order', () => {
    const line = formatMarketStatus('AAPL', 'stock', SAT_1200_ET)
    assert.match(line, /^AAPL: market is CLOSED/)
    assert.match(line, /Next open: Mon 09:30 ET/)
    assert.match(line, /in \d+d \d+h|in \d+h \d+m/, 'the wait is stated as a duration, not raw ms')
    // The part a desk acts on — it must not read as a neutral status line.
    assert.match(line, /cannot be filled until it reopens/)
})

test('crypto never claims to be closed', () => {
    const line = formatMarketStatus('BTCUSD', null, SAT_1200_ET)
    assert.match(line, /market is OPEN/)
    assert.match(line, /24\/7/)
})

test('forex at 03:00 reads as open on its own calendar, not the equity one', () => {
    const line = formatMarketStatus('EURUSD', null, WED_0300_ET)
    assert.match(line, /market is OPEN/)
    assert.match(line, /24\/5/)
})

// ─── The get_quote rider ──────────────────────────────────────────────────────

test('a text quote gets the status appended, original text intact', () => {
    const out = withMarketStatus('AAPL 250.10 +1.2%', 'AAPL')
    assert.match(out, /^AAPL 250\.10 \+1\.2%/)
    assert.match(out, /market is (OPEN|CLOSED)/)
})

test('an object payload gets a market_status field instead of being stringified', () => {
    const out = withMarketStatus({ price: 250.1 }, 'AAPL')
    assert.equal(out.price, 250.1)
    assert.match(out.market_status, /market is (OPEN|CLOSED)/)
})

test('a FAILED quote is never decorated — an error must not read like data', () => {
    const err = toolError('Could not fetch quote for AAPL: upstream down')
    assert.deepEqual(withMarketStatus(err, 'AAPL'), err)
})

test('nothing to say → the payload comes back untouched', () => {
    assert.equal(withMarketStatus('quote', null), 'quote', 'no ticker')
    assert.equal(withMarketStatus(null, 'AAPL'), null, 'no payload')
    assert.equal(withMarketStatus(undefined, 'AAPL'), undefined)
})

test('the annotation never throws, whatever the ticker looks like', () => {
    // A broken status read must not take a working quote down with it.
    for (const t of ['', '   ', '!!!', '💥', 'A'.repeat(200)]) {
        assert.doesNotThrow(() => withMarketStatus('quote', t || 'X'))
    }
})
