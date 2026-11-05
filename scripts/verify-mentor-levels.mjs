// MENTOR'S LEVELS, AGAINST THE CODE ON DISK (Roy, 2026-11-05). No server, no UI, no sign-in: the agent is a plain service,
// so a real model builds a real name in this process. A running dev backend can be hours behind the files; a drive through
// it proves nothing about them, and this one cannot be (the first drives of this change ran on a morning's process).
// A name at its highs, walked to the risk question and one turn past it. Checks: the worksheet's target is the calculated
// measured move, the reply says that number, the distances are in dollars and percent.
//
//   node scripts/verify-mentor-levels.mjs [TICKER]
//
// Real model spend: four to seven Mentor turns. Writes nothing to Mongo.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const TICKER = process.argv[2] ?? 'AAPL'
const { mentorAgentService, emptyMentorState } = await import('../services/agents/mentor.agent.service.js')
const { thesisTurnFacts } = await import('../services/tools/thesisStructure.tools.js')

const ACCOUNTS = [{ id: 'paper-verify', broker: 'paper', login: 'paper-verify', isLive: false, currency: 'USD', balance: 100000, equity: 100000, freeMargin: 100000 }]
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

const facts = await thesisTurnFacts({ ticker: TICKER })
console.log('facts', JSON.stringify({ close: facts.close, stop: facts.stop, target: facts.target, kind: facts.target_kind, range_high: facts.range_high }))

const history = []
let chatState = emptyMentorState()
async function turn(text) {
    const res = await mentorAgentService.chatStream({
        messages: [...history, { role: 'user', content: text }],
        chatState, accounts: ACCOUNTS, mainAccountId: 'paper-verify',
        clientTime: { clientNow: Date.now(), clientTz: 'Asia/Jerusalem' }, userId: null,
        onToken: () => {}, onAsset: () => {}, onToolStart: () => {}, onCoverage: () => {},
    })
    history.push({ role: 'user', content: text }, { role: 'assistant', content: res.reply })
    chatState = { active_asset: res.setup?.asset ?? chatState.active_asset, draft: res.setup ?? chatState.draft, coverage: res.coverage ?? chatState.coverage }
    const legs = chatState.draft?.scenarios?.[0]?.target_legs
    console.log(`\n>>> ${text}\n<<< ${res.reply}\n    [stage ${chatState.draft?.build?.names?.[0]?.asset ?? ''} · target ${JSON.stringify(legs?.map(l => [l.price, l.anchor]))}]`)
    return res
}

let r = await turn(`Build me a swing trade on ${TICKER}.`)
r = await turn('Yes — long, swing. Stop at the checkpoints.')
const asks = (t) => /risk limit|stop distance/i.test(t) && /reward[- ]to[- ]risk|r:r/i.test(t) && /\?/.test(t) && !/next checkpoint/i.test(t)
for (let i = 0; i < 4 && !asks(r.reply); i++) r = await turn('Agreed — go on. Stay on the regular stop, one target, and no break scenario.')
check('the turn asks for the limits', asks(r.reply))
check('a distance in dollars and percent', /\$\d[\d,.]*\s*\(\d+(\.\d+)?%\)/.test(r.reply))
const all = history.filter(m => m.role === 'assistant').map(m => m.content).join('\n')
const leg = chatState.draft?.scenarios?.[0]?.target_legs?.[0]
if (facts.target_kind === 'measured_move') {
    check('the worksheet holds the calculated measured move', leg?.price === facts.target && leg?.anchor === 'measured_move', JSON.stringify(leg && [leg.price, leg.anchor]))
    check('the replies say that number', all.includes(String(facts.target)))
}
await turn('My risk limit is 8% and my minimum reward to risk is 1.5.')
const failed = results.filter(x => !x).length
console.log(`\n${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
