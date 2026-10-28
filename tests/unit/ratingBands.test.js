import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { _setClientFactory, closeDb } from '../../providers/mongodb.provider.js'
import { ratingBand, bandsText, MARKET_PA, MARGIN_PA, RERATE_KIND } from '../../services/ratingBands.js'
import { coverageService, _setCoverageIO, houseRatingNote } from '../../api/analyst/coverage.service.js'

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
    assert.deepEqual(b, { rating: 'buy', implied_pct: 4.5, market_pct: 2, excess_pct: 2.5, margin_pct: 2, horizon: '3m' })
    assert.equal(ratingBand({ target: 104.5, price: 100, horizon: '12m' }).rating, 'hold', 'the same +4.5% over a year is a hold')
    assert.equal(ratingBand({ target: 140, price: 100, horizon: '24m' }).rating, 'buy', '+40% over two years: SPY ~+16%, buy from +32%')
    assert.equal(ratingBand({ target: 110, price: 100 }).horizon, '12m', 'no horizon: the house convention')
    assert.match(bandsText('6m'), /^6m: SPY ~\+4% — strong buy from \+12%, buy from \+8%, sell at \+0% or under/)
})

test('the prompt\'s table is the code\'s bands — every horizon, every line', async () => {
    const { readFileSync } = await import('node:fs')
    const prompt = readFileSync(new URL('../../prompts/analyst_system_prompt.md', import.meta.url), 'utf8')
    const sign = (v) => (v > 0 ? `+${v}%` : v < 0 ? `−${-v}%` : '0%')
    for (const h of ['3m', '6m', '12m', '18m', '24m']) {
        const b = ratingBand({ target: 100, price: 100, horizon: h })
        const m = b.market_pct, g = b.margin_pct
        const row = `| ${h.padEnd(3)} | +${m}%`.replace(/\s+\|/, ' |')
        assert.ok(prompt.includes(`| ${h}`), `${h} row`)
        const line = prompt.split('\n').find(l => l.trim().startsWith(`| ${h} `))
        assert.ok(line, row)
        assert.deepEqual(line.split('|').map(s => s.trim()).filter(Boolean),
            [h, `+${m}%`, `≥ ${sign(m + 2 * g)}`, `≥ ${sign(m + g)}`, 'between', `≤ ${sign(m - g)}`, `≤ ${sign(m - 2 * g)}`])
    }
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

test('no price → his rating stands, unchanged', async () => {
    _setCoverageIO({ getPrice: async () => null })
    const made = await coverageService.initiateCoverage(draft('NOP', 'buy', 120))
    assert.equal(made.ok, true)
    assert.equal(rows('coverage').find(d => d.symbol === 'NOP').rating, 'buy')
})
