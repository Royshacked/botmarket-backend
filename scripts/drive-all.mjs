#!/usr/bin/env node
// DRIVE THE WHOLE APP — every screen, every menu, the three workspaces, the profile, on a desktop, a
// laptop and a phone, with a design audit of each screen (fonts, palette, contrast, overlap, cut-off
// text, sideways scroll). Screens only by default: no agent turns, no model spend.
//
//   node scripts/drive-all.mjs [--base http://localhost:5173] [--out <dir>] [--only Home,Hotlist] [--headed]
//                              [--with-agents | --agents-only]
//
// --with-agents adds real conversations with every desk (drive-all/agentSteps.mjs) after the desktop screens:
// real model spend (printed at the end), a setup and a book saved on PAPER and deleted again, nothing armed.
// --agents-only runs just those.
//
// Reads, never writes: every POST/PUT/PATCH/DELETE to /api/ is aborted unless it is on ALLOW below,
// and each abort is listed in the report. As the throwaway QA user `ui-smoke` (or DRIVE_USER /
// DRIVE_PASSWORD), ONE sign-in and ONE page load per run — the auth limiter (20 per 15 min, by IP)
// counts every page load, and it is the developer's IP too. The trade-window step opens one pop-out
// (one more page load).
//
// Output goes OUTSIDE the repo (os temp dir by default): `npm run dev` runs nodemon over the repo, and
// a .json written inside it would restart the backend mid-drive.
//
// Exit 1 when any step fails a check, throws, logs a page error or gets a 5xx. Design findings do not
// fail the run — they are the report's first table, for a person to judge.
/* global document */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import { auditPage, settleAnimations } from './drive-all/audit.mjs'
import { BROWSER_HELPERS, composeSteps, isBlockedWrite, isIgnorableError, summarize } from './drive-all/lib.mjs'
import { renderReport } from './drive-all/report.mjs'
import { STEPS } from './drive-all/steps.mjs'
import { AGENT_STEPS, cleanup as agentCleanup } from './drive-all/agentSteps.mjs'

const args = process.argv.slice(2)
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt }
const BASE = arg('base', 'http://localhost:5173').replace(/\/$/, '')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'axl-drive-all', STAMP)))
const ONLY = arg('only', '')?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const HEADED = args.includes('--headed')
const AGENTS_ONLY = args.includes('--agents-only')
const WITH_AGENTS = AGENTS_ONLY || args.includes('--with-agents')
const USER = { username: process.env.DRIVE_USER || 'ui-smoke', password: process.env.DRIVE_PASSWORD || 'Sm0ke!Drive#29' }
const STEP_TIMEOUT = 180_000

const VIEWPORTS = {
    desktop: { width: 1440, height: 900 },
    laptop:  { width: 1280, height: 720 },
    phone:   { width: 390,  height: 844 },
}

// The writes a screen may make — all of them the QA user's own view state, none of them trades,
// setups, books or chat turns. Anything else a screen tries is stopped and listed in the report.
const ALLOW = [
    { method: 'POST', path: '/api/auth/signin' },
    { method: 'PUT',  path: '/api/workspace' },                              // the LIVE · PAPER · MANUAL switch
    { method: 'PUT',  path: '/api/paper/mode' },                             // …which the paper venue mirrors
    { method: 'POST', path: /^\/api\/chat\/conversations\/[^/]+\/read$/ },   // opening a conversation marks it read
]

// With --with-agents, the chat may talk: a new session, a turn, a chain's continue, a desk's commit (Generate) and a
// stop. Still never a broker, an arm (that is the setup window's own route, not on this list) or a delete from the UI.
const ALLOW_AGENTS = [
    { method: 'POST', path: '/api/sessions/new' },
    { method: 'POST', path: /^\/api\/sessions\/[^/]+\/(turn|continue|act|edit)$/ },
    { method: 'POST', path: /^\/api\/turns\/[^/]+\/stop$/ },
    { method: 'POST', path: '/api/setups/validate' },                        // the pane checks a draft — reads only
]

const C = { dim: '\x1b[2m', ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', head: '\x1b[36m', off: '\x1b[0m' }
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

// ── preflight: is the app up, and is the backend running the code on disk? ──
async function preflight() {
    const health = await fetch(`${BASE}/api/health`).then(r => r.json()).catch(e => ({ error: e.message }))
    if (health.error || health.status !== 'ok') throw new Error(`the app is not answering at ${BASE} (${health.error ?? JSON.stringify(health)}) — start the backend and Vite first`)
    const startedAt = Date.now() - (health.uptimeSec ?? 0) * 1000
    let lastCommit = 0
    try {
        const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
        lastCommit = +execFileSync('git', ['-C', repo, 'log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim() * 1000
    } catch { /* no git — skip the check */ }
    const stale = lastCommit && startedAt < lastCommit
    return { startedAt, stale, text: `up ${Math.round((health.uptimeSec ?? 0) / 60)} min${stale ? ' — STARTED BEFORE THE LAST COMMIT, restart it' : ''}` }
}

async function main() {
    mkdirSync(OUT, { recursive: true })
    const pre = await preflight()
    console.log(`${C.head}Whole-app drive${C.off} · ${BASE} · backend ${pre.text}`)
    console.log(`${C.dim}screenshots + report → ${OUT}${C.off}`)
    if (pre.stale) console.log(`${C.warn}! the backend predates the last commit; the drive is checking old server code${C.off}`)

    const browser = await chromium.launch({ headless: !HEADED })
    const context = await browser.newContext({ viewport: VIEWPORTS.desktop })
    await context.addInitScript(BROWSER_HELPERS)

    // per-step collectors, swapped by the runner
    let sink = { errors: [], blocked: [] }
    const allow = WITH_AGENTS ? [...ALLOW, ...ALLOW_AGENTS] : ALLOW
    await context.route('**/*', (route) => {
        const req = route.request()
        if (isBlockedWrite(req.method(), req.url(), allow)) {
            sink.blocked.push(`${req.method()} ${new URL(req.url()).pathname}`)
            return route.abort('blockedbyclient')
        }
        return route.fallback()
    })
    const watch = (page, who = '') => {
        page.on('pageerror', e => sink.errors.push(`${who}page error: ${e.message.slice(0, 240)}`))
        page.on('console', m => {
            if (m.type() !== 'error') return
            const text = `${who}console: ${m.text().slice(0, 240)}`
            // the guard's own aborts show up as failed loads; they are reported under "blocked"
            if (!isIgnorableError(text) && !/ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(text)) sink.errors.push(text)
        })
        page.on('response', r => { if (r.status() >= 500) sink.errors.push(`${who}${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`) })
    }

    const page = await context.newPage()
    watch(page)

    // ── one sign-in, one page load ──
    const signin = await page.request.post(`${BASE}/api/auth/signin`, { data: USER })
    if (signin.status() !== 200) {
        await browser.close()
        throw new Error(`sign-in as ${USER.username} answered ${signin.status()}${signin.status() === 429 ? ' — the auth limiter; wait 15 minutes or restart the backend' : ''}`)
    }
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline textarea').first().waitFor({ timeout: 30_000 })
    await page.waitForTimeout(2500)

    const results = []
    let viewport = 'desktop'
    let themeFonts = []
    const steps = composeSteps(STEPS, AGENT_STEPS, { withAgents: WITH_AGENTS, agentsOnly: AGENTS_ONLY, only: ONLY })
    const shared = {}   // what the agent steps hand each other: the name, the baseline, what was saved

    try {
    for (const [i, step] of steps.entries()) {
        const r = { name: step.name, viewport: step.viewport, checks: [], notes: [], errors: [], blocked: [], warnings: [], shots: [], fonts: [], fontSizes: [], ms: 0 }
        sink = r
        const t0 = Date.now()
        console.log(`\n${C.head}── ${i + 1}/${steps.length} ${step.name}${C.off} ${C.dim}(${step.viewport})${C.off}`)
        if (step.viewport !== viewport) {
            viewport = step.viewport
            await page.setViewportSize(VIEWPORTS[viewport])
            await page.waitForTimeout(1200)
        }
        const phone = viewport === 'phone'

        const capture = async (label, target = page) => {
            await target.evaluate(settleAnimations).catch(() => {})
            const file = `${String(i + 1).padStart(2, '0')}-${slug(step.name)}-${slug(label) || 'screen'}.png`
            await target.screenshot({ path: path.join(OUT, file) })
            const audit = await target.evaluate(auditPage, { phone }).catch(e => ({ findings: [{ kind: 'audit', severity: 'warn', message: `audit failed: ${e.message.slice(0, 120)}` }], inventory: {} }))
            for (const f of audit.findings) {
                r.warnings.push({ ...f, screen: label })
                if (f.severity === 'fail') r.checks.push({ ok: false, what: `${label}: ${f.message}${f.where ? ` (${f.where})` : ''}` })
            }
            r.fonts = [...new Set([...r.fonts, ...(audit.inventory.fonts ?? [])])]
            r.fontSizes = [...new Set([...r.fontSizes, ...(audit.inventory.fontSizes ?? []).map(([px]) => px)])]
            if (audit.inventory.themeFonts?.length) themeFonts = audit.inventory.themeFonts
            r.shots.push({ file, label, findings: audit.findings.filter(f => f.severity !== 'info').length })
        }

        const t = {
            page,
            base: BASE,
            shared,
            check(ok, what) {
                r.checks.push({ ok: !!ok, what })
                console.log(`${ok ? C.ok + '  ✓' : C.bad + '  ✗'} ${what}${C.off}`)
                return !!ok
            },
            note(text) { r.notes.push(text); console.log(`${C.dim}  · ${text}${C.off}`) },
            warn(kind, message, where = '') { r.warnings.push({ kind, severity: 'warn', message, where, screen: step.name }) },
            capture: (label) => capture(label),
            async popup(fn, label) {
                const [pop] = await Promise.all([context.waitForEvent('page', { timeout: 15_000 }), fn()])
                watch(pop, `${label}: `)
                await pop.waitForLoadState('domcontentloaded')
                await pop.waitForTimeout(3500)
                t.check(new URL(pop.url()).pathname !== '/', `the ${label} opens (${new URL(pop.url()).pathname})`)
                const text = (await pop.evaluate(() => document.body.innerText).catch(() => '')).trim()
                t.check(text.length > 20, `the ${label} shows content`)
                await capture(label, pop)
                await pop.close()
            },
        }

        const limit = step.timeout ?? STEP_TIMEOUT
        let timer
        try {
            await Promise.race([
                step.run(t),
                new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`step took over ${limit / 1000}s`)), limit) }),
            ])
        } catch (e) {
            r.crashed = e.message.split('\n')[0].slice(0, 300)
            console.log(`${C.bad}  ✗ stopped: ${r.crashed}${C.off}`)
        } finally { clearTimeout(timer) }
        await capture('end').catch(e => r.notes.push(`final screenshot failed: ${e.message.slice(0, 120)}`))
        // a write the guard stopped makes the app log a "Network Error" — that is the guard, not a bug
        const stopped = r.blocked.map(b => b.split(' ')[1].replace(/^\//, ''))
        r.errors = r.errors.filter(e => !stopped.some(p => e.includes(p)))
        for (const e of r.errors) console.log(`${C.bad}  ! ${e}${C.off}`)
        for (const b of r.blocked) console.log(`${C.warn}  ⊘ write stopped: ${b}${C.off}`)
        const real = r.warnings.filter(w => w.severity !== 'info').length
        if (real) console.log(`${C.warn}  ${real} design findings${C.off}`)
        r.ms = Date.now() - t0

        // leave the next step a clean stage: no open dialog, back home
        await page.keyboard.press('Escape').catch(() => {})
        if (/\/profile/.test(page.url())) await page.locator('.app-header-axl__brand').click().catch(() => {})
        results.push(r)
    }
    } finally {
        // Whatever the agent steps saved is deleted even when a step crashed or timed out half-way.
        if (WITH_AGENTS && shared.baseline) {
            const left = await agentCleanup({ page, base: BASE, shared }).catch(e => [`cleanup failed: ${e.message}`])
            if (left?.length) console.log(`${C.warn}cleanup: ${left.join(' · ')}${C.off}`)
        }
    }

    await browser.close()

    const meta = { base: BASE, when: new Date().toLocaleString(), user: USER.username, backend: pre.text, themeFonts,
        agents: WITH_AGENTS, cost: shared.cost ?? null, name: shared.name?.symbol ?? null }
    writeFileSync(path.join(OUT, 'report.html'), renderReport({ steps: results, meta }))
    writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ meta, steps: results }, null, 2))

    const sum = summarize(results)
    console.log(`\n${sum.failed ? C.bad : C.ok}${sum.passed}/${sum.steps} steps passed${C.off} · ${sum.checksFailed} failed checks/errors · ${sum.warnings} design findings`)
    console.log(`${C.dim}${Object.entries(sum.byKind).map(([k, n]) => `${k} ${n}`).join(' · ')}${C.off}`)
    if (meta.cost != null) console.log(`model spend (the QA user's turns): $${meta.cost.toFixed(4)}`)
    console.log(`report: ${path.join(OUT, 'report.html')}`)
    process.exit(sum.failed ? 1 : 0)
}

main().catch(e => { console.error(`${C.bad}drive-all: ${e.message}${C.off}`); process.exit(2) })
