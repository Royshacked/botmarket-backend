import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    ret, sma, fromHigh, stretchPercentile, seriesReading, regimeItem, marketReading, marketItem, breadth,
    industryRows, industryItems, moneyItems, calendarItems, buildDataSections, _setIO, REGIME_SERIES, MARKET, BARS,
} from '../../services/situation/state.data.js'
import { checkItem } from '../../services/situation/model.js'

const line = (n, start = 100, step = 1) => Array.from({ length: n }, (_, i) => start + i * step)
const monthly = (from, values) => values.map((v, i) => {
    const d = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1 + i, 1))
    return { date: d.toISOString().slice(0, 10), value: v }
})

test('ret, sma, fromHigh read the last bars and skip gaps', () => {
    const c = [null, 100, 110, 121]
    assert.ok(Math.abs(ret(c, 1) - 0.1) < 1e-12)
    assert.ok(Math.abs(ret(c, 2) - 0.21) < 1e-12)
    assert.equal(ret(c, 3), null, 'not enough bars')
    assert.equal(sma([1, 2, 3, 4], 2), 3.5)
    assert.equal(sma([1, 2], 3), null)
    assert.ok(Math.abs(fromHigh([100, 120, 90]) - (90 / 120 - 1)) < 1e-12)
})

test('stretchPercentile: a sudden jump above the 50-day ranks at the top of its own year; too little history is null', () => {
    const calm = Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 7))
    calm.push(...[110, 115, 120])
    assert.ok(stretchPercentile(calm) >= 0.99)
    assert.equal(stretchPercentile(line(100)), null)
})

test('seriesReading: level, the level about three months back, and a direction with a flat band', () => {
    const spec = { id: 'DGS10', label: '10-year', unit: '%', flatAbs: 0.15 }
    const obs = monthly('2026-01-01', [4.0, 4.1, 4.2, 4.3, 4.6])
    const r = seriesReading(spec, obs)
    assert.equal(r.value, 4.6)
    assert.equal(r.before_date, '2026-01-01', 'the last reading at least 90 days back')
    assert.equal(r.direction, 'rising')
    assert.equal(seriesReading(spec, monthly('2026-01-01', [4.0, 4.0, 4.0, 4.0, 4.1])).direction, 'flat')
    assert.equal(seriesReading(spec, []), null)
})

test('seriesReading: year-on-year of an index, annualised quarter-on-quarter, monthly change', () => {
    const yoy = seriesReading({ id: 'CPI', label: 'CPI', unit: '%', yoy: true, flatAbs: 0.2 }, monthly('2025-01-01', [...line(13, 100, 0), 103]))
    assert.ok(Math.abs(yoy.value - 3) < 1e-9, 'a year ago 100, now 103 → 3%')
    const q = seriesReading({ id: 'GDPC1', label: 'GDP', unit: '%', qoqAnnualized: true, flatAbs: 0.5 }, [{ date: '2026-01-01', value: 100 }, { date: '2026-04-01', value: 101 }])
    assert.ok(Math.abs(q.value - ((1.01 ** 4 - 1) * 100)) < 1e-9)
    const pay = seriesReading({ id: 'PAYEMS', label: 'Payrolls', unit: 'k', monthlyChange: true, flatAbs: 50 }, monthly('2026-01-01', [1000, 1100, 1150]))
    assert.equal(pay.value, 50)
})

test('regime and market items pass the state checks', () => {
    const r = seriesReading(REGIME_SERIES.find(s => s.id === 'DGS10'), monthly('2026-01-01', [4.0, 4.1, 4.2, 4.3, 4.6]))
    const it = regimeItem(r)
    assert.equal(checkItem(it).ok, true)
    assert.match(it.text, /4\.60%, rising over three months \(from 4\.00% on 2026-01-01\)/)
    assert.equal(it.source, 'FRED DGS10')
    const rows = line(300).map((c, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, close: c }))
    const m = marketReading(MARKET[1], rows)
    assert.equal(m.above_200d, true)
    assert.equal(checkItem(marketItem(m, 'FMP')).ok, true)
    const vix = marketReading(MARKET.find(x => x.level), rows)
    assert.match(marketItem(vix, 'FMP').text, /one-year average/)
    assert.equal(marketReading(MARKET[1], rows.slice(0, 10)), null, 'too few bars')
})

test('breadth: the share above their own 200-day; short series are skipped', () => {
    const up = line(250), down = line(250, 400, -1), short = line(20)
    assert.deepEqual(breadth([up, down, short]), { share: 0.5, n: 2 })
    assert.equal(breadth([short]), null)
})

test('industryRows: each basket against the S&P over the same bars; a basket ending another day is skipped', () => {
    const spx = { date: '2026-11-20', close: line(300, 100, 0) }   // flat S&P
    const dates = Array.from({ length: 300 }, (_, i) => (i === 299 ? '2026-11-20' : `d${i}`))
    const docs = [
        { _id: 'sub_industry:15104030', dates, levels: line(300, 1, 0.01) },
        { _id: 'industry:252010', dates: [...dates.slice(0, -1), '2026-11-19'], levels: line(300) },
    ]
    const rows = industryRows(docs, spx, new Map([['sub_industry:15104030', 'Gold']]))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, 'Gold')
    assert.equal(rows[0].code, '15104030')
    assert.ok(rows[0].vs_m3 > 0 && Math.abs(rows[0].vs_m3 - rows[0].m3) < 1e-12, 'against a flat S&P, vs = own return')
    const items = industryItems(rows)
    assert.ok(items.every(i => checkItem(i).ok))
    assert.match(items[0].text, /LEADING.*Gold/)
})

test('moneyItems: capex leaders and fund flows by NAME; insider clusters carry the no-edge warning', () => {
    const leaders = { asof: '2026-11-22', up: [{ name: 'Software', delta: 1.2e11, change: 1.08 }], down: [{ name: 'Automobiles', delta: -6.7e9, change: -0.16 }] }
    const flows = new Map([
        ['40203030', { funds: { quarter: '2026-06-30', flow_vs_universe: 0.079 } }],
        ['15101030', { funds: { quarter: '2026-06-30', flow_vs_universe: -0.094 } }],
        ['40101015', { insiders: { cluster: true, companies_buying: 55, asof: '2026-11-22' } }],
    ])
    const names = new Map([['40203030', 'Diversified Capital Markets'], ['15101030', 'Commodity Chemicals'], ['40101015', 'Regional Banks']])
    const items = moneyItems(leaders, flows, '2026-11-23', names)
    assert.equal(items.length, 4)
    assert.ok(items.every(i => checkItem(i).ok))
    assert.match(items[0].text, /Software \+\$120\.0B/)
    assert.match(items[2].text, /IN most: Diversified Capital Markets \+7\.9%.*OUT most: Commodity Chemicals -9\.4%/)
    assert.match(items[3].text, /no tested edge.*Regional Banks \(55 companies\)/)
    assert.deepEqual(moneyItems(null, new Map(), '2026-11-23'), [])
})

test('calendarItems: FOMC and high-impact only, from today, each once; the index movers in date order', () => {
    const fed = [
        { date: '2026-12-09', kind: 'fomc' }, { date: '2026-12-10', event: 'CPI', impact: 'high' },
        { date: '2026-12-10', event: 'CPI', impact: 'high' }, { date: '2026-12-11', event: 'Claims', impact: 'low' },
        { date: '2026-11-01', kind: 'fomc' },
    ]
    const items = calendarItems(fed, [{ symbol: 'NVDA', date: '2027-02-24' }, { symbol: 'AVGO', date: '2026-12-09' }], '2026-11-23')
    assert.deepEqual(items.map(i => i.text), ['2026-12-09: FOMC rate decision', '2026-12-10: CPI', 'Earnings of the index movers: AVGO 2026-12-09, NVDA 2027-02-24'])
    assert.ok(items.every(i => checkItem(i).ok))
})

test('buildDataSections: a failed leg is a named gap, the rest still build, nothing throws', async () => {
    const obs = monthly('2025-01-01', line(23, 100, 0.5))
    const bars = line(300).map((c, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, close: c }))
    _setIO({
        series: async (id) => { if (id === 'DGS2') throw new Error('FRED 500'); return obs },
        candles: async (sym) => { if (sym === 'BTCUSD') throw new Error('402'); return bars },
        engineDb: async () => { throw new Error('engine down') },
        moneyLeaders: async () => ({ asof: null, up: [], down: [] }),
        flows: async () => new Map(),
        fedEvents: async () => [{ date: '2026-12-09', kind: 'fomc' }],
        earnings: async () => [],
    })
    const r = await buildDataSections('2026-11-23')
    assert.equal(r.sections.regime.length, REGIME_SERIES.length - 1)
    assert.ok(r.gaps.some(g => /FRED DGS2: FRED 500/.test(g)))
    assert.ok(r.gaps.some(g => /FMP BTCUSD: 402/.test(g)))
    assert.ok(r.gaps.some(g => /engine database: engine down/.test(g)))
    const spxItem = r.sections.prices.find(i => i.text.startsWith('S&P 500'))
    assert.equal(spxItem.source, 'FMP daily bars ^GSPC', 'engine down → the S&P from FMP, labelled so')
    assert.equal(r.sections.calendar.length, 1)
    assert.ok(Object.values(r.sections).flat().every(i => checkItem(i).ok))
    assert.equal(BARS.m12, 252)
})
