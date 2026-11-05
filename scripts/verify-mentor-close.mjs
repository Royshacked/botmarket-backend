// A CLOSE FROM THE CHAT, WRITTEN (Roy, 2026-11-05: "if it is decided to close the setup, its status should turn to closed"). A real
// model, a real session turn and a throwaway setup on axl_dev, in this process: nothing stubbed, so the status, the seal
// and the clean desk are what Mongo holds afterwards. The setup, its context and the session are removed.
//
//   node scripts/verify-mentor-close.mjs
//
// Real model spend: one or two Mentor turns.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
if (process.env.DB_NAME !== 'axl_dev') throw new Error(`refusing to run against ${process.env.DB_NAME} — axl_dev only`)

const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')
const { sessionTurn } = await import('../services/desks/sessionTurn.js')
const { sealing } = await import('../services/desks/seal.js')
const { agentContextService } = await import('../services/agentContext.service.js')

const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

const db = await getDb()
const entities = db.collection('entities')
const userId = (await db.collection('users').findOne({ username: 'ui-smoke' }, { projection: { id: 1 } }))?.id
if (!userId) throw new Error('no ui-smoke user')
const ID = `setup_VERIFYCLOSE_${Date.now()}`
const account = `verify-${ID}`
const plan = { asset: 'AAPL', direction: 'long', type: 'swing', trade_mode: 'thesis', timeframe: 'day',
    scenarios: [{ id: 's1', entry_legs: [{ price: 330, quantity: 10 }], stop_legs: [{ price: 320 }], target_legs: [{ price: 360, quantity: 10 }], quantity: 10 }],
    entry_legs: [{ price: 330, quantity: 10 }], stop_legs: [{ price: 320 }], target_legs: [{ price: 360, quantity: 10 }], quantity: 10 }
await entities.insertOne({ ...plan, id: ID, kind: 'setup', userId, parentId: null, status: 'waiting', savedAt: Date.now(), mode: 'paper', broker: 'paper',
    accounts: [account], mainAccountId: account, chat_state: { draft: plan, coverage: [] }, monitor_state: { scenarios: {}, guards: [] } })
const { sessionId } = await sessionService.startNew({ userId, force: true })
const user = { _id: userId, role: 'user' }
const input = { accounts: [{ id: account, broker: 'paper', isLive: false, currency: 'USD', balance: 100000, equity: 100000, freeMargin: 100000 }], mainAccountId: account, clientTime: { clientNow: Date.now(), clientTz: 'Asia/Jerusalem' } }

try {
    const entity = await entities.findOne({ id: ID }, { projection: { _id: 0 } })
    const opened = await sealing.openForEdit({ userId, sessionId, kind: 'setup', entity, name: 'AAPL setup', force: true })
    check('the setup opened for editing', !opened.reason, opened.reason ?? '')

    const out = await sessionTurn({ user, sessionId, agent: 'mentor', text: 'I do not want this setup any more. Yes, close it now.', input })
    console.log(`\n<<< ${out?.reply?.content ?? JSON.stringify(out).slice(0, 300)}\n`)

    const doc = await entities.findOne({ id: ID })
    check('the status is closed in Mongo', doc.status === 'closed', doc.status)
    check('it says when and why', Number.isFinite(doc.closedAt) && doc.closedReason === 'invalidated', `${doc.closedAt} ${doc.closedReason}`)
    const session = await sessionService.get({ sessionId, userId })
    check('the desk is not still editing it', !session.agentState?.mentor?.editing, JSON.stringify(session.agentState?.mentor ?? null).slice(0, 160))
    check('the desk starts clean', !session.agentState?.mentor?.draft)
    const sealed = await agentContextService.load({ userId, kind: 'setup', entityId: ID, agent: 'mentor' })
    check('the conversation is on the setup', sealed?.messages?.some(m => /close it now/.test(m.content)), `${sealed?.messages?.length ?? 0} messages`)
    const rows = await sessionService.messagesSince({ sessionId, userId })
    check('the reply stays in the chat', rows.some(m => m.role === 'assistant' && m.agent === 'mentor'))
    check('the session links the setup', session.links?.some(l => l.id === ID))
} catch (err) {
    check('the run finished', false, err.stack?.slice(0, 400))
} finally {
    await entities.deleteOne({ id: ID })
    await db.collection('agent_contexts').deleteMany({ entityId: ID })
    await sessionService.startNew({ userId, force: true }).catch(() => {})
    await db.collection('sessions').deleteOne({ sessionId }).catch(() => {})
    await closeDb?.().catch?.(() => {})
}
const failed = results.filter(x => !x).length
console.log(`\n${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
