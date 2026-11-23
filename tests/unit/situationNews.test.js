import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toArticle, mergeArticles, articleLines, fetchNews, _setIO, GNEWS_TOPICS } from '../../services/situation/news.js'
import { checkState } from '../../services/situation/model.js'

test('toArticle: every source to one shape; a bare date becomes midnight UTC', () => {
    const fr = toArticle({ title: 'Tariff rule', date: '2025-02-01', url: 'https://fr/1', text: 'RULE. Commerce.' }, 'Federal Register')
    assert.deepEqual(fr, { url: 'https://fr/1', title: 'Tariff rule', source: 'Federal Register', published_at: '2025-02-01T00:00:00Z', text: 'RULE. Commerce.' })
    const g = toArticle({ title: 'Fed holds', publishedAt: '2025-01-29T19:00:00Z', url: 'https://g/1', description: 'Rates unchanged', source: { name: 'Reuters' } }, 'GNews')
    assert.equal(g.source, 'Reuters')
    assert.equal(g.text, 'Rates unchanged')
})

test('mergeArticles: dedupes by URL then title, drops the undated and anything after asOf, newest first', () => {
    const a = { url: 'https://x/1', title: 'A', source: 's', published_at: '2025-01-05T10:00:00Z' }
    const b = { url: null, title: 'Same Title', source: 's', published_at: '2025-01-06T10:00:00Z' }
    const out = mergeArticles([[a, { ...a }], [b, { ...b, title: 'same title' }], [{ url: 'https://x/2', title: 'Late', source: 's', published_at: '2025-01-08T00:00:00Z' }], [{ title: 'No date', published_at: null }]], '2025-01-07')
    assert.deepEqual(out.map(x => x.title), ['Same Title', 'A'])
    assert.equal(mergeArticles([[a, b]], '2025-01-07', 1).length, 1)
})

test('articleLines: numbered, dated, cited by number', () => {
    const lines = articleLines([{ title: 'Fed holds', source: 'Reuters', published_at: '2025-01-29T19:00:00Z', text: 'Rates unchanged' }])
    assert.equal(lines, '[1] 2025-01-29 · Reuters · Fed holds — Rates unchanged')
})

test('fetchNews: every source merged; a failed source is a gap; no GNews key is said; articles pass the state check', async () => {
    const asked = []
    _setIO({
        now: () => new Date('2025-01-07T12:00:00Z'),
        policy: async () => [{ title: 'Export controls rule', date: '2025-01-06', url: 'https://fr/9' }],
        fmpNews: async () => { throw new Error('FMP 429') },
        defense: async () => [],
        hasGnews: () => true,
        gnews: async (q, from, to) => { asked.push([q, from, to]); return { articles: [{ title: `On ${q}`, publishedAt: '2025-01-05T08:00:00Z', url: `https://g/${q}` }] } },
    })
    const r = await fetchNews({ days: 7 })
    assert.equal(r.articles.length, 1 + GNEWS_TOPICS.length)
    assert.ok(r.gaps.some(g => /FMP general news: FMP 429/.test(g)))
    assert.equal(asked[0][1], '2024-12-31T00:00:00.000Z')
    assert.equal(asked[0][2], '2025-01-07T23:59:59Z')
    const sections = { regime: [], policy: [], money: [], stories: [], prices: [], calendar: [] }
    assert.equal(checkState({ as_of: '2025-01-07', sections, articles: r.articles }).ok, true)

    _setIO({ hasGnews: () => false, fmpNews: async () => [] })
    const r2 = await fetchNews({ days: 7 })
    assert.ok(r2.gaps.some(g => /no GNEWS_API_KEY/.test(g)))
})

test('capPerDay: at most n per publication day, undated dropped', async () => {
    const { capPerDay } = await import('../../services/situation/news.js')
    const a = (d, i) => ({ title: `t${d}${i}`, published_at: `2025-01-0${d}T0${i}:00:00Z` })
    const out = capPerDay([a(5, 1), a(5, 2), a(5, 3), a(6, 1), { title: 'x', published_at: null }], 2)
    assert.deepEqual(out.map(x => x.title), ['t51', 't52', 't61'])
})
