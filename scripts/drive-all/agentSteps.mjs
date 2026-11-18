// The AGENT half of the whole-app drive (`npm run drive:all -- --with-agents`): real conversations with every desk,
// through the chat, as the QA user, on its PAPER account. Real model calls — the run prints what it spent.
//
// What a turn is checked for is STRUCTURE, never wording (the models word it differently every run): the turn ends; a
// reply from the right ROLE lands ("Trader", "Technical analyst" — One Axl shows roles, not desk names); no raw tags or
// failure lines leak into the chat; the pane, the Info diagram and the chart show what that desk should show.
//
// RULES (Roy, 2026-11-17):
//   · SAVE ON PAPER, THEN DELETE. Mentor's setup and Atlas's book are saved for real (Generate), checked in the lists,
//     and deleted again — in the step, and once more in `cleanup` whatever happened. Nothing is ARMED: Generate saves
//     unarmed; arming is a separate press in the setup's window, which the drive never makes.
//   · COVERED NAMES ONLY. Research (coverage, industry views) is shared by every user and the desks' tools write it on
//     the server, where the request guard cannot reach. So the drive asks about a name the house already covers, on
//     the horizon it is covered for (a 12-month view asked for a swing makes the trader order a fresh swing read — seen
//     2026-11-17 on NVDA). A turn that still starts a read anyway is reported (`research`), not hidden.
//
// Every step starts a NEW session, so each conversation is its own.

/* global document */
import { mentionsNumber, echoedSentence } from './lib.mjs'

const ROLES = ['Portfolio manager', 'Technical analyst', 'Industry strategist', 'Event analyst', 'Stock picker', 'Analyst', 'Trader']
const RAW_TAG = /<\/?(route|open|ticker|chart|go|show|tool|thinking)\b[^>]*>/i
// The app's OWN failure lines (services/chain/runner.js, services/desks/startTurn.js) — not English that happens to
// say "could not" (an Atlas plan reads "the stock could not reach…"; run 1 flagged it).
const FAILED = /I was interrupted — continue\?|That step did not go through|Something went wrong generating it|The turn failed/
// A model's internal channel leaking into the chat: stray Indic-script characters and "think (final)"-style markers
// (run 1, 2026-11-17: Mentor's reply carried "તર્મinal ಥink (final)").
const GARBLED = /[\u0900-\u0DFF\u0E00-\u0E7F]|\b\w*ink \((final|analysis)\)|<\|(channel|message|end)\|>/
const TURN_MS = 6 * 60_000

const wait = (t, ms) => t.page.waitForTimeout(ms)
const visible = (loc) => loc.first().isVisible().catch(() => false)
const pane = (t) => t.page.locator('.side-pane')

// ── the app's own API, as the signed-in user (page.request carries the cookie; the guard does not see it) ──────────
async function api(t, method, path, data) {
    const res = await t.page.request.fetch(`${t.base}${path}`, { method, data, failOnStatusCode: false })
    let body = null
    try { body = await res.json() } catch { /* empty */ }
    return { status: res.status(), body }
}
const listSetups = async (t) => { const r = await api(t, 'GET', '/api/setups'); return Array.isArray(r.body) ? r.body : r.body?.items ?? [] }
const listBooks = async (t) => (await api(t, 'GET', '/api/portfolio')).body?.portfolios ?? []
const bookId = (b) => b?.portfolioId ?? b?.id

/**
 * Is work still going on? The live row; the Stop button; a desk waiting on a read it asked for; the pane's
 * "Finding a name" while the stock picker has the turn. A chain hands from desk to desk with gaps — run 1 read a
 * 4-second gap as the end and moved on before the picker ran.
 */
const busy = (t) => t.page.evaluate(() => !!document.querySelector('.chat-timeline__row--live')
    || !!document.querySelector('[aria-label="Stop response"], [title="Stop response"]')
    || !!document.querySelector('.chat-timeline__row--waiting-read')
    || [...document.querySelectorAll('.side-pane [role=tab]')].some(n => /Finding a name/i.test(n.textContent)))

/** Wait until the chat has been quiet for 8s in a row. */
async function waitIdle(t, maxMs) {
    const t0 = Date.now()
    let quiet = 0
    while (Date.now() - t0 < maxMs) {
        quiet = (await busy(t)) ? 0 : quiet + 1
        if (quiet >= 8) return Date.now() - t0
        await wait(t, 1000)
    }
    return -1
}

/** The chat's rows as { cls, text, role } — role read off the row's header ("AXL Trader …"). */
const rowsNow = (t) => t.page.evaluate((roles) => [...document.querySelectorAll('.chat-timeline__row')].map(r => {
    const text = r.innerText.replace(/\s+/g, ' ').trim()
    const head = text.replace(/^AXL\s+/i, '')
    return { cls: r.className, text, role: roles.find(x => head.startsWith(x)) ?? (/^AXL\b/i.test(text) ? 'Axl' : null) }
}), ROLES)

/**
 * One user turn: type it, send it, wait for the chat to settle, check what came back.
 * Returns the NEW rows. Checks: it finished; an assistant reply landed; no raw tag; no failure line. A row that says a
 * research read was started is reported as `research` (the covered-names rule) — a finding, not a failure.
 */
async function say(t, text, { maxMs = TURN_MS, label = text.slice(0, 40) } = {}) {
    const before = (await rowsNow(t)).length
    const box = t.page.locator('.chat-timeline textarea')
    await box.fill(text)
    await box.press('Enter')
    await wait(t, 2500)
    const ms = await waitIdle(t, maxMs)
    const rows = (await rowsNow(t)).slice(before)
    const replies = rows.filter(r => /--assistant/.test(r.cls) && r.text.length > 20)
    t.check(ms >= 0, `"${label}" — the turn finished${ms >= 0 ? ` (${Math.round(ms / 1000)}s)` : ` within ${maxMs / 60000} min`}`)
    if (ms < 0) {   // stop it, so the next step does not inherit a running turn
        await t.page.locator('[aria-label="Stop response"], [title="Stop response"]').first().click().catch(() => {})
        await waitIdle(t, 30_000)
    }
    // A desk's GO ends the session on its commit ("back with Axl"): the timeline is the new session's then, so the
    // reply is in the one that ended — that IS the answer (the Atlas drive, 2026-11-18).
    const ended = replies.length ? '' : await t.page.locator('.chat-timeline__ended').innerText().catch(() => '')
    t.check(replies.length > 0 || /back with Axl/i.test(ended),
        `"${label}" — a reply landed (${replies.map(r => r.role ?? '?').join(', ') || (ended ? `the session ended: ${ended.slice(0, 60)}` : 'none')})`)
    const raw = rows.find(r => RAW_TAG.test(r.text))
    t.check(!raw, `"${label}" — no raw tags in the chat${raw ? ` (${raw.text.match(RAW_TAG)[0]})` : ''}`)
    const bad = rows.find(r => FAILED.test(r.text))
    t.check(!bad, `"${label}" — no failure line${bad ? `: ${bad.text.slice(0, 120)}` : ''}`)
    const garbled = rows.find(r => GARBLED.test(r.text))
    t.check(!garbled, `"${label}" — no garbled model output${garbled ? `: …${garbled.text.match(GARBLED)[0]}… in "${garbled.text.slice(0, 160)}"` : ''}`)
    const echo = rows.map(r => echoedSentence(r.text)).find(Boolean)
    t.check(!echo, `"${label}" — no sentence said twice in one reply (a model's channel leaking)${echo ? `: "${echo.slice(0, 120)}"` : ''}`)
    for (const r of rows.filter(r => /waiting-read/.test(r.cls))) {
        t.warn('research', 'a fresh research read was started (shared data written; the covered-names rule missed)', r.text.slice(0, 140))
    }
    t.note(`reply (${label}): ${replies.map(r => r.text).join(' ┃ ').slice(0, 400)}`)
    return rows
}

async function newSession(t) {
    const p = t.page
    const close = p.locator('.detail-panel__close')
    if (await visible(close)) { await close.first().click(); await wait(t, 500) }
    const fresh = p.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await wait(t, 2000) }
    t.check(await p.locator('.chat-timeline__row--assistant, .chat-timeline__row--user').count() === 0 || await visible(p.locator('.chat-timeline__empty')),
        'a fresh session — the chat is empty')
    const dock = p.locator('.chat-chart-dock')
    if (await visible(dock)) {
        t.warn('carry-over', 'a chart from the previous conversation is still docked over the new, empty session', (await dock.innerText().catch(() => '')).slice(0, 60))
        await dock.getByRole('button', { name: /close/i }).first().click().catch(() => {})
        await wait(t, 500)
    }
}

const infoText = (t) => t.page.locator('.floor-info').innerText().catch(() => '')
const hasRole = (rows, role) => rows.some(r => r.role === role)

// ── cleanup: whatever this run saved, deleted — called by the step AND by the runner's finally ─────────────────────
export async function cleanup(t) {
    const s = t.shared
    if (!s?.baseline) return
    const notes = []
    for (const setup of (await listSetups(t)).filter(x => !s.baseline.setups.has(x.id))) {
        const r = await api(t, 'DELETE', `/api/setups/${encodeURIComponent(setup.id)}`)
        notes.push(`setup ${setup.asset} ${setup.id}: ${r.status}`)
    }
    for (const book of (await listBooks(t)).filter(b => !s.baseline.books.has(bookId(b)))) {
        const id = bookId(book)
        const items = (await api(t, 'GET', `/api/portfolio/${encodeURIComponent(id)}/items`)).body
        const ideas = Array.isArray(items) ? items : items?.items ?? items?.ideas ?? []
        for (const i of ideas) await api(t, 'DELETE', `/api/trade-ideas/${encodeURIComponent(i.id)}`)
        const r = await api(t, 'DELETE', `/api/portfolio/chat-state/${encodeURIComponent(id)}`)
        notes.push(`book ${book.name ?? id}: ${ideas.length} holdings, chat-state ${r.status}`)
    }
    return notes
}

// ── the steps ───────────────────────────────────────────────────────────────────────────────────────────────────────
const STEPS_RAW = [
    { name: 'Agents: prepare', viewport: 'desktop', bookend: true, async run(t) {
        const p = t.page
        // Paper, before anything can be saved: a save binds to the workspace the user is standing in.
        await p.locator('.app-header-axl__mode', { hasText: 'PAPER' }).click()
        await wait(t, 1500)
        const active = (await p.locator('.app-header-axl__mode.is-active').first().innerText().catch(() => '')).trim()
        if (!t.check(active === 'PAPER', `standing in PAPER (${active || '?'})`)) throw new Error('not on paper — refusing to drive the desks')

        // A name the house covers ON A SWING HORIZON, with a price to put levels on.
        const book = (await api(t, 'GET', '/api/hotlist/book')).body ?? {}
        const swing = (book.swing ?? []).filter(c => c.status === 'active' && c.price > 5 && /^(3m|6m)$/.test(c.horizon ?? '')
            && /buy/.test(c.rating ?? ''))
            .sort((a, b) => String(b.set_at).localeCompare(String(a.set_at)))
        const pick = swing[0]
        if (!t.check(!!pick, `a swing-covered name to talk about (${swing.length} candidates)`)) throw new Error('no covered swing name')
        t.shared.name = pick
        t.shared.swingSet = new Set((book.swing ?? []).map(c => c.symbol))
        t.note(`name: ${pick.symbol} (${pick.name}) · ${pick.industry} · ${pick.horizon} target ${pick.target} · last ${pick.price}`)

        // What exists before — cleanup deletes only what is NEW.
        t.shared.baseline = {
            setups: new Set((await listSetups(t)).map(s => s.id)),
            books:  new Set((await listBooks(t)).map(bookId)),
        }
        const me = (await api(t, 'GET', '/api/auth/me')).body
        t.shared.userId = me?._id ?? me?.id ?? me?.user?._id
        t.shared.costBefore = (await api(t, 'GET', `/api/users/${t.shared.userId}/usage`)).body?.totalCost ?? null
        t.note(`baseline: ${t.shared.baseline.setups.size} setups, ${t.shared.baseline.books.size} books; month spend so far $${t.shared.costBefore?.toFixed?.(4) ?? '?'}`)
    } },

    { name: 'Agents: Axl', viewport: 'desktop', async run(t) {
        await newSession(t)
        const rows = await say(t, 'What can this app do for me?')
        t.check(rows.some(r => r.role === 'Axl'), 'Axl answers himself — no desk took it')
        t.check(!(await visible(pane(t))), 'no work pane opens for a question about the app')
        t.check(/Talking with Axl/i.test(await infoText(t)), 'Info: "Talking with Axl"')
    } },

    { name: 'Agents: Technical analyst', viewport: 'desktop', async run(t) {
        const X = t.shared.name.symbol
        await newSession(t)
        const rows = await say(t, `How does ${X} trade? Does it respect any moving average?`)
        t.check(hasRole(rows, 'Technical analyst'), 'the Technical analyst answers')
        t.check(rows.some(r => r.text.includes(X)), `the answer is about ${X}`)
        t.check(await t.page.locator('.chat-timeline canvas').count() > 0, 'an example chart is drawn in the chat')
        t.check(/How a stock trades/i.test(await infoText(t)), 'Info: "How a stock trades"')
        await t.capture('answer')
    } },

    { name: 'Agents: Analyst', viewport: 'desktop', async run(t) {
        const X = t.shared.name.symbol
        await newSession(t)
        const rows = await say(t, `What is the analyst's view on ${X}? The rating and the price target.`)
        // Axl reads the house's coverage himself for a plain question (get_watched_items) — run 1. Either is an answer.
        const by = hasRole(rows, 'Analyst') ? 'Analyst' : hasRole(rows, 'Axl') ? 'Axl' : null
        t.check(!!by, `the Analyst — or Axl, reading the house's coverage — answers (${by ?? 'neither'})`)
        const target = Number(t.shared.name.target)
        t.check(rows.some(r => r.text.includes(X) && mentionsNumber(r.text, target)), `the answer gives the house's target (${target})`)
        if (by === 'Analyst') t.check(/Researching a company/i.test(await infoText(t)), 'Info: "Researching a company"')
    } },

    { name: 'Agents: Industry strategist', viewport: 'desktop', async run(t) {
        const ind = t.shared.name.industry
        await newSession(t)
        const rows = await say(t, `What does the industry strategist think of the ${ind} industry right now?`)
        const by = hasRole(rows, 'Industry strategist') ? 'Industry strategist' : hasRole(rows, 'Axl') ? 'Axl' : null
        t.check(!!by, `the Industry strategist — or Axl, reading the house's views — answers (${by ?? 'neither'})`)
        t.check(rows.some(r => new RegExp(ind.split(/\s+/)[0], 'i').test(r.text)), `the answer is about ${ind}`)
    } },

    { name: 'Agents: Stock picker', viewport: 'desktop', async run(t) {
        await newSession(t)
        const rows = await say(t, 'Find me a swing trade — pick one name for me.', { maxMs: 10 * 60_000 })
        t.check(hasRole(rows, 'Stock picker'), 'the Stock picker answers')
        const tab = (await t.page.locator('.side-pane [role=tab]').allInnerTexts().catch(() => [])).join(' | ')
        const sym = tab.match(/\b([A-Z]{1,5})\s·/)?.[1] ?? null
        t.check(!!sym, `the pick reaches the trader — a trade on one name in the pane (${tab || 'no tab'})`)
        if (sym) {
            if (t.shared.swingSet.has(sym)) t.note(`picked ${sym}, on the house's Swing list`)
            else t.warn('pick', `picked ${sym}, which is not on the house's Swing list`, sym)
        }
        t.check(hasRole(rows, 'Trader'), 'the Trader takes the pick (the hand-off ran)')
        await t.capture('hand-off')
    } },

    { name: 'Agents: Trader builds and saves', viewport: 'desktop', timeout: 20 * 60_000, async run(t) {
        const p = t.page
        const n = t.shared.name
        const X = n.symbol
        const px = Number(n.price)
        const entry = +(px * 0.99).toFixed(2), stop = +(px * 0.95).toFixed(2), target = +(px * 1.08).toFixed(2)
        const qty = Math.max(1, Math.floor(5000 / entry))
        // NEVER "all the way" / "build it as is": Mentor reads that as take it all the way, and all the way SAVES AND ARMS
        // inside the turn (run 1, 2026-11-17: MUFG armed on paper for 17 minutes until cleanup). Step by step stops at the
        // pane's Generate, which saves unarmed.
        const plan = `Trade it: I want to go long ${X} as a swing on my paper account. Enter ${qty} shares at ${entry}, stop at ${stop}, `
            + `target ${target}. The condition is a daily close above ${entry}. Those are my levels — go step by step, and I will press Generate myself.`
        const nudge = 'Yes — keep my levels exactly as I gave them. Step by step; I will press Generate myself.'
        // A setup that appears WITHOUT the Generate press was saved by a turn — and a turn's save is armed. Delete it now.
        const savedByTurn = async () => {
            const sneaked = (await listSetups(t)).filter(x => !t.shared.baseline.setups.has(x.id))
            for (const x of sneaked) {
                t.check(false, `a turn saved ${x.asset} itself (status ${x.status}) — no Generate was pressed; deleted at once`)
                await api(t, 'DELETE', `/api/setups/${encodeURIComponent(x.id)}`)
            }
            return sneaked.length > 0
        }

        await newSession(t)
        let rows = await say(t, plan, { label: 'the plan' })
        t.check(hasRole(rows, 'Trader'), 'the Trader takes the plan')
        if (await savedByTurn()) return
        const gen = pane(t).getByRole('button', { name: 'Generate setup' })
        const lit = async () => (await gen.count()) > 0 && !(await gen.isDisabled().catch(() => true))
        for (let i = 0; i < 8 && !(await lit()); i++) {
            const last = rows.filter(r => /--assistant/.test(r.cls)).at(-1)?.text ?? ''
            rows = await say(t, /all the way|step by step/i.test(last) ? 'Step by step.' : nudge, { label: `step ${i + 1}` })
            if (await savedByTurn()) return
        }
        const tab = (await p.locator('.side-pane [role=tab]').allInnerTexts().catch(() => [])).join(' | ')
        t.check(tab.includes(X), `the pane is the ${X} trade (${tab})`)
        t.check(/Building a trade/i.test(await infoText(t)), 'Info: "Building a trade" with its steps')
        await t.capture('ready')
        if (!t.check(await lit(), 'Generate setup is lit')) return

        await gen.click()
        await p.locator('.chat-timeline__ended').waitFor({ timeout: 30_000 }).catch(() => {})
        await wait(t, 1500)
        t.check(/back with Axl/i.test(await p.locator('.chat-timeline__ended').innerText().catch(() => '')), 'Generate ends the session — "back with Axl"')
        const made = (await listSetups(t)).filter(s => !t.shared.baseline.setups.has(s.id) && s.asset === X)
        const s = made[0]
        if (!t.check(made.length === 1, `one ${X} setup saved (${made.length})`)) return
        t.check(s.mode === 'paper' && s.broker === 'paper', `…on PAPER (mode ${s.mode}, broker ${s.broker})`)
        t.check(s.status !== 'looking', `…and NOT armed (status ${s.status})`)
        t.check(JSON.stringify(s.entry_legs ?? s.scenarios ?? '').includes(String(entry)), `…with the entry the user gave (${entry})`)
        await t.capture('saved')

        await p.locator('.floor-desk__head', { hasText: 'Your trades' }).click()
        await wait(t, 1800)
        t.check(await p.locator('.detail-panel .floor-row', { hasText: X }).count() > 0, `${X} is in Your trades`)
        await t.capture('in the list')
        await p.locator('.detail-panel__close').first().click().catch(() => {})

        const r = await api(t, 'DELETE', `/api/setups/${encodeURIComponent(s.id)}`)
        t.check(r.status < 300, `the setup is deleted again (${r.status})`)
        t.check(!(await listSetups(t)).some(x => x.id === s.id), '…and gone from the list')
    } },

    { name: 'Agents: Portfolio manager builds and saves', viewport: 'desktop', timeout: 25 * 60_000, async run(t) {
        const p = t.page
        await newSession(t)
        let rows = await say(t, 'Build me a portfolio on my paper account.', { label: 'build a portfolio' })
        t.check(hasRole(rows, 'Portfolio manager'), 'the Portfolio manager takes it')
        const mandate = 'A $20,000 long-term growth book on my paper account: 3 to 4 US stocks, moderate risk, no leverage. '
            + 'Use only names the house already covers. Build it straight through.'
        rows = await say(t, mandate, { label: 'the mandate', maxMs: 15 * 60_000 })
        let made = (await listBooks(t)).filter(b => !t.shared.baseline.books.has(bookId(b)))
        // Atlas generates on his own go; if he stopped at a ready plan instead, press Generate as the user would.
        const gen = pane(t).getByRole('button', { name: /^Generate( plan)?$/ })
        if (!made.length && (await gen.count()) && !(await gen.first().isDisabled().catch(() => true))) {
            await gen.first().click()
            await wait(t, 6000)
            made = (await listBooks(t)).filter(b => !t.shared.baseline.books.has(bookId(b)))
        }
        await t.capture('built')
        if (!t.check(made.length === 1, `one book saved (${made.length})`)) return
        const book = made[0]
        t.note(`book: ${book.name ?? bookId(book)}`)
        const items = (await api(t, 'GET', `/api/portfolio/${encodeURIComponent(bookId(book))}/items`)).body
        const ideas = Array.isArray(items) ? items : items?.items ?? items?.ideas ?? []
        t.check(ideas.length >= 2, `…with holdings (${ideas.map(i => i.asset ?? i.symbol).join(', ')})`)
        t.check(ideas.every(i => (i.mode ?? 'paper') === 'paper'), '…every holding on PAPER')
        t.check(ideas.every(i => !/^(long|short|looking)$/.test(i.status)), `…not activated (${[...new Set(ideas.map(i => i.status))].join(', ')})`)

        await p.locator('.floor-desk__head', { hasText: 'Your portfolios' }).click()
        await wait(t, 1800)
        t.check(await p.locator('.detail-panel .floor-row').count() > t.shared.baseline.books.size, 'the book is in Your portfolios')
        await t.capture('in the list')
        await p.locator('.detail-panel__close').first().click().catch(() => {})

        const notes = await cleanup(t)
        t.note(`deleted: ${notes.join(' · ') || 'nothing'}`)
        t.check(!(await listBooks(t)).some(b => bookId(b) === bookId(book)), 'the book is deleted again')
    } },

    { name: 'Agents: clean up', viewport: 'desktop', bookend: true, async run(t) {
        const notes = await cleanup(t)
        t.note(`left over and deleted: ${notes?.join(' · ') || 'nothing'}`)
        const setups = await listSetups(t), books = await listBooks(t)
        t.check(setups.every(s => t.shared.baseline.setups.has(s.id)), `no setup left behind (${setups.length} — baseline ${t.shared.baseline.setups.size})`)
        t.check(books.every(b => t.shared.baseline.books.has(bookId(b))), `no book left behind (${books.length} — baseline ${t.shared.baseline.books.size})`)
        await newSession(t)
        const after = (await api(t, 'GET', `/api/users/${t.shared.userId}/usage`)).body?.totalCost ?? null
        if (after != null && t.shared.costBefore != null) {
            t.shared.cost = after - t.shared.costBefore
            t.note(`model spend this run (the QA user's own turns; house research is booked elsewhere): $${t.shared.cost.toFixed(4)}`)
        }
    } },
]

// Every agent step: a desktop step, 12 minutes unless it says otherwise (a turn alone may take 6).
export const AGENT_STEPS = STEPS_RAW.map(st => ({ timeout: 12 * 60_000, ...st }))
