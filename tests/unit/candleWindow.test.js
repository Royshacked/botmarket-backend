import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowStartSec } from '../../services/ohlcv.service.js'
import { _resolveSecRange, fetchStartMs } from '../../services/price.service.js'

// THE WINDOW A MONITOR SEES.
//
// The monitor's app-feed candles come through ohlcv → price.service, and neither had a test. What
// that hid: the READ window was a flat 30 days no matter what was asked for. A caller wanting 300
// daily candles — which is what the monitor asks for, CANDLE_COUNT = 300 — got the ~22 trading days
// that fit in a month, and every indicator with a longer lookback read n/a.
//
// Nothing failed. The series was simply short, so a condition written on SMA-200 could never come
// true, and the only trace was indicator.evaluator's warmup warning — the same bug seen from the
// far end, where it looks like a data hiccup rather than a window.

const DAY = 86_400

// ── the window a request needs ────────────────────────────────────────────────

test('300 daily bars reaches back far enough to actually hold 300 trading days', () => {
    const back = (Math.floor(Date.now() / 1000) - windowStartSec({ timeSpan: 'day', multiplier: 1 }, 300)) / DAY
    // 300 trading days is ~420 calendar days before holidays. Anything near 30 is the old bug.
    assert.ok(back > 420, `only ${Math.round(back)} calendar days — cannot contain 300 trading days`)
})

test('a long lookback on the weekly reaches back years, not a month', () => {
    const back = (Math.floor(Date.now() / 1000) - windowStartSec({ timeSpan: 'week', multiplier: 1 }, 100)) / DAY
    assert.ok(back > 700, `${Math.round(back)} days cannot contain 100 weekly bars`)
})

test('a small request still floors at the old 30 days — nothing regresses', () => {
    // The floor is what makes this change safe for every caller that was already satisfied: a
    // 20-bar daily ask used to get a 30-day window and still does.
    const back = (Math.floor(Date.now() / 1000) - windowStartSec({ timeSpan: 'day', multiplier: 1 }, 20)) / DAY
    assert.ok(back >= 30, `${back} days is below the floor`)
    assert.ok(back < 60, `${back} days over-reaches for a 20-bar request`)
})

test('intraday buys calendar slack, because a session is a fraction of a day', () => {
    // 300 five-minute bars is 25 hours of MARKET time and about four trading days — but they only
    // arrive during sessions, so the calendar window has to be far wider than the arithmetic.
    const back = (Math.floor(Date.now() / 1000) - windowStartSec({ timeSpan: 'minute', multiplier: 5 }, 300)) / DAY
    assert.ok(back >= 6, `${back} days is too tight for 300 five-minute session bars`)
})

test('a junk count is a request for one bar, not a crash or an empty window', () => {
    for (const bad of [0, -5, NaN, null, undefined, 'x']) {
        const back = Math.floor(Date.now() / 1000) - windowStartSec({ timeSpan: 'day', multiplier: 1 }, bad)
        assert.ok(back >= 30 * DAY, `count=${bad} produced a window of ${back}s`)
    }
})

// ── one window, for fetch AND read ────────────────────────────────────────────

test('a window given in MILLISECONDS is honoured by the read, not just the fetch', () => {
    // The exact divergence: _resolveFetchWindow accepted `from`/`to` in ms, _resolveSecRange only
    // accepted fromSec/toSec. So asking in ms widened what was fetched and STORED, and returned
    // thirty days regardless — bars written to the cache that could never be read back out.
    const fromMs = Date.now() - 400 * DAY * 1000
    const { fromSec } = _resolveSecRange({ from: fromMs })
    assert.equal(fromSec, Math.floor(fromMs / 1000))
})

test('seconds still work, and are not double-converted', () => {
    const fromSec = Math.floor(Date.now() / 1000) - 400 * DAY
    assert.equal(_resolveSecRange({ fromSec }).fromSec, fromSec)
})

test('naming no window at all still means the last 30 days', () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const { fromSec, toSec } = _resolveSecRange({})
    assert.ok(Math.abs(toSec - nowSec) <= 2)
    assert.ok(Math.abs((nowSec - fromSec) - 30 * DAY) <= 2)
})

// ── where a fetch starts: the tail, or a one-off backfill ─────────────────────
//
// The trap in widening the window. ohlcv now names a start, and syncCandles used to skip its
// incremental fetch whenever a start was named — so every intraday tick (which passes `refresh`,
// so it syncs on EVERY wake) would have re-pulled the entire window instead of the few new bars.
// That is the same self-inflicted quota burn that once had FMP answering 429, arriving by the
// back door of a fix for something else.

const SEC = { step: 86_400, now: Math.floor(Date.now() / 1000) }

test('cache already covers the request → fetch only the new tail', () => {
    const start = fetchStartMs({
        requestedFromMs: (SEC.now - 100 * DAY) * 1000,   // asked for 100 days
        toMs: Date.now(),
        earliestTs: SEC.now - 400 * DAY,                 // cache holds 400
        latestTs:   SEC.now - DAY,
        stepSec: SEC.step,
    })
    assert.equal(start, (SEC.now - DAY + SEC.step) * 1000, 'must resume from the newest bar, not the request')
})

test('request reaches further back than the cache → backfill the whole window, once', () => {
    const asked = (SEC.now - 500 * DAY) * 1000
    const start = fetchStartMs({
        requestedFromMs: asked,
        toMs: Date.now(),
        earliestTs: SEC.now - 30 * DAY,   // cache only holds 30
        latestTs:   SEC.now - DAY,
        stepSec: SEC.step,
    })
    assert.equal(start, asked, 'an incremental fetch only adds to the NEWEST end — the gap would never fill')
})

test('an empty cache fetches the whole requested window', () => {
    const asked = (SEC.now - 500 * DAY) * 1000
    assert.equal(fetchStartMs({ requestedFromMs: asked, toMs: Date.now(), earliestTs: null, latestTs: null, stepSec: SEC.step }), asked)
})

test('no window named and nothing cached → the 30-day default, as before', () => {
    const toMs = Date.now()
    assert.equal(fetchStartMs({ toMs, earliestTs: null, latestTs: null, stepSec: SEC.step }), toMs - 30 * DAY * 1000)
})

test('no window named but a cache present → still the tail', () => {
    const start = fetchStartMs({ toMs: Date.now(), earliestTs: SEC.now - 30 * DAY, latestTs: SEC.now - DAY, stepSec: SEC.step })
    assert.equal(start, (SEC.now - DAY + SEC.step) * 1000)
})
