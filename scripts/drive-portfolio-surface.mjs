// DRIVE ATLAS'S SURFACE — the side pane over the session, in a real browser (unified-chat plan phase 8c).
//
// The FE tests stub the session; the backend tests stub the browser. This runs the paths that matter for 8c, with
// Atlas's state SEEDED (no model call): the pane on Atlas's floor with a plan on the table → Generate saves the book
// from the session → a review of that book with a proposal listed → Dismiss (asked first) closes it → adopt mode:
// the server stages the draft, a paste in the grid prices a row, Cancel leaves adopt mode → an adopt over an unsaved
// plan ASKS first → the phone's sheet. A page error fails the drive.
// The screenshots are the evidence — look at them.
//
//   node scripts/drive-portfolio-surface.mjs [baseUrl] [outDir]
//
// Runs against the Vite dev server (:5173, /api and /ws proxied to :3030) as the throwaway `ui-smoke` user, on a
// FRESH session. Everything it makes is removed after: the book's ideas, its portfolio_books row and its sealed
// conversation (agent_contexts), the adoption drafts, and the session itself.
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
const { ideaService } = await import('../api/trade-ideas/tradeIdeas.service.js')
const { adoptBookService } = await import('../api/portfolio/adoptBook.service.js')

// A plan as Atlas emits it, sized — what the real save (saveBatchIdeas) reads.
const PLAN = {
    name: 'Drive Quality', positionSize: 10000,
    ideas: [
        { asset: 'MSFT', asset_class: 'stock', direction: 'long', type: 'long_term', quantity: 10, allocationRatio: 0.5 },
        { asset: 'KO',   asset_class: 'stock', direction: 'long', type: 'long_term', quantity: 40, allocationRatio: 0.5 },
    ],
    limits: { notes: ['KO is held under the house\'s single-name cap'] },
}

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/ps-${name}.png`, fullPage: false }); console.log('  shot:', name) }
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

const atlas = async (userId, sessionId) => (await sessionService.get({ sessionId, userId }))?.agentState?.portfolio ?? null
async function seed(userId, sessionId, state) {
    await sessionService.setAgentState({ sessionId, userId, agent: 'portfolio', state })
    await sessionService.setFloor({ sessionId, userId, agent: 'portfolio' })
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
// The books that were there before — the one Generate makes is the one that is new (a name can repeat after a crash).
const before = new Set((await ideaService.getIdeas(userId)).map(i => i.portfolioId).filter(Boolean))
const drafts = new Set()
const sid    = (await sessionService.startNew({ userId })).sessionId
console.log('session:', sid)
await seed(userId, sid, { pendingPlan: PLAN, mandate: { goal: 'drive' }, thesis: { strategy: 'Compounders at fair prices' } })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
let bookId = null
let draftId = null

try {
    // ── 1. Atlas holds the floor with a plan → its surface beside the chat: the summary, the limits, Generate ──
    await signIn(page)
    await pane(page).waitFor({ timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(1000)
    await shot(page, '01-plan')
    const text1 = await pane(page).innerText().catch(() => '')
    check('the pane opens on Atlas (it holds the floor)', /Atlas/.test(await pane(page).locator('.side-pane__tabs').innerText().catch(() => '')))
    check('the plan is summarised, with the house\'s limits', /Drive Quality/.test(text1) && /MSFT/.test(text1) && /single-name cap/.test(text1))

    // ── 2. Generate saves the book FROM THE SESSION ──
    const gen = pane(page).getByRole('button', { name: 'Generate plan' })
    if (await gen.isDisabled()) {
        check('Generate is lit for a sized plan with an account marked', false, 'disabled — is an account marked for ui-smoke?')
    } else {
        await gen.click()
        await pane(page).getByText(/is saved —/).waitFor({ timeout: 15000 }).catch(() => {})
        await shot(page, '02-generated')
        const mine = (await ideaService.getIdeas(userId)).filter(i => i.portfolioName === 'Drive Quality' && !before.has(i.portfolioId))
        bookId = mine[0]?.portfolioId ?? null
        check('Generate saved the book (its holdings exist)', mine.length === 2, `${mine.length} holdings, book ${bookId}`)
        check('the surface says so and Atlas\'s table is clear', /Drive Quality is saved — 2 holdings/.test(await pane(page).innerText()) && !(await atlas(userId, sid)))
    }

    // ── 3. a review of that book: the proposal is listed, Dismiss asks, then closes the review ──
    if (bookId) {
        const msft = (await ideaService.getIdeas(userId)).find(i => i.portfolioId === bookId && i.asset === 'MSFT')
        await seed(userId, sid, {
            portfolioId: bookId, reviewMode: true, reviewed: true, editing: { kind: 'portfolio', entityId: bookId },
            reviewUpdate: { changes: [{ action: 'trim_item', itemId: msft?.id, reduceFraction: 0.5 }] },
        })
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.locator('.chat-timeline').waitFor({ timeout: 15000 })
        await pane(page).getByText('Trim MSFT by 50%').waitFor({ timeout: 15000 }).catch(() => {})
        await shot(page, '03-review')
        check('the review lists what Accept would do', (await pane(page).getByText('Trim MSFT by 50%').count()) === 1)
        check('…and offers Accept / Dismiss / Later', (await pane(page).getByRole('button', { name: 'Accept changes (1)' }).count()) === 1 && (await pane(page).getByRole('button', { name: 'Dismiss' }).count()) === 1)
        await pane(page).getByRole('button', { name: 'Dismiss' }).click()
        check('Dismiss asks first', (await pane(page).getByText(/Dismiss this review\?/).count()) === 1)
        await pane(page).getByRole('button', { name: 'Confirm' }).click()
        await pane(page).getByText(/Review dismissed/).waitFor({ timeout: 15000 }).catch(() => {})
        await shot(page, '04-dismissed')
        check('the review is closed and Atlas\'s table is clear', /Review dismissed/.test(await pane(page).innerText()) && !(await atlas(userId, sid)))
    }

    // ── 4. adopt mode: the server stages the draft; the grid prices a paste; Cancel leaves the mode ──
    await seed(userId, sid, { adopt: true })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline').waitFor({ timeout: 15000 })
    await pane(page).getByText('Your book at the bank').waitFor({ timeout: 15000 }).catch(() => {})
    draftId = (await atlas(userId, sid))?.adoptDraftId ?? null
    if (draftId) drafts.add(draftId)
    check('adopt mode stages a draft on Atlas\'s state and draws the grid', !!draftId && (await pane(page).getByText('Your book at the bank').count()) === 1, `draft ${draftId}`)
    await pane(page).getByLabel('Paste your holdings').fill('AAPL 10 150')
    await pane(page).getByRole('button', { name: /Read my book|Add these/ }).click()
    await pane(page).locator('.adopt-grid__table td', { hasText: 'AAPL' }).waitFor({ timeout: 20000 }).catch(() => {})
    await shot(page, '05-adopt')
    check('a paste in the grid becomes a row', (await pane(page).locator('.adopt-grid__table td', { hasText: 'AAPL' }).count()) >= 1)
    await pane(page).getByRole('button', { name: 'Cancel' }).click()
    await page.waitForTimeout(1500)
    const afterAdopt = await atlas(userId, sid)
    check('Cancel leaves adopt mode (the session no longer points at the draft)', afterAdopt?.adopt === false && !afterAdopt?.adoptDraftId)

    // ── 5. adopt over an unsaved plan: the surface ASKS before putting it aside ──
    await seed(userId, sid, { pendingPlan: PLAN, adopt: true })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline').waitFor({ timeout: 15000 })
    await pane(page).getByText(/Put it aside and adopt your bank book\?/).waitFor({ timeout: 15000 }).catch(() => {})
    await shot(page, '06-adopt-over-work')
    check('over an unsaved plan, adopt asks first (nothing staged yet)', (await pane(page).getByRole('button', { name: 'Put it aside' }).count()) === 1 && !(await atlas(userId, sid))?.adoptDraftId)
    await pane(page).getByRole('button', { name: 'Put it aside' }).click()
    await pane(page).getByText('Your book at the bank').waitFor({ timeout: 15000 }).catch(() => {})
    const putAside = await atlas(userId, sid)
    if (putAside?.adoptDraftId) drafts.add(putAside.adoptDraftId)
    check('a yes stages the draft on a clean table', !!putAside?.adoptDraftId && !putAside?.pendingPlan)

    // ── 6. a phone: Atlas's surface is a bottom sheet ──
    await seed(userId, sid, { pendingPlan: PLAN })
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    phone.on('pageerror', e => errors.push(`PAGEERROR(phone) ${e.message.slice(0, 200)}`))
    await signIn(phone)
    await phone.locator('.side-pane--sheet').waitFor({ timeout: 15000 }).catch(() => {})
    await phone.waitForTimeout(800)
    await phone.screenshot({ path: `${OUT}/ps-07-phone.png` })
    console.log('  shot: 07-phone')
    check('on a phone Atlas\'s surface is a bottom sheet', (await phone.locator('body > .side-pane--sheet').count()) === 1 && /Drive Quality/.test(await phone.locator('.side-pane--sheet').innerText()))
    await phone.close()
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
} finally {
    const db = await getDb()
    if (bookId) {
        for (const i of (await ideaService.getIdeas(userId)).filter(x => x.portfolioId === bookId)) await ideaService.deleteIdea(i.id, userId).catch(() => {})
        await db.collection('portfolio_books').deleteOne({ portfolioId: bookId }).catch(() => {})
        await db.collection('agent_contexts').deleteMany({ kind: 'portfolio', entityId: bookId }).catch(() => {})
    }
    for (const d of drafts) await adoptBookService.discardDraft({ draftId: d, userId }).catch(() => {})
    await db.collection('session_messages').deleteMany({ sessionId: sid }).catch(() => {})
    await db.collection('sessions').deleteOne({ sessionId: sid }).catch(() => {})
    // A page error is a failure, not a footnote (the 401 before sign-in and the deliberate 409s are console lines).
    const crashed = errors.filter(e => e.startsWith('PAGEERROR'))
    if (crashed.length) check('no page errors', false, crashed.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].join('\n  '))
    await closeDb()
}
