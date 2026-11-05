// A RE-DRAW AND A CLOSE, AGAINST THE CODE ON DISK (Roy, 2026-11-05). A real model reopens a real saved setup in this process,
// as Talos's card would: the whole trade has to be checked again, and "close it" has to reach the close. The running dev
// backend is not involved, so it cannot be the thing tested.
//
//   node scripts/verify-mentor-redraw.mjs [TICKER]
//
// Real model spend: two to three Mentor turns. Writes nothing: the document is latched in memory, and the close is recorded.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { mentorAgentService, emptyMentorState } = await import('../services/agents/mentor.agent.service.js')
const { mentorStateFromEntity, mentorNextState } = await import('../services/desks/mentor.desk.js')
const { getDb } = await import('../providers/mongodb.provider.js')
const { normalizeBuild, activeName, stageOf } = await import('../services/mentorBuild.util.js')

const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

const db = await getDb()
const query = { kind: 'setup', status: { $in: ['waiting', 'looking'] }, 'chat_state.draft.build': { $exists: true }, ...(process.argv[2] ? { asset: process.argv[2] } : {}) }
const doc = await db.collection('entities').findOne(query, { projection: { _id: 0 } })
if (!doc) { console.log('no saved setup with a stored build in this database'); process.exit(1) }
console.log('setup', doc.id, doc.asset, JSON.stringify(doc.scenarios?.map(s => [s.entry_legs?.[0]?.price, s.stop_legs?.[0]?.price, s.target_legs?.map(l => l.price)])))

const latched = { ...doc, invalidation_status: 'drifting', invalidation_edge: 'away', invalidation_reason: 'price ran past the away edge without filling', monitor_state: { ...doc.monitor_state, scenarios: {} } }
let state = { ...mentorStateFromEntity(latched), editing: { kind: 'setup', entityId: doc.id } }
console.log('redraw', JSON.stringify(state.redraw))

const ACCOUNTS = [{ id: doc.mainAccountId, broker: 'paper', isLive: false, currency: 'USD', balance: 100000, equity: 100000, freeMargin: 100000 }]
const closes = []
const history = []
async function turn(text) {
    const tools = []
    const res = await mentorAgentService.chatStream({
        messages: [...history, { role: 'user', content: text }],
        chatState: state, accounts: ACCOUNTS, mainAccountId: doc.mainAccountId, userId: doc.userId,
        clientTime: { clientNow: Date.now(), clientTz: 'Asia/Jerusalem' },
        onToken: () => {}, onAsset: () => {}, onCoverage: () => {},
        onToolStart: (t) => tools.push(t?.name ?? t),
        _closeSetup: async (id, userId) => { closes.push({ id, userId }); return { ok: true, closed: true } },
    })
    history.push({ role: 'user', content: text }, { role: 'assistant', content: res.reply })
    const next = mentorNextState(state, res)
    state = next ? { ...next, editing: state.editing } : emptyMentorState()
    console.log(`\n>>> ${text}\n<<< ${res.reply}\n    [tools ${tools.join(', ')}]`)
    return { res, tools }
}

const first = await turn(`Talos says my ${doc.asset} setup ran without filling — price ran past the away edge. The read wasn't wrong; the entry never came. Re-draw it on today's chart if there is still a trade, and say so plainly if there is not.`)
check('it read the chart again', first.tools.some(t => /get_price_structure|get_candles|get_chart|get_quote/.test(String(t))), first.tools.join(', '))
check('the stop is answered', /stop/i.test(first.res.reply))
check('the target is answered', /target/i.test(first.res.reply))
check('the card\'s opening closed nothing', closes.length === 0)
const open = activeName(normalizeBuild(state.draft?.build))
check('the turn did not finish the build again', !('entries' in (open?.settled ?? {})), `stage ${stageOf(open)}, settled ${Object.keys(open?.settled ?? {}).join(', ')}`)

const second = await turn('No, I do not want this one any more. Close the setup.')
check('"close it" reached the close', closes.length === 1 && closes[0].id === doc.id, JSON.stringify(closes))
check('the turn reports it closed', second.res.closedSetup?.id === doc.id)
check('nothing is left on the table', mentorNextState({}, second.res) === null)
const failed = results.filter(x => !x).length
console.log(`\n${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
