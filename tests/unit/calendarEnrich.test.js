import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _enrichWithProfiles } from '../../api/calendar/calendar.controller.js'

test('enrich: every row gets its name + logo, none skipped or duplicated', async () => {
    const items = ['AAPL', 'MSFT', 'TSLA', 'JPM', 'NVDA', 'AMD', 'INTC']
        .map(symbol => ({ symbol }))
    const fetchProfile = async (symbol) => ({ name: `${symbol} Inc`, logo: `logo/${symbol}` })

    await _enrichWithProfiles(items, fetchProfile, 3)

    for (const it of items) {
        assert.equal(it.name, `${it.symbol} Inc`)
        assert.equal(it.logo, `logo/${it.symbol}`)
    }
})

test('enrich: never runs more workers than the concurrency cap', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ symbol: `S${i}` }))
    let active = 0
    let peak = 0
    const fetchProfile = async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise(r => setTimeout(r, 1))
        active--
        return { name: 'x', logo: 'y' }
    }

    await _enrichWithProfiles(items, fetchProfile, 4)

    assert.ok(peak <= 4, `peak concurrency ${peak} exceeded cap of 4`)
})

test('enrich: null name/logo from a failed lookup is passed through unchanged', async () => {
    const items = [{ symbol: 'AAPL' }]
    const fetchProfile = async () => ({ name: null, logo: null })

    await _enrichWithProfiles(items, fetchProfile)

    assert.equal(items[0].name, null)
    assert.equal(items[0].logo, null)
})

test('enrich: empty list is a no-op (no workers spawned)', async () => {
    let called = false
    const fetchProfile = async () => { called = true; return { name: null, logo: null } }

    const out = await _enrichWithProfiles([], fetchProfile)

    assert.deepEqual(out, [])
    assert.equal(called, false)
})
