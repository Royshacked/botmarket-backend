// DRIVE THE PANE'S KEPT TABS AND THE TEARDOWN — in a real browser (unified-chat plan phase 8e).
//
// What 8e changed that only a browser shows: the chat column is ALWAYS the timeline (no desk tabs, no agent bar, no
// crumb); the side pane is about a third of the column and the header's toggle hides it and brings the same tab back;
// and Discard throws a desk's unsaved work away (asked first) and SETS ITS TURNS ASIDE — the seal point and the summary
// move past them, so they never seal onto Mentor's next setup. No model call: Mentor's draft and turns are seeded.
// The admin's Pythia / Aether row under the header is OFF for now (Roy, 2026-10-18) — the drive checks it is gone; a
// kept tab's mount (Pythia, Aether, the order ticket) is covered by SidePane.test.
//
//   node scripts/drive-pane-tabs.mjs [baseUrl] [outDir]
//
// Runs against the Vite dev server (:5173, /api and /ws proxied to :3030) as the throwaway `ui-smoke` user (an
// admin), on a FRESH session, removed after. A failed check fails the process. Several drives back to back trip the
// dev server's in-memory rate limits — restart it between runs (touch a backend file).
/* global document -- page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT  = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { userService } = await import('../api/user/user.service.js')
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')
const { draftVerdict } = await import('../services/setupVerdict.js')

const DRAFT = {
    asset: 'NVDA', direction: 'long', type: 'swing',
    conditions:  [{ id: 'c1', text: 'CHoCH up on the 15m' }],
    entry_legs:  [{ price: 238.6, quantity: 100 }],
    stop_legs:   [{ price: 234.8 }],
    target_legs: [{ price: 246 }],
}

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/pt-${name}.png`, fullPage: false }); console.log('  shot:', name) }
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const pane = (page) => page.locator('.side-pane')

async function ensureUser() {
    try { await userService.createUser(USER); console.log('qa user: created') }
    catch (err) { console.log('qa user: already there —', err.message) }
    const db = await getDb()
    const u = await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1 } })
    if (!u?.id) throw new Error('qa user has no id')
    return u.id
}

async function signIn(page) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input').first().count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
    await page.locator('.chat-timeline').waitFor({ timeout: 15000 })
}

const userId = await ensureUser()
const sid    = (await sessionService.startNew({ userId })).sessionId
console.log('session:', sid)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))

try {
    // ── 1. the chat column is the timeline — no desk tab, no agent bar, no crumb ──
    await signIn(page)
    await page.waitForTimeout(800)
    // The timeline and the pane are the chat column's only content — no desk panel shares it.
    check('the chat column is the timeline and the pane, nothing else', (await page.locator('.workspace__chat > .chat-with-pane > .chat-timeline').count()) === 1 && (await page.locator('.workspace__chat .portfolio-panel').count()) === 0)

    // ── 2. the admin's Pythia / Aether row under the chat header is OFF for now (Roy, 2026-10-18) ──
    check('no Pythia or Aether button under the chat header', (await page.locator('.chat-timeline__desks').count()) === 0
        && (await page.getByRole('button', { name: 'Pythia', exact: true }).count()) === 0 && (await page.getByRole('button', { name: 'Aether', exact: true }).count()) === 0)

    // ── 3. Mentor holds a draft (seeded, with its turns) → its surface opens beside the chat ──
    for (const message of [
        { agent: 'mentor', role: 'user', content: 'Drive — NVDA on a pullback?' },
        { agent: 'mentor', role: 'assistant', content: 'Drive — here is an NVDA draft.' },
    ]) await sessionService.append({ sessionId: sid, userId, message })
    const before = await sessionService.get({ sessionId: sid, userId })
    const v = draftVerdict(DRAFT, true)
    await sessionService.setAgentState({ sessionId: sid, userId, agent: 'mentor', state: { active_asset: 'NVDA', draft: v.setup, coverage: [], drafts: {}, view: { gate: null, readiness: v.readiness, setups: null } } })
    await sessionService.setFloor({ sessionId: sid, userId, agent: 'mentor' })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline').waitFor({ timeout: 15000 })
    await pane(page).waitFor({ timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(800)
    await shot(page, '01-mentor')
    check('Mentor\'s surface opens beside the chat', /Mentor/.test(await pane(page).locator('.side-pane__tab.is-active').innerText().catch(() => '')) && await page.locator('.chat-timeline').isVisible())

    // ── 4. the chat keeps most of the width; the header's toggle hides the pane and brings the same tab back ──
    const widths = await page.evaluate(() => ({
        chat: document.querySelector('.chat-with-pane > .chat-timeline')?.getBoundingClientRect().width ?? 0,
        pane: document.querySelector('.side-pane--docked')?.getBoundingClientRect().width ?? 0,
    }))
    check('the chat is the wider of the two (the pane is about a third)', widths.chat > widths.pane * 1.6 && widths.pane >= 270, `chat ${Math.round(widths.chat)}px · pane ${Math.round(widths.pane)}px`)
    await page.getByRole('button', { name: /^Hide / }).click()
    await page.waitForTimeout(500)
    check('"Hide" closes the pane', (await pane(page).count()) === 0)
    await page.getByRole('button', { name: /^Show / }).click()
    await page.waitForTimeout(800)
    await shot(page, '02b-reshown')
    check('"Show" brings back Mentor\'s tab, with the draft still on it', /Mentor/.test(await pane(page).locator('.side-pane__tab.is-active').innerText().catch(() => '')) && /NVDA/.test(await pane(page).innerText().catch(() => '')))

    // ── 5. Discard: Mentor's unsaved draft thrown away, asked first — and its turns set aside ──
    await pane(page).getByRole('button', { name: 'Discard' }).waitFor({ timeout: 15000 }).catch(() => {})
    let asked = null
    page.once('dialog', d => { asked = d.message(); d.accept() })
    await pane(page).getByRole('button', { name: 'Discard' }).click()
    await page.waitForTimeout(1500)
    await shot(page, '03-discarded')
    const after = await sessionService.get({ sessionId: sid, userId })
    const mentor = after?.agentState?.mentor ?? null
    check('Discard asks first, then Mentor\'s table is clear', /Discard the NVDA plan\? It is not saved anywhere/.test(asked ?? '') && !mentor, `asked: ${asked}`)
    const through = after?.seals?.mentor ?? 0
    check('…and its turns are set aside (the seal point and the summary move past them)',
        through >= before.seq && after?.summaries?.mentor?.throughSeq === through && after.summaries.mentor.text === '',
        `seal ${before?.seals?.mentor ?? 0} → ${through}, session seq ${before.seq}`)
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
} finally {
    const db = await getDb()
    await db.collection('session_messages').deleteMany({ sessionId: sid }).catch(() => {})
    await db.collection('sessions').deleteOne({ sessionId: sid }).catch(() => {})
    const crashed = errors.filter(e => e.startsWith('PAGEERROR'))
    if (crashed.length) check('no page errors', false, crashed.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (results.some(r => !r.ok)) process.exitCode = 1
    if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].join('\n  '))
    await closeDb()
}
