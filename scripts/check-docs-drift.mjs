/**
 * Which claims in the docs no longer point at anything?
 *
 * A doc drifts one reference at a time: a service is renamed, a route moves, a status value is
 * retired, and the sentence that named it keeps reading as if nothing happened. Re-reading 13k
 * lines to find those sentences is the expensive part of a docs cycle; this script does the
 * mechanical 80% first so the reading can start where the rot actually is.
 *
 * It pulls every CHECKABLE claim out of the docs — backtick paths, module names, routes, emit
 * tags, symbols, constants, markdown links and their anchors — and asks the tree whether each one
 * still exists. It does not judge prose: a doc can be 100% resolved and still describe a
 * mechanism that was replaced. That is what the read-through is for; this tells you which docs
 * to read first, and which of their sentences to distrust.
 *
 *   npm run check:docs                      every living doc
 *   npm run check:docs -- docs/desks        one folder, or a file
 *   npm run check:docs -- --json > out.json machine-readable, for a fix pass
 *
 * Historical records (`docs/code-review-*.md`) and `archive/` are skipped by design: they describe
 * a moment, not the present, and are supposed to go stale. A symbol that resolves ONLY inside
 * `archive/` is reported as `archived` — that is a drift signal, not a pass.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative, sep, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FRONTEND = resolve(ROOT, '..', 'botmarket-frontend')
const AETHER = resolve(ROOT, '..', 'aether-engine')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const DEPS = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})])
const toPosix = p => p.split(sep).join('/')

// ---------------------------------------------------------------- the corpus

const CODE_EXT = new Set(['.js', '.mjs', '.jsx', '.ts', '.tsx', '.json', '.md', '.yaml', '.yml', '.txt', '.css', '.scss', '.py'])
const ASSET_EXT = new Set(['.svg', '.png', '.jpg', '.ico', '.html'])   // path targets only, never searched
const SKIP_DIRS = new Set(['node_modules', '.git', 'logs', 'data', 'dist', 'build', 'coverage', 'scratch'])

function walk(dir, out = []) {
    if (!existsSync(dir)) return out
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full, out)
        else if (CODE_EXT.has(extname(name)) || ASSET_EXT.has(extname(name))) out.push(full)
    }
    return out
}

const readText = full => ASSET_EXT.has(extname(full)) ? '' : readFileSync(full, 'utf8')

/** One searchable corpus: { rel, text, tier } where tier is live | archive | frontend. */
function loadCorpus() {
    const files = []
    for (const full of walk(ROOT)) {
        const rel = toPosix(relative(ROOT, full))
        const tier = rel.startsWith('archive/') ? 'archive' : 'live'
        files.push({ rel, tier, text: readText(full) })
    }
    if (existsSync(join(FRONTEND, 'src'))) {
        for (const full of walk(join(FRONTEND, 'src'))) {
            files.push({ rel: 'frontend/' + toPosix(relative(FRONTEND, full)), tier: 'frontend', text: readText(full) })
        }
    }
    // The Python engine is a path target only (a doc may name one of its scripts); its symbols
    // are never searched.
    if (existsSync(AETHER)) {
        for (const full of walk(AETHER)) {
            files.push({ rel: 'aether/' + toPosix(relative(AETHER, full)), tier: 'aether', text: '' })
        }
    }
    return files
}

const corpus = loadCorpus()
// Docs are part of the corpus (a symbol mentioned in two docs must not confirm itself), so every
// symbol lookup runs against code only.
const isDoc = f => f.rel.endsWith('.md') && !f.rel.startsWith('prompts/')
const code = corpus.filter(f => !isDoc(f) && f.tier !== 'aether')

const dirNames = new Set()        // every directory rel, 'api/broker/adapters'
for (const f of corpus) {
    const parts = f.rel.split('/')
    for (let i = 1; i < parts.length; i++) dirNames.add(parts.slice(0, i).join('/'))
}
const TOP_DIRS = new Set([...dirNames].filter(d => !d.includes('/')))

const byBasename = new Map()      // 'broker.service.js' -> [rel]
const moduleNames = new Set()     // 'broker.service'
for (const f of corpus) {
    const b = basename(f.rel)
    if (!byBasename.has(b)) byBasename.set(b, [])
    byBasename.get(b).push(f.rel)
    moduleNames.add(b.replace(/\.[^.]+$/, ''))
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Where does a bare identifier occur? Returns the tier of the best hit: live > frontend > archive. */
function findWord(word, { within } = {}) {
    const re = new RegExp(`(?<![\\w$])${escapeRe(word)}(?![\\w$])`)
    const pool = within ? code.filter(f => within.includes(f.rel)) : code
    let best = null
    for (const f of pool) {
        if (!re.test(f.text)) continue
        if (f.tier === 'live') return 'live'
        if (f.tier === 'frontend') best = 'frontend'
        else if (!best) best = 'archive'
    }
    return best
}

function findLiteral(str) {
    let best = null
    for (const f of code) {
        if (!f.text.includes(str)) continue
        if (f.tier === 'live') return 'live'
        if (f.tier === 'frontend') best = 'frontend'
        else if (!best) best = 'archive'
    }
    return best
}

// ---------------------------------------------------------------- the docs

function listDocs(args) {
    const roots = args.length ? args.map(a => resolve(ROOT, a)) : [
        join(ROOT, 'README.md'), join(ROOT, 'APP_SPEC.md'), join(ROOT, 'CODE_MAP.md'), join(ROOT, 'CLAUDE.md'),
        join(ROOT, 'docs'),
    ]
    const out = []
    for (const r of roots) {
        if (!existsSync(r)) { console.error(`no such doc: ${r}`); process.exit(2) }
        if (statSync(r).isDirectory()) out.push(...walk(r).filter(f => f.endsWith('.md')))
        else out.push(r)
    }
    return out
        .map(f => toPosix(relative(ROOT, f)))
        .filter(f => !/^docs\/code-review-/.test(f) && !f.startsWith('archive/'))
        .sort()
}

// GitHub's heading slug, close enough for the anchors these docs use.
const slug = h => h.toLowerCase().replace(/[`*_~]/g, '').replace(/[^\w\- ]/g, '').trim().replace(/ /g, '-')

function headingsOf(rel) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    return new Set([...text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map(m => slug(m[1])))
}

// ---------------------------------------------------------------- claims

/**
 * Pull the checkable claims out of one doc. Each claim: { line, kind, raw, ...detail }.
 * Fenced code blocks give up only path-shaped tokens (a tree listing, a test name); the prose
 * around them gives up everything in single backticks plus every markdown link.
 */
function extractClaims(text) {
    const claims = []
    const lines = text.split('\n')
    let inFence = false
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const n = i + 1
        if (/^\s*```/.test(line)) { inFence = !inFence; continue }
        if (inFence) {
            for (const m of line.matchAll(/(?<![\w/.-])((?:[\w-]+\/)*[\w.-]+\.(?:m?jsx?|tsx?|md|json|ya?ml|py))(?![\w/.-])/g)) {
                const c = classify(m[1])
                if (c?.kind === 'path') claims.push({ line: n, ...c, raw: m[1] })
            }
            continue
        }
        for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
            if (/^(https?:|mailto:)/.test(m[1])) continue
            claims.push({ line: n, kind: 'link', raw: m[1] })
        }
        for (const m of line.matchAll(/`([^`\n]{2,120})`/g)) {
            const c = classify(m[1].trim())
            if (c) claims.push({ line: n, ...c, raw: m[1] })
        }
    }
    return claims
}

const PATH_EXT = /\.(m?jsx?|tsx?|md|json|ya?ml|py|txt|s?css|svg|png|jpg|ico|html)$/
const isIdent = s => /^[A-Za-z_$][\w$]*$/.test(s)

function classify(raw) {
    let s = raw
    if (/^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+\//.test(s)) {
        const [method, path] = s.split(/\s+/)
        return { kind: 'route', method, path: path.replace(/[?#].*$/, '') }
    }
    // `/api/foo/:id`, or a tail from a route table: `/connections/:type`
    if (/^\/[\w\-/:.?=&]+$/.test(s) && !PATH_EXT.test(s.replace(/[?#].*$/, '')) && !/\/[gimsuy]*$/.test(s)) {
        return { kind: 'route', method: null, path: s.replace(/[?#].*$/, '') }
    }
    if (/^<\/?[a-z][\w-]*>$/.test(s)) return { kind: 'tag', tag: s.replace(/[<>/]/g, '') }
    if (/[<>*{}]/.test(s)) return null                         // placeholders: `<kind>.monitor.js`
    if (/^[0-9a-f]{7,40}$/.test(s)) return null                // a commit hash
    if (s.startsWith('@') || DEPS.has(s)) return { kind: 'dep', name: s.replace(/@[^/]*$/, '') }
    if (s.includes('/') || PATH_EXT.test(s)) {
        if (/\s|:\/\//.test(s)) return null
        s = s.replace(/:\d+$/, '')                               // `file.js:26`
        const [file, member] = s.split('#')
        const last = file.split('/').pop()
        if (last.startsWith('.')) return null                   // `.tools.js` — a suffix, not a file
        const first = file.split('/')[0]
        // `long/short`, `feat/branch-name`, `text/event-stream`: slashes that are not paths. A path
        // claim has an extension on its last segment, a known top-level dir, or a relative prefix.
        const anchored = TOP_DIRS.has(first) || /^\.\.?$/.test(first)
        if (file.endsWith('/')) return anchored || dirNames.has(file.replace(/\/$/, '')) ? { kind: 'path', path: file } : null
        if (!PATH_EXT.test(last) && !anchored) return null
        return { kind: 'path', path: file, member }
    }
    // `foo()` / `foo(a, b)` → foo ; `obj.method(...)` → obj.method
    s = s.replace(/\(.*\)$/, '')
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(s)) return { kind: 'const', name: s }
    if (s.includes('.')) {
        const parts = s.split('.')
        if (!parts.every(isIdent)) return null
        return { kind: 'dotted', parts }
    }
    if (!isIdent(s)) return null
    // Short lowercase words (`done`, `hit`, `idea`) are status values and prose, not symbols; they
    // would resolve against any code base and prove nothing.
    if (!/[A-Z_]/.test(s) && s.length < 6) return null
    return { kind: 'symbol', name: s }
}

// ---------------------------------------------------------------- checks

/** Resolve a path claim to `ok` / `missing`, with where it landed. */
function checkPath(raw, docRel, member) {
    const p = raw.replace(/^\.\//, '').replace(/\/$/, '')
    const explicitArchive = p.startsWith('archive/')
    const found = locate(p, docRel)
    if (!found) {
        const parts = p.split('.')
        if (!p.includes('/') && parts.length === 2 && parts.every(isIdent)) return checkDotted(parts)
        return { verdict: 'missing' }
    }
    // A doc that points INTO the archive on purpose is not drifting; one whose bare filename now
    // resolves only there is.
    if (found.startsWith('archive/') && !explicitArchive) return { verdict: 'archived', at: found }
    if (member) {
        const f = corpus.find(x => x.rel === found)
        if (f && !new RegExp(`(?<![\\w$])${escapeRe(member)}(?![\\w$])`).test(f.text)) {
            return { verdict: 'missing', at: found, detail: `#${member} not in file` }
        }
    }
    return { verdict: 'ok', at: found }
}

/** Where does a doc's path land? Exact → relative to the doc → sibling repos → suffix of any rel → basename. */
function locate(p, docRel) {
    const exts = ['', '.js', '.mjs', '.jsx', '.ts', '.tsx']
    const bases = [ROOT, resolve(ROOT, dirname(docRel)), join(ROOT, 'docs'), FRONTEND, join(FRONTEND, 'src'), AETHER]
    for (const base of bases) for (const ext of exts) {
        const abs = resolve(base, p + ext)
        if (!existsSync(abs)) continue
        if (abs.startsWith(ROOT)) return toPosix(relative(ROOT, abs))
        if (abs.startsWith(FRONTEND)) return 'frontend/' + toPosix(relative(FRONTEND, abs))
        return 'aether/' + toPosix(relative(AETHER, abs))
    }
    if (dirNames.has(p)) return p
    for (const ext of exts) {
        const suffix = '/' + p + ext
        const hit = corpus.find(f => f.rel.endsWith(suffix) && !f.rel.startsWith('archive/')) || corpus.find(f => f.rel.endsWith(suffix))
        if (hit) return hit.rel
        if (!p.includes('/')) {
            const hits = byBasename.get(p + ext)
            if (hits?.length) return hits.find(h => !h.startsWith('archive/')) || hits[0]
        }
    }
    const dirHit = [...dirNames].find(d => d.endsWith('/' + p))
    return dirHit || null
}

function checkLink(raw, docRel) {
    const [file, anchor] = raw.split('#')
    let target = docRel
    if (file) {
        const abs = resolve(ROOT, dirname(docRel), file)
        if (!existsSync(abs)) return { verdict: 'missing' }
        target = toPosix(relative(ROOT, abs))
    }
    if (anchor && target.endsWith('.md')) {
        if (!headingsOf(target).has(anchor.toLowerCase())) return { verdict: 'missing', detail: `anchor #${anchor} not in ${target}` }
    }
    return { verdict: 'ok', at: target }
}

const routeFiles = code.filter(f => f.tier === 'live' && (f.rel.startsWith('api/') || f.rel === 'server.js'))

/**
 * Express mounts a router at a prefix and declares the tail on the router, so the full path never
 * appears in one place. The literal path as a whole is accepted first (mounts in server.js are
 * written that way); otherwise every literal segment after the mount must appear quoted somewhere
 * under api/. Loose on purpose: it catches renamed and deleted endpoints, not wrong methods.
 */
function checkRoute(path) {
    const clean = path.replace(/\/$/, '')
    const hay = routeFiles.map(f => f.text).join('\n')
    if (hay.includes(`'${clean}'`) || hay.includes(`"${clean}"`)) return { verdict: 'ok' }
    const segs = clean.split('/').filter(Boolean)
    const literal = segs.filter(s => !/^[:{<]/.test(s))
    const missing = literal.filter(s => !new RegExp(`['"\`/]${escapeRe(s)}['"\`/?]`).test(hay))
    return missing.length ? { verdict: 'missing', detail: `segment(s) ${missing.join(', ')}` } : { verdict: 'ok' }
}

// Live and frontend hits both pass; only archive-only hits are a finding.
const verdictFor = tier => !tier ? 'missing' : tier === 'archive' ? 'archived' : 'ok'

function checkTag(tag) {
    return { verdict: verdictFor(findLiteral(`<${tag}>`) || findLiteral(`<${tag} `) || findLiteral(`</${tag}>`)) }
}

function checkWord(name) {
    const tier = findWord(name)
    if (tier) return { verdict: verdictFor(tier), ...(tier === 'frontend' ? { at: 'frontend' } : {}) }
    // `jsdocAttachment` names tests/unit/jsdocAttachment.test.js, not an identifier inside it
    const mod = [...moduleNames].find(m => m === name || m.startsWith(name + '.'))
    if (mod) {
        const rel = (byBasename.get([...byBasename.keys()].find(b => b.replace(/\.[^.]+$/, '') === mod)) || [])[0]
        return rel?.startsWith('archive/') ? { verdict: 'archived', at: rel } : { verdict: 'ok', at: rel }
    }
    return { verdict: 'missing' }
}

function checkDotted(parts) {
    // Longest prefix that is a module name: `broker.service.listConnections` → broker.service + listConnections
    // A module prefix is `name.suffix` at least — a bare `setup` would match tests/setup.mjs
    for (let i = parts.length; i >= 2; i--) {
        const mod = parts.slice(0, i).join('.')
        if (!moduleNames.has(mod)) continue
        const files = [...byBasename.entries()].filter(([b]) => b.replace(/\.[^.]+$/, '') === mod).flatMap(([, rels]) => rels)
        const live = files.filter(f => !f.startsWith('archive/'))
        if (!live.length) return { verdict: 'archived', at: files[0] }
        const rest = parts.slice(i)
        if (!rest.length) return { verdict: 'ok', at: live[0] }
        const member = rest[rest.length - 1]
        if (findWord(member, { within: live })) return { verdict: 'ok', at: live[0] }
        const elsewhere = findWord(member)
        return elsewhere ? { verdict: 'moved', detail: `${member} not in ${live[0]}, exists elsewhere` } : { verdict: 'missing', detail: `${member} not in ${live[0]}` }
    }
    const [head, ...rest] = parts
    const headTier = findWord(head)
    // `BRK.B` — a head that is not an identifier anywhere is a ticker or prose, not a claim
    if (!headTier) return { verdict: 'skipped' }
    const member = rest[rest.length - 1]
    const memberTier = findWord(member)
    if (!memberTier) return { verdict: 'missing', detail: `${member} not found as identifier` }
    return { verdict: verdictFor([headTier, memberTier].includes('archive') ? 'archive' : 'live') }
}

function checkDep(name) {
    return DEPS.has(name) ? { verdict: 'ok' } : { verdict: 'missing', detail: 'not in package.json' }
}

function check(claim, docRel) {
    switch (claim.kind) {
        case 'path': return checkPath(claim.path, docRel, claim.member)
        case 'dep': return checkDep(claim.name)
        case 'link': return checkLink(claim.raw, docRel)
        case 'route': return checkRoute(claim.path)
        case 'tag': return checkTag(claim.tag)
        case 'const': return checkWord(claim.name)
        case 'symbol': return checkWord(claim.name)
        case 'dotted': return checkDotted(claim.parts)
        default: return { verdict: 'skipped' }
    }
}

// ---------------------------------------------------------------- run

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const docs = listDocs(argv.filter(a => !a.startsWith('--')))

const report = []
for (const docRel of docs) {
    const text = readFileSync(join(ROOT, docRel), 'utf8')
    const claims = extractClaims(text)
    const seen = new Set()
    const results = []
    for (const c of claims) {
        const key = `${c.kind}:${c.name || c.path || c.tag || c.parts?.join('.') || c.raw}`
        if (seen.has(key)) continue      // one verdict per distinct claim per doc; first line wins
        seen.add(key)
        results.push({ ...c, ...check(c, docRel) })
    }
    const counted = results.filter(r => r.verdict !== 'skipped')
    const bad = counted.filter(r => r.verdict !== 'ok')
    report.push({
        doc: docRel,
        lines: text.split('\n').length,
        claims: counted.length,
        bad: bad.length,
        pct: counted.length ? Math.round((bad.length / counted.length) * 100) : 0,
        findings: bad.sort((a, b) => a.line - b.line),
    })
}

if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exit(0)
}

const pad = (s, n) => String(s).padEnd(n)
const rpad = (s, n) => String(s).padStart(n)

console.log(`\nDocs drift — ${docs.length} doc(s), corpus ${code.length} code files` +
    (corpus.some(f => f.tier === 'frontend') ? ' (+frontend)' : ' (frontend repo not found)') + '\n')
console.log(pad('doc', 46) + rpad('lines', 6) + rpad('claims', 8) + rpad('bad', 5) + rpad('%', 5))
console.log('-'.repeat(70))
for (const r of [...report].sort((a, b) => b.pct - a.pct || b.bad - a.bad)) {
    console.log(pad(r.doc, 46) + rpad(r.lines, 6) + rpad(r.claims, 8) + rpad(r.bad, 5) + rpad(r.pct, 5))
}
const totalClaims = report.reduce((n, r) => n + r.claims, 0)
const totalBad = report.reduce((n, r) => n + r.bad, 0)
console.log('-'.repeat(70))
console.log(pad('total', 46) + rpad('', 6) + rpad(totalClaims, 8) + rpad(totalBad, 5) + rpad(totalClaims ? Math.round(totalBad / totalClaims * 100) : 0, 5))

for (const r of report) {
    if (!r.findings.length) continue
    console.log(`\n== ${r.doc}  (${r.bad}/${r.claims})`)
    for (const f of r.findings) {
        const where = f.at ? ` → ${f.at}` : ''
        const detail = f.detail ? `  (${f.detail})` : ''
        console.log(`  ${rpad(f.line, 5)}  ${pad(f.verdict, 9)} ${pad(f.kind, 7)} ${f.raw}${where}${detail}`)
    }
}
console.log()
