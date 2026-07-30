/**
 * The authored concept set — plain explanations of the trading ideas a beginner meets in the app.
 *
 * WHY AUTHORED RATHER THAN GENERATED. An LLM improvising trading education will occasionally teach
 * confident nonsense, and a beginner is precisely the reader who cannot catch it. These few dozen
 * concepts are stable enough to be written once and reviewed, so they are. This is not in tension
 * with the project's no-hardcoded-rules principle: that rule is about routing and decisions, not
 * about facts.
 *
 * Content lives in `concepts.md` at the repo root, beside the system prompts — the same place this
 * codebase already keeps authored copy, loaded through the same mtime-gated loader, so edits take
 * effect without a restart. This module PARSES and LOOKS UP. It never formats and never writes
 * anything the model reads directly; that belongs to concepts.tools.js, the same read-service /
 * adapter split the reporting tools use.
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { makePromptLoader } from './agentUtils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG = '[concepts]'
const _loadFile = makePromptLoader(join(__dirname, '../concepts.md'), LOG)

// Memoised on the loader's returned STRING, not on time. makePromptLoader hands back the same
// string until the file's mtime changes, so this re-parses exactly when the content actually
// changed and never on a hot path.
let _cache = { source: null, byKey: new Map(), byAlias: new Map() }

/**
 * Anything a user might type → a comparable key. Case, spaces, hyphens and underscores all
 * collapse, and a trailing 's' is dropped, so "Stop Loss", "stop-loss" and "stops" agree.
 * Applied to BOTH sides of the lookup, which is what makes it symmetric.
 */
export function normalizeKey(raw) {
    if (typeof raw !== 'string') return ''
    const flat = raw.trim().toLowerCase().replace(/[\s_-]+/g, '')
    // Only strip a plural 's' when something is left worth matching — "s" itself is not a concept,
    // and neither is a word that ends in "ss" (a "loss" must not become a "los").
    return (flat.length > 3 && flat.endsWith('s') && !flat.endsWith('ss')) ? flat.slice(0, -1) : flat
}

/**
 * Split the markdown into `{ key, aliases[], body }`.
 *
 * `## key` opens an entry; an optional `Aliases:` line follows; everything up to the next `##` is
 * the body. Aliases live in the content file rather than in code so that adding a concept is one
 * edit in one place, by whoever is writing the copy.
 */
function _parse(source) {
    const byKey = new Map()
    const byAlias = new Map()

    // Split on level-2 headings only. The file's `#` title and any `---` rules are ignored.
    const sections = source.split(/^##\s+/m).slice(1)
    for (const section of sections) {
        const [headingLine, ...rest] = section.split('\n')
        const key = headingLine.trim()
        if (!key) continue

        let lines = rest
        const aliases = []
        const aliasLine = lines.find(l => /^aliases:/i.test(l.trim()))
        if (aliasLine) {
            for (const a of aliasLine.replace(/^\s*aliases:/i, '').split(',')) {
                const t = a.trim()
                if (t) aliases.push(t)
            }
            lines = lines.filter(l => l !== aliasLine)
        }

        const body = lines.join('\n').trim()
        if (!body) continue

        const entry = { key, aliases, body }
        byKey.set(key, entry)
        // The key is its own alias, so a caller can pass either.
        for (const name of [key, ...aliases]) byAlias.set(normalizeKey(name), entry)
    }
    return { byKey, byAlias }
}

function _index() {
    const source = _loadFile()
    if (source !== _cache.source) _cache = { source, ..._parse(source) }
    return _cache
}

/**
 * The authored explanation for a concept, or null if there isn't one.
 * Null is a normal, expected answer — the caller falls back to explaining it another way, so this
 * never throws for an unknown name.
 *
 * @returns {{key:string, aliases:string[], body:string}|null}
 */
export function getConcept(name) {
    const wanted = normalizeKey(name)
    if (!wanted) return null
    return _index().byAlias.get(wanted) ?? null
}

/** Every authored concept key, in file order. */
export function listConcepts() {
    return [..._index().byKey.keys()]
}

/** Full entries — for tests and for anything that wants to render the whole set. */
export function allConcepts() {
    return [..._index().byKey.values()]
}
