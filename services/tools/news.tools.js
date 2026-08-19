/**
 * NEWS, as a read tool.
 *
 * UNBOUND — no userId, same as the market brief and the sector view, and for the same reason: a
 * headline is about the world. A handler that cannot see a user cannot connect their book to it,
 * which is the boundary the prompt asks Axl to hold and this signature is what makes it structural.
 *
 * ── ONE NEWS PIPE ────────────────────────────────────────────────────────────
 * Every fetch goes through services/news.service.js — the same fetch + file-cache + dedupe pipe the
 * news condition evaluator has always used (CLAUDE.md: shared mechanism → one service). This module
 * adds no fetching of its own; it only turns the articles into something a model can read. WHICH
 * source answers a category (Finnhub by symbol or front page, GNews for free text) is that
 * service's decision, not this tool's — the model picks the kind of question, never the provider.
 *
 * ── DATA HERE, JUDGMENT IN THE CHAT ──────────────────────────────────────────
 * The digest is assembled deterministically: newest first, dated, sourced, capped. The SUMMARY — what
 * the story is, what repeats, what matters — is the agent's, written in its own voice in the reply.
 * We never ask a second model to pre-summarise: that would put a judgment nobody reads between the
 * headlines and the desk that is already qualified to make it.
 */

import { makeToolHandler }             from '../agentUtils.js'
import { newsService, NEWS_CATEGORIES, HEADLINES_SUBJECT } from '../news.service.js'

const LOG = '[newsTool]'

/** How many headlines reach the model. The cache holds a month; a chat answer does not need it. */
const MAX_ARTICLES = 12
/** Each paper's own blurb, trimmed. Long enough to carry the story, short enough to list 12. */
const MAX_SUMMARY = 220

export const NEWS_TOOL_SPEC = {
    get_news: `Recent NEWS HEADLINES, in three kinds. \`companies\` takes a TICKER (NVDA, BA) and returns that company's own coverage. \`headlines\` takes no subject and returns the market's front page — call it for "what's the news today", "anything big happening". \`topic\` takes free text and searches a general news index — for a theme, an institution or an asset with no ticker ("Federal Reserve", "OPEC", "semiconductors", "gold"). Every kind returns real articles: date, age, source, headline and the publisher's own summary, newest first. This is what was WRITTEN about a subject — it is NOT today's market brief (the tape, rates, macro), NOT a price or a chart, and NOT our view. Summarise what the headlines say and attribute them; never turn them into a trade view, a price target or advice, and never connect them to what this user holds.`,
}

/** A unix-second timestamp → how a reader would say its age. Absolute date is printed beside it. */
function _age(datetimeSec, now = Date.now()) {
    const days = Math.floor((now - datetimeSec * 1000) / 86_400_000)
    if (days <= 0) return 'today'
    if (days === 1) return 'yesterday'
    if (days < 14) return `${days} days ago`
    const weeks = Math.round(days / 7)
    return `${weeks} weeks ago`
}

/**
 * Publisher feeds arrive damaged in two consistent ways, and the model quotes what it is handed —
 * so "Advanced Micro Devices, Inc.âs AI hardware" and "Nvidia&#39;s GPUs" would reach the chat.
 *
 * 1. UTF-8 read as Latin-1. It appears in TWO forms depending on who mangled it: the RAW one, whose
 *    middle byte is still a C1 control (â), and the CP1252-decoded one, where that byte became a
 *    euro sign (â€™). Both are listed, raw FIRST — the C1 sweep below would otherwise eat the
 *    middle byte and leave a bare "â" that nothing can interpret.
 * 2. HTML entities the publisher's own feed writer never decoded.
 *
 * Only unambiguous sequences are repaired. Anything cleverer starts rewriting real text.
 */
const MOJIBAKE = [
    // UTF-8-as-Latin-1, raw C1 form
    [/\u00e2\u0080\u0099/g, '\u2019'],
    [/\u00e2\u0080\u0098/g, '\u2018'],
    [/\u00e2\u0080\u009c/g, '\u201c'],
    [/\u00e2\u0080\u009d/g, '\u201d'],
    [/\u00e2\u0080\u0094/g, '\u2014'],
    [/\u00e2\u0080\u0093/g, '\u2013'],
    [/\u00e2\u0080\u00a6/g, '\u2026'],
    // the same sequences after a CP1252 decode
    [/\u00e2\u20ac\u2122/g, '\u2019'],
    [/\u00e2\u20ac\u02dc/g, '\u2018'],
    [/\u00e2\u20ac\u009c/g, '\u201c'],
    [/\u00e2\u20ac\u009d/g, '\u201d'],
    [/\u00e2\u20ac\u201d/g, '\u2014'],
    [/\u00e2\u20ac\u201c/g, '\u2013'],
    [/\u00e2\u20ac\u00a6/g, '\u2026'],
    [/\u00c2\u00a0/g, ' '],              // non-breaking space read as Latin-1
    [/[\u0080-\u009f]/g, ''],            // stray C1 bytes from a half-decoded sequence
    // HTML entities
    [/&#0*39;|&#x0*27;|&apos;/gi, '\u2019'],
    [/&quot;|&#0*34;/gi, '"'],
    [/&nbsp;|&#0*160;/gi, ' '],
    [/&lt;/gi, '<'], [/&gt;/gi, '>'],
    [/&amp;|&#0*38;/gi, '&'],            // LAST: decoding it earlier would re-arm the entities above
]

function _trim(text, max) {
    let t = String(text ?? '')
    for (const [re, to] of MOJIBAKE) t = t.replace(re, to)
    t = t.replace(/\s+/g, ' ').trim()
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/**
 * Articles → an LLM-ready digest. Pure — `now` is injected so the ages are testable.
 *
 * The empty case is not an empty string: a tool that returns nothing is a tool the model answers
 * from memory. It gets told, in words, that the index came back empty and that saying so IS the
 * answer — the same instruction formatSectorView gives for a view nobody has published.
 */
export function formatNewsDigest(articles, { subject, category, now = Date.now() } = {}) {
    // Sorted HERE and not merely assumed: the header claims which item is newest and the slice keeps
    // the top 12, so an unsorted list would both mislabel the freshness and drop the very headlines
    // the reader asked for. The service sorts too; this is the guarantee that survives a new caller.
    const rows = (Array.isArray(articles) ? articles : [])
        .filter(a => Number.isFinite(a?.datetime))
        .sort((a, b) => b.datetime - a.datetime)
        .slice(0, MAX_ARTICLES)
    const what = category === 'headlines'
        ? "today's market front page"
        : `${subject}${category === 'companies' ? '' : ` (${category})`}`

    if (!rows.length) {
        return `NEWS — ${what}: the news index returned nothing for this subject.\n\n`
            + `Say so plainly: there is no recent coverage you can see. Do NOT fill the gap from memory, `
            + `do not repeat a story you think you know, and do not guess why it is quiet. Offer to try a `
            + `different wording of the subject if that seems likely to help.`
    }

    // On a ticker read, the OTHER names a story was tagged with. A symbol-keyed feed still carries
    // peer coverage — an AMD piece tagged NVDA — and the tags are what let the model say "that one
    // is really about AMD" instead of reporting it as this company's news.
    const subjectTicker = category === 'companies' ? String(subject).toUpperCase() : null
    const others = (a) => {
        if (!subjectTicker) return ''
        const rest = (Array.isArray(a.related) ? a.related : []).filter(t => t !== subjectTicker)
        return rest.length ? ` [also tagged: ${rest.slice(0, 5).join(', ')}]` : ''
    }

    const lines = rows.map((a) => {
        const date    = new Date(a.datetime * 1000).toISOString().slice(0, 10)
        const source  = a.source ? ` — ${a.source}` : ''
        const head    = `• [${date}, ${_age(a.datetime, now)}]${source}${others(a)}\n  ${_trim(a.headline, 200)}`
        const summary = _trim(a.summary, MAX_SUMMARY)
        return summary ? `${head}\n  ${summary}` : head
    })

    const newest = rows[0].datetime
    const oldest = rows[rows.length - 1].datetime

    return [
        `NEWS — ${what} (${rows.length} article${rows.length === 1 ? '' : 's'}, newest ${_age(newest, now)}, oldest ${_age(oldest, now)})`,
        '',
        ...lines,
        '',
        // Two failures this block exists to prevent: reporting a three-week-old headline as this
        // morning's, and relaying a publisher's claim as the house's own read.
        'These are third-party headlines, not our research and not our view. Summarise what they say and '
        + 'attribute it to the papers. Be explicit about WHEN — an old story reported as fresh is the '
        + 'one mistake here that changes a decision. Never add a price view, a level, or what any of it '
        + 'means for anyone\'s positions.'
        // The company feed is symbol-keyed but not symbol-EXCLUSIVE: a publisher tags a rival's story
        // with every name it touches, so an AMD piece arrives under NVDA. The tags catch some of it;
        // the headline catches the rest, which is why this is said on every ticker read.
        + (subjectTicker
            ? ` Some of these will be PEER or sector stories that only mention ${subjectTicker} —`
              + ' a headline about another company is not this one\'s news, and a story tagged with other'
              + ' tickers is usually about them. Read the headline before you report it, and say which'
              + ' ones are really about someone else rather than folding them in.'
            : ''),
    ].join('\n')
}

/**
 * `company` → `companies`; anything unrecognised becomes a `topic` search rather than throwing. A
 * free-text read on the wrong shelf still returns news; a thrown category returns none.
 */
export function _normalizeCategory(raw) {
    const c = String(raw ?? '').trim().toLowerCase()
    if (c === 'company') return 'companies'
    return NEWS_CATEGORIES.has(c) ? c : 'topic'
}

export function makeNewsHandlers(deps = {}) {
    const { fetchNews = (opts) => newsService.getOrFetch(opts) } = deps

    return {
        get_news: makeToolHandler('get_news',
            async ({ subject, category } = {}) => {
                const cat = _normalizeCategory(category)
                // The front page has no subject; every other kind needs one, and a model that asked
                // for a company without naming it gets told so rather than a silent empty read.
                const subj = cat === 'headlines'
                    ? HEADLINES_SUBJECT
                    : String(subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 64)
                if (!subj) return 'get_news needs a subject — the ticker or theme to read about (or category "headlines" for the front page).'

                // subject IS the query, deliberately. The service caches by category+subject, so a
                // free-form query would let one phrasing ("Nvidia earnings") fill the cache another
                // phrasing ("Nvidia") then reads back as its own.
                const { articles } = await fetchNews({ category: cat, subject: subj, query: subj })
                return formatNewsDigest(articles, { subject: subj, category: cat })
            },
            (err) => `Could not fetch the news: ${err.message}`, LOG),
    }
}
