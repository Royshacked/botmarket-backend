// THE CHOICE OF SCENARIOS, ON THE TURN MENTOR ASKS (Roy, 2026-11-07), against the code on disk: no server, no UI, a real
// model in this process. Walks a thesis build to "A, B or both" and one turn past it. Checks: the turn that asks carries
// the offer with the numbers its reply says, the tag is not in the reply, the worksheet waits for the answer, and the
// answer's turn carries no offer.
//
//   node scripts/verify-mentor-offer.mjs [TICKER]
//
// Real model spend: three to seven Mentor turns. Writes nothing to Mongo.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const TICKER = process.argv[2] ?? 'ARMK'
const { mentorAgentService, emptyMentorState } = await import('../services/agents/mentor.agent.service.js')

const ACCOUNTS = [{ id: 'paper-verify', broker: 'paper', login: 'paper-verify', isLive: false, currency: 'USD', balance: 100000, equity: 100000, freeMargin: 100000 }]
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

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
    console.log(`\n>>> ${text}\n<<< ${res.reply}\n    [offer ${JSON.stringify(res.scenarioOffer ?? null)} · scenarios ${chatState.draft?.scenarios?.length ?? 0}]`)
    return res
}

const asks = (t) => /\bA,? B,? or both\b|\bA, B, or both\b/i.test(t)
let r = await turn(`Build me a swing trade on ${TICKER}, thesis lens, long.`)
for (let i = 0; i < 5 && !asks(r.reply); i++) r = await turn('Yes, go on.')
if (!asks(r.reply)) {
    console.log(`\nMentor did not reach "A, B or both" on ${TICKER}: no break scenario on this chart? Try another name.`)
    process.exit(2)
}

check('the turn that asks carries the offer', r.scenarioOffer?.options?.length >= 2, JSON.stringify(r.scenarioOffer))
for (const o of r.scenarioOffer?.options ?? []) check(`${o.id}'s stop is the one the reply says`, r.reply.includes(String(o.stop)), String(o.stop))
const b = r.scenarioOffer?.options?.find(o => o.arm != null)
check('B carries its arming line, and the reply says it', b && r.reply.includes(String(b.arm)), String(b?.arm))
check('the tag is not in the reply', !/scenario_offer/.test(r.reply))
check('the worksheet waits for the answer', (chatState.draft?.scenarios?.length ?? 0) <= 1, `${chatState.draft?.scenarios?.length ?? 0} scenarios`)

r = await turn('Both A and B. My stop distance is at most 8% and my minimum reward to risk is 1.5.')
check('the answer\'s turn carries no offer', !r.scenarioOffer, JSON.stringify(r.scenarioOffer ?? null))
check('both are on the worksheet now', chatState.draft?.scenarios?.length === 2, `${chatState.draft?.scenarios?.length ?? 0} scenarios`)

const failed = results.filter(x => !x).length
console.log(`\n${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
