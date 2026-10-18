// DRIVE THE DOORWAYS — every desk card's button, pressed IN THE SOCIAL CHAT, lands where it should (unified-chat 8f).
//
// Desk cards live in the social chat and only there (Roy, 2026-10-18), and MainPage's bus listeners are what their
// buttons reach — the one part of the app with no unit suite (plan §10.3 / §10.6 "8f drives them"). This presses them
// in a real browser, on a FRESH session for the throwaway `ui-smoke` user (an admin, so the coverage card shows):
//   1. a portfolio review card → Atlas's surface opens beside the chat, the book reopened in REVIEW mode
//   2. a setup-invalidation card while Mentor holds other work → asked first; "no" keeps the work, "yes" sets it
//      aside and reopens the setup at Mentor with the re-draw turn running (stopped at once — a cent, not a build)
//   3. a coverage verdict card → Prometheus's surface, the thesis reopened, the revise turn running (stopped)
//   4. the market-brief card → Axl's brief turn in the chat (stopped)
//   5. the queued-list card → the Floor's queued desk
//   6. no card ever lands in the timeline
// The fixtures (a setup, a book, the cards) are made here and removed after; the coverage doc is a house one, read
// and never written (the revise turn is stopped and Prometheus's table discarded).
//
//   node scripts/drive-doorways.mjs [baseUrl] [outDir]
//
// Against the Vite dev server (:5173, /api and /ws proxied to :3030). A failed check fails the run (exit 1).
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
const { setupService } = await import('../api/setups/setups.service.js')
const { paperBrokerService } = await import('../api/broker/paperBroker.service.js')
const { portfolioCommit } = await import('../api/portfolio/portfolioCommit.service.js')
const { postBotCard, cardActions } = await import('../api/chat/chat.service.js')
const { draftVerdict } = await import('../services/setupVerdict.js')

const SETUP = {
    asset: 'NVDA', direction: 'long', type: 'swing',
    conditions:  [{ id: 'c1', text: 'CHoCH up on the 15m' }],
    entry_legs:  [{ price: 238.6, quantity: 100 }],
    stop_legs:   [{ price: 234.8 }],
    target_legs: [{ price: 246 }],
}
// What Mentor is "holding" when the re-draw card arrives — a different name, so the reopen must ask.
const HELD = { ...SETUP, asset: 'AMD', entry_legs: [{ price: 150, quantity: 50 }], stop_legs: [{ price: 145 }], target_legs: [{ price: 165 }] }
const BOOK = {
    name: 'Drive Review Book',
    ideas: [{ asset: 'MSFT', asset_class: 'stock', direction: 'long', type: 'long_term', quantity: 5, allocationRatio: 1 }],
}

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/dw-${name}.png`, fullPage: false }); console.log('  shot:', name) }
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const pane     = (page) => page.locator('.side-pane')
// The tab the pane is SHOWING — not just one that is open.
const paneTabs = async (page) => (await pane(page).locator('.side-pane__tab.is-active').innerText().catch(() => '')).replace(/\s*×\s*$/, '').trim()

async function ensureUser() {
    try { await userService.createUser(USER); console.log('qa user: created') }
    catch (err) { console.log('qa user: already there —', err.message) }
    const db = await getDb()
    const u = await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1 } })
    if (!u?.id) throw new Error('qa user has no id')
    return u.id
}

const stateOf = async (userId, sessionId, agent) => (await sessionService.get({ sessionId, userId }))?.agentState?.[agent] ?? null

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

/** Open the social chat on a bot's conversation and press the LAST card's primary button. → whether it was found. */
async function pressCard(page, bot, label) {
    if (!(await page.locator('.social-chat__topbar').count())) await page.locator('.app-header-axl__chat').click()
    await page.locator('.social-chat__topbar').waitFor({ timeout: 10000 })
    // On the list (a conversation may already be open from a previous press — go back to the list first).
    const back = page.getByLabel('Back to conversations')
    if (await back.count()) await back.click()
    const conv = page.locator('.social-chat__conv-item', { hasText: bot }).first()
    await conv.waitFor({ timeout: 10000 })
    await conv.click()
    const btn = page.getByRole('button', { name: label }).last()
    await btn.waitFor({ timeout: 10000 }).catch(() => {})
    if (!(await btn.count())) return false
    await btn.click()
    return true
}

/** A turn started by a doorway is stopped as soon as it shows — the drive checks the door, not the answer. */
async function stopTurn(page) {
    const stop = page.getByLabel('Stop response')
    const shown = await stop.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)
    if (shown) { await page.waitForTimeout(800); await stop.click().catch(() => {}) }
    await page.waitForTimeout(1500)
    return shown
}

const userId = await ensureUser()
const db = await getDb()

// ── fixtures ──
const paper = await paperBrokerService.getAccount(userId)
const accounts = paper ? [{ id: paper.accountId, broker: 'paper' }] : []
const made = await setupService.generateSetup(SETUP, { userId, accounts, mainAccountId: paper?.accountId ?? null })
const setupId = made?.ok ? made.doc?.id ?? null : null
// As Generate makes one: the holdings, then the book's own document (portfolio_books — what a reopen reads).
const book = await portfolioCommit.createBook(BOOK, userId, { accounts: accounts.map(a => a.id), mainAccountId: paper?.accountId ?? null })
const bookId = book?.ok && book.ideas?.length ? book.portfolioId : null
if (bookId) await portfolioCommit.recordConstruction(bookId, userId, { mandate: { goal: 'drive' } })
const coverage = await db.collection('coverage').findOne({ status: 'active' }, { projection: { _id: 0, id: 1, symbol: 1 } })
const sid = (await sessionService.startNew({ userId })).sessionId
const cardIds = []
console.log('session:', sid, '· setup:', setupId, `(${made?.reason ?? 'ok'})`, '· book:', bookId, '· coverage:', coverage?.symbol)

const post = async (card) => { const m = await postBotCard({ userId, ...card }); if (m?.id) cardIds.push(m.id); return m }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', async m => {
    if (m.type() !== 'error') return
    // React's warnings carry their component names as %s arguments — read them, or the line names nothing.
    const args = /%s/.test(m.text()) ? await Promise.all(m.args().slice(1, 4).map(a => a.jsonValue().catch(() => '?'))) : []
    errors.push((m.text().slice(0, 160) + (args.length ? ` [${args.map(a => String(a).slice(0, 40)).join(', ')}]` : '')))
})
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
// window.confirm: the next answer is set per step; every question asked is recorded.
let confirmAnswer = true
const asked = []
page.on('dialog', d => { asked.push(d.message()); (confirmAnswer ? d.accept() : d.dismiss()).catch(() => {}) })

try {
    check('fixtures: a saved setup, a book, a house coverage doc', !!setupId && !!bookId && !!coverage?.id,
        `setup ${setupId ?? made?.reason} · book ${bookId} · coverage ${coverage?.id ?? 'none'}`)
    await signIn(page)
    const rowsAtStart = await page.locator('.chat-timeline__row').count()

    // ── 1. portfolio review card → Atlas, the book in review mode ──
    if (bookId) {
        await post({ botId: 'portfolio', type: 'portfolio_review', content: 'Drive Review Book is due its review.',
            payload: { portfolioId: bookId, portfolioName: BOOK.name, mode: 'paper', lastReviewAt: null, reason: 'cadence', triggers: [] },
            actions: cardActions('Review portfolio') })
        const pressed = await pressCard(page, 'Atlas', 'Review portfolio')
        check('the review card is in the social chat, with its button', pressed)
        await page.waitForTimeout(3000)
        await shot(page, '01-review')
        const atlas = await stateOf(userId, sid, 'portfolio')
        check('the social chat closed and Atlas\'s surface opened beside the chat', (await page.locator('.social-chat__topbar').count()) === 0 && /Atlas/.test(await paneTabs(page)), await paneTabs(page))
        check('…the book reopened in REVIEW mode in the session', atlas?.portfolioId === bookId && atlas?.reviewMode === true, JSON.stringify({ portfolioId: atlas?.portfolioId, reviewMode: atlas?.reviewMode }))
    }

    // ── 2. setup invalidation while Mentor holds other work → asked; no keeps it, yes sets it aside ──
    if (setupId) {
        const v = draftVerdict(HELD, true)
        await sessionService.setAgentState({ sessionId: sid, userId, agent: 'mentor', state: {
            active_asset: 'AMD', draft: v.setup, coverage: ['markets'], drafts: {}, view: { gate: null, readiness: v.readiness, setups: null },
        } })
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.locator('.chat-timeline').waitFor({ timeout: 15000 })
        await page.waitForTimeout(1500)
        await post({ botId: 'mentor', type: 'setup_invalidation', content: 'NVDA is no longer valid — price closed past the edge.',
            payload: { setupId, asset: 'NVDA', event: 'invalidated', scenario: null, remaining: 0 }, actions: cardActions('Re-draw it') })

        confirmAnswer = false
        asked.length = 0
        check('the re-draw card is in the social chat, with its button', await pressCard(page, 'Mentor', 'Re-draw it'))
        await page.waitForTimeout(2500)
        const kept = await stateOf(userId, sid, 'mentor')
        check('over Mentor\'s other work it ASKS first', asked.some(q => /Mentor is in the middle of something else/.test(q)), asked.join(' | '))
        check('…and a "no" keeps the AMD work on Mentor\'s table', kept?.draft?.asset === 'AMD' && !kept?.editing, JSON.stringify({ asset: kept?.draft?.asset, editing: kept?.editing ?? null }))

        confirmAnswer = true
        await pressCard(page, 'Mentor', 'Re-draw it')
        const ran = await stopTurn(page)
        await shot(page, '02-redraw')
        const m = await stateOf(userId, sid, 'mentor')
        check('a "yes" reopens the NVDA setup at Mentor, in the session', m?.editing?.entityId === setupId, JSON.stringify(m?.editing ?? null))
        check('…Mentor\'s surface is up beside the chat', /Mentor/.test(await paneTabs(page)), await paneTabs(page))
        check('…and the re-draw turn ran on it (stopped here)', ran)
    }

    // ── 3. coverage verdict card → Prometheus, the thesis reopened, the revise turn running ──
    if (coverage?.id) {
        await post({ botId: 'analyst', type: 'coverage_event', content: `${coverage.symbol}: the thesis is under pressure.`,
            payload: { kind: 'coverage', symbol: coverage.symbol, coverageId: coverage.id, state: 'diverging' },
            actions: cardActions('Revise thesis'), visibility: 'admin' })
        check('the coverage card is in the social chat, with its button', await pressCard(page, 'Prometheus', 'Revise thesis'))
        const ran = await stopTurn(page)
        await shot(page, '03-coverage')
        const p = await stateOf(userId, sid, 'analyst')
        check('the thesis reopened at Prometheus, in the session', p?.editing?.entityId === coverage.id, JSON.stringify(p?.editing ?? null))
        check('…its surface is up beside the chat', /Prometheus/.test(await paneTabs(page)), await paneTabs(page))
        check('…and the revise turn ran (stopped here)', ran)
    }

    // ── 4. market-brief card → Axl's brief turn in the chat ──
    await post({ botId: 'axl', type: 'market_brief_offer', content: 'Want today\'s market brief?',
        payload: { day: new Date().toISOString().slice(0, 10) }, actions: cardActions('Get the brief', { resolvesOn: 'open' }) })
    check('the brief card is in the social chat, with its button', await pressCard(page, 'Axl', 'Get the brief'))
    const briefRan = await stopTurn(page)
    await shot(page, '04-brief')
    check('the brief is asked for in the chat, as Axl\'s turn', briefRan && /Today.s market brief, please\./.test(await page.locator('.chat-timeline').innerText()))
    await page.waitForTimeout(3000)
    check('…and Stop ends it', (await page.getByLabel('Stop response').count()) === 0 && !/Writing today.s brief/.test(await page.locator('.chat-timeline').innerText()))

    // ── 5. queued-list card → the Floor's queued desk ──
    await post({ botId: 'mentor', type: 'queue_ready', content: 'The market is open — 0 orders are queued.',
        payload: { count: 0 }, actions: cardActions('Open the list', { resolvesOn: 'open' }) })
    check('the queue card is in the social chat, with its button', await pressCard(page, 'Mentor', 'Open the list'))
    await page.waitForTimeout(2500)
    await shot(page, '05-queued')
    // The queued desk exists only on the Floor design; on the classic one the card says where the list lives.
    if (await page.locator('.floor-desk').count()) {
        const open = await page.locator('.floor-desk--open').innerText().catch(() => '')
        check('the Floor opens its queued desk', /Awaiting orders/i.test(open), open.slice(0, 80).replace(/\s+/g, ' '))
    } else {
        check('on the classic design the card says the list is on the Floor', /queued list is on the Floor/.test(await page.locator('body').innerText()))
    }

    // ── 6. none of it landed in the timeline as a card ──
    check('no card was drawn in the timeline', (await page.locator('.chat-timeline__card').count()) === 0)
    check('…and the timeline holds only the turns the doorways asked for', (await page.locator('.chat-timeline__row').count()) >= rowsAtStart)
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
} finally {
    if (setupId) await setupService.deleteSetup(setupId, userId).catch(() => {})
    if (bookId) {
        for (const i of (await ideaService.getIdeas(userId)).filter(x => x.portfolioId === bookId)) await ideaService.deleteIdea(i.id, userId).catch(() => {})
        await db.collection('portfolio_books').deleteOne({ portfolioId: bookId }).catch(() => {})
        await db.collection('agent_contexts').deleteMany({ kind: 'portfolio', entityId: bookId }).catch(() => {})
    }
    if (cardIds.length) await db.collection('chat_messages').deleteMany({ id: { $in: cardIds } }).catch(() => {})
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
