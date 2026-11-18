import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    parseColor, blend, contrastRatio, nearestColor, firstFamily, BROWSER_HELPERS,
    isBlockedWrite, summarize, groupWarnings, isIgnorableError, escapeHtml, composeSteps, mentionsNumber, echoedSentence,
} from '../../scripts/drive-all/lib.mjs'
import { renderReport } from '../../scripts/drive-all/report.mjs'
import { STEPS, DESKS } from '../../scripts/drive-all/steps.mjs'
import { AGENT_STEPS } from '../../scripts/drive-all/agentSteps.mjs'

// The whole-app drive (scripts/drive-all.mjs) — its pure parts. The browser parts are proved by
// running the drive; these keep the judgement it rests on (contrast maths, the read-only guard,
// grouping) from drifting quietly.

test('parseColor reads every computed form the audit meets', () => {
    assert.deepEqual(parseColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 })
    assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 })
    assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 })
    assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 })
    assert.deepEqual(parseColor('#00000080'), { r: 0, g: 0, b: 0, a: 128 / 255 })
    assert.deepEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 })
    // color-mix(in srgb, …) computes to color(srgb …) — the forecast tiles. Unread, the audit used to guess white.
    const mix = parseColor('color(srgb 1 0 0.5 / 0.3)')
    assert.equal(mix.r, 255); assert.equal(mix.g, 0); assert.equal(Math.round(mix.b), 128); assert.equal(mix.a, 0.3)
})

test('parseColor returns null for what it cannot read, so the audit skips rather than guesses', () => {
    for (const s of ['oklch(0.7 0.1 200)', 'var(--x)', '', null, undefined, 'red', '#12345']) assert.equal(parseColor(s), null, String(s))
})

test('contrastRatio matches the WCAG reference values', () => {
    const black = parseColor('#000'), white = parseColor('#fff')
    assert.equal(Math.round(contrastRatio(black, white) * 10) / 10, 21)
    assert.equal(contrastRatio(white, white), 1)
    assert.equal(contrastRatio(black, white), contrastRatio(white, black))
    // #767676 on white is the classic 4.5:1 boundary
    assert.ok(Math.abs(contrastRatio(parseColor('#767676'), white) - 4.54) < 0.02)
})

test('blend paints a translucent colour over an opaque one', () => {
    assert.deepEqual(blend({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 }), { r: 127.5, g: 127.5, b: 127.5, a: 1 })
    assert.deepEqual(blend({ r: 9, g: 9, b: 9, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }), { r: 9, g: 9, b: 9, a: 1 })
    assert.deepEqual(blend({ r: 9, g: 9, b: 9 }, { r: 0, g: 0, b: 0, a: 1 }), { r: 9, g: 9, b: 9, a: 1 }, 'a missing alpha is opaque')
})

test('nearestColor finds the closest palette entry, ignoring alpha', () => {
    const pal = [parseColor('#000'), parseColor('#ff0000'), parseColor('#00ff00')]
    const hit = nearestColor(parseColor('rgba(250, 5, 0, 0.4)'), pal)
    assert.deepEqual(hit.color, pal[1])
    assert.ok(hit.d < 8)
    assert.equal(nearestColor(pal[0], []), null)
})

test('firstFamily unquotes and lower-cases the first family', () => {
    assert.equal(firstFamily(`'Space Mono', monospace`), 'space mono')
    assert.equal(firstFamily('"Hanken Grotesk", system-ui'), 'hanken grotesk')
    assert.equal(firstFamily('Arial'), 'arial')
    assert.equal(firstFamily(''), '')
    assert.equal(firstFamily(undefined), '')
})

test('BROWSER_HELPERS installs a working window.__driveLib', () => {
    const window = {}
    new Function('window', BROWSER_HELPERS)(window)
    const L = window.__driveLib
    for (const k of ['parseColor', 'blend', 'luminance', 'contrastRatio', 'colorDistance', 'nearestColor', 'firstFamily']) assert.equal(typeof L[k], 'function', k)
    assert.equal(Math.round(L.contrastRatio(L.parseColor('#000'), L.parseColor('#fff'))), 21)
})

test('the read-only guard stops every write to /api except the allowed ones', () => {
    const allow = [{ method: 'POST', path: '/api/auth/signin' }, { method: 'POST', path: /^\/api\/chat\/conversations\/[^/]+\/read$/ }]
    const B = 'http://localhost:5173'
    assert.equal(isBlockedWrite('GET', `${B}/api/setups`, allow), false, 'reads pass')
    assert.equal(isBlockedWrite('POST', `${B}/api/auth/signin`, allow), false, 'sign-in is allowed')
    assert.equal(isBlockedWrite('POST', `${B}/api/chat/conversations/c1/read`, allow), false, 'a regex entry matches')
    assert.equal(isBlockedWrite('POST', `${B}/api/chat/conversations/c1/messages`, allow), true, 'sending a message is stopped')
    assert.equal(isBlockedWrite('DELETE', `${B}/api/chat/sessions/s1`, allow), true, 'deleting is stopped')
    assert.equal(isBlockedWrite('GET', `${B}/api/auth/signin`, [{ method: 'POST', path: '/api/auth/signin' }]), false)
    assert.equal(isBlockedWrite('PUT', `${B}/api/auth/signin`, [{ method: 'POST', path: '/api/auth/signin' }]), true, 'the method must match too')
    assert.equal(isBlockedWrite('post', `${B}/api/x`, []), true, 'method case does not matter')
    assert.equal(isBlockedWrite('POST', `${B}/@vite/client`, []), false, 'non-api traffic is not guarded')
    assert.equal(isBlockedWrite('POST', 'not a url', []), true, 'an unparseable url is stopped')
})

test('summarize counts failed steps, failed checks, errors, crashes and warnings', () => {
    const s = summarize([
        { checks: [{ ok: true }], warnings: [{ kind: 'font' }] },
        { checks: [{ ok: false }, { ok: true }], errors: ['boom'], warnings: [{ kind: 'font' }, { kind: 'contrast' }] },
        { checks: [], crashed: 'timeout' },
        {},
    ])
    assert.deepEqual(s, { steps: 4, passed: 2, failed: 2, checksFailed: 3, warnings: 3, byKind: { font: 2, contrast: 1 } })
})

test('groupWarnings folds repeats per component and keeps a few samples', () => {
    const w = (where) => ({ kind: 'contrast', severity: 'warn', message: 'low', where })
    const g = groupWarnings([w('span.a "1"'), w('span.a "2"'), w('span.a "3"'), w('span.a "4"'), w('span.b "x"'), { kind: 'font', message: 'arial' }])
    assert.equal(g.length, 3)
    assert.deepEqual(g[0], { kind: 'contrast', severity: 'warn', message: 'low', count: 4, samples: ['span.a "1"', 'span.a "2"', 'span.a "3"'] })
    assert.equal(g.find(x => x.kind === 'font').samples.length, 0)
    assert.deepEqual(groupWarnings(undefined), [])
})

test('isIgnorableError lets the signed-out 401 and favicon misses through, nothing else', () => {
    assert.ok(isIgnorableError('401 GET /api/auth/me'))
    assert.ok(isIgnorableError('console: Failed to load resource /favicon.ico'))
    assert.ok(!isIgnorableError('500 GET /api/setups'))
    assert.ok(!isIgnorableError('page error: x is undefined'))
})

test('the report escapes what the page says and shows the totals', () => {
    assert.equal(escapeHtml(`<b a="1">&'`), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;')
    const html = renderReport({
        meta: { base: 'http://x', when: 'now', user: 'qa', backend: 'up', themeFonts: ['space mono'] },
        steps: [
            { name: 'Home', viewport: 'desktop', ms: 1000, checks: [{ ok: true, what: 'brand <b>' }], warnings: [{ kind: 'font', severity: 'warn', message: 'arial', where: 'b "a"' }], shots: [{ file: '01.png', label: 'end', findings: 1 }], fonts: ['arial'], fontSizes: [12] },
            { name: 'Bad', viewport: 'phone', ms: 10, checks: [{ ok: false, what: 'x' }], errors: ['500 GET /api/y'], crashed: 'took too long' },
        ],
    })
    assert.match(html, /1\/2<\/b>steps passed/)
    assert.match(html, /brand &lt;b&gt;/)
    assert.ok(!html.includes('brand <b>'))
    assert.match(html, /Font outside the theme/)
    assert.match(html, /Step stopped: took too long/)
    assert.match(html, /500 GET \/api\/y/)
})

test('the steps: unique names, known viewports, every desk on the menu', () => {
    const names = STEPS.map(s => s.name)
    assert.equal(new Set(names).size, names.length)
    for (const s of STEPS) {
        assert.ok(['desktop', 'laptop', 'phone'].includes(s.viewport), s.name)
        assert.equal(typeof s.run, 'function', s.name)
    }
    for (const d of DESKS) assert.ok(names.includes(d), `a step for ${d}`)
    // phone steps come last: the runner resizes one page, it never goes back to a wider screen mid-run
    const firstPhone = STEPS.findIndex(s => s.viewport === 'phone')
    assert.ok(STEPS.slice(firstPhone).every(s => s.viewport === 'phone'))
})

// ── the agent half (--with-agents) ─────────────────────────────────────────────────────────────────────────────

test('composeSteps: screens only by default; agents after the last desktop screen; agents-only alone', () => {
    const S = [{ name: 'A', viewport: 'desktop' }, { name: 'B', viewport: 'desktop' }, { name: 'L', viewport: 'laptop' }, { name: 'P', viewport: 'phone' }]
    const G = [{ name: 'Agents: prepare', bookend: true }, { name: 'Agents: X' }, { name: 'Agents: clean up', bookend: true }]
    const names = (l) => l.map(s => s.name)
    assert.deepEqual(names(composeSteps(S, G)), ['A', 'B', 'L', 'P'])
    assert.deepEqual(names(composeSteps(S, G, { withAgents: true })), ['A', 'B', 'Agents: prepare', 'Agents: X', 'Agents: clean up', 'L', 'P'])
    assert.deepEqual(names(composeSteps(S, G, { agentsOnly: true })), ['Agents: prepare', 'Agents: X', 'Agents: clean up'])
    assert.deepEqual(names(composeSteps(S, G, { only: ['b', 'p'] })), ['B', 'P'])
    assert.deepEqual(names(composeSteps(S, G, { withAgents: true, only: ['agents: x'] })), ['Agents: prepare', 'Agents: X', 'Agents: clean up'],
        'one agent step brings the bookends — it needs the name and the baseline they set')
})

test('the agent steps: bookends first and last, a long timeout, and the chat writes allowed only with the flag', () => {
    assert.equal(AGENT_STEPS[0].name, 'Agents: prepare')
    assert.equal(AGENT_STEPS.at(-1).name, 'Agents: clean up')
    assert.ok(AGENT_STEPS[0].bookend && AGENT_STEPS.at(-1).bookend)
    for (const s of AGENT_STEPS) {
        assert.equal(s.viewport, 'desktop', s.name)
        assert.ok(s.timeout >= 12 * 60_000, `${s.name} has time for a turn`)
    }
    assert.equal(new Set(AGENT_STEPS.map(s => s.name)).size, AGENT_STEPS.length)
    for (const role of ['Axl', 'Technical analyst', 'Analyst', 'Industry strategist', 'Stock picker', 'Trader', 'Portfolio manager']) {
        assert.ok(AGENT_STEPS.some(s => s.name.includes(role)), `a step for the ${role}`)
    }
})

test('the guard with agents: a turn and a commit pass; arming, deleting and brokers are still stopped', () => {
    const allow = [
        { method: 'POST', path: '/api/sessions/new' },
        { method: 'POST', path: /^\/api\/sessions\/[^/]+\/(turn|continue|act|edit)$/ },
        { method: 'POST', path: /^\/api\/turns\/[^/]+\/stop$/ },
    ]
    const B = 'http://localhost:5173'
    assert.equal(isBlockedWrite('POST', `${B}/api/sessions/ses_1/turn`, allow), false)
    assert.equal(isBlockedWrite('POST', `${B}/api/sessions/ses_1/act`, allow), false)
    assert.equal(isBlockedWrite('POST', `${B}/api/sessions/new`, allow), false)
    assert.equal(isBlockedWrite('DELETE', `${B}/api/sessions/ses_1`, allow), true, 'deleting a session from History is still stopped')
    assert.equal(isBlockedWrite('POST', `${B}/api/setups/setup_1/action`, allow), true, 'the setup window\'s own routes are not opened')
    assert.equal(isBlockedWrite('POST', `${B}/api/broker/order`, allow), true)
    assert.equal(isBlockedWrite('POST', `${B}/api/sessions/ses_1/turn/extra`, allow), true, 'the pattern is anchored')
})

test('echoedSentence finds a sentence said twice in one reply — the leak around a bracket (2026-11-18)', () => {
    const A = "I'll have the stock picker choose one swing-trade name for you."
    assert.equal(echoedSentence(`${A} (Open tags? yes) ${A}`), A)
    assert.equal(echoedSentence('The stop is 41.20 under the range. The target is the prior high.'), null)
    assert.equal(echoedSentence('Yes. Yes.'), null)
    assert.equal(echoedSentence(''), null)
})

test('mentionsNumber compares by value, not by spelling', () => {
    assert.ok(mentionsNumber('a target of $22.80 by April', 22.8))
    assert.ok(mentionsNumber('target $22.00', 22))
    assert.ok(mentionsNumber('about 1,250.5 shares', 1250.5))
    assert.ok(!mentionsNumber('122.8', 22.8), 'not inside a bigger number')
    assert.ok(!mentionsNumber('22.5', 22))
    assert.ok(!mentionsNumber('no numbers', 22))
    assert.ok(!mentionsNumber('22', 'x'))
})
