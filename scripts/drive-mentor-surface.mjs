// DRIVE MENTOR'S SURFACE — the side pane over the session, in a real browser (unified-chat plan phase 8b).
//
// The FE tests stub the session; the backend tests stub the browser. This runs the one path that matters for 8b:
// Mentor's state on the session → the pane opens on the floor → a hand edit (PATCH /state) → Generate and Arm
// (POST /act) → a stale press refused (the revision) → the pencil reopening a saved setup → the phone's bottom sheet.
// No model call: Mentor's state is SEEDED here, with a draft the real readiness gate passes, so the drive is cheap
// and repeatable. The screenshots are the evidence — look at them.
//
//   node scripts/drive-mentor-surface.mjs [baseUrl] [outDir]
//
// Runs against the Vite dev server (:5173, /api and /ws proxied to :3030). Uses the throwaway `ui-smoke` user on a
// FRESH session. Writes from this process do not push to the page (the socket is the dev server's), which is what
// the stale-press step relies on.
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
const { setupService } = await import('../api/setups/setups.service.js')
const { draftVerdict } = await import('../services/setupVerdict.js')

// The backend suite's ready draft (tests/unit/sessionPhase8.test.js): it passes the real readiness gate.
const DRAFT = {
    asset: 'NVDA', direction: 'long', type: 'swing',
    conditions:  [{ id: 'c1', text: 'CHoCH up on the 15m' }],
    entry_legs:  [{ price: 238.6, quantity: 100 }],
    stop_legs:   [{ price: 234.8 }],
    target_legs: [{ price: 246 }],
}

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/ms-${name}.png`, fullPage: false }); console.log('  shot:', name) }
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

const mentorState = async (userId, sessionId) => {
    const s = await sessionService.get({ sessionId, userId })
    return { state: s?.agentState?.mentor ?? null, rev: s?.agentRev?.mentor ?? 0 }
}

async function seed(userId, sessionId) {
    // The draft as a turn leaves it — normalised, so it carries its scenario (what the worksheet edits).
    const v = draftVerdict(DRAFT, true)
    await sessionService.setAgentState({ sessionId, userId, agent: 'mentor', state: {
        active_asset: 'NVDA', draft: v.setup, coverage: ['markets', 'technicals'], drafts: {},
        view: { gate: null, readiness: v.readiness, setups: null },
    } })
    await sessionService.setFloor({ sessionId, userId, agent: 'mentor' })
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
const fresh  = await sessionService.startNew({ userId })
const sid    = fresh.sessionId
console.log('session:', sid)
await seed(userId, sid)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
let made = null

try {
    // ── 1. Mentor holds the floor → its surface is up beside the chat, the chat still there ──
    await signIn(page)
    await pane(page).waitFor({ timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(1000)
    await shot(page, '01-pane')
    check('the pane opens on Mentor (it holds the floor)', (await pane(page).count()) === 1 && /Mentor/.test(await pane(page).locator('.side-pane__tabs').innerText()))
    check('it is docked beside the timeline, not over it', (await page.locator('.chat-with-pane > .side-pane--docked').count()) === 1 && (await page.locator('.chat-with-pane > .chat-timeline').isVisible()))
    check('the worksheet header reads the seeded setup', /your setup/i.test(await pane(page).innerText()))

    // ── 2. a hand edit is a PATCH of Mentor's state (re-judged there) ──
    const before = await mentorState(userId, sid)
    await pane(page).getByRole('button', { name: /your setup/i }).click()
    await page.waitForTimeout(600)
    // A price in the worksheet (not the account picker's checkbox, which comes first in the pane).
    const field = pane(page).locator('.mentor-panel__build input[aria-label^="Entry price"]').first()
    if (await field.count()) {
        await field.fill('238.4')             // a change that keeps the plan whole
        await page.waitForTimeout(1600)       // the edit settles, then sends
        const after = await mentorState(userId, sid)
        check('a worksheet edit reached the session (the revision moved)', after.rev > before.rev, `rev ${before.rev} → ${after.rev}`)
    } else {
        check('the worksheet has a field to edit', false, 'no input in the open worksheet')
    }
    await pane(page).getByRole('button', { name: /your setup/i }).click()
    await shot(page, '02-edited')

    // ── 3. a STALE press: Mentor's state moves behind the page's back (no frame reaches it) → refused, said ──
    await seed(userId, sid)
    const gen = pane(page).getByRole('button', { name: 'Generate setup' })
    const dark = await gen.isDisabled()
    if (dark) {
        check('Generate is lit for a ready draft', false, `the surface says: ${(await pane(page).locator('.mentor-panel__generate').innerText()).replace(/\s+/g, ' ')}`)
    } else {
        await gen.click()
        await page.waitForTimeout(2000)
        const alert = await pane(page).getByRole('alert').innerText().catch(() => '')
        check('a press on a state the user did not see is refused, and said', /moved on while you were looking/i.test(alert), alert)
        await shot(page, '03-stale')

        // ── 4. Generate for real (the refusal folded the new revision in) → saved, waiting on Arm ──
        await gen.click()
        await pane(page).getByText(/nothing is watching it yet/).waitFor({ timeout: 15000 }).catch(() => {})
        const s4 = await mentorState(userId, sid)
        made = s4.state?.generated?.id ?? null
        await shot(page, '04-generated')
        check('Generate saved the setup from the session', !!made, `generated: ${JSON.stringify(s4.state?.generated ?? null)}`)
        check('the surface stops on Arm', (await pane(page).getByRole('button', { name: /Arm it/ }).count()) === 1)

        // ── 5. Arm → watched; Mentor's table clears ──
        if (made) {
            await pane(page).getByRole('button', { name: /Arm it/ }).click()
            await page.waitForTimeout(2500)
            const armed = await setupService.getSetup(made, userId).catch(() => null)
            const status = armed?.doc?.status ?? armed?.status ?? null
            await shot(page, '05-armed')
            check('Arm armed it (looking)', status === 'looking', `status: ${status}`)
            check('the surface says so and Mentor\'s table is clear', /armed — Talos is watching/i.test(await pane(page).innerText()) && !(await mentorState(userId, sid)).state)
        }
    }

    // ── 6. the pencil reopens a saved setup IN THE SESSION → Mentor's surface, editing it ──
    if (made) {
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.locator('.chat-timeline').waitFor({ timeout: 15000 })
        await page.waitForTimeout(2500)
        // The setups list is behind the Floor's Setups tile.
        await page.getByText('Setups', { exact: true }).first().click().catch(() => {})
        await page.waitForTimeout(1500)
        // The Floor row's pencil, or the setup card's (whichever list draws it).
        const pencil = page.locator('button[title="Edit setup in Mentor chat"], button[title="Edit in Mentor chat"]')
        await pencil.first().waitFor({ timeout: 10000 }).catch(() => {})
        console.log(`  (${await pencil.count()} setup pencil(s) on the page)`)
        let opened = false
        for (let i = 0; i < Math.min(await pencil.count(), 12) && !opened; i++) {
            const b = pencil.nth(i)
            if (!(await b.isVisible())) continue
            await b.click().catch(() => {})
            await page.waitForTimeout(2500)
            opened = /editing NVDA/i.test(await pane(page).innerText().catch(() => ''))
        }
        await shot(page, '06-reopened')
        check('a pencil reopens the setup at Mentor\'s surface', opened)
        const s6 = await mentorState(userId, sid)
        check('…in the session, marked as editing it', s6.state?.editing?.entityId === made, `editing: ${JSON.stringify(s6.state?.editing ?? null)}`)
    }

    // ── 7. a phone: the pane is a bottom sheet over the app ──
    await seed(userId, sid)
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    phone.on('pageerror', e => errors.push(`PAGEERROR(phone) ${e.message.slice(0, 200)}`))
    await signIn(phone)
    await phone.locator('.side-pane--sheet').waitFor({ timeout: 15000 }).catch(() => {})
    await phone.waitForTimeout(800)
    await phone.screenshot({ path: `${OUT}/ms-07-phone.png` })
    console.log('  shot: 07-phone')
    check('on a phone the pane is a bottom sheet', (await phone.locator('body > .side-pane--sheet').count()) === 1)
    await phone.getByRole('button', { name: 'Close' }).last().click()
    await phone.waitForTimeout(500)
    check('the sheet closes', (await phone.locator('.side-pane--sheet').count()) === 0)
    await phone.close()
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
} finally {
    if (made) await setupService.deleteSetup(made, userId).catch(() => {})
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].join('\n  '))
    await closeDb()
}
