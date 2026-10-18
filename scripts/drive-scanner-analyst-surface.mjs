// DRIVE ARGUS'S AND PROMETHEUS'S SURFACES — the side pane over the session, in a real browser (unified-chat plan 8d).
//
// The FE tests stub the session; the backend tests stub the browser. This runs the paths that matter for 8d, with the
// desks' state SEEDED (no model call, no Prometheus read): Argus on the floor with a list → the lens is a hand edit →
// Generate saves the scan from the session → the scan reopened for editing → Update saves it back → a radar cut with
// its read already handed back (the verdict drawn) → Prometheus with a standing draft and its kill-criteria, offered to
// save (`ui-smoke` is an admin — the button is checked, never pressed: it would write house coverage). The
// screenshots are the evidence — look at them.
//
//   node scripts/drive-scanner-analyst-surface.mjs [baseUrl] [outDir]
//
// Runs against the Vite dev server (:5173, /api and /ws proxied to :3030) as the throwaway `ui-smoke` user, on a
// FRESH session. Everything it makes is removed after: the scan, its sealed conversation, the session.
// A page error fails the drive.
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
const { scanService } = await import('../api/scanner/scan.service.js')

const LIST = {
    thesis: 'Drive — semis on a pullback', direction: 'long', period: { label: 'this week' },
    candidates: [{ ticker: 'NVDA', direction: 'long', thesis: 'Reclaim of the 50-day' }, { ticker: 'AMD', direction: 'long', thesis: 'Higher low' }],
}
const DRAFT = { symbol: 'ZTS', rating: 'outperform', price_target: { base: 190 }, thesis: 'Drive — companion-animal pricing holds.', kill_criteria: ['Vet visits fall two quarters running'] }

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/sa-${name}.png`, fullPage: false }); console.log('  shot:', name) }
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

// A commit ENDS the session (Roy, 2026-10-18): the old one archived, a new one open with the saved line above Axl's
// greeting, the pane closed. `sid` moves to the new one — the steps after seed it.
const sessionsMade = new Set()
async function endedHere(page, userId) {
    const next = (await sessionService.getActive({ userId }))?.sessionId
    const old  = await sessionService.get({ sessionId: sid, userId })
    const line = await page.locator('.chat-timeline__ended').innerText().catch(() => '')
    const ok = !!next && next !== sid && old?.status === 'archived' && /back with Axl/.test(line) && (await pane(page).count()) === 0
    if (next) { sid = next; sessionsMade.add(next) }
    return ok
}

/**
 * Wait for a commit to have ENDED the session: a new active one on the server, then the page on it. Not just "an
 * ended line is on screen" — a session a commit opened STARTS with one, so the next press's wait would pass on the
 * old line before the press had even landed (the race that failed this drive, 2026-10-18).
 */
async function waitEnded(page, userId, ms = 15000) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
        const next = (await sessionService.getActive({ userId }))?.sessionId
        if (next && next !== sid) break
        await page.waitForTimeout(500)
    }
    await page.locator('.chat-timeline__ended').waitFor({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(800)
}

const stateOf = async (userId, sessionId, agent) => (await sessionService.get({ sessionId, userId }))?.agentState?.[agent] ?? null
async function seed(userId, sessionId, agent, state) {
    await sessionService.setAgentState({ sessionId, userId, agent, state })
    await sessionService.setFloor({ sessionId, userId, agent })
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
async function reload(page) {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline').waitFor({ timeout: 15000 })
    await page.waitForTimeout(1500)
}

const userId = await ensureUser()
// A crashed earlier run can leave its list behind under the same thesis — cleared first, so the one Generate makes is
// the only one carrying it.
for (const old of ((await scanService.getScans(userId)) ?? []).filter(s => s.thesis === LIST.thesis)) await scanService.deleteScan(old.id, userId).catch(() => {})
const before = new Set(((await scanService.getScans(userId)) ?? []).map(s => s.id))
let sid      = (await sessionService.startNew({ userId })).sessionId
sessionsMade.add(sid)
console.log('session:', sid)
await seed(userId, sid, 'scanner', { profile: 'trading', pendingScan: LIST })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
// Every press's answer, printed — a commit that "did nothing" is read off what the server said, not guessed.
page.on('response', async r => { if (/\/(act|state)$/.test(new URL(r.url()).pathname)) console.log(`  ${r.request().method()} ${new URL(r.url()).pathname.split('/').slice(-2).join('/')} → ${r.status()} ${(await r.text().catch(() => '')).slice(0, 160)}`) })
// Every Prometheus read the page asks for — the drive seeds its verdicts, so it must never pay for one.
const reads = []
page.on('request', r => { if (r.url().includes('/aether/batch-read')) reads.push(r.url()) })
let scanId = null

try {
    // ── 1. Argus holds the floor with a list → its surface: the list, the lens, Generate ──
    await signIn(page)
    await pane(page).waitFor({ timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(800)
    await shot(page, '01-list')
    const t1 = await pane(page).innerText().catch(() => '')
    check('the pane opens on Argus with the list', /Argus/.test(await pane(page).locator('.side-pane__tabs').innerText().catch(() => '')) && /semis on a pullback/i.test(t1) && /NVDA/.test(t1))

    // ── 2. the lens is a hand edit of Argus's state ──
    await pane(page).getByRole('button', { name: 'Investing' }).click()
    await page.waitForTimeout(1200)
    check('the lens is a hand edit (Argus\'s state reads investing)', (await stateOf(userId, sid, 'scanner'))?.profile === 'investing')
    await pane(page).getByRole('button', { name: 'Trading' }).click()
    await page.waitForTimeout(1200)
    check('…and back to trading', (await stateOf(userId, sid, 'scanner'))?.profile === 'trading')

    // ── 3. Generate saves the scan FROM THE SESSION ──
    await pane(page).getByRole('button', { name: 'Generate list' }).click()
    await waitEnded(page, userId)
    const mine = ((await scanService.getScans(userId)) ?? []).filter(s => !before.has(s.id) && s.thesis === LIST.thesis)
    scanId = mine[0]?.id ?? null
    await shot(page, '02-generated')
    check('Generate saved the scan', !!scanId, `scan ${scanId}`)
    check('…and the session ended — back with Axl, the saved line above his greeting', await endedHere(page, userId))

    // ── 4. the scan reopened for editing → Update saves it back to the same scan ──
    if (scanId) {
        await seed(userId, sid, 'scanner', {
            profile: 'trading', editingScanId: scanId, editing: { kind: 'scan', entityId: scanId },
            pendingScan: { ...LIST, candidates: [LIST.candidates[0]] }, editList: { ...LIST, candidates: [LIST.candidates[0]] },
        })
        await reload(page)
        await pane(page).getByText('editing list —').waitFor({ timeout: 15000 }).catch(() => {})
        await shot(page, '03-editing')
        check('a saved list being edited says so, with Update and Later', (await pane(page).getByRole('button', { name: 'Update list' }).count()) === 1 && (await pane(page).getByRole('button', { name: /later/i }).count()) === 1)
        const upd = pane(page).getByRole('button', { name: 'Update list' })
        console.log(`  (Update list enabled: ${await upd.isEnabled()}; rows in the chat: ${await page.locator('.chat-timeline__row, .chat-timeline__ended').count()})`)
        await upd.click()
        await waitEnded(page, userId)
        console.log(`  (after the press — pane note: "${(await pane(page).locator('.desk-surface__note').allInnerTexts().catch(() => [])).join(' | ')}")`)
        const saved = await scanService.getScanById(scanId, userId).catch(() => null)
        const doc = saved?.doc ?? saved
        check('Update saved the narrowed list onto the same scan', doc?.candidates?.length === 1, `${doc?.candidates?.length} candidates`)
        check('…and the session ended', await endedHere(page, userId))
    }

    // ── 5. a radar cut with its read handed back: the verdict and the caveat are drawn (no read fires) ──
    await seed(userId, sid, 'scanner', {
        profile: 'trading', radar: true, radarBoard: { candidates: [{ ticker: 'NVDA' }], runIds: [] },
        pendingScan: { ...LIST, candidates: [{ ticker: 'NVDA', direction: 'long', prometheus: { direction: 'short', why: 'the record reads short' } }] },
        readCut: { dropped: [{ ticker: 'AMD', verdict: 'contradicted' }], survived: true },
    })
    await reload(page)
    await pane(page).getByText(/Prometheus dropped 1/).waitFor({ timeout: 15000 }).catch(() => {})
    await shot(page, '04-radar')
    const t5 = await pane(page).innerText().catch(() => '')
    check('a radar cut draws the read\'s verdict and the caveat on the name', /Prometheus dropped 1 — AMD contradicted/.test(t5) && /record disagrees/.test(t5))
    check('…and with its verdict in, no read is asked for', reads.length === 0, `${reads.length} batch-read request(s)`)
    await sessionService.setAgentState({ sessionId: sid, userId, agent: 'scanner', state: null })

    // ── 6. Prometheus with a standing draft: the whole draft is drawn, and the save offered ──
    await seed(userId, sid, 'analyst', { draft: DRAFT, standing: true, active_symbol: 'ZTS' })
    await reload(page)
    await pane(page).getByText(/companion-animal pricing holds/i).waitFor({ timeout: 15000 }).catch(() => {})
    await shot(page, '05-prometheus')
    const t6 = await pane(page).innerText().catch(() => '')
    check('the pane opens on Prometheus with the draft', /Prometheus/.test(await pane(page).locator('.side-pane__tabs').innerText().catch(() => '')) && /companion-animal/i.test(t6))
    check('the kill-criteria are on screen, not clipped under their label', await pane(page).getByText('Vet visits fall two quarters running').isVisible().catch(() => false))
    // Initiate for a name the house does not cover, Update for one it does — either is the save, offered.
    check('the save is offered (Initiate, or Update when the house already covers ZTS)', (await pane(page).getByRole('button', { name: /^(Initiate|Update) coverage on ZTS$/ }).count()) === 1)
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
} finally {
    const db = await getDb()
    if (scanId) {
        await scanService.deleteScan(scanId, userId).catch(() => {})
        await db.collection('agent_contexts').deleteMany({ kind: 'scan', entityId: scanId }).catch(() => {})
    }
    // Every session the drive made — each commit opened one.
    for (const id of sessionsMade) {
        await db.collection('session_messages').deleteMany({ sessionId: id }).catch(() => {})
        await db.collection('sessions').deleteOne({ sessionId: id }).catch(() => {})
    }
    const crashed = errors.filter(e => e.startsWith('PAGEERROR'))
    if (crashed.length) check('no page errors', false, crashed.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    // A failed check fails the run, so a script or CI reading the exit code is told (phase 8d CR).
    if (results.some(r => !r.ok)) process.exitCode = 1
    if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].join('\n  '))
    await closeDb()
}
