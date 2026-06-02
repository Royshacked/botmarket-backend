/**
 * One-time migration: data/news/lanes/** → data/news/{global,markets,sectors,companies}/
 * Run: node scripts/migrate-news-lanes.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const LANES_DIR = path.join(ROOT, 'data', 'news', 'lanes')
const TTL_SUFFIX = /_(?:\d+[mhd]|1h|4h|15m)$/i

const LANE_FOLDER_CATEGORY = {
    company: 'companies',
    ticker: 'companies',
    news: 'companies',
    top: 'companies',
    quantum: 'sectors',
    market: 'markets',
    topic: 'global',
}

/** @type {Map<string, { category: string, subject: string, query: string, lastFetchedAt: number, items: object[] }>} */
const buckets = new Map()

function main() {
    if (!fs.existsSync(LANES_DIR)) {
        console.log('No data/news/lanes — nothing to migrate.')
        return
    }

    const files = collectJsonFiles(LANES_DIR)
    for (const filePath of files) {
        const rel = path.relative(LANES_DIR, filePath)
        const laneFolder = rel.split(path.sep)[0]
        const baseName = path.basename(filePath, '.json')
        let envelope
        try {
            envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        } catch (err) {
            console.warn(`Skip (invalid JSON): ${rel}`, err.message)
            continue
        }
        const dest = resolveDestination(laneFolder, baseName, envelope)
        if (!dest) {
            console.warn(`Skip (unmapped): ${rel}`)
            continue
        }
        mergeIntoBucket(dest, envelope)
    }

    for (const [key, envelope] of buckets) {
        const [category, subject] = key.split('/')
        const outDir = path.join(ROOT, 'data', 'news', category)
        fs.mkdirSync(outDir, { recursive: true })
        const outPath = path.join(outDir, `${subject}.json`)
        fs.writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n', 'utf8')
        console.log(`Wrote ${path.relative(ROOT, outPath)} (${envelope.items.length} items)`)
    }

    fs.rmSync(LANES_DIR, { recursive: true, force: true })
    console.log(`Removed ${path.relative(ROOT, LANES_DIR)}`)
}

/** @returns {string[]} */
function collectJsonFiles(dir) {
    /** @type {string[]} */
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...collectJsonFiles(full))
        else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full)
    }
    return out
}

/**
 * @param {string} laneFolder
 * @param {string} baseName
 * @param {Record<string, unknown>} envelope
 */
function resolveDestination(laneFolder, baseName, envelope) {
    const kind =
        typeof envelope.kind === 'string' ? envelope.kind : laneFolder
    let category = LANE_FOLDER_CATEGORY[laneFolder] ?? 'global'
    let subject =
        typeof envelope.subject === 'string' && envelope.subject.trim()
            ? envelope.subject.trim()
            : stripTtlSuffix(baseName)

    if (laneFolder === 'quantum' || kind === 'quantum') {
        category = 'sectors'
        subject = 'quantum'
    } else if (
        laneFolder === 'company' ||
        laneFolder === 'ticker' ||
        laneFolder === 'news' ||
        laneFolder === 'top' ||
        kind === 'company' ||
        kind === 'ticker' ||
        kind === 'news' ||
        kind === 'top'
    ) {
        category = 'companies'
        subject = normalizeCompanySubject(subject, envelope.query)
    } else if (
        category === 'markets' &&
        isTickerLike(subject) &&
        !isMarketSubjectSlug(subject)
    ) {
        category = 'companies'
        subject = subject.toUpperCase()
    } else if (laneFolder === 'topic' || kind === 'topic') {
        const ticker = tickerFromQuery(envelope.query)
        if (ticker) {
            category = 'companies'
            subject = ticker
        } else {
            category = 'global'
            subject = sanitizeSlug(subject || stripTtlSuffix(baseName))
        }
    } else {
        subject = sanitizeSlug(subject)
        if (category === 'companies') {
            subject = normalizeCompanySubject(subject, envelope.query)
        }
    }

    if (!subject) return null
    return { category, subject: sanitizeSlug(subject) }
}

/**
 * @param {{ category: string, subject: string }} dest
 * @param {Record<string, unknown>} envelope
 */
function mergeIntoBucket(dest, envelope) {
    const key = `${dest.category}/${dest.subject}`
    const query =
        typeof envelope.query === 'string' && envelope.query.trim()
            ? envelope.query.trim()
            : dest.subject
    const lastFetchedAt = Number(envelope.lastFetchedAt) || 0
    const items = Array.isArray(envelope.items) ? envelope.items : []

    const existing = buckets.get(key)
    if (!existing) {
        buckets.set(key, {
            category: dest.category,
            subject: dest.subject,
            query,
            lastFetchedAt,
            items: [...items],
        })
        return
    }

    existing.items = dedupeArticles([...existing.items, ...items])
    if (lastFetchedAt >= existing.lastFetchedAt) {
        existing.lastFetchedAt = lastFetchedAt
        existing.query = query
    }
}

/** @param {object[]} items */
function dedupeArticles(items) {
    const map = new Map()
    for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const key =
            item.id != null
                ? `id:${item.id}`
                : `dt:${item.datetime}|h:${item.headline}`
        map.set(key, item)
    }
    return [...map.values()].sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0))
}

function stripTtlSuffix(name) {
    return name.replace(TTL_SUFFIX, '').replace(/_sector$/i, '')
}

const MARKET_SUBJECTS = new Set(['news', 'general', 'us', 'global', 'macro'])

function isTickerLike(value) {
    return /^[A-Za-z]{1,5}$/.test(String(value).trim())
}

function isMarketSubjectSlug(value) {
    return MARKET_SUBJECTS.has(String(value).trim().toLowerCase())
}

/** @param {unknown} query */
function tickerFromQuery(query) {
    if (typeof query !== 'string') return null
    const m = query.match(/\b([A-Z]{1,5})\b/)
    return m && ['AAPL', 'TSLA', 'META', 'NVDA', 'MSFT', 'GOOG', 'GOOGL', 'AMZN'].includes(m[1])
        ? m[1]
        : null
}

/** @param {string} subject @param {unknown} query */
function normalizeCompanySubject(subject, query) {
    const s = String(subject).trim()
    if (/^apple\b/i.test(s)) return 'AAPL'
    const fromQuery = tickerFromQuery(query)
    if (fromQuery && /apple|earnings/i.test(s)) return fromQuery
    if (isTickerLike(s)) return s.toUpperCase()
    const word = s.split(/\s+/)[0]
    if (isTickerLike(word)) return word.toUpperCase()
    return sanitizeSlug(s).toUpperCase()
}

function sanitizeSlug(value) {
    return (
        String(value)
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 64) || 'UNKNOWN'
    )
}

main()
