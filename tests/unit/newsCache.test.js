import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'

import { newsService, CACHE_TTL_MS, NEWS_CATEGORIES, _fetchArticles } from '../../services/news.service.js'

// THE CACHE IS THE FEATURE HERE, not an optimization around it.
//
// Two providers sit behind this service and both are quota-metered — GNews rate-limits per SECOND
// (two reads in one agent turn earned a 429), and the FMP episode already showed what our own
// polling does to a shared budget. Every rule below exists so that N users asking about the same
// name in the same hour costs ONE call, and so that a provider having a bad minute never costs us
// news we already hold.
//
// These tests hit the REAL file cache under a throwaway subject rather than a stubbed IO layer:
// the disk round-trip (envelope written, envelope read back, timestamp honoured) is the half that
// would silently regress, so it is the half worth exercising. Providers are injected via the
// `_providers` seam so nothing here touches a network.

// No leading/trailing underscores: the store sanitizer strips them, so a subject wrapped in them
// writes to one path and this file's cleanup deletes another — leaking a warm shelf into the next
// test, which then reads as "the cache worked" when nothing was fetched at all.
const SUBJECT = 'zz-test-news-cache'
const dataFile = (category, subject) =>
    path.join(process.cwd(), 'data', 'news', category, `${subject}.json`)

/**
 * Remove every shelf a test in this file may have written — and ONLY those.
 *
 * The front page (`headlines`) is deliberately not touched here. It caches under one fixed key, so
 * it is the one shelf two test files would share, and node runs test files in parallel: a cleanup
 * of it here deletes another file's warm cache mid-assertion. newsSource.test.js owns that shelf;
 * everything in this file lives under a subject nothing else uses.
 */
function cleanup() {
    for (const cat of NEWS_CATEGORIES) {
        try { fs.rmSync(dataFile(cat, SUBJECT), { force: true }) } catch { /* nothing to remove */ }
    }
}
afterEach(cleanup)

const secs = (iso) => Math.floor(Date.parse(iso) / 1000)

/** A raw Finnhub row (unix SECONDS, flat `source`) — mapped by the service, not by the test. */
const finnhubRow = (over = {}) => ({
    datetime: secs('2026-08-19T08:00:00Z'),
    headline: 'Nvidia beats on data-centre revenue',
    summary: 'Revenue above expectations.',
    url: 'https://example.com/finnhub-1',
    image: '',
    source: 'Reuters',
    id: 1,
    ...over,
})

/** A raw GNews row (ISO `publishedAt`, nested source) — the other shape the service must accept. */
const gnewsRow = (over = {}) => ({
    publishedAt: '2026-08-19T07:00:00Z',
    title: 'OPEC weighs a production cut',
    description: 'Ministers meet in Vienna.',
    url: 'https://example.com/gnews-1',
    image: '',
    source: { name: 'AP' },
    ...over,
})

/** Counting providers, so "did it fetch?" is an assertion rather than an inference. */
function spyProviders({ company = [], general = [], search = [] } = {}) {
    const calls = { companyNews: 0, generalNews: 0, search: 0 }
    return {
        calls,
        providers: {
            companyNews: async (args) => { calls.companyNews++; calls.lastCompany = args; return company },
            generalNews: async () => { calls.generalNews++; return general },
            search: async (args) => { calls.search++; calls.lastSearch = args; return { articles: search, totalArticles: search.length } },
        },
    }
}

test('cold → fetch, warm → no provider call at all', async () => {
    const { calls, providers } = spyProviders({ company: [finnhubRow()] })

    const cold = await newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: providers })
    assert.equal(calls.companyNews, 1)
    assert.equal(cold.meta.cached, false)
    assert.equal(cold.articles.length, 1)

    // Same subject, same hour: this is the call that must cost nothing. It is the whole reason the
    // cache exists — one warm shelf serves every user asking about the name.
    const warm = await newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: providers })
    assert.equal(calls.companyNews, 1, 'a warm shelf must not re-fetch')
    assert.equal(warm.meta.cached, true)
    assert.equal(warm.articles.length, 1)
    assert.equal(warm.meta.ttlMs, CACHE_TTL_MS.companies)
})

test('refresh:true goes past a warm shelf', async () => {
    const { calls, providers } = spyProviders({ company: [finnhubRow()] })

    await newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: providers })
    await newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: providers, refresh: true })

    assert.equal(calls.companyNews, 2, 'an explicit refresh is the one way past the TTL')
})

test('the front page keeps a SHORTER shelf than the archives', () => {
    // The failure this pins: "what's the news today" answered with a top-stories list from an hour
    // ago. A company archive going an hour stale is invisible; the front page going stale is not.
    assert.ok(CACHE_TTL_MS.headlines < CACHE_TTL_MS.companies)
    assert.ok(CACHE_TTL_MS.headlines < CACHE_TTL_MS.topic)
    assert.equal(CACHE_TTL_MS.headlines, 900_000)
})

test('a refetch is INCREMENTAL — it asks from the last fetch, not from a month back', async () => {
    const { calls, providers } = spyProviders({ company: [finnhubRow()] })

    await newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: providers })
    const coldFrom = Date.parse(calls.lastCompany.from)

    // Age the shelf past its TTL by rewriting the stored timestamp — the same thing an hour would do.
    const file = dataFile('companies', SUBJECT)
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
    const anHourAgo = Date.now() - CACHE_TTL_MS.companies - 1000
    envelope.lastFetchedAt = anHourAgo
    fs.writeFileSync(file, JSON.stringify(envelope))

    await newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: providers })

    assert.equal(calls.companyNews, 2)
    const warmFrom = Date.parse(calls.lastCompany.from)
    assert.ok(warmFrom > coldFrom, 'the second window must start where the first left off')
    assert.equal(warmFrom, anHourAgo, 'and it starts exactly at the last successful fetch')
})

test('new articles MERGE into the shelf instead of replacing it', async () => {
    const first = finnhubRow({ url: 'https://example.com/a', id: 1, headline: 'First story' })
    const { providers } = spyProviders({ company: [first] })
    await newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: providers })

    const file = dataFile('companies', SUBJECT)
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
    envelope.lastFetchedAt = Date.now() - CACHE_TTL_MS.companies - 1000
    fs.writeFileSync(file, JSON.stringify(envelope))

    // The provider now returns only what is NEW (that is what the incremental window asks for) plus
    // one it already gave us. The old story must survive and the duplicate must not double.
    const second = spyProviders({ company: [
        first,
        finnhubRow({ url: 'https://example.com/b', id: 2, headline: 'Second story', datetime: secs('2026-08-19T09:00:00Z') }),
    ] })
    const out = await newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: second.providers })

    assert.equal(out.articles.length, 2, 'the shelf is an archive, not a replacement')
    assert.deepEqual(out.articles.map(a => a.headline), ['Second story', 'First story'], 'newest first')
})

test('a provider failure serves the warm shelf STALE rather than an error', async () => {
    const { providers } = spyProviders({ company: [finnhubRow()] })
    await newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: providers })

    const file = dataFile('companies', SUBJECT)
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
    envelope.lastFetchedAt = Date.now() - CACHE_TTL_MS.companies - 1000
    fs.writeFileSync(file, JSON.stringify(envelope))

    const broken = {
        companyNews: async () => { throw new Error('Finnhub 429') },
        generalNews: async () => { throw new Error('Finnhub 429') },
        search: async () => { throw new Error('GNews API error 429') },
    }
    const out = await newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: broken })

    assert.equal(out.meta.stale, true)
    assert.equal(out.articles.length, 1, 'an hour-old headline beats an error')
    assert.match(out.meta.error, /429/)
})

test('a stale serve does NOT bump the timestamp — the next call retries', async () => {
    // The trap: catching the error and saving anyway would mark the shelf fresh, so a provider blip
    // would silence the news for a full TTL instead of one call.
    const { providers } = spyProviders({ company: [finnhubRow()] })
    await newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: providers })

    const file = dataFile('companies', SUBJECT)
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
    const aged = Date.now() - CACHE_TTL_MS.companies - 1000
    envelope.lastFetchedAt = aged
    fs.writeFileSync(file, JSON.stringify(envelope))

    const broken = { companyNews: async () => { throw new Error('down') }, generalNews: async () => { throw new Error('down') }, search: async () => { throw new Error('down') } }
    await newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: broken })

    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(after.lastFetchedAt, aged, 'a failed fetch must leave the shelf cold')

    // ...and the very next call does try again.
    const recovered = spyProviders({ company: [finnhubRow({ url: 'https://example.com/new', id: 9 })] })
    const out = await newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: recovered.providers })
    assert.equal(recovered.calls.companyNews, 1)
    assert.notEqual(out.meta.stale, true)
})

test('with NOTHING cached a provider failure still surfaces — silence is not an answer', async () => {
    const broken = { companyNews: async () => { throw new Error('Finnhub down') }, generalNews: async () => { throw new Error('x') }, search: async () => { throw new Error('GNews down') } }
    await assert.rejects(
        () => newsService.getOrFetch({ category: 'companies', subject: SUBJECT, _providers: broken }),
        /down/,
    )
})

test('the source split: a ticker goes to Finnhub, words go to the text index', async () => {
    const company = spyProviders({ company: [finnhubRow()] })
    await _fetchArticles({ category: 'companies', subject: 'NVDA', query: 'NVDA' }, company.providers)
    assert.equal(company.calls.companyNews, 1)
    assert.equal(company.calls.search, 0, 'a name with a ticker never needs the text index')

    const topic = spyProviders({ search: [gnewsRow()] })
    await _fetchArticles({ category: 'topic', subject: 'OPEC', query: 'OPEC' }, topic.providers)
    assert.equal(topic.calls.search, 1)
    assert.equal(topic.calls.companyNews, 0, 'a theme has no symbol to key on')

    const front = spyProviders({ general: [finnhubRow()] })
    await _fetchArticles({ category: 'headlines', subject: 'top-stories', query: 'top-stories' }, front.providers)
    assert.equal(front.calls.generalNews, 1)
})

test('a company Finnhub cannot price falls back to the text index, and says so', async () => {
    // Foreign listings, indices and crypto pairs come back empty from a symbol-keyed feed. Falling
    // through is what keeps them answerable; the meta records that it happened.
    const { calls, providers } = spyProviders({ company: [], search: [gnewsRow()] })
    const out = await _fetchArticles({ category: 'companies', subject: 'XAUUSD', query: 'XAUUSD' }, providers)

    assert.equal(calls.companyNews, 1)
    assert.equal(calls.search, 1)
    assert.equal(out.meta.source, 'gnews')
    assert.equal(out.meta.fallback, 'finnhub-empty')
    assert.equal(out.articles.length, 1)
})

test('both provider shapes map into ONE article shape', async () => {
    // Finnhub dates in unix seconds and GNews in ISO. A mapper that divided Finnhub's again would
    // put every article in 1970 and the digest would report it as 56 years old.
    const fh = await _fetchArticles({ category: 'companies', subject: 'NVDA', query: 'NVDA' },
        spyProviders({ company: [finnhubRow()] }).providers)
    const gn = await _fetchArticles({ category: 'topic', subject: 'OPEC', query: 'OPEC' },
        spyProviders({ search: [gnewsRow()] }).providers)

    for (const [name, res] of [['finnhub', fh], ['gnews', gn]]) {
        const a = res.articles[0]
        assert.ok(a.datetime > secs('2020-01-01T00:00:00Z'), `${name} datetime landed outside this decade`)
        assert.ok(a.headline.length > 0, `${name} lost the headline`)
        assert.ok(a.source.length > 0, `${name} lost the source`)
    }
    assert.equal(fh.articles[0].source, 'Reuters')
    assert.equal(gn.articles[0].source, 'AP', 'GNews nests its source name one level down')
})
