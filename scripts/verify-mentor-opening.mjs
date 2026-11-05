// THE RULES OF THE LENS, TOLD ONCE (Roy, 2026-11-05: "nothing tells him about the rules of this lens"). A real model, in this
// process, so a dev backend that has not restarted cannot be what is tested: a bare name and a hand-off open with the
// rules, the next turn does not repeat them, a user's own setup does not get them, and a redraw does not either.
//
//   node scripts/verify-mentor-opening.mjs [TICKER]
//
// Real model spend: about five Mentor turns. Writes nothing to Mongo.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const TICKER = process.argv[2] ?? 'AAPL'
const { mentorAgentService, emptyMentorState } = await import('../services/agents/mentor.agent.service.js')
const { mentorStateFromEntity, mentorNextState } = await import('../services/desks/mentor.desk.js')
const { getDb } = await import('../providers/mongodb.provider.js')

const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

const RULES = [/\*\*Stop:?\*\*/, /\*\*Target:?\*\*/, /\*\*Your limits:?\*\*/, /\*\*Entry:?\*\*/, /\*\*If it leaves before filling:?\*\*/]
const told = (reply) => RULES.every(r => r.test(reply))
const anyRule = (reply) => /I'm building this risk-based/i.test(reply) || /\*\*If it leaves before filling:?\*\*/.test(reply)

const db = await getDb()
const saved = await db.collection('entities').findOne({ kind: 'setup', status: { $in: ['waiting', 'looking'] }, 'chat_state.draft.build': { $exists: true } }, { projection: { _id: 0 } })
const accountId = saved?.mainAccountId ?? 'verify-opening'
const userId = saved?.userId ?? 'verify-opening'
const ACCOUNTS = [{ id: accountId, broker: 'paper', isLive: false, currency: 'USD', balance: 100000, equity: 100000, freeMargin: 100000 }]

function conversation(state = emptyMentorState()) {
    const history = []
    return async function turn(text, extra = {}) {
        const res = await mentorAgentService.chatStream({
            messages: [...history, { role: 'user', content: text }],
            chatState: state, accounts: ACCOUNTS, mainAccountId: accountId, userId,
            clientTime: { clientNow: Date.now(), clientTz: 'Asia/Jerusalem' },
            onToken: () => {}, onAsset: () => {}, onToolStart: () => {}, onCoverage: () => {},
            ...extra,
        })
        history.push({ role: 'user', content: text }, { role: 'assistant', content: res.reply })
        state = { ...(mentorNextState(state, res) ?? emptyMentorState()), editing: state.editing }
        console.log(`\n>>> ${text}\n<<< ${res.reply}\n`)
        return res
    }
}

const bare = conversation()
const first = await bare(`Build me a swing trade on ${TICKER}.`)
check('a bare name opens with the rules', told(first.reply))
check('the rules come first', /^\W*I'm building this risk-based/i.test(first.reply.trim()), first.reply.slice(0, 60))
const second = await bare('Yes, go on. Stop at the checkpoints.')
check('the next turn does not repeat them', !anyRule(second.reply))

const handed = conversation()
const seeded = await handed(`Build with Mentor: ${TICKER}`, { seed: { ticker: TICKER, book_facts: 'Prometheus: buy', book_name: 'swing', horizon: 'swing' } })
check('a hand-off opens with the rules', told(seeded.reply))

const own = conversation()
const theirs = await own(`Long ${TICKER} on a pullback to the 50-day, stop under the last swing low.`)
check("the user's own setup does not get them", !anyRule(theirs.reply))

if (saved) {
    const latched = { ...saved, invalidation_status: 'drifting', invalidation_edge: 'away', invalidation_reason: 'price ran past the away edge without filling', monitor_state: { ...saved.monitor_state, scenarios: {} } }
    const redraw = conversation({ ...mentorStateFromEntity(latched, { redraw: true }), editing: { kind: 'setup', entityId: saved.id } })
    const again = await redraw(`Talos says my ${saved.asset} setup ran without filling. The read wasn't wrong; the entry never came. Re-draw it on today's chart if there is still a trade, and say so plainly if there is not.`)
    check('a redraw does not get them', !anyRule(again.reply))
} else console.log('SKIP  a redraw: no saved setup with a stored build')

const failed = results.filter(x => !x).length
console.log(`\n${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
