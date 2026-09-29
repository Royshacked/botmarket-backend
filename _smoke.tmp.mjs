// The full build, driven the way the REAL client drives it: the new user turn goes INSIDE
// `messages` (buildDeskMessages ignores userPrompt when messages is non-empty — the bug that
// invalidated the first smoke). Prose only, no pressed ops: this is the default path.
import dns from 'dns'
import { writeFileSync } from 'fs'
import 'dotenv/config'
dns.setServers(['8.8.8.8', '1.1.1.1'])
const { mentorAgentService } = await import('./services/agents/mentor.agent.service.js')
const { runAgentStream } = await import('./services/agentIO.js')
const { activeName, stageOf } = await import('./services/mentorBuild.util.js')

const OUT = process.argv[2]
const ACCOUNTS = [{ id: 'a1', broker: 'paper', isLive: false, login: 'SMOKE', currency: 'USD', balance: 50000, freeMargin: 50000 }]
const state = { chat: { active_asset: '', draft: null, coverage: [] }, messages: [] }
let charts = 0

async function say(text, label) {
    const tools = []
    state.messages = [...state.messages, { role: 'user', content: text }]
    const out = await mentorAgentService.chatStream({
        messages: state.messages, chatState: state.chat,
        accounts: ACCOUNTS, mainAccountId: 'a1', userId: 'smoke',
        onToolStart: (n) => tools.push(n),
        onChart: (c) => { charts += 1; writeFileSync(`${OUT}/chart-${charts}.png`, Buffer.from(c.imageBase64, 'base64')) },
        _venueSection: async () => '\n\nVENUE: paper. One account marked (SMOKE, $50,000).',
        _run: async (args) => {
            const raw = await runAgentStream(args)
            const tags = [...String(raw).matchAll(/<(build|spans|entries)>[\s\S]*?<\/\1>/g)].map(m => m[0].slice(0, 110))
            console.log('   tags:', tags.length ? tags.join(' | ') : '(none)')
            return raw
        },
    })
    const n = activeName(out.build)
    console.log(`\n${'='.repeat(70)}\n### ${label} — "${text}"`)
    console.log('   tools  :', tools.length, '|', tools.join(',') || '(none)')
    console.log('   STAGE  :', stageOf(n) ?? 'DONE', '| settled:', Object.keys(n?.settled ?? {}).join(',') || '(none)')
    console.log('   spans  :', out.setup?.spans ? out.setup.spans.candidates.map(c => c.id).join(',') : '-',
                '| entries:', out.setup?.entries ? out.setup.entries.trades.map(t => `${t.id}(${t.semantics},${t.options.length})`).join(',') : '-')
    console.log('   qty    :', out.setup?.scenarios?.map(s => s.quantity).join(',') || '-',
                '| money:', out.setup?.summary ? `+${out.setup.summary.gainCash}/-${out.setup.summary.lossCash}` : '-',
                '| ready:', out.readiness?.ready ?? false)
    console.log('   charts :', charts)
    console.log('   reply  :', out.reply.replace(/\n+/g, ' ').slice(0, 320))
    state.messages = [...state.messages, { role: 'assistant', content: out.reply }]
    state.chat = { active_asset: out.setup?.asset ?? state.chat.active_asset, draft: out.setup ?? state.chat.draft, coverage: out.coverage ?? [] }
    return out
}

await say('I want to build a swing trade on NVDA', 'TURN 1 — the name')
await say('Yes, those are right. Stop at the checkpoints.', 'TURN 2 — confirm (prose)')
await say('Build the first one.', 'TURN 3 — pick a trade')
await say('Take your own pick for the entry.', 'TURN 4 — pick a way in')
await say('Risk 1% of the account.', 'TURN 5 — size it')
process.exit(0)
