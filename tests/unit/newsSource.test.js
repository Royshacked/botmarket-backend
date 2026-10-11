import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { newsService, _fetchArticles, NEWS_CATEGORIES, HEADLINES_SUBJECT, _resetNewsCache, _readShelf } from '../../services/news.service.js'
import { mapFinnhubArticle, mapGNewsArticle, isValidArticle } from '../../services/newsArticle.service.js'

// WHICH SOURCE ANSWERS WHICH QUESTION. Finnhub is keyed — a ticker or the front page — and GNews is
// the text index for everything that only has words. The split is invisible downstream, which is
// exactly why it needs a test: getting it wrong doesn't fail, it just returns the wrong news (a
// text search for "Nvidia" comes back full of competitors' stories that merely mention it).

const finnhubRow = (over = {}) => ({
    category: 'company',
    datetime: Math.floor(Date.parse('2026-08-19T08:00:00Z') / 1000),
    headline: 'Nvidia beats on data-centre revenue',
    id: 141254410,
    image: 'https://example.com/i.png',
    related: 'NVDA',
    source: 'Reuters',
    summary: 'Revenue above expectations.',
    url: 'https://example.com/nvda',
    ...over,
})

const gnewsRow = (over = {}) => ({
    title: 'Oil steadies after OPEC signals restraint',
    description: 'Crude held its gains.',
    url: 'https://example.com/oil',
    image: '',
    publishedAt: '2026-08-19T07:00:00Z',
    source: { name: 'Bloomberg' },
    ...over,
})

/** Records what each provider was asked for; returns whatever the test set up. */
function fakeProviders({ company = [], general = [], search = [] } = {}) {
    const calls = { companyNews: [], generalNews: [], search: [] }
    return {
        calls,
        providers: {
            companyNews: async (opts) => { calls.companyNews.push(opts); return company },
            generalNews: async (opts) => { calls.generalNews.push(opts ?? null); return general },
            search: async (opts) => { calls.search.push(opts); return { articles: search, totalArticles: search.length } },
        },
    }
}

/** A provider set where every fetch fails — an outage, a rate limit, a spent quota. */
const brokenProviders = (message = 'rate limited') => ({
    companyNews: async () => { throw new Error(message) },
    generalNews: async () => { throw new Error(message) },
    search: async () => { throw new Error(message) },
})

test('a COMPANY read goes to the symbol-keyed feed, never to the text index', async () => {
    const { calls, providers } = fakeProviders({ company: [finnhubRow()] })
    const out = await _fetchArticles({ category: 'companies', subject: 'nvda', query: 'nvda' }, providers)

    assert.equal(calls.companyNews.length, 1)
    assert.equal(calls.companyNews[0].symbol, 'NVDA', 'the symbol is upper-cased for the provider')
    assert.equal(calls.search.length, 0, 'a keyed read must not spend a text search')
    assert.equal(out.meta.source, 'finnhub')
    assert.equal(out.articles[0].headline, 'Nvidia beats on data-centre revenue')
    assert.equal(out.articles[0].source, 'Reuters')
})

test('a company with NO keyed coverage falls back to the text index', async () => {
    // Foreign listings, indices and crypto pairs are not in the company feed. Without this fallback
    // "any news on XAUUSD" would answer "nothing", which is false rather than empty.
    const { calls, providers } = fakeProviders({ company: [], search: [gnewsRow()] })
    const out = await _fetchArticles({ category: 'companies', subject: 'XAUUSD', query: 'XAUUSD' }, providers)

    assert.equal(calls.companyNews.length, 1, 'the keyed source is still tried FIRST')
    assert.equal(calls.search.length, 1)
    assert.equal(out.meta.source, 'gnews')
    assert.equal(out.meta.fallback, 'finnhub-empty')
    assert.equal(out.articles.length, 1)
})

test('the FRONT PAGE is the general feed — no subject, no search', async () => {
    const { calls, providers } = fakeProviders({ general: [finnhubRow({ category: 'top news', related: '' })] })
    const out = await _fetchArticles({ category: 'headlines' }, providers)

    assert.equal(calls.generalNews.length, 1)
    assert.equal(calls.companyNews.length, 0)
    assert.equal(calls.search.length, 0)
    assert.equal(out.meta.feed, 'general')
})

test('a TOPIC is the text index — the one thing a keyed source cannot answer', async () => {
    const { calls, providers } = fakeProviders({ search: [gnewsRow()] })
    const out = await _fetchArticles({ category: 'topic', subject: 'OPEC', query: 'OPEC' }, providers)

    assert.equal(calls.search.length, 1)
    assert.equal(calls.search[0].query, 'OPEC')
    assert.equal(calls.companyNews.length, 0)
    assert.equal(out.articles[0].source, 'Bloomberg')
})

test('the keyed feed is sorted newest-first BEFORE it is capped', async () => {
    // The provider returns a window; slicing an unsorted window drops exactly the headlines a
    // reader came for.
    const day = (d) => Math.floor(Date.parse(`2026-08-${d}T08:00:00Z`) / 1000)
    const { providers } = fakeProviders({
        company: [
            finnhubRow({ datetime: day('01'), headline: 'oldest', id: 1, url: 'u1' }),
            finnhubRow({ datetime: day('19'), headline: 'newest', id: 2, url: 'u2' }),
            finnhubRow({ datetime: day('10'), headline: 'middle', id: 3, url: 'u3' }),
        ],
    })
    const out = await _fetchArticles({ category: 'companies', subject: 'NVDA', query: 'NVDA', limit: 2 }, providers)
    assert.deepEqual(out.articles.map(a => a.headline), ['newest', 'middle'])
})

test('a Finnhub row maps into the SAME internal shape a GNews row does', () => {
    const a = mapFinnhubArticle(finnhubRow())
    assert.ok(isValidArticle(a))
    // Finnhub already dates in unix SECONDS. Dividing again would land every article in 1970.
    assert.equal(a.datetime, Math.floor(Date.parse('2026-08-19T08:00:00Z') / 1000))
    assert.deepEqual(Object.keys(a).sort(), ['datetime', 'headline', 'id', 'image', 'related', 'source', 'summary', 'url'])
    assert.deepEqual(a.related, ['NVDA'], 'the publisher ticker tags survive the mapping')
    // Both mappers emit the SAME keys — a text-index row simply tags no tickers. One shape downstream
    // is what lets the cache, the dedupe and the digest stay blind to which provider fetched a row.
    assert.deepEqual(Object.keys(mapGNewsArticle(gnewsRow())).sort(), Object.keys(a).sort())
    // A dateless row is NaN, so the shared validator drops it rather than dating it 1970.
    assert.equal(isValidArticle(mapFinnhubArticle({ headline: 'no date' })), false)
})

// `basket` joined on 2026-10-10 (Pythia's industry news, docs/design/pythia-assessment.md §4.1): several
// tickers in one FMP call. The model-facing get_news schema still offers only the first three.
test('the vocabulary names exactly the four kinds of read', () => {
    assert.deepEqual([...NEWS_CATEGORIES].sort(), ['basket', 'companies', 'headlines', 'topic'])
})

test('a basket goes to FMP in ONE call for every ticker, mapped, dated and newest first', async () => {
    const calls = []
    const providers = {
        companyNews: async () => { throw new Error('not Finnhub') }, generalNews: async () => [], search: async () => { throw new Error('not GNews') },
        stockNews: async (opts) => { calls.push(opts); return [
            { symbol: 'AMD', publishedDate: '2026-10-09 10:00:00', publisher: 'Reuters', title: 'AMD older', text: 's1', url: 'u1' },
            { symbol: 'NVDA', publishedDate: '2026-10-10 12:38:00', publisher: 'PRNewsWire', title: 'NVDA newer', text: 's2', url: 'u2' },
            { symbol: 'NVDA', publishedDate: '', title: 'no date' },
        ] },
    }
    const r = await _fetchArticles({ category: 'basket', subject: 'gics_45301020', query: 'AMD,NVDA' }, providers)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].symbols, ['AMD', 'NVDA'])
    assert.deepEqual(r.articles.map(a => a.headline), ['NVDA newer', 'AMD older'], 'newest first, the dateless row dropped')
    assert.deepEqual(r.articles[0].related, ['NVDA'])
    assert.equal(r.articles[0].datetime, Date.parse('2026-10-10T12:38:00Z') / 1000)
    assert.equal(r.meta.source, 'fmp')
    await assert.rejects(() => _fetchArticles({ category: 'basket', subject: 'gics_x', query: '' }, providers), /basket needs tickers/)
})

// ── The warm-cache guarantee ──────────────────────────────────────────────────
// These use the real in-process shelf (a file under data/news until 2026-09-16) under a subject
// nothing else reads, and clear it after.

const TEST_SUBJECT = 'zz-news-source-test'
after(_resetNewsCache)

test('a provider failure serves the warm cache stale instead of throwing it away', async () => {
    _resetNewsCache()
    const first = await newsService.getOrFetch({
        category: 'companies', subject: TEST_SUBJECT, refresh: true,
        _providers: fakeProviders({ company: [finnhubRow()] }).providers,
    })
    assert.equal(first.articles.length, 1)
    const warmAt = _readShelf('companies', TEST_SUBJECT).lastFetchedAt

    const second = await newsService.getOrFetch({
        category: 'companies', subject: TEST_SUBJECT, refresh: true, _providers: brokenProviders(),
    })

    assert.equal(second.articles.length, 1, 'an hour-old headline beats an error')
    assert.equal(second.meta.stale, true, 'and the caller is TOLD it is stale')
    assert.match(second.meta.error, /rate limited/)

    // The failure must not touch the cache: bumping the timestamp would silence the subject for a
    // full TTL after the provider recovered, and overwriting it would lose the articles.
    const afterFailure = _readShelf('companies', TEST_SUBJECT)
    assert.equal(afterFailure.lastFetchedAt, warmAt, 'a failed fetch does not re-stamp the cache')
    assert.equal(afterFailure.items.length, 1)
})

test('with NOTHING cached, a provider failure still surfaces', async () => {
    // Stale beats an error; SILENCE does not. With no articles to fall back on there is genuinely
    // no answer, and returning an empty list would be read as "no news".
    await assert.rejects(
        () => newsService.getOrFetch({ category: 'companies', subject: 'zz-news-source-test-missing', _providers: brokenProviders('down') }),
        /down/,
    )
})

test('the front page needs no subject to reach the cache at all', async () => {
    const { calls, providers } = fakeProviders({ general: [finnhubRow({ id: 77, url: 'u77' })] })
    // `refresh` because the front page caches under ONE fixed key that a dev machine (or an earlier
    // live check) may already have warmed — without it this passes on somebody else's articles and
    // proves nothing. newsCache.test.js deliberately leaves this shelf to this file; see its header.
    const out = await newsService.getOrFetch({ category: 'headlines', refresh: true, _providers: providers })
    assert.equal(calls.generalNews.length, 1, 'the front page was actually fetched, not read back')
    assert.equal(out.meta.subject, HEADLINES_SUBJECT)
    assert.ok(out.articles.length >= 1)
})

test('a ticker reads FMP first (Roy, 2026-10-11); Finnhub only when FMP errors or has nothing', async () => {
    const fmpRow = { symbol: 'NVDA', publishedDate: '2026-10-10 12:00:00', title: 'Nvidia from FMP', text: 's', url: 'https://x/fmp', publisher: 'FMP wire' }
    const finn = { headline: 'Nvidia from Finnhub', summary: 's', datetime: 1_791_000_000, url: 'https://x/f', source: 'Reuters' }
    const make = (stockNews) => {
        const calls = { stock: 0, company: 0 }
        return { calls, providers: {
            stockNews: async (o) => { calls.stock++; return stockNews(o) },
            companyNews: async () => { calls.company++; return [finn] },
            generalNews: async () => [], search: async () => { throw new Error('not GNews') },
        } }
    }
    const a = make(async (o) => { assert.deepEqual(o.symbols, ['NVDA']); return [fmpRow] })
    const out = await _fetchArticles({ category: 'companies', subject: 'nvda', query: 'nvda' }, a.providers)
    assert.equal(out.meta.source, 'fmp')
    assert.equal(out.articles[0].headline, 'Nvidia from FMP')
    assert.deepEqual(out.articles[0].related, ['NVDA'])
    assert.equal(a.calls.company, 0, 'Finnhub is not asked when FMP answered')

    const empty = make(async () => [])
    assert.equal((await _fetchArticles({ category: 'companies', subject: 'NVDA', query: 'NVDA' }, empty.providers)).meta.source, 'finnhub')
    const down = make(async () => { throw new Error('FMP 500') })
    const r = await _fetchArticles({ category: 'companies', subject: 'NVDA', query: 'NVDA' }, down.providers)
    assert.equal(r.meta.source, 'finnhub', 'an FMP outage falls back, it does not fail the read')
    assert.equal(down.calls.company, 1)
})
