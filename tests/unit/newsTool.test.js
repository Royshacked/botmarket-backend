import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatNewsDigest, makeNewsHandlers, _normalizeCategory, NEWS_TOOL_SPEC } from '../../services/tools/news.tools.js'
import { NEWS_CATEGORIES, HEADLINES_SUBJECT } from '../../services/news.service.js'
import { TOOLS as AXL_TOOLS } from '../../services/agents/axl.agent.service.js'
import { isToolError, toolErrorText } from '../../services/toolResult.util.js'

// Axl's READ of the outside world's headlines. Reporting what the papers wrote is Axl's half of the
// line; forming a view about it belongs to a desk.

const NOW = Date.parse('2026-08-19T12:00:00Z')
const secs = (iso) => Math.floor(Date.parse(iso) / 1000)

const article = (over = {}) => ({
    datetime: secs('2026-08-19T08:00:00Z'),
    headline: 'Nvidia beats on data-centre revenue',
    summary: 'The chipmaker reported quarterly revenue above expectations, driven by data-centre demand.',
    url: 'https://example.com/a',
    image: '',
    source: 'Reuters',
    id: null,
    ...over,
})

test('the digest carries each article dated, aged, sourced and summarised', () => {
    const out = formatNewsDigest([article()], { subject: 'Nvidia', category: 'companies', now: NOW })
    assert.match(out, /NEWS — Nvidia/)
    assert.match(out, /\[2026-08-19, today\]/)
    assert.match(out, /— Reuters/)
    assert.match(out, /Nvidia beats on data-centre revenue/)
    assert.match(out, /driven by data-centre demand/)
})

test('age is stated in words per item — a stale headline must not read as this morning', () => {
    // The failure this guards: the model relays a three-week-old story as today's news, and someone
    // acts on it. The absolute date alone did not stop that; the age in words is the fix.
    const out = formatNewsDigest([
        article({ datetime: secs('2026-08-18T09:00:00Z'), headline: 'Yesterday story' }),
        article({ datetime: secs('2026-08-14T09:00:00Z'), headline: 'Five day story' }),
        article({ datetime: secs('2026-07-29T09:00:00Z'), headline: 'Three week story' }),
    ], { subject: 'Nvidia', category: 'companies', now: NOW })
    assert.match(out, /yesterday\]/)
    assert.match(out, /5 days ago\]/)
    assert.match(out, /3 weeks ago\]/)
})

test('the header states how fresh the newest item is and how old the oldest is', () => {
    const out = formatNewsDigest([
        article({ datetime: secs('2026-08-19T08:00:00Z') }),
        article({ datetime: secs('2026-08-05T08:00:00Z') }),
    ], { subject: 'Nvidia', category: 'companies', now: NOW })
    assert.match(out, /2 articles, newest today, oldest 2 weeks ago/)
})

test('at most 12 headlines reach the model', () => {
    const many = Array.from({ length: 30 }, (_, i) => article({ headline: `Story ${i}` }))
    const out = formatNewsDigest(many, { subject: 'Nvidia', category: 'companies', now: NOW })
    assert.match(out, /12 articles/)
    assert.match(out, /Story 11/)
    assert.doesNotMatch(out, /Story 12\b/)
})

test('NO articles tells the model to say so, not to answer from memory', () => {
    const out = formatNewsDigest([], { subject: 'Nvidia', category: 'companies', now: NOW })
    assert.match(out, /returned nothing/)
    assert.match(out, /Do NOT fill the gap from memory/)
    // An empty return would be answered from the model's own recall — the whole point of the words.
    assert.ok(out.length > 100)
})

test('the digest forbids a price view and any link to the reader"s book', () => {
    const out = formatNewsDigest([article()], { subject: 'Nvidia', category: 'companies', now: NOW })
    assert.match(out, /third-party headlines, not our research and not our view/)
    assert.match(out, /Never add a price view, a level, or what any of it means for anyone's positions/)
})

test('a topic read is labelled with its kind, and the front page names itself', () => {
    const topic = formatNewsDigest([article({ headline: 'Fed holds' })], { subject: 'Federal Reserve', category: 'topic', now: NOW })
    assert.match(topic, /NEWS — Federal Reserve \(topic\)/)
    const front = formatNewsDigest([article({ headline: 'Stocks rally' })], { subject: HEADLINES_SUBJECT, category: 'headlines', now: NOW })
    assert.match(front, /NEWS — today's market front page/)
    // "top-stories" is a cache key, not something a reader should ever be shown.
    assert.doesNotMatch(front, /top-stories/)
})

test('the category vocabulary is the news service own — no second copy', () => {
    for (const c of NEWS_CATEGORIES) assert.equal(_normalizeCategory(c), c)
    assert.equal(_normalizeCategory('company'), 'companies')
    // A model typo falls back rather than throwing: a text search still reads news, a throw reads none.
    assert.equal(_normalizeCategory('gossip'), 'topic')
    assert.equal(_normalizeCategory(undefined), 'topic')
})

test('the handler asks the news service for the subject, using it as the query', async () => {
    const calls = []
    const { get_news } = makeNewsHandlers({
        fetchNews: async (opts) => { calls.push(opts); return { articles: [article()] } },
    })
    const out = await get_news({ subject: '  Nvidia  ', category: 'companies' })
    // subject IS the query: a free-form query would let one phrasing fill the cache another reads back.
    assert.deepEqual(calls, [{ category: 'companies', subject: 'Nvidia', query: 'Nvidia' }])
    assert.match(out, /Nvidia beats/)
})

test('a missing subject is answered, not thrown — except on the front page, which needs none', async () => {
    const { get_news } = makeNewsHandlers({ fetchNews: async () => { throw new Error('must not be called') } })
    assert.match(await get_news({ category: 'companies' }), /needs a subject/)

    const calls = []
    const front = makeNewsHandlers({ fetchNews: async (o) => { calls.push(o); return { articles: [article()] } } })
    await front.get_news({ category: 'headlines' })
    assert.deepEqual(calls, [{ category: 'headlines', subject: HEADLINES_SUBJECT, query: HEADLINES_SUBJECT }])
})

test('a provider failure comes back as a tool error, never as silence', async () => {
    const { get_news } = makeNewsHandlers({ fetchNews: async () => { throw new Error('GNews API error 429') } })
    const out = await get_news({ subject: 'Nvidia', category: 'companies' })
    assert.ok(isToolError(out))
    assert.match(toolErrorText(out), /Could not fetch the news: GNews API error 429/)
})

test('Axl carries the tool, and it is APPENDED last', () => {
    const names = AXL_TOOLS.map(t => t.name)
    assert.ok(names.includes('get_news'))
    // The kit is compared by index by the snapshot test and cached by array prefix — a tool inserted
    // mid-array invalidates Axl's cached tool block on every request until it re-warms.
    assert.equal(names[names.length - 1], 'get_news')
})

test('the tool description holds the line against the brief and against advice', () => {
    const desc = NEWS_TOOL_SPEC.get_news
    assert.match(desc, /NOT today's market brief/)
    assert.match(desc, /never connect them to what this user holds/)
    // A company read is keyed by SYMBOL now — a model told to pass a name gets a text search's noise.
    assert.match(desc, /takes a TICKER/)
})

test('peer coverage is TAGGED so it cannot be reported as this company"s news', () => {
    // The symbol-keyed feed still returns stories about rivals that merely mention the name. The
    // tags are data; deciding what to do with them is the chat's job, and the digest says so.
    const out = formatNewsDigest([
        article({ headline: 'AMD Helios platform impresses', related: ['AMD', 'NVDA'] }),
        article({ headline: 'Nvidia beats', related: ['NVDA'] }),
    ], { subject: 'NVDA', category: 'companies', now: NOW })

    assert.match(out, /\[also tagged: AMD\]/)
    assert.equal((out.match(/also tagged/g) || []).length, 1, 'a story tagged only with the subject gets no tag line')
    assert.match(out, /PEER or sector stories that only mention NVDA/)
})

test('a topic read carries no ticker tags — there is no subject symbol to compare against', () => {
    const out = formatNewsDigest([article({ related: ['AMD', 'NVDA'] })], { subject: 'oil', category: 'topic', now: NOW })
    assert.doesNotMatch(out, /also tagged/)
    assert.doesNotMatch(out, /PEER or sector stories/)
})

test('mojibake from the publisher feeds is repaired, not relayed', () => {
    // "Inc.\u00e2\u20ac\u2122s" is UTF-8 read as Latin-1. The model quotes what it is handed, so the
    // garbage would land in the chat.
    const out = formatNewsDigest([article({
        headline: 'Advanced Micro Devices, Inc.\u00e2\u20ac\u2122s AI hardware',
        summary: 'An AI\u00e2\u20ac\u201ddriven quarter\u00c2\u00a0with records.',
    })], { subject: 'NVDA', category: 'companies', now: NOW })

    assert.match(out, /Inc\.\u2019s AI hardware/)
    assert.match(out, /AI\u2014driven quarter with records/)
    assert.doesNotMatch(out, /\u00e2\u20ac/)
})

test('the RAW C1 form of the same damage is repaired too — it is what the live feed sends', () => {
    // Two forms exist: the middle byte still a C1 control (what Finnhub sends) and the CP1252-decoded
    // euro-sign form. Catching only the second left "Inc.\u00e2s" in the chat.
    const out = formatNewsDigest([article({
        headline: 'Inc.\u00e2\u0080\u0099s hardware',
        summary: 'AI\u00e2\u0080\u0094driven \u00e2\u0080\u009crecords\u00e2\u0080\u009d',
    })], { subject: 'NVDA', category: 'companies', now: NOW })

    assert.match(out, /Inc\.\u2019s hardware/)
    assert.match(out, /AI\u2014driven \u201crecords\u201d/)
    assert.doesNotMatch(out, /\u00e2/)
})

test('un-decoded HTML entities are decoded, and &amp; does not re-arm them', () => {
    const out = formatNewsDigest([article({
        headline: 'Nvidia&#39;s GPUs &amp; &quot;records&quot;',
        summary: 'Costs &lt; revenue &amp;#39; stays literal',
    })], { subject: 'NVDA', category: 'companies', now: NOW })

    assert.match(out, /Nvidia\u2019s GPUs & "records"/)
    assert.match(out, /Costs < revenue/)
    // &amp; is decoded LAST, so an escaped entity in the source text is not turned into a quote.
    assert.match(out, /&#39; stays literal/)
})

test('the digest sorts before it caps — an unsorted caller cannot mislabel the freshness', () => {
    // The header claims which item is newest and the slice keeps the top 12. Trusting the caller to
    // have sorted would both misdate the answer and drop the headlines the reader came for.
    const day = (d) => Math.floor(Date.parse(`2026-08-${d}T08:00:00Z`) / 1000)
    const out = formatNewsDigest([
        article({ datetime: day('05'), headline: 'two weeks old' }),
        article({ datetime: day('19'), headline: 'from today' }),
    ], { subject: 'NVDA', category: 'companies', now: NOW })

    assert.match(out, /newest today, oldest 2 weeks ago/)
    assert.ok(out.indexOf('from today') < out.indexOf('two weeks old'), 'newest is listed first')
})

test('a dateless row is dropped rather than dated 1970', () => {
    const out = formatNewsDigest([article(), { headline: 'no date', summary: '' }], { subject: 'NVDA', category: 'companies', now: NOW })
    assert.match(out, /1 article,/)
    assert.doesNotMatch(out, /no date/)
})
