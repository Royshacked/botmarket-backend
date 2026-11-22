import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { _setClientFactory, closeDb } from '../../providers/mongodb.provider.js'
import { ratingBand, bandsText, MARKET_PA, MARGIN_PA, SIGMA_MARGIN, RERATE_KIND, horizonSigmaPct, horizonSigmaPctFromDaily, stickyBand, HYSTERESIS } from '../../services/ratingBands.js'
import { coverageService, _setCoverageIO, houseRatingNote, withTargetRef } from '../../api/analyst/coverage.service.js'
import { targetWay, classifyGapState } from '../../monitoring/coverage.assess.js'
import { _dailyRerate } from '../../monitoring/coverage.monitor.service.js'
import { callBand, refPriceFromCalls } from '../../services/prometheusCalls.service.js'

// The house's rating bands (Roy, 2026-10-28: "relative to SPY, build it"): a rating is the band of the target's implied
// return against SPY's over the horizon — not a direction Prometheus picks (his holds ran −30% … +37% at the call).

test('12 months: SPY ~+8%; buy from +16%, strong buy from +24%; sell at 0% or under, strong sell at −8%; hold between', () => {
    assert.equal(MARKET_PA, 8); assert.equal(MARGIN_PA, 8)
    const at = (pct) => ratingBand({ target: 100 * (1 + pct / 100), price: 100, horizon: '12m' }).rating
    assert.equal(at(30), 'strong_buy'); assert.equal(at(24), 'strong_buy')
    assert.equal(at(20), 'buy'); assert.equal(at(16), 'buy')
    assert.equal(at(15), 'hold'); assert.equal(at(3), 'hold'); assert.equal(at(1), 'hold')
    assert.equal(at(0), 'sell'); assert.equal(at(-5), 'sell')
    assert.equal(at(-8), 'strong_sell'); assert.equal(at(-30), 'strong_sell')
})

test('the bands scale with the horizon — a 3-month target needs a quarter of it', () => {
    const b = ratingBand({ target: 104.5, price: 100, horizon: '3m' })
    assert.deepEqual(b, { rating: 'buy', implied_pct: 4.5, market_pct: 2, excess_pct: 2.5, margin_pct: 2, basis: 'flat', sigma_pct: null, capped: false, horizon: '3m' })
    assert.equal(ratingBand({ target: 104.5, price: 100, horizon: '12m' }).rating, 'hold', 'the same +4.5% over a year is a hold')
    assert.equal(ratingBand({ target: 140, price: 100, horizon: '24m' }).rating, 'buy', '+40% over two years: SPY ~+16%, buy from +32%')
    assert.equal(ratingBand({ target: 110, price: 100 }).horizon, '12m', 'no horizon: the house convention')
    assert.match(bandsText('6m'), /^6m: SPY ~\+4% — strong buy from \+12%, buy from \+8%, sell at \+0% or under/)
})

// 2026-11-21: the prompt states the σ bands; its row must be the code's margin, and its worked example the code's answer.
test('the prompt\'s table is the code\'s σ bands, and its worked example adds up', async () => {
    const { readFileSync } = await import('node:fs')
    const prompt = readFileSync(new URL('../../prompts/analyst_system_prompt.md', import.meta.url), 'utf8')
    const line = prompt.split(/\r?\n/).find(l => l.trim().startsWith('| in the stock\'s σ'))
    assert.ok(line, 'the σ row')
    const g = SIGMA_MARGIN, s = (k) => `${k * g}σ`.replace(/^0\./, '0.')
    assert.deepEqual(line.split('|').map(x => x.trim()).filter(Boolean),
        ['in the stock\'s σ over the horizon', `≥ +${s(2)}`, `≥ +${s(1)}`, 'between', `≤ −${s(1)}`, `≤ −${s(2)}`])
    // "a stock with a 20% three-month σ needs about +7% for a buy and +12% for a strong buy; a quiet one with 8% +4% and +6%"
    const at = (pct, sig) => ratingBand({ target: 100 + pct, price: 100, horizon: '3m', sigma_pct: sig }).rating
    assert.deepEqual([at(7, 20), at(6.9, 20), at(12, 20), at(4, 8), at(6, 8)], ['buy', 'hold', 'strong_buy', 'buy', 'strong_buy'])
    assert.match(prompt, /`low` conviction is never "strong"/)
})

// Roy, 2026-11-21 (263 open calls on prod): the margin in the stock's own σ over the horizon, 0.25σ / 0.5σ.
test('σ bands: the margin is 0.25σ over the horizon, strong at 0.5σ — the same % is a buy on a quiet name, a hold on a wild one', () => {
    assert.equal(SIGMA_MARGIN, 0.25)
    const b = ratingBand({ target: 110, price: 100, horizon: '3m', sigma_pct: 18 })
    assert.deepEqual(b, { rating: 'buy', implied_pct: 10, market_pct: 2, excess_pct: 8, margin_pct: 4.5, basis: 'sigma', sigma_pct: 18, capped: false, horizon: '3m' })
    assert.equal(ratingBand({ target: 110, price: 100, horizon: '3m', sigma_pct: 40 }).rating, 'hold', '+8% over SPY inside a 40% σ is noise')
    assert.equal(ratingBand({ target: 110, price: 100, horizon: '3m', sigma_pct: 10 }).rating, 'strong_buy')
    // The old flat 3m bands made −2% a strong sell; in an 18% σ it is a hold.
    assert.equal(ratingBand({ target: 98, price: 100, horizon: '3m' }).rating, 'strong_sell')
    assert.equal(ratingBand({ target: 98, price: 100, horizon: '3m', sigma_pct: 18 }).rating, 'hold')
    assert.equal(ratingBand({ target: 88, price: 100, horizon: '3m', sigma_pct: 18 }).rating, 'strong_sell', '−14% over SPY ≥ 0.5σ')
    // No usable σ → the flat margin, said so.
    for (const s of [null, 0, -5, NaN, 'x']) assert.equal(ratingBand({ target: 104.5, price: 100, horizon: '3m', sigma_pct: s }).basis, 'flat', String(s))
})

test('a LOW conviction is never strong — capped at buy / sell; medium and high are not', () => {
    const at = (target, conviction) => ratingBand({ target, price: 100, horizon: '12m', sigma_pct: 40, conviction })
    assert.deepEqual([at(140, 'low').rating, at(140, 'low').capped], ['buy', true])
    assert.deepEqual([at(60, 'low').rating, at(60, 'low').capped], ['sell', true])
    assert.equal(at(140, 'medium').rating, 'strong_buy'); assert.equal(at(140, 'high').rating, 'strong_buy'); assert.equal(at(140, null).rating, 'strong_buy')
    assert.deepEqual([at(120, 'low').rating, at(120, 'low').capped], ['buy', false], 'a buy is not capped')
})

test('σ over a horizon: a month\'s σ × √months, in %; a day\'s × √(21 × months)', () => {
    assert.equal(horizonSigmaPct(0.1, '3m'), 17.3)
    assert.equal(horizonSigmaPct(0.1, '12m'), 34.6)
    assert.equal(horizonSigmaPct(0.1, null), 34.6, 'no horizon: 12m')
    assert.equal(horizonSigmaPctFromDaily(0.02, '3m'), 15.9)
    for (const s of [null, 0, -0.1, NaN]) assert.equal(horizonSigmaPct(s, '3m'), null)
})

test('no target or no price → no band (his rating stands; market data never blocks research)', () => {
    assert.equal(ratingBand({ target: null, price: 100 }), null)
    assert.equal(ratingBand({ target: 120, price: 0 }), null)
    assert.equal(ratingBand({}), null)
})

test('the re-rating says what it did — and nothing when his rating already sat in the band', () => {
    const band = ratingBand({ target: 137, price: 100, horizon: '12m' })
    assert.equal(houseRatingNote({ band, from: 'hold' }), 'Rated strong buy by the house bands: the target is +37% against SPY\'s ~+8% over 12m (hold given)')
    assert.equal(houseRatingNote({ band, from: undefined }), null)
})

const { db, rows } = memDb()
const restore = _setClientFactory(() => ({ connect: async () => {}, db: () => db, close: async () => {} }))
process.env.MONGODB_URI ??= 'mongodb://fake.invalid/test'
await closeDb()
after(async () => { await closeDb(); restore?.() })
// No σ unless a test gives one — the saves below are the flat bands' cases, and a real σ read is the candle stack.
_setCoverageIO({ getSigma: async () => null })
const draft = (symbol, rating, value, horizon = '12m') => ({ symbol, sector: 'Technology', thesis: 't', rating, price_target: { value, horizon, basis: 'b' } })

test('a save takes the house\'s rating: a +37% "hold" initiates as a strong buy, the trail says why; an update re-rates', async () => {
    _setCoverageIO({ getPrice: async () => 100, getMultipleHistory: async () => [], sectorRaw: async () => ({ sector: 'Technology', industry: 'Software' }) })
    const made = await coverageService.initiateCoverage(draft('HLD', 'hold', 137))
    assert.equal(made.ok, true)
    const doc = rows('coverage').find(d => d.symbol === 'HLD')
    assert.equal(doc.rating, 'strong_buy')
    assert.match(doc.revisions[0].note, /Rated strong buy by the house bands: the target is \+37%.*\(hold given\)/)

    const upd = await coverageService.updateCoverage(doc.id, { price_target: { value: 105, horizon: '12m', basis: 'b' }, revision_note: 'Cut on the guide' })
    assert.equal(upd.ok, true)
    assert.equal(upd.doc.rating, 'hold', '+5% over a year is a hold')
    assert.equal(rows('coverage').find(d => d.symbol === 'HLD').rating, 'hold', 'saved, not just shown')
    assert.match(upd.doc.revisions[0].note, /^Cut on the guide\. Rated hold by the house bands/)

    // A sell whose target is ABOVE the price (the old direction gate's case) is now a band like any other.
    const sell = await coverageService.initiateCoverage(draft('SLL', 'sell', 110, '3m'))
    assert.equal(sell.ok, true)
    assert.equal(rows('coverage').find(d => d.symbol === 'SLL').rating, 'strong_buy', '+10% in 3 months is far over SPY\'s ~+2%')
})

// 2026-10-28: 84% of the book sat on 12m and nothing told a chosen 12m from a default.
test('a target with no horizon stores as 12m and SAYS so; a horizon given later clears the mark', async () => {
    _setCoverageIO({ getPrice: async () => 100, getMultipleHistory: async () => [], sectorRaw: async () => ({ sector: 'Technology', industry: 'Software' }) })
    const made = await coverageService.initiateCoverage({ symbol: 'NOH', sector: 'Technology', thesis: 't', rating: 'buy', price_target: { value: 130, basis: 'b' } })
    assert.equal(made.ok, true)
    const doc = rows('coverage').find(d => d.symbol === 'NOH')
    assert.deepEqual([doc.price_target.horizon, doc.price_target.horizon_defaulted], ['12m', true])
    const kept = await coverageService.updateCoverage(doc.id, { thesis: 't2' })
    assert.equal(kept.doc.price_target.horizon_defaulted, true, 'kept through an update that does not touch the target')
    const chosen = await coverageService.updateCoverage(doc.id, { price_target: { value: 130, horizon: '12m', basis: 'b' } })
    assert.equal(chosen.doc.price_target.horizon_defaulted, undefined, 'chosen now')
    const given = await coverageService.initiateCoverage(draft('HAS', 'buy', 130, '6m'))
    assert.equal(given.ok, true)
    assert.equal(rows('coverage').find(d => d.symbol === 'HAS').price_target.horizon_defaulted, undefined)
})

// Roy, 2026-10-28: the bands apply on a save, so live coverage kept its old rating until its next re-model.
test('re-rating live coverage relabels it by its own target — the target untouched, the trail says why, a dry run writes nothing', async () => {
    _setCoverageIO({ getPrice: async () => 100 })
    const id = 'cov_OLD_1'
    rows('coverage').push({ id, symbol: 'OLD', status: 'active', rating: 'hold', price_target: { value: 130, horizon: '12m', set_at: '2026-09-01T00:00:00.000Z' }, revisions: [] })
    await new Promise(r => setTimeout(r, 50))   // the tests before log calls fire-and-forget: let theirs land first
    const callsBefore = rows('prometheus_calls').length
    const dry = await coverageService.rerateCoverage(id, { dry: true })
    assert.deepEqual([dry.outcome, dry.from, dry.to], ['rerated', 'hold', 'strong_buy'])
    assert.equal(rows('coverage').find(d => d.id === id).rating, 'hold', 'dry: nothing written')
    const done = await coverageService.rerateCoverage(id)
    assert.equal(done.outcome, 'rerated')
    const doc = rows('coverage').find(d => d.id === id)
    assert.equal(doc.rating, 'strong_buy')
    assert.equal(doc.price_target.value, 130, 'his target stands')
    assert.equal(doc.revisions[0].kind, RERATE_KIND)
    assert.deepEqual(doc.revisions[0].changed, { rating: { from: 'hold', to: 'strong_buy' } })
    assert.equal((await coverageService.rerateCoverage(id)).outcome, 'same', 'twice is once')
    await new Promise(r => setTimeout(r, 50))   // a logged call is fire-and-forget: give one the time to land
    assert.equal(rows('prometheus_calls').length, callsBefore, 'a relabel is not a call')
})

test('the scorecard\'s seed undoes a relabel but never makes a call of it', async () => {
    const { callsFromTrail } = await import('../../services/prometheusCalls.backfill.js')
    const cov = { id: 'c', symbol: 'X', created_at: '2026-08-01T00:00:00.000Z', rating: 'strong_buy',
        price_target: { value: 130, horizon: '12m', set_at: '2026-08-01T00:00:00.000Z' },
        revisions: [{ at: '2026-10-28T00:00:00.000Z', kind: RERATE_KIND, changed: { rating: { from: 'hold', to: 'strong_buy' } } }] }
    const calls = callsFromTrail(cov)
    assert.deepEqual(calls.map(c => c.state.rating), ['hold'], 'his one call, as he made it')
})

// 2026-11-21 — a save reads the σ and the conviction, and the target keeps the price and σ it was set against.
test('a save rates in the stock\'s σ under its conviction, and the target keeps its reference until it is re-set', async () => {
    _setCoverageIO({ getPrice: async () => 100, getSigma: async () => 20, getMultipleHistory: async () => [], sectorRaw: async () => ({ sector: 'Technology', industry: 'Software' }) })
    // +14% over 3m in a 20% σ: excess 12 ≥ 0.5σ (10) → strong buy; LOW conviction caps it at buy, and the trail says so.
    const made = await coverageService.initiateCoverage({ ...draft('SIG', 'strong_buy', 114, '3m'), conviction: { level: 'low', score: 0.3, rationale: 'r' } })
    assert.equal(made.ok, true)
    let doc = rows('coverage').find(d => d.symbol === 'SIG')
    assert.equal(doc.rating, 'buy')
    assert.deepEqual([doc.price_target.ref_price, doc.price_target.sigma_pct], [100, 20])
    assert.match(doc.revisions[0].note, /0\.25σ of the stock's 20%\), capped by low conviction \(strong buy given\)/)
    // Conviction raised, nothing else: the cap lifts — re-banded to strong buy; the target's reference is untouched.
    const up = await coverageService.updateCoverage(doc.id, { conviction: { level: 'medium', score: 0.6, rationale: 'r' } })
    assert.equal(up.ok, true)
    doc = rows('coverage').find(d => d.symbol === 'SIG')
    assert.equal(doc.rating, 'strong_buy')
    assert.equal(doc.price_target.ref_price, 100, 'a conviction change is not a new target')
    // The price moves. The same target restated (keepClock): the reference stays. A new value: a new one at today's price.
    _setCoverageIO({ getPrice: async () => 104 })
    await coverageService.updateCoverage(doc.id, { price_target: { value: 114, horizon: '3m', basis: 'b' } })
    assert.equal(rows('coverage').find(d => d.symbol === 'SIG').price_target.ref_price, 100, 'reaffirmed: its reference kept')
    await coverageService.updateCoverage(doc.id, { price_target: { value: 120, horizon: '3m', basis: 'b' } })
    assert.deepEqual([rows('coverage').find(d => d.symbol === 'SIG').price_target.ref_price, rows('coverage').find(d => d.symbol === 'SIG').price_target.sigma_pct], [104, 20])
    _setCoverageIO({ getSigma: async () => null })
})

test('the daily re-rate follows the price but keeps the target\'s reference; a draft cannot write its own reference', async () => {
    _setCoverageIO({ getPrice: async () => 100, getSigma: async () => null })
    const id = 'cov_REF_1'
    rows('coverage').push({ id, symbol: 'REF', status: 'active', rating: 'strong_buy', price_target: { value: 130, horizon: '12m', set_at: '2026-09-01T00:00:00.000Z', ref_price: 100 }, revisions: [] })
    const res = await coverageService.rerateCoverage(id, { price: 120 })
    assert.deepEqual([res.outcome, res.to], ['rerated', 'hold'], '+8.3% at 120 trails the market')
    const doc = rows('coverage').find(d => d.id === id)
    assert.deepEqual([doc.rating, doc.price_target.ref_price, doc.price_target.value], ['hold', 100, 130])
    // withTargetRef: a new target takes the band's price; a reaffirmed one (same set_at) keeps the stored reference.
    const house = { price: 50.126, band: { sigma_pct: 12 } }
    assert.deepEqual(withTargetRef({ value: 60, set_at: 'b', ref_price: 1 }, { set_at: 'a', ref_price: 40 }, house), { value: 60, set_at: 'b', ref_price: 50.13, sigma_pct: 12 })
    assert.deepEqual(withTargetRef({ value: 60, set_at: 'a' }, { set_at: 'a', ref_price: 40, sigma_pct: 9 }, house), { value: 60, set_at: 'a', ref_price: 40, sigma_pct: 9 })
    assert.equal(withTargetRef(null, null, house), null)
})

// 2026-11-22 — the flip-flop guard: a label following the price leaves its band only once clearly past the edge.
test('the guard holds a label within 0.2 × the margin past its edge, and lets it go beyond', () => {
    // 12m flat: SPY +8, margin 8 — buy from excess 8, the guard 1.6 either side.
    const at = (target) => ratingBand({ target, price: 100, horizon: '12m' })
    assert.equal(HYSTERESIS, 0.2)
    assert.deepEqual([stickyBand(at(117), 'hold').rating, stickyBand(at(117), 'hold').held], ['hold', true], 'excess 9 < 9.6: still a hold')
    assert.equal(stickyBand(at(118), 'hold').rating, 'buy', 'excess 10 is past the guard')
    assert.equal(stickyBand(at(115), 'buy').rating, 'buy', 'excess 7 > 6.4: still a buy')
    assert.equal(stickyBand(at(114), 'buy').rating, 'hold', 'excess 6 is past it')
    assert.equal(stickyBand(at(130), 'hold').rating, 'strong_buy', 'two bands away is never held')
    assert.equal(stickyBand(at(117), 'buy').held, undefined, 'the same band is just the band')
    assert.equal(stickyBand(at(117), null).rating, 'buy', 'no label yet → the band')
    // LOW conviction: a buy is held all the way up (its strong side is capped onto it); a strong label is never held.
    const low = (target) => ratingBand({ target, price: 100, horizon: '12m', conviction: 'low' })
    assert.equal(stickyBand(low(140), 'buy', { conviction: 'low' }).rating, 'buy')
    assert.equal(stickyBand(ratingBand({ target: 123, price: 100, horizon: '12m', conviction: 'low' }), 'strong_buy', { conviction: 'low' }).rating, 'buy')
    // In σ: a 20% σ → margin 5; a hold is held to excess < 6.
    assert.equal(stickyBand(ratingBand({ target: 113.5, price: 100, horizon: '12m', sigma_pct: 20 }), 'hold').rating, 'hold')
})

test('the daily re-rate keeps a label near its edge — no revision — and lets it go past the guard', async () => {
    _setCoverageIO({ getPrice: async () => 100, getSigma: async () => null })
    const id = 'cov_EDGE_1'
    rows('coverage').push({ id, symbol: 'EDGE', status: 'active', rating: 'buy', price_target: { value: 115, horizon: '12m', set_at: '2026-09-01T00:00:00.000Z', ref_price: 100 }, revisions: [] })
    assert.equal((await coverageService.rerateCoverage(id, { price: 100 })).outcome, 'same', 'excess 7: inside the guard')
    assert.equal(rows('coverage').find(d => d.id === id).revisions.length, 0)
    assert.deepEqual(await coverageService.rerateCoverage(id, { price: 101 }).then(r => [r.outcome, r.to]), ['rerated', 'hold'], 'excess 5.9: past it')
})

test('the backfill takes a target\'s set-price from the call that froze it — same coverage, same value, nearest its set_at', () => {
    const cov = { id: 'c1', symbol: 'X', price_target: { value: 130, set_at: '2026-10-01T15:00:00.000Z' } }
    const calls = [
        { coverage_id: 'c1', pt: 120, made_at: '2026-10-01T15:00:00.000Z', entry: { price: 90 } },      // another target
        { coverage_id: 'c1', pt: 130, made_at: '2026-09-01T15:00:00.000Z', entry: { price: 95 } },      // same value, earlier
        { coverage_id: 'c1', pt: 130, made_at: '2026-10-01T15:00:01.000Z', entry: { price: 101.5 } },   // the one
        { coverage_id: 'c2', pt: 130, made_at: '2026-10-01T15:00:00.000Z', entry: { price: 70 } },      // another coverage
        { coverage_id: 'c1', pt: 130, made_at: '2026-10-01T15:00:00.000Z', entry: null },               // not entered yet
    ]
    assert.equal(refPriceFromCalls(cov, calls), 101.5)
    assert.equal(refPriceFromCalls(cov, calls.slice(0, 1)), null, 'no call of this target → left')
    assert.equal(refPriceFromCalls({ ...cov, price_target: { value: null } }, calls), null)
    assert.equal(refPriceFromCalls(cov, undefined), null)
})

test('a target is hit by the way it POINTED when set — a hold\'s too; a re-banded rating cannot turn it round', () => {
    const cov = (rating, value, ref) => ({ rating, price_target: { value, ...(ref ? { ref_price: ref } : {}) } })
    assert.equal(targetWay(cov('hold', 110, 100)), 1)
    assert.equal(targetWay(cov('strong_buy', 90, 100)), -1, 'the reference beats the label')
    assert.equal(targetWay(cov('buy', 110)), 1, 'no reference: the rating')
    assert.equal(targetWay(cov('hold', 110)), 0, 'no reference, a hold: none (as before)')
    assert.equal(classifyGapState(cov('hold', 110, 100), { price: 111 }).state, 'target_hit')
    // DVN: a strong sell at $49.36 from $50.31 — re-banded to strong buy at $41.54 it is still a target reached.
    assert.equal(classifyGapState(cov('strong_buy', 49.36, 50.31), { price: 41.54 }).state, 'target_hit')
    assert.equal(classifyGapState(cov('hold', 110, 100), { price: 105 }).state, 'stable')
})

test('the monitor\'s daily re-rate stands down on a reached target, and a failure leaves the label', async () => {
    const seen = []
    const deps = { rerate: async (id, price) => { seen.push([id, price]); return { outcome: 'rerated', from: 'buy', to: 'hold' } } }
    assert.equal((await _dailyRerate({ id: 'a', symbol: 'A' }, 50, { state: 'stable' }, deps)).outcome, 'rerated')
    assert.deepEqual(seen, [['a', 50]], 'today\'s price handed on — no second read')
    for (const [cov, v] of [[{ id: 'b' }, { state: 'target_hit' }], [{ id: 'c' }, { state: 'target_hit_early' }], [{ id: 'd', status: 'target_hit' }, { state: 'stable' }]]) {
        assert.equal(await _dailyRerate(cov, 50, v, deps), null, `${cov.id} stands down`)
    }
    assert.equal(await _dailyRerate({ id: 'e' }, null, { state: 'stable' }, deps), null, 'no price, no re-rate')
    assert.equal(await _dailyRerate({ id: 'f' }, 50, { state: 'stable' }, {}), null, 'no rerate dep (a test harness): nothing')
    assert.equal(await _dailyRerate({ id: 'g' }, 50, { state: 'stable' }, { rerate: async () => { throw new Error('db') } }), null)
    assert.equal(seen.length, 1)
})

test('the scorecard reads a call in the band it was made in — its σ and its conviction', () => {
    const call = { pt: 114, entry: { price: 100 }, horizon: '3m' }
    assert.equal(callBand(call), 'strong_buy', 'no σ recorded: the flat bands')
    assert.equal(callBand({ ...call, sigma_pct: 20 }), 'strong_buy')
    assert.equal(callBand({ ...call, sigma_pct: 20, conviction: 'low' }), 'buy')
    assert.equal(callBand({ ...call, sigma_pct: 60 }), 'hold')
})

test('no price → his rating stands, unchanged', async () => {
    _setCoverageIO({ getPrice: async () => null })
    const made = await coverageService.initiateCoverage(draft('NOP', 'buy', 120))
    assert.equal(made.ok, true)
    assert.equal(rows('coverage').find(d => d.symbol === 'NOP').rating, 'buy')
})
