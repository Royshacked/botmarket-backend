import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newsProfile, newsEvents, bigSessions, NEWS } from '../../services/behaviourProfile.engine.js'
import { companyPattern, fetchNameNews } from '../../services/proteusNews.service.js'
import { newsDailyWords, newsIntradayWords, rowProfile, formatProfile } from '../../services/tools/behaviourProfile.tools.js'
import { profileFor } from '../../services/behaviourProfile.service.js'

// L. The news around the moves (docs/design/proteus.md §10.10, Roy 2026-11-17).

const DAY = 86_400
function walk(n, seed = 7, step = DAY, start = Date.parse('2016-01-04T14:30:00Z') / 1000) {
    let s = seed >>> 0
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    let p = 100
    return Array.from({ length: n }, (_, i) => {
        const o = p
        p = Math.max(1, p * (1 + (rnd() - 0.48) * 0.05))
        return { timestamp: start + i * step, open: o, high: Math.max(o, p) * 1.006, low: Math.min(o, p) * 0.994, close: p, volume: 1e6 * (0.5 + rnd()) }
    })
}
const dayOf = (b) => new Date(b.timestamp * 1000).toISOString().slice(0, 10)

test('companyPattern: the name\'s distinctive core, or its first two words; the ticker as (LNG) / $LNG', () => {
    const lng = companyPattern('CHENIERE ENERGY, INC.', 'LNG')
    assert.equal(lng.test('Cheniere confirms maintenance'), true)
    assert.equal(lng.test('Dynagas LNG Partners results'), false)
    assert.equal(lng.test('Will Cheniere Energy (LNG) beat?'), true)
    const ko = companyPattern('COCA COLA CO', 'KO')
    assert.equal(ko.test('Coca-Cola raises its dividend'), true)
    assert.equal(ko.test('The Coca Cola Company beats'), true)
    assert.equal(ko.test('PepsiCo beats'), false)
    const duk = companyPattern('DUKE ENERGY CORP', 'DUK')
    assert.equal(duk.test('Duke Energy files rate case'), true)
    assert.equal(duk.test('Duke University study'), false)
    assert.equal(companyPattern(null, 'XYZ').test('$XYZ jumps'), true)
})

test('fetchNameNews: every source compact; one failing source is empty, the rest read', async () => {
    const deps = {
        filings: async () => ({ title: 'COCA COLA CO', filings: [{ day: '2026-10-27', items: '2.02,9.01' }] }),
        reports: async () => [{ date: '2026-10-27', epsActual: 0.8, epsEstimated: 0.7 }, { date: '2027-02-10', epsActual: null }],
        grades: async () => [{ date: '2026-06-01', action: 'upgrade' }, { date: '2026-06-02', action: 'maintain' }],
        targets: async () => [{ publishedDate: '2026-06-10T12:00:00Z', priceTarget: 89, priceWhenPosted: 81, newsTitle: 'X raises KO target' }],
        insiders: async () => { throw new Error('402') },
        headlines: async () => [{ publishedDate: '2026-11-01 10:00:00', title: 'Coca-Cola news' }, { publishedDate: '2026-11-01 10:00:00', title: 'Coca-Cola news' }],
    }
    const n = await fetchNameNews('ko', { now: Date.parse('2026-11-17T00:00:00Z'), deps })
    assert.equal(n.title, 'COCA COLA CO')
    assert.deepEqual(n.reports, [{ day: '2026-10-27', beat: true }])
    assert.deepEqual(n.grades, [{ day: '2026-06-01', action: 'upgrade' }])
    assert.deepEqual(n.targets, [{ day: '2026-06-10', target: 89, price: 81, dir: 1 }])
    assert.deepEqual(n.insiders, [])            // the failed source
    assert.equal(n.headlines.length, 1)         // de-duplicated across windows
})

test('newsEvents: the kinds — an 8-K by item, a report beat / miss, analysts, targets, insiders; headlines company / industry', () => {
    const { events, headlines } = newsEvents({
        filings: [{ day: '2026-01-02', items: '2.02,9.01' }, { day: '2026-01-03', items: '5.02' }],
        reports: [{ day: '2026-01-02', beat: false }], grades: [{ day: '2026-01-05', action: 'downgrade' }],
        targets: [{ day: '2026-01-06', dir: 0 }], insiders: [{ day: '2026-01-07' }],
        headlines: [{ at: '2026-01-08 14:00:00', title: 'Coca-Cola X' }, { at: '2026-01-08T15:00:00Z', title: 'Sugar prices' }],
    }, /coca-cola/i)
    assert.deepEqual(events.map(e => e.kind), ['8-K results', '8-K people', 'report miss', 'downgrade', 'target set', 'insider buy'])
    assert.deepEqual(headlines.map(h => h.company), [true, false])
})

test('newsProfile: daily and intraday parts, every rate a number or null; null without news', () => {
    assert.equal(newsProfile(walk(1000), null, null), null)
    const day = walk(2500).map((b, i) => (i % 40 === 0 ? { ...b, volume: b.volume * 5 } : b))   // a big (volume) session every 40
    const news = { filings: day.map(b => ({ day: dayOf(b), items: '2.02' })), reports: [],   // a filing every day: every big session is major
        grades: [], targets: [], insiders: [], headlines: null }
    const p = newsProfile(day, null, news)
    assert.ok(p.daily.moves > 0)
    for (const k of ['top', 'pullback', 'low', 'any']) assert.ok(p.daily.major_per100[k] === null || p.daily.major_per100[k] >= 0)
    assert.ok(p.daily.major_per100.any > 0)
    assert.equal(p.intraday, null)              // no headlines → no 5-minute part
    assert.equal(p.sources.filings, day.length)
    assert.equal(p.daily.unexplained_per100.any, 0)   // nothing is undated
    assert.ok(bigSessions(day, day.map(() => 1)).some(Boolean))
    const five = walk(1200, 3, 300, Date.parse('2026-08-11T13:30:00Z') / 1000)
    const q = newsProfile(day, five, { ...news, headlines: [{ at: new Date(five[500].timestamp * 1000).toISOString(), title: 'Acme beats' }] }, /acme/i)
    assert.ok(q.intraday && q.intraday.company.any >= 0 && q.intraday.industry.before >= 0)
})

test('the words: a lead phrase from the low; the row shows the daily news for a swing, the 5-minute for a day trade', () => {
    const daily = { moves: 27, major_per100: { top: 0.7, pullback: 1.1, low: 0.3, any: 1.1 }, unexplained_per100: { top: 1, pullback: 2, low: 3, any: 2.7 },
        moves_with_major: { top: 2, pullback: 5, low: 1 }, major_kinds: { '8-K results': { top: 0, pullback: 6, low: 0 } }, before_start: { filing: 66.7, report: 11.1, filing_any: 53.3, report_any: 16 } }
    const intraday = { moves: 71, company: { before: 35, any: 40, during: 1 }, industry: { before: 70, any: 72, during: 4 } }
    const n = { sources: { headlines_from: '2026-08-17' }, daily, intraday }
    assert.match(newsDailyWords(n), /^27 moves: its moves start away from news\. .*8-K results ×6 \(mostly in the pullback\)/)
    assert.match(newsDailyWords({ daily: { ...daily, major_per100: { ...daily.major_per100, low: 3 } } }), /start ON major news/)
    assert.match(newsIntradayWords(n), /do not follow the news — a company headline .* an industry headline/)
    assert.equal(newsDailyWords(null), null)
    const tf = { bars: 300, from: '2020', to: '2026', atr_pct: 2, drift: { rate: 0.5 }, indicators: {}, false_breaks: { breaks: 0, after_sweep: {}, recent: {} }, order_blocks: { blocks: 0 } }
    const p = { symbol: 'LNG', timeframes: { day: tf, week: tf, '5min': tf, '1hour': tf }, news: n, computed_at: '2026-11-17' }
    assert.ok(rowProfile(p, 'swing').lines.some(([k]) => k === 'News (daily)'))
    assert.ok(rowProfile(p, 'intraday').lines.some(([k]) => k === 'News (5-minute)'))
})

test('profileFor: the news is read beside the bars (deps.news); a test\'s own candle source reads none', async () => {
    const days = walk(1200).map(b => ({ ...b, timestamp: b.timestamp }))
    const get = async (s, o) => (o.timeSpan === 'day' ? days : [])
    const cache = { read: async () => null, write: async () => {} }
    const withNews = await profileFor('ZZZ', { fresh: true, deps: { get, cache, now: Date.parse('2026-11-17T00:00:00Z'), news: async () => ({ title: 'ZZZ CORP', filings: [], reports: [], grades: [], targets: [], insiders: [], headlines: null }) } })
    assert.ok(withNews.news && withNews.news.daily)
    const without = await profileFor('ZZY', { fresh: true, deps: { get, cache, now: Date.parse('2026-11-17T00:00:00Z') } })
    assert.equal(without.news, undefined)
    assert.equal(NEWS.bigAtr, 2)
})

test('the row\'s Tested line: what failed on the horizon\'s timeframes, what was too thin — a test that holds on either is left out', async () => {
    const { testedWords } = await import('../../services/tools/behaviourProfile.tools.js')
    const tf = (over = {}) => ({ indicators: { ema20: { verdict: 'no' }, sma50: { verdict: 'no' }, rsi_oversold: { verdict: 'thin' } },
        false_breaks: { after_sweep: { verdict: 'no' } }, order_blocks: { verdict: 'no' }, cycle: { verdict: 'thin' }, wyckoff: null, fib: { verdict: 'no' }, ...over })
    const p = { timeframes: { day: tf(), week: tf({ indicators: { ema20: { verdict: 'respects' }, sma50: { verdict: 'no' }, rsi_oversold: { verdict: 'no' } } }) } }
    const w = testedWords(p, ['day', 'week'])
    assert.match(w, /^No edge: 50 MA, RSI under 30, sweeps lows, order blocks, Fibonacci pullbacks\./)
    assert.doesNotMatch(w, /20 EMA/)                         // holds on the weekly
    assert.match(w, /Too few to say: price cycle, Wyckoff springs, range breakouts, dry-volume retests\.$/)
    assert.equal(testedWords({ timeframes: {} }, ['day']), null)
})
