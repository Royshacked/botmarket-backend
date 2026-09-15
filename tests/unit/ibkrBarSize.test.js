import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toIbBarSize } from '../../api/broker/adapters/ibkr.adapter.js'

// The monitor speaks ONE timeframe vocabulary — '5min' / '1hr' / 'day' (monitorUtils.fetchCandles
// passes the idea's own tf straight to brokerService.getCandles). IBKR's map only knew the legacy
// 'minutes' / 'hours' / 'daily' labels, so every app timeframe missed it, logged "unknown", and
// came back as DAILY bars — for an adapter whose `ohlcv:true` tells the monitor to prefer them.
// This is the sibling of ctraderTrendbars.test.js, pinning the same contract on the other adapter.

test('app timeframes resolve to the matching IB bar width', () => {
    assert.equal(toIbBarSize('1min').barSize,  '1 min')
    assert.equal(toIbBarSize('5min').barSize,  '5 mins')
    assert.equal(toIbBarSize('15min').barSize, '15 mins')
    assert.equal(toIbBarSize('1hr').barSize,   '1 hour')
    assert.equal(toIbBarSize('4hr').barSize,   '4 hours')
    assert.equal(toIbBarSize('day').barSize,   '1 day')
    assert.equal(toIbBarSize('week').barSize,  '1 week')
    assert.equal(toIbBarSize('month').barSize, '1 month')
})

test('an intraday timeframe is never answered with daily bars', () => {
    for (const tf of ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr']) {
        assert.notEqual(toIbBarSize(tf)?.barSize, '1 day', `${tf} must not degrade to daily`)
    }
})

test('legacy labels still resolve (parseTimeframe keeps them)', () => {
    assert.equal(toIbBarSize('minutes').barSize, '5 mins')
    assert.equal(toIbBarSize('hours').barSize,   '1 hour')
    assert.equal(toIbBarSize('daily').barSize,   '1 day')
    assert.equal(toIbBarSize('weekly').barSize,  '1 week')
    assert.equal(toIbBarSize('monthly').barSize, '1 month')
})

test('a width IB has no bar for is null → getCandles hands off to the app feed', () => {
    assert.equal(toIbBarSize('7min'), null)
    assert.equal(toIbBarSize('12hr'), null)   // cTrader has H12; IB does not
    assert.equal(toIbBarSize('garbage'), null)
})

test('every entry carries a duration the socket request needs', () => {
    for (const tf of ['1min', '5min', '1hr', 'day', 'week', 'month']) {
        const r = toIbBarSize(tf)
        assert.match(r.duration, /^\d+ [SDWMY]$/, `${tf} duration "${r.duration}" is an IB duration string`)
    }
})

test('a missing timeframe defaults to daily, as parseTimeframe does', () => {
    assert.equal(toIbBarSize(undefined).barSize, '1 day')
})
