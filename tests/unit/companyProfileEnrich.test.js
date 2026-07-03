import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enrichWithProfiles } from '../../services/companyProfile.util.js'

test('enrich: custom key reads the symbol from a different field (ticker)', async () => {
    const items = [{ ticker: 'AAPL' }, { ticker: 'MSFT' }]
    const fetchProfile = async (sym) => ({ name: `${sym} Inc`, logo: `logo/${sym}` })

    await enrichWithProfiles(items, { key: 'ticker', fetchProfile })

    assert.equal(items[0].logo, 'logo/AAPL')
    assert.equal(items[1].logo, 'logo/MSFT')
})

test('enrich: overwriteName=false keeps an existing name, fills a blank one', async () => {
    const items = [
        { ticker: 'AAPL', name: 'Agent Label' }, // keep
        { ticker: 'MSFT', name: '' },             // fill
        { ticker: 'TSLA' },                       // fill (absent)
    ]
    const fetchProfile = async (sym) => ({ name: `${sym} Inc`, logo: `logo/${sym}` })

    await enrichWithProfiles(items, { key: 'ticker', overwriteName: false, fetchProfile })

    assert.equal(items[0].name, 'Agent Label')  // preserved
    assert.equal(items[1].name, 'MSFT Inc')     // filled
    assert.equal(items[2].name, 'TSLA Inc')     // filled
    for (const it of items) assert.equal(it.logo, `logo/${it.ticker}`)
})

test('enrich: overwriteName=true (default) replaces an existing name', async () => {
    const items = [{ symbol: 'AAPL', name: 'stale' }]
    const fetchProfile = async (sym) => ({ name: `${sym} Inc`, logo: `logo/${sym}` })

    await enrichWithProfiles(items, { fetchProfile })

    assert.equal(items[0].name, 'AAPL Inc')
})

test('enrich: respects the concurrency cap', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ symbol: `S${i}` }))
    let active = 0, peak = 0
    const fetchProfile = async () => {
        active++; peak = Math.max(peak, active)
        await new Promise(r => setTimeout(r, 1))
        active--; return { name: 'x', logo: 'y' }
    }

    await enrichWithProfiles(items, { concurrency: 4, fetchProfile })

    assert.ok(peak <= 4, `peak concurrency ${peak} exceeded cap of 4`)
})
