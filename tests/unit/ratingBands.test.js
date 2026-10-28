import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { _setClientFactory, closeDb } from '../../providers/mongodb.provider.js'
import { ratingBand, bandsText, MARKET_PA, MARGIN_PA } from '../../services/ratingBands.js'
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

test('no price → his rating stands, unchanged', async () => {
    _setCoverageIO({ getPrice: async () => null })
    const made = await coverageService.initiateCoverage(draft('NOP', 'buy', 120))
    assert.equal(made.ok, true)
    assert.equal(rows('coverage').find(d => d.symbol === 'NOP').rating, 'buy')
})
