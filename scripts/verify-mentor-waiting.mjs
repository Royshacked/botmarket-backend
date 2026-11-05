// WHAT MENTOR SAYS ABOUT THE MONEY, AGAINST THE CODE ON DISK (Roy, 2026-11-05). A real model sizes a real name on an account
// that already has setups waiting, in this process, so a dev backend that has not restarted cannot be what is tested.
// The account is the first one with waiting setups in the database this runs on, and its figures are overridden so that
// value and free cash differ: a percent has to come off the value, the fit off the free cash.
//
//   node scripts/verify-mentor-waiting.mjs [TICKER]
//
// Real model spend: four to seven Mentor turns. Writes nothing to Mongo.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const TICKER = process.argv[2] ?? 'AAPL'
const { mentorAgentService, emptyMentorState, _waitingSetups } = await import('../services/agents/mentor.agent.service.js')
const { getDb } = await import('../providers/mongodb.provider.js')

const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

const db = await getDb()
const doc = await db.collection('entities').findOne({ kind: 'setup', status: { $in: ['waiting', 'looking', 'hit'] }, mainAccountId: { $ne: null } })
if (!doc) { console.log('no waiting setup in this database'); process.exit(1) }
const accountId = doc.mainAccountId, userId = doc.userId
const VALUE = 100000, FREE = 60000
const ACCOUNTS = [{ id: accountId, broker: 'paper', login: accountId, isLive: false, currency: 'USD', balance: VALUE, equity: VALUE, freeMargin: FREE }]
const docs = await db.collection('entities').find({ kind: 'setup', userId, status: { $in: ['waiting', 'looking', 'hit'] } }).toArray()
const expected = _waitingSetups(docs, { accountId })
console.log('waiting', JSON.stringify(expected))

const history = []
const reports = []
let chatState = emptyMentorState()
async function turn(text) {
    const res = await mentorAgentService.chatStream({
        messages: [...history, { role: 'user', content: text }],
        chatState, accounts: ACCOUNTS, mainAccountId: accountId, userId,
        clientTime: { clientNow: Date.now(), clientTz: 'Asia/Jerusalem' },
        onToken: () => {}, onAsset: () => {}, onToolStart: () => {}, onCoverage: () => {},
        _run: async (args) => {
            const { runAgentStream } = await import('../services/agentIO.js')
            const handler = args.toolHandlers.size_position
            args.toolHandlers.size_position = async (a) => { const out = await handler(a); reports.push(out); return out }
            return runAgentStream(args)
        },
    })
    history.push({ role: 'user', content: text }, { role: 'assistant', content: res.reply })
    chatState = { active_asset: res.setup?.asset ?? chatState.active_asset, draft: res.setup ?? chatState.draft, coverage: res.coverage ?? chatState.coverage }
    console.log(`\n>>> ${text}\n<<< ${res.reply}`)
    return res
}

await turn(`Build me a swing trade on ${TICKER}.`)
await turn('Yes, long, swing. Stop at the checkpoints.')
const sized = () => chatState.draft?.scenarios?.[0]?.quantity > 0
for (let i = 0; i < 5 && !reports.length; i++) await turn('Agreed, go on. Regular stop, one target, no break scenario. My risk limit is 8%, minimum reward to risk 1.5. Size: risk 1%.')
if (!reports.length) await turn('Size it: risk 1% of the account.')

const report = reports.at(-1) ?? ''
console.log(`\nREPORT\n${report}\n`)
check('the sizing tool ran', reports.length > 0)
check('the report has the waiting line', /WAITING SETUPS on this account/.test(report))
check('the report names the waiting setups', expected.names.every(n => report.includes(n)))
check('the plan was sized', sized())
const sc = chatState.draft?.scenarios?.[0]
const entry = Number(sc?.entry_legs?.[0]?.price), stop = Number(sc?.stop_legs?.[0]?.price)
const qty = Number(sc?.quantity)
if (entry > 0 && stop > 0 && qty > 0) {
    const risk = qty * Math.abs(entry - stop)
    check('1% is of the account value, not of the free cash', Math.abs(risk - VALUE * 0.01) <= Math.abs(entry - stop), `${qty} units risk $${risk.toFixed(2)} against $${VALUE * 0.01}`)
}
const last = history.at(-1).content
check('the reply mentions the waiting setups', expected.names.some(n => last.includes(n)) || /waiting|not filled/i.test(last), last.slice(0, 120))
const failed = results.filter(x => !x).length
console.log(`\n${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
