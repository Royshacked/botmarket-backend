/**
 * Axl routing live verification — the BRIEF / SHOW / ROUTE three-way split.
 *
 * The one that matters: **"read the market" must produce the MARKET BRIEF, not route to Pythia.**
 * It asks what the world is doing, not what we think about it — and the phrasing sounds exactly like
 * a strategy desk, which is why it is checked against the real model rather than only asserted in
 * the prompt.
 *
 *   node scripts/verify-axl-routing.mjs
 *
 * Needs ANTHROPIC_API_KEY (+ the data keys the brief reads). Read-only: nothing is written.
 */
import dotenv from 'dotenv'
dotenv.config()

const { axlAgentService } = await import('../services/axl.agent.service.js')

// ask → what MUST happen. `tool` is required, `route` is asserted exactly (null = must not route).
const CASES = [
    { ask: 'read the market',                 tool: 'get_market_brief', route: null,
      why: 'the tape, not our opinion of it — the collision this file exists for' },
    { ask: 'how are markets doing today?',    tool: 'get_market_brief', route: null,
      why: 'plain brief phrasing' },
    { ask: 'what is our sector view?',        tool: 'get_sector_view',  route: null,
      why: 'SHOW a published view — reading is Axl’s half of the line' },
    { ask: 'are we overweight tech?',         tool: 'get_sector_view',  route: null,
      why: 'a question about the view, not a request to change it' },
    // The regression: Axl SHOWED the view and then routed to Pythia anyway. "Report the facts, then
    // route" is about a question the facts opened up, not about the desk that owns what was read.
    { ask: 'can you show me the forecast?',   tool: 'get_sector_view',  route: null,
      why: 'showing is the WHOLE answer — a read turn must not route' },
    { ask: 'show me the sector tilts',        tool: 'get_sector_view',  route: null,
      why: '"show me" is a read, not a request to go anywhere' },
    { ask: 'i want to set a new house view',  tool: null,               route: 'strategy',
      why: 'AUTHORING belongs to Pythia' },
    { ask: 'update the sector tilts please',  tool: null,               route: 'strategy',
      why: 'changing an existing view is still authoring' },
]

let failed = 0
console.log('\nAXL ROUTING — brief vs show vs route\n' + '─'.repeat(78))

for (const c of CASES) {
    const tools = []
    let res
    try {
        res = await axlAgentService.chatStream({
            messages: [{ role: 'user', content: c.ask }], userId: 'verify-script',
            onToolStart: (t) => tools.push(t),
        })
    } catch (err) {
        console.log(`\n✗ "${c.ask}" — THREW: ${err.message}`)
        failed++
        continue
    }

    const route  = res.route ?? null
    const okTool = c.tool ? tools.includes(c.tool) : true
    const okRoute = route === c.route
    const ok = okTool && okRoute
    if (!ok) failed++

    console.log(`\n${ok ? '✓' : '✗'} "${c.ask}"   (${c.why})`)
    console.log(`    tools : ${tools.join(', ') || '(none)'}${c.tool && !okTool ? `   ← expected ${c.tool}` : ''}`)
    console.log(`    route : ${route ?? '(none)'}${okRoute ? '' : `   ← expected ${c.route ?? '(none)'}`}`)
    console.log(`    reply : ${String(res.reply || '').replace(/\s+/g, ' ').slice(0, 110)}`)
}

console.log('\n' + '─'.repeat(78))
console.log(failed ? `\n${failed}/${CASES.length} FAILED\n` : `\nAll ${CASES.length} routed correctly\n`)
process.exit(failed ? 1 : 0)
