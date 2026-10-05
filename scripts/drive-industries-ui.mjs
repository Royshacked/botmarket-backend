// DRIVE THE ACTUAL SCREEN — Pythia's industry views, end to end, in a real browser.
//
//   node scripts/drive-industries-ui.mjs [baseUrl] [outDir] [--review]
//
// 1. As a TRADER: the Forecasts board — all sub-industries, grouped, chips — and one row expanded.
// 2. With --review, as an ADMIN (the throwaway user promoted): one real Pythia turn on semiconductors,
//    the drafted answer, Publish, and the board after. The turn's cost is read back from token_usage —
//    the one way to measure what a review costs before INDUSTRY_REVIEWS is switched on.
// The throwaway user (and its usage row) is deleted at the end. LOOK at the screenshots.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const args   = process.argv.slice(2)
const REVIEW = args.includes('--review')
const [BASE = 'http://localhost:5173', OUT = '.'] = args.filter(a => !a.startsWith('--'))
const USER = { username: 'ui-smoke-industries', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { userService } = await import('../api/user/user.service.js')

async function setRole(role) {
    const db = await getDb()
    await db.collection('users').updateOne({ username: USER.username }, { $set: { role } })
}

const shot = async (page, name) => {
    await page.screenshot({ path: `${OUT}/ind-${name}.png`, fullPage: false })
    console.log('  shot:', name)
}

async function signIn(page) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    const inputs = page.locator('input')
    if (await inputs.count()) {
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
}

try { await userService.createUser(USER); console.log('qa user created') } catch (e) { console.log('qa user exists —', e.message) }
await setRole('trader')

const browser = await chromium.launch({ channel: 'msedge' })
const errors = []
try {
    // ── 1. the board, as a trader ─────────────────────────────────────────────
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
    await signIn(page)
    await shot(page, '01-after-login')

    const forecasts = page.getByRole('button', { name: /Forecasts/ }).first()
    await forecasts.click()
    await page.waitForTimeout(3000)
    await shot(page, '02-board')
    const rows = await page.locator('.industry-view__row').count()
    const sectors = await page.locator('.industry-view__sector').count()
    console.log(`board: ${rows} rows in ${sectors} sectors`)

    await page.getByLabel('Find an industry').fill('semicon')
    await page.waitForTimeout(500)
    await page.locator('.industry-view__line').first().click()
    await page.waitForTimeout(800)
    await shot(page, '03-semis-expanded')
    await ctx.close()

    // ── 2. one real review, as an admin ───────────────────────────────────────
    if (REVIEW) {
        await setRole('admin')
        const actx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
        const ap = await actx.newPage()
        ap.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
        await signIn(ap)
        await ap.getByRole('button', { name: /Economics/ }).first().click()   // the desk's home button (agentMeta `lead`)
        await ap.waitForTimeout(2500)
        await shot(ap, '04-pythia-open')
        const box = ap.getByPlaceholder(/Ask about an industry/i)
        await box.click()
        await box.fill('Review semiconductors (GICS 45301020).')
        await box.press('Enter')
        console.log('review sent — waiting up to 6 minutes for the draft…')
        const t0 = Date.now()
        await ap.getByText('Publish this answer').first().waitFor({ timeout: 360_000 }).catch(() => {})
        console.log(`turn took ${Math.round((Date.now() - t0) / 1000)}s`)
        await shot(ap, '05-draft')
        const publish = ap.getByText('Publish this answer').first()
        if (await publish.count()) {
            await publish.click()
            await ap.waitForTimeout(3000)
            await shot(ap, '06-after-publish')
        } else {
            console.log('NO DRAFT came back')
        }
        const db = await getDb()
        const u = await db.collection('users').findOne({ username: USER.username })
        const usage = await db.collection('token_usage').find({ userId: u?.id }).toArray()
        for (const r of usage) console.log('usage:', JSON.stringify({ byAgent: r.byAgent, byModel: r.byModel }))
        await actx.close()
    }
} finally {
    await browser.close()
    const db = await getDb()
    const u = await db.collection('users').findOne({ username: USER.username })
    if (u) {
        await db.collection('token_usage').deleteMany({ userId: u.id })   // usage is keyed by the user's string id, not _id
        await db.collection('users').deleteOne({ _id: u._id })
        console.log('qa user removed')
    }
    await closeDb()
    if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '))
}
