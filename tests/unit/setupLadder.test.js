import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ladderFor, rungsBetween, bucketForMarketCap, MARKET_CAPS } from '../../services/setup.ladder.js'
import { TF_RUNGS, isFetchableRung } from '../../services/setup.schema.js'
import { TRADE_HORIZONS } from '../../services/entity/vocabulary.js'

// The ladder is the DEFAULT pace — what a setup is read on when nobody named a rung
// (docs/design/talos-two-tier.md §Phase 2). It is never an override: a named rung wins outright,
// and nothing here runs for that setup at all.

// ─── rungsBetween ─────────────────────────────────────────────────────────────

test('a spoken range is every rung between its endpoints, inclusive — not the two ends', () => {
    // The bug this exists to prevent: "15min to 1hr" filed as ["15min","1hr"] silently drops the
    // 30min from a user who asked for the band.
    assert.deepEqual(rungsBetween('15min', '1hr'), ['1hr', '30min', '15min'])
    assert.deepEqual(rungsBetween('4hr', 'day'), ['day', '4hr'])
    assert.deepEqual(rungsBetween('15min', '15min'), ['15min'], 'one rung stays one rung')
})

test('rungsBetween is order-agnostic and always returns coarse→fine', () => {
    assert.deepEqual(rungsBetween('1hr', '15min'), rungsBetween('15min', '1hr'))
    const r = rungsBetween('5min', 'day')
    const idx = r.map(tf => TF_RUNGS.indexOf(tf))
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b))
})

test('rungsBetween drops what the providers cannot serve and refuses what it cannot place', () => {
    // 1min is off-plan at FMP (402) — a rung whose fetch can only fail.
    assert.ok(!rungsBetween('1min', '15min').includes('1min'))
    assert.deepEqual(rungsBetween('fortnight', '1hr'), [])
    assert.deepEqual(rungsBetween(null, undefined), [])
})

test('rungsBetween accepts the loose spellings a trader actually types', () => {
    assert.deepEqual(rungsBetween('15m', '1h'), rungsBetween('15min', '1hr'))
    assert.deepEqual(rungsBetween('4h', 'daily'), rungsBetween('4hr', 'day'))
})

// ─── market cap ───────────────────────────────────────────────────────────────

test('market cap buckets at the usual boundaries, and an unusable number is null not a guess', () => {
    assert.equal(bucketForMarketCap(3.2e12), 'mega')
    assert.equal(bucketForMarketCap(200e9), 'mega', 'the floor is inclusive')
    assert.equal(bucketForMarketCap(45e9), 'large')
    assert.equal(bucketForMarketCap(4e9), 'mid')
    assert.equal(bucketForMarketCap(900e6), 'small')
    assert.equal(bucketForMarketCap(120e6), 'micro')
    for (const bad of [null, undefined, 0, -1, NaN, 'big', {}]) {
        assert.equal(bucketForMarketCap(bad), null, String(bad))
    }
})

// ─── the table ────────────────────────────────────────────────────────────────

test('every horizon × cap cell yields a non-empty, coarse→fine, fetchable ladder', () => {
    for (const h of TRADE_HORIZONS) {
        for (const cap of MARKET_CAPS) {
            const l = ladderFor(h, cap)
            assert.ok(l.length, `${h}/${cap} is empty`)
            assert.ok(l.every(isFetchableRung), `${h}/${cap} offers an unfetchable rung`)
            const idx = l.map(tf => TF_RUNGS.indexOf(tf))
            assert.deepEqual(idx, [...idx].sort((a, b) => a - b), `${h}/${cap} is out of order`)
        }
    }
})

test('the ladder gets COARSER as the cap falls — the whole reason cap is in the table', () => {
    // A 15-minute candle on a $2T name is structure; on a $200M name it is two prints and a spread.
    for (const h of ['intraday', 'day', 'swing']) {
        const mega  = ladderFor(h, 'mega')
        const micro = ladderFor(h, 'micro')
        const finest = (l) => TF_RUNGS.indexOf(l[l.length - 1])
        assert.ok(finest(micro) <= finest(mega), `${h}: micro is finer than mega`)
    }
})

test('the ladder gets COARSER as the horizon lengthens', () => {
    const coarsest = (l) => TF_RUNGS.indexOf(l[0])
    const order = ['intraday', 'day', 'swing', 'long term'].map(h => coarsest(ladderFor(h, 'large')))
    for (let i = 1; i < order.length; i++) {
        assert.ok(order[i] <= order[i - 1], `${i}: horizon got finer, not coarser`)
    }
})

test('a swing on a large cap reaches the daily for structure and the hour for the trigger', () => {
    assert.deepEqual(ladderFor('swing', 'large'), ['day', '4hr', '2hr', '1hr'])
})

test('an unknown horizon or cap falls to the middle rather than to nothing', () => {
    assert.deepEqual(ladderFor('scalp', 'mega'), ladderFor('day', 'mega'), 'unknown horizon → day')
    assert.deepEqual(ladderFor('swing', null), ladderFor('swing', 'mid'), 'unknown cap → mid')
    assert.ok(ladderFor(undefined, undefined).length)
})

test('never 1min, at any cell — it is off-plan at the provider', () => {
    for (const h of TRADE_HORIZONS) {
        for (const cap of MARKET_CAPS) {
            assert.ok(!ladderFor(h, cap).includes('1min'), `${h}/${cap}`)
        }
    }
})

// ─── Generate binds the cap, and the ladder follows (Phase 7) ──────────────────

test('a spoken range expands to every rung between — the case Mentor sees most', () => {
    // The prompt tells Mentor to file the expansion, not the endpoints. This is the arithmetic it
    // is filing against, and getting it wrong drops a rung nobody notices for weeks.
    assert.deepEqual(rungsBetween('15min', '1hr'), ['1hr', '30min', '15min'])
    assert.deepEqual(rungsBetween('4hr', 'day'), ['day', '4hr'])
})

test('an unknown cap is not a reason to refuse a setup — it lands in the middle', () => {
    // getMarketCap returns null on any provider failure, and bucketForMarketCap passes that through.
    assert.equal(bucketForMarketCap(null), null)
    assert.deepEqual(ladderFor('swing', bucketForMarketCap(null)), ladderFor('swing', 'mid'))
})
