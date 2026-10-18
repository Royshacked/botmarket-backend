// DRIVE A REAL MENTOR BUILD — typed in the chat, real model turns, Generate and Arm from the pane (unified-chat 8f).
//
// The surface drives seed Mentor's state; this one does not. A plan is typed into the empty chat as a user would, Axl
// routes it, Mentor builds it turn by turn (the drive answers his questions with the same plan, up to a few turns),
// and once the pane lights Generate the setup is saved FROM THE SESSION and armed. What it proves that the seeded
// drives cannot: a real model's turns land in Mentor's state in a shape the surface reads and the commit accepts.
//
//   node scripts/drive-live-mentor.mjs [baseUrl] [outDir]
//
// Against the Vite dev server (:5173) as the throwaway `ui-smoke` user, on a FRESH session. Real model spend: a few
// Mentor turns (cents). The setup it makes is deleted after, with its sealed conversation and the session.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT  = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }
const MAX_TURNS = 6

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { userService } = await import('../api/user/user.service.js')
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')
const { setupService } = await import('../api/setups/setups.service.js')

// Everything a ready setup needs, in one message — the drive is about the pipe, not about Mentor's interview.
const PLAN = 'Trade it: I want to go long NVDA as a swing on my paper account. Enter 100 shares at 180, stop at 172, '
    + 'target 196. The condition is a 15-minute close back above 180 after a dip. Those are my levels — please build it as is.'
const NUDGE = 'Those levels and that size are final, on my paper account. Nothing else to add — build it as is so I can generate it.'

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/lm-${name}.png`, fullPage: false }); console.log('  shot:', name) }
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

async function waitIdle(page, ms) {
    const deadline = Date.now() + ms
    await page.waitForTimeout(2000)
    while (Date.now() < deadline) {
        if (!(await page.getByLabel('Stop response').count())) return true
        await page.waitForTimeout(2000)
    }
    return false
}

async function say(page, text) {
    const box = page.locator('.chat-timeline textarea')
    await box.fill(text)
    await box.press('Enter')
    // A first turn runs Axl AND the desk he hands to (its opening) — measured over three minutes (8f, 2026-10-18).
    return waitIdle(page, 300000)
}

const userId = await ensureUser()
const sid = (await sessionService.startNew({ userId })).sessionId
console.log('session:', sid)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
let made = null
let nextSid = null   // the session a commit opened (2026-10-18)

try {
    await signIn(page)

    // ── 1. the plan, typed into the empty chat → Axl hands it to Mentor, who answers in the same chat ──
    check('the first turn finished', await say(page, PLAN))
    await page.waitForTimeout(2000)
    const floor = (await sessionService.get({ sessionId: sid, userId }))?.floor
    await shot(page, '01-first-turn')
    check('the plan reached Mentor (he holds the floor)', floor === 'mentor', `floor: ${floor}`)
    check('Mentor\'s surface opened beside the chat', /Mentor/.test(await pane(page).locator('.side-pane__tab.is-active').innerText().catch(() => '')))

    // ── 2. Mentor builds; the drive answers with the same plan until Generate lights (or the budget runs out) ──
    const gen = pane(page).getByRole('button', { name: 'Generate setup' })
    let turns = 1
    while (turns < MAX_TURNS && !((await gen.count()) && !(await gen.isDisabled()))) {
        await say(page, NUDGE)
        turns++
    }
    const draft = (await sessionService.get({ sessionId: sid, userId }))?.agentState?.mentor?.draft
    await shot(page, '02-ready')
    check(`Generate lit within ${MAX_TURNS} turns`, (await gen.count()) > 0 && !(await gen.isDisabled()),
        `${turns} turns · draft ${draft ? `${draft.asset} ${draft.direction}` : 'none'} · pane: ${(await pane(page).innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)}`)
    check('…on the plan the user typed (NVDA long)', draft?.asset === 'NVDA' && draft?.direction === 'long', JSON.stringify({ asset: draft?.asset, direction: draft?.direction }))

    // ── 3. Generate → the setup is saved from the session, and the session ENDS (2026-10-18): back with Axl, the saved
    //       line above his greeting; Arm is in the setup's own window ──
    if ((await gen.count()) && !(await gen.isDisabled())) {
        const before = new Set(((await setupService.listSetups(userId).catch(() => [])) ?? []).map(s => s.id))
        await gen.click()
        await page.locator('.chat-timeline__ended').waitFor({ timeout: 20000 }).catch(() => {})
        await page.waitForTimeout(1000)
        made = ((await setupService.listSetups(userId).catch(() => [])) ?? []).find(s => !before.has(s.id) && s.asset === 'NVDA')?.id ?? null
        nextSid = (await sessionService.getActive({ userId }))?.sessionId ?? null
        await shot(page, '03-generated')
        check('Generate saved the setup Mentor built', !!made, `setup ${made}`)
        check('…and the session ended — back with Axl, the saved line above his greeting',
            nextSid !== sid && /back with Axl/.test(await page.locator('.chat-timeline__ended').innerText().catch(() => '')) && (await pane(page).count()) === 0)
        if (made) {
            const doc = await setupService.getSetup(made, userId).catch(() => null)
            const s = doc?.doc ?? doc
            check('…with the user\'s levels', s?.asset === 'NVDA' && /180/.test(JSON.stringify(s?.entry_legs ?? s?.scenarios ?? '')), `entry ${JSON.stringify(s?.entry_legs ?? null)}`)
            const [popup] = await Promise.all([
                page.context().waitForEvent('page', { timeout: 15000 }),
                page.getByRole('button', { name: 'Open the setup to arm it' }).click(),
            ])
            await popup.getByRole('button', { name: 'Arm it' }).waitFor({ timeout: 15000 })
            await popup.getByRole('button', { name: 'Arm it' }).click()
            await popup.waitForTimeout(3000)
            await popup.screenshot({ path: `${OUT}/lm-04-armed.png` })
            const armed = await setupService.getSetup(made, userId).catch(() => null)
            check('Arm in the setup\'s window — Talos is watching', (armed?.doc ?? armed)?.status === 'looking', `status: ${(armed?.doc ?? armed)?.status}`)
            await popup.close()
        }
    }
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
} finally {
    const db = await getDb()
    if (made) {
        await setupService.deleteSetup(made, userId).catch(() => {})
        await db.collection('agent_contexts').deleteMany({ kind: 'setup', entityId: made }).catch(() => {})
    }
    for (const id of [sid, nextSid].filter(Boolean)) {
        await db.collection('session_messages').deleteMany({ sessionId: id }).catch(() => {})
        await db.collection('sessions').deleteOne({ sessionId: id }).catch(() => {})
    }
    const crashed = errors.filter(e => e.startsWith('PAGEERROR'))
    if (crashed.length) check('no page errors', false, crashed.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (results.some(r => !r.ok)) process.exitCode = 1
    if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].join('\n  '))
    await closeDb()
}
