// DRIVE THE SAVED LINE'S LIFETIME (Roy, 2026-11-02: "the built PENG setup chip is stuck even when it's armed").
//
// The "✓ … saved — You're back with Axl." line a commit opens a session with shows only on the visit it was saved in
// (frontend timelineRows.isFreshEndedLine). Two sessions for `ui-smoke`, each holding only that line:
//   OLD — stamped two days ago → no line, no "Open the setup to arm it"; Axl's greeting as a fresh start.
//   NEW — stamped now          → the line and its button above the greeting.
//
//   node scripts/drive-saved-line.mjs [baseUrl] [outDir]
//
// Against the Vite dev server (:5173). Sessions deleted after. No model spend. One sign-in.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT  = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

const db = await getDb()
const userId = (await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1 } }))?.id
if (!userId) throw new Error('no ui-smoke user — run another drive first')

const sessions = []
/** A fresh active session holding only the saved line, stamped `at`. */
async function seeded(at) {
    const sid = (await sessionService.startNew({ userId, force: true })).sessionId
    sessions.push(sid)
    await sessionService.append({ sessionId: sid, userId, message: {
        agent: 'axl', role: 'assistant', kind: 'sealed',
        content: '✓ Mentor built PENG setup — saved to your Setups. You\'re back with Axl.',
        ref: { kind: 'setup', ids: ['setup_DRIVE_x'], ended: true },
    } })
    await db.collection('session_messages').updateOne({ sessionId: sid, kind: 'sealed' }, { $set: { at } })
    return sid
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(e.message.slice(0, 200)))

async function look(name) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
    }
    await page.locator('.chat-timeline__empty').waitFor({ timeout: 20000 })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${OUT}/saved-line-${name}.png` })
    return {
        line: await page.locator('.chat-timeline__ended').count(),
        arm: await page.getByRole('button', { name: 'Open the setup to arm it' }).count(),
        greeting: await page.locator('.chat-timeline__empty').innerText(),
    }
}

try {
    await seeded(Date.now() - 2 * 86_400_000)
    let v = await look('old')
    check('OLD: no saved line', v.line === 0, `${v.line}`)
    check('OLD: no "Open the setup to arm it"', v.arm === 0)
    check('OLD: Axl\'s greeting, a fresh start', /Trade it/.test(v.greeting))

    await seeded(Date.now() + 5_000)   // the newest active session wins; stamped after this page load
    v = await look('new')
    check('NEW: the saved line shows', v.line === 1, `${v.line}`)
    check('NEW: with its arm button', v.arm === 1)
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
} finally {
    for (const sid of sessions) {
        await db.collection('session_messages').deleteMany({ sessionId: sid }).catch(() => {})
        await db.collection('sessions').deleteOne({ sessionId: sid }).catch(() => {})
    }
    if (errors.length) check('no page errors', false, errors.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (results.some(r => !r.ok)) process.exitCode = 1
    await closeDb()
}
