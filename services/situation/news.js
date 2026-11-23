// THE SITUATION NETWORK'S NEWS (docs/design/situation-network.md §11.7; plan step 3).
//
// One dated feed for the state's reading sections and the event watcher. Sources, shared, not copied:
//   · Echo's intake readers (echoIntake.service): the Federal Register (tariffs, export controls, sanctions, subsidies,
//     critical minerals), FMP's general news, the Defense Department's large awards;
//   · GNews, on the network's macro topics (GNEWS_API_KEY; skipped, and said, without one).
// Every article is dated, deduped (by URL, else by title), and nothing after `asOf` is kept — the hindsight rule. The
// articles a state is built from are stored on it (model.js checkState's `articles`), so any week can be audited.

import { echoIntakeService } from '../echoIntake.service.js'
import { fetchGNews } from '../../providers/gnews.provider.js'
import { config } from '../config.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.news]'

/** The macro topics GNews is asked about, one query each (the free plan's daily quota is about 100). */
export const GNEWS_TOPICS = Object.freeze([
    'tariffs trade war', 'Federal Reserve interest rates', 'inflation economy', 'sanctions', 'OPEC oil supply',
    'China economy stimulus', 'Russia Ukraine', 'Iran', 'Taiwan China', 'AI data center spending',
])
export const MAX_ARTICLES = 200
/** FMP's general news runs to hundreds a day; at most this many per day, so a week is a week and not its last day. */
export const FMP_PER_DAY = 10
/** FMP's pages are read until they reach back past the window (echoIntake.news stops there); this many at most. */
export const FMP_MAX_PAGES = 40
const TEXT_MAX = 500

const _io = {
    policy: (now, days) => echoIntakeService.policy(now, { days }),
    fmpNews: (now, days) => echoIntakeService.news(now, { days, pages: FMP_MAX_PAGES }),
    defense: (now) => echoIntakeService.defense(now),
    gnews: (q, from, to) => fetchGNews({ query: q, from, to, max: 10 }),
    hasGnews: () => Boolean(config.gnewsApiKey),
    now: () => new Date(),
}
export function _setIO(io) { Object.assign(_io, io) }

const clip = (s, n = TEXT_MAX) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const day = (d) => d.toISOString().slice(0, 10)

/** One source's rows → the feed's article shape. Pure. */
export function toArticle(r, source) {
    const published = r.published_at ?? r.publishedAt ?? r.date ?? null
    const at = published ? String(published) : null
    return {
        url: clip(r.url, 500) || null, title: clip(r.title, 300), source: clip(r.source?.name ?? r.sourceName ?? source, 120),
        published_at: at && at.length === 10 ? `${at}T00:00:00Z` : at, text: clip(r.text ?? r.description ?? r.content),
    }
}

/**
 * Dedupe (URL, else lowercased title), drop anything undated or dated after `asOf`, newest first, at most `max`. Pure.
 */
export function mergeArticles(lists, asOf, max = MAX_ARTICLES) {
    const seen = new Set(), out = []
    for (const a of lists.flat()) {
        if (!a?.title || !a.published_at) continue
        if (a.published_at.slice(0, 10) > asOf) continue
        const key = a.url ? `u|${a.url}` : `t|${a.title.toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(a)
    }
    return out.sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, max)
}

/** At most `n` articles per publication day, in the order given. Pure. */
export function capPerDay(articles, n = FMP_PER_DAY) {
    const count = new Map()
    return articles.filter(a => {
        const d = a.published_at?.slice(0, 10)
        if (!d) return false
        const c = count.get(d) ?? 0
        count.set(d, c + 1)
        return c < n
    })
}

/** The articles as numbered lines for a prompt (the number is how the model cites one). Pure. */
export function articleLines(articles) {
    return articles.map((a, i) => `[${i + 1}] ${a.published_at.slice(0, 10)} · ${a.source} · ${a.title}${a.text ? ` — ${a.text}` : ''}`).join('\n')
}

/**
 * The feed for the `days` up to `asOf` → `{ articles, gaps }`. A source that fails is a named gap; never throws.
 */
export async function fetchNews({ days = 7, asOf = null } = {}) {
    const now = _io.now()
    const until = asOf ?? day(now)
    const gaps = []
    const guard = async (name, fn) => { try { return (await fn()) ?? [] } catch (err) { gaps.push(`${name}: ${err.message}`); logger.warn(LOG, `${name} failed`, { error: err.message }); return [] } }

    const [policy, fmp, defense] = await Promise.all([
        guard('Federal Register', () => _io.policy(now, days)),
        guard('FMP general news', () => _io.fmpNews(now, days)),
        guard('Defense awards', () => _io.defense(now)),
    ])
    const lists = [policy.map(r => toArticle(r, 'Federal Register')), capPerDay(fmp.map(r => toArticle(r, 'FMP news'))), defense.map(r => toArticle(r, 'Defense contracts'))]

    if (_io.hasGnews()) {
        const from = new Date(Date.parse(`${until}T00:00:00Z`) - days * 864e5).toISOString()
        const to = `${until}T23:59:59Z`
        for (const q of GNEWS_TOPICS) {
            const j = await guard(`GNews "${q}"`, () => _io.gnews(q, from, to))
            lists.push((j?.articles ?? []).map(r => toArticle(r, 'GNews')))
        }
    } else {
        gaps.push('GNews: no GNEWS_API_KEY — the feed runs on the Federal Register, FMP and Defense only')
    }
    return { articles: mergeArticles(lists, until), gaps }
}
