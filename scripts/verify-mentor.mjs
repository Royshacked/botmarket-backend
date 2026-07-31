/**
 * Mentor + Talos live verification — no UI, no server, no auth.
 *
 * The agent is a plain service, so this drives it directly: a real multi-turn conversation
 * against the real model with the real market tools, then runs whatever Mentor produced through
 * the `setup` contract and Talos's zone gate at the LIVE price.
 *
 *   node scripts/verify-mentor.mjs                 # BTC (crypto trades 24/7 — works any day)
 *   node scripts/verify-mentor.mjs --ticker NVDA   # any ticker; equities need market data
 *   node scripts/verify-mentor.mjs --persist       # also write to Mongo, arm it, run one tick
 *
 * Needs ANTHROPIC_API_KEY in .env. --persist additionally needs Mongo up.
 *
 * This is a DIAGNOSTIC, not a pass/fail gate: it prints what Mentor actually authored so the
 * prompt can be judged against real output. Contract violations are reported as WARN/FAIL lines
 * but the run continues, because the point is to see the whole picture in one go.
 */
import dotenv from 'dotenv'
dotenv.config()

// App modules are imported DYNAMICALLY, below, on purpose: ESM hoists every static `import` above
// module-level code, so a static import here would construct the Anthropic client (and its
// apiKey) before dotenv.config() had run — "Could not resolve authentication method".
const { mentorAgentService, emptyMentorState } = await import('../services/mentor.agent.service.js')
const { normalizeSetup, setupReadiness, computeRR, buildLadder, buildCadence, validityProblems } = await import('../services/setup.schema.js')
const { zoneGate, proximityGapMin, zoneDistance } = await import('../monitoring/talos.monitor.service.js')
const { fetchLastPrice } = await import('../monitoring/monitorUtils.js')

const args   = process.argv.slice(2)
const argOf  = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
// NVDA by default: equity history is reliable even at the weekend (a Sunday quote returns Friday's
// close, which is all the zone gate needs). BTC is the 24/7 option but its aggregates rate-limit.
const TICKER = String(argOf('--ticker', 'NVDA')).toUpperCase()
const PERSIST = args.includes('--persist')
const VERIFY_USER = 'mentor-verify-user'

const fmtZones = (zs) => zs?.length ? zs.map(z => (z.lower === z.upper ? `${z.lower}` : `${z.lower}–${z.upper}`)).join(' / ') : '—'

// A placeholder account for the CHAT turns, so the readiness gate can reach green without a broker
// connection. --persist replaces it with a REAL paper account from the store (an invented id
// resolves to an empty order plan).
const ACCOUNTS = [{ id: 'paper-chat-stub', broker: 'paper', name: 'Paper (verify)', balance: 100000, currency: 'USD' }]

const C = { dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', bold: '\x1b[1m', off: '\x1b[0m' }
const findings = []
const ok   = (m) => { console.log(`${C.green}  ✓${C.off} ${m}`) }
const warn = (m) => { findings.push(['WARN', m]); console.log(`${C.yellow}  ! ${m}${C.off}`) }
const fail = (m) => { findings.push(['FAIL', m]); console.log(`${C.red}  ✗ ${m}${C.off}`) }
const head = (m) => console.log(`\n${C.bold}${C.cyan}── ${m} ${'─'.repeat(Math.max(0, 62 - m.length))}${C.off}`)

// The conversation. Deliberately shaped to exercise the three things the prompt claims:
// the nucleus, the no-setup candidate offer, and the pick collapsing into one worksheet.
const TURNS = [
    `I want to go long ${TICKER} as a swing trade over the next couple of weeks. What do you make of it?`,
    `I don't have a setup in mind — build me a couple of options and I'll pick one.`,
    `Let's go with the first one. Size it for a $500 risk.`,
]

async function runTurn(prompt, chatState, history, n) {
    head(`Turn ${n}: "${prompt.slice(0, 58)}${prompt.length > 58 ? '…' : ''}"`)
    let streamed = ''
    let asset = null
    const tools = []

    const res = await mentorAgentService.chatStream({
        // The real client posts the running transcript, NOT just the latest prompt — without it
        // every turn starts blind and the agent re-asks for the ticker.
        messages:   [...history, { role: 'user', content: prompt }],
        userPrompt: prompt,
        chatState,
        accounts: ACCOUNTS,
        mainAccountId: 'paper-chat-stub',
        clientTime: { clientNow: Date.now(), clientTz: 'Asia/Jerusalem' },
        userId: null,                       // no usage accounting in a script run
        onToken:     (t) => { streamed += t; process.stdout.write(C.dim + t + C.off) },
        onAsset:     (a) => { asset = a },  // the client mirrors this into chatState.active_asset
        onToolStart: (t) => tools.push(typeof t === 'string' ? t : t?.name ?? '?'),
        onCoverage:  () => {},
    })

    console.log(`\n${C.dim}   tools (${tools.length}): ${tools.length ? tools.join(', ') : '(none)'}${C.off}`)
    console.log(`${C.dim}   asset tag: ${asset || '—'}   coverage: [${(res.coverage ?? []).join(', ') || '—'}]${C.off}`)
    if (!streamed.trim()) warn('turn produced no visible prose (everything may have been swallowed as a tag)')
    if (tools.length > 14) warn(`turn made ${tools.length} tool calls — expensive for one reply`)
    return { ...res, asset, streamed }
}

// ── Contract checks on what Mentor authored ───────────────────────────────────

function checkSetup(setup, price) {
    head('Setup contract')
    console.log(JSON.stringify(setup, null, 2))
    console.log('')

    // Nucleus
    setup.asset      ? ok(`asset ${setup.asset}`)            : fail('no asset')
    setup.direction  ? ok(`direction ${setup.direction}`)    : fail('no direction')
    setup.type       ? ok(`horizon ${setup.type}`)           : fail('no horizon')
    setup.timeframe  ? ok(`timeframe ${setup.timeframe}`)    : warn('no timeframe — the ladder fell back to a default')
    setup.thesis?.length > 20 ? ok('thesis is written out')  : warn('thesis is thin or missing')

    // The lens must be named, never blended.
    ;['classical', 'smc'].includes(setup.trade_mode)
        ? ok(`lens ${setup.trade_mode}`)
        : fail(`lens is "${setup.trade_mode}" — must be classical or smc`)

    // conditions[] — the monitor's instruction sheet, and the whole quality tradeoff of the kind.
    const conditions = setup.conditions ?? []
    const n = conditions.length
    if (n === 0)      fail('conditions[] is EMPTY — the monitor has nothing to verify against the thesis')
    else if (n > 4)   warn(`conditions[] declares ${n} — over-declaring pays for a look at every one on EVERY wake`)
    else              ok(`conditions[] declares ${n}`)

    const ids = conditions.map(c => c.id)
    new Set(ids).size === ids.length
        ? ok(`ids are unique (${ids.join(', ')})`)
        : fail(`duplicate condition ids ${ids.join(', ')} — the latch would attach a finding to the wrong condition`)

    for (const c of conditions) {
        if (!c.text || c.text.length < 15) warn(`condition ${c.id} is too vague to verify: "${c.text}"`)
        // The checkability gate is Mentor's, and this is the only signal we have that it ran.
        if (!['measured', 'discretionary'].includes(c.mode)) {
            warn(`condition ${c.id} carries no mode — Mentor never settled whether it is a named test or handed-over judgment`)
        }
        if (c.persistence === 'latching' && c.weight === 'primary') {
            warn(`condition ${c.id} is a latching PRIMARY — once met the trigger is permanently satisfied; check that is intended`)
        }
    }

    conditions.some(c => c.weight === 'primary')
        ? ok('a primary (trigger) condition is named')
        : warn('nothing is marked primary — the monitor has no trigger, only confirmations')

    // Referenced symbols must cover any name the conditions mention, or the monitor can't look.
    const refs = setup.referenced_symbols ?? []
    refs.length ? ok(`referenced_symbols ${refs.join(', ')}`) : ok('no referenced symbols (own asset only)')

    // validity — the second arithmetic gate, and the only thing that speaks when price is far away.
    head('Validity range')
    if (!setup.validity) {
        warn('no validity range — Talos can only ever say "price is outside my zones", never "this is dead"')
    } else {
        const v = setup.validity
        ok(`range [${v.lower ?? '-'}, ${v.upper ?? '-'}] · away pivot ${v.approach ?? '-'} · on_break ${v.on_break} · ${v.timeframe ?? 'no rung'} close`)
        const problems = validityProblems(setup)
        problems.length ? problems.forEach(p => fail(`validity: ${p}`)) : ok('range is coherent with the stop')
        if (!v.timeframe) warn('no timeframe on the range — which close decides is undefined, so a wick could kill the setup')
    }

    // Zones
    head('Zones')
    const groups = [['entry', setup.entry_zones], ['stop', setup.stop_zones], ['tp', setup.tp_zones]]
    for (const [label, zones] of groups) {
        if (!zones.length) { (label === 'tp' ? warn : fail)(`no ${label} zone`); continue }
        for (const z of zones) {
            const width = z.upper - z.lower
            const pct   = price ? (width / price) * 100 : null
            const size  = pct == null ? '' : ` (${pct.toFixed(2)}% of price)`
            console.log(`   ${label} ${z.id}: ${z.lower} – ${z.upper}${size} qty=${z.quantity ?? '—'}`)
            if (width === 0) warn(`${label} ${z.id} is a zero-width band — an exact level, not a zone`)
            if (pct != null && pct > 6)    warn(`${label} ${z.id} spans ${pct.toFixed(1)}% of price — implausibly wide`)
            if (pct != null && pct > 0 && pct < 0.02) warn(`${label} ${z.id} spans ${pct.toFixed(3)}% — too tight to ever fill`)
            if (label === 'entry' && !z.quantity) fail(`entry ${z.id} has no quantity — the setup can't be sized`)
        }
    }

    // Derived fields must be the server's, not the model's.
    head('Derived fields')
    JSON.stringify(setup.ladder) === JSON.stringify(buildLadder(setup.timeframe))
        ? ok(`ladder ${setup.ladder.join(' → ')}`)
        : fail('ladder does not match the derivation — the model authored it')
    JSON.stringify(setup.cadence) === JSON.stringify(buildCadence(setup.type))
        ? ok(`cadence ${setup.cadence.min}–${setup.cadence.max} min`)
        : fail('cadence does not match the derivation')

    const rr = computeRR(setup)
    if (rr == null) warn('rr could not be computed (a leg is missing, or entry sits inside the stop)')
    else if (rr < 1.5) warn(`rr ${rr} is thin — the prompt says to push back below ~1.5R`)
    else ok(`rr ${rr} (from the worst entry edge)`)

    setup.conviction?.level ? ok(`conviction ${setup.conviction.level} — "${setup.conviction.rationale ?? ''}"`) : warn('no conviction set')

    const { ready, missing } = setupReadiness(setup, true)
    ready ? ok('READY to generate') : warn(`not ready — missing: ${missing.join(', ')}`)
    return ready
}

// ── Talos's gate at the live price ────────────────────────────────────────────

function checkGate(setup, price) {
    head('Talos zone gate (live price)')
    if (!Number.isFinite(price)) { fail('no live price — the gate can never trip'); return }

    console.log(`   live ${setup.asset} = ${price}`)
    const hit  = zoneGate(setup.entry_zones, price)
    const dist = zoneDistance(setup.entry_zones, price)
    const gap  = proximityGapMin(setup, price)

    console.log(`   distance to nearest zone: ${dist?.toFixed(2)} zone-widths`)
    console.log(`   next check in: ${gap} min  (cadence ${setup.cadence.min}–${setup.cadence.max})`)

    if (hit) ok(`price is INSIDE ${hit.id} — this would trigger an assessment + confirm card right now`)
    else     ok(`price is outside every zone — the cheap gate holds, no LLM spend this wake`)

    // The zone must be reachable: an entry the market has to travel to is fine, one it has
    // already blown past by a mile is a setup that will never fire.
    if (dist != null && dist > 40) warn(`price is ${dist.toFixed(0)} zone-widths away — this may never trigger`)
}

// ── Optional: the persist path + one real tick ────────────────────────────────

async function checkPersist(setup) {
    head('Persist + arm + one tick (--persist)')
    const { setupService }      = await import('../api/setups/setups.service.js')
    const { _checkSetup, _testDeps } = await import('../monitoring/talos.monitor.service.js')
    const { paperBrokerService } = await import('../api/broker/paperBroker.service.js')

    // A REAL paper account in the store. The order-plan builder resolves account ids against the
    // paper store, so an invented id silently yields an empty plan ("no placeable accounts") and
    // the money path goes untested — which is exactly what happened on the first --persist run.
    const acct = await paperBrokerService.createAccount(VERIFY_USER, { mode: 'paper', name: 'verify', startingBalance: 100000 })
    const acctId = acct.accountId
    ok(`paper account ${acctId} created`)
    const accounts = [{ id: acctId, broker: 'paper', name: 'verify', balance: 100000, currency: 'USD' }]

    const gen = await setupService.generateSetup(setup, { userId: VERIFY_USER, accounts, mainAccountId: acctId })
    if (!gen.ok) { fail(`generate rejected: ${gen.reason}`); return }
    ok(`generated ${gen.setup.id} — status ${gen.setup.status}, mode ${gen.setup.mode}, broker ${gen.setup.broker}`)
    gen.setup.event_risk?.length
        ? ok(`event_risk stamped: ${gen.setup.event_risk.map(e => `${e.date} ${e.label}`).join(' · ')}`)
        : ok('event_risk stamped: none in the next ~10 days')

    const armed = await setupService.patchSetup(gen.setup.id, { status: 'looking' }, VERIFY_USER)
    armed.ok ? ok('armed → looking') : fail(`arm refused: ${armed.reason}`)
    if (!armed.ok) return

    // The assessment and the card are stubbed — we're verifying the gate and the EXECUTION
    // handoff here, not spending an LLM call or posting into the user's chat. The order plan is
    // the real one.
    let carded = null
    // NOT stubbed: the real plan builder, resolving the paper account for real.
    const { buildOrderPlanForIdea } = await import('../services/orderPlan.service.js')
    // Spread the real deps and override only what this harness fakes, so anything the monitor grows
    // later (today: `persist`, which must stay REAL here — writing Mongo is the point of --persist)
    // keeps working without another edit. Overriding key-by-key silently dropped new deps.
    const tickDeps = (priceFn) => ({
        ..._testDeps,
        isAssetOpen: () => true,
        nextOpenMs:  () => Date.now() + 3600_000,
        getPrice:    priceFn,
        assess:      async () => ({ verdict: 'wait', read: '(stubbed) not convinced', warning: 'Stubbed warning — the card must fire anyway.', next_check_min: 30 }),
        onCard:       async (_s, a) => { carded = a },
        onManualCard: async () => {},
        buildOrderPlan: buildOrderPlanForIdea,
    })

    // Tick 1 — the real live price. Almost certainly outside the zone; proves the cheap path.
    const real = await _checkSetup(armed.setup, Date.now(), tickDeps(() => fetchLastPrice(setup.asset)))
    ok(`tick @ live price → ${real.reason}${real.fired ? ` (FIRED, orderState=${real.orderState})` : ''}`)

    // Tick 2 — force price into the first entry zone so the EXECUTION handoff actually runs.
    // Without this the money-adjacent path (order plan + orderState + card) stays untested.
    const z = setup.entry_zones[0]
    const inZone = (z.lower + z.upper) / 2
    head(`Forced trigger @ ${inZone} (inside ${z.id})`)
    const fired = await _checkSetup(armed.setup, Date.now(), tickDeps(async () => inZone))

    fired.fired ? ok(`triggered on ${z.id}`) : fail(`price inside ${z.id} did not trigger`)
    fired.orderState === 'awaiting_confirm'
        ? ok(`orderState ${fired.orderState}`)
        : fail(`orderState is ${fired.orderState} — a 'hit' with no plan dead-ends at the dialog`)
    carded ? ok(`card fired on a "${carded.verdict}" verdict — warning: "${carded.warning}"`) : fail('no confirm card')
    if (carded && !carded.warning) fail('a non-enter verdict produced no warning')

    // Read it back: this is what the confirm dialog would actually receive.
    const after = await setupService.getSetup(gen.setup.id, VERIFY_USER)
    console.log(`   status=${after.status} orderState=${after.orderState} armed_zone=${after.armed_zone_id}`)
    console.log(`   pendingOrder.plan: ${JSON.stringify(after.pendingOrder?.plan ?? null)}`)
    after.pendingOrder?.plan?.length
        ? ok('a placeable order plan is persisted')
        : fail('no pendingOrder.plan persisted — nothing for the confirm dialog to place')
    console.log(`   timeline: ${(after.monitor_state?.timeline ?? []).map(t => t.kind).join(' → ')}`)
    console.log(`   memo: ${after.monitor_state?.memo ?? '(none)'}`)

    await setupService.deleteSetup(gen.setup.id, VERIFY_USER)
    await paperBrokerService.deleteAccount(VERIFY_USER, acctId).catch(() => {})
    ok('cleaned up (setup + paper account)')
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY missing from .env'); process.exit(1) }

    console.log(`${C.bold}Mentor live verification — ${TICKER}${C.off}`)
    console.log(`${C.dim}${new Date().toString()}${C.off}`)

    let chatState = emptyMentorState()
    const history = []
    let last = null

    for (const [i, prompt] of TURNS.entries()) {
        last = await runTurn(prompt, chatState, history, i + 1)

        history.push({ role: 'user', content: prompt })
        if (last.streamed?.trim()) history.push({ role: 'assistant', content: last.streamed.trim() })

        // Carry state forward exactly as the client would: the asset tag drives active_asset, and
        // a picked candidate becomes the live worksheet.
        chatState = {
            active_asset: last.setup?.asset ?? last.asset ?? chatState.active_asset,
            draft:        last.setup ?? chatState.draft,
            coverage:     last.coverage ?? chatState.coverage,
        }

        if (last.setups) {
            head(`Candidate offer — ${last.setups.candidates.length} option(s)`)
            for (const c of last.setups.candidates) {
                const s = c.setup
                console.log(`   • ${C.bold}${c.label}${C.off} [${s.trade_mode}] ${s.asset} ${s.direction} rr=${s.rr ?? '—'}`)
                console.log(`     ${C.dim}${c.pitch}${C.off}`)
                console.log(`     ${C.dim}entry ${fmtZones(s.entry_zones)} · stop ${fmtZones(s.stop_zones)} · tp ${fmtZones(s.tp_zones)}${C.off}`)
                console.log(`     ${C.dim}conditions: ${(s.conditions ?? []).map(c => `${c.text} (${c.weight})`).join(' · ') || '(none)'}${C.off}`)
            }
            last.setups.candidates.length >= 2
                ? ok('offered multiple candidates')
                : warn('only one candidate offered — the prompt asks for 2–3 differing in character')
            const modes = new Set(last.setups.candidates.map(c => c.setup.trade_mode))
            const dirs  = new Set(last.setups.candidates.map(c => `${c.setup.direction}|${JSON.stringify(c.setup.entry_zones?.[0])}`))
            if (dirs.size === 1) warn('candidates share the same entry — they should differ in CHARACTER, not just wording')
            else ok(`candidates differ (${modes.size} lens/es, ${dirs.size} distinct entries)`)

            // The agent stays on the ticker the user brought — it must never go hunting for names.
            const offTicker = last.setups.candidates.filter(c => c.setup.asset !== TICKER).map(c => c.setup.asset)
            if (offTicker.length) fail(`candidates are for ${[...new Set(offTicker)].join('/')}, not ${TICKER} — Mentor SCREENED for names, which Pipeline F forbids`)
            else ok(`all candidates stay on ${TICKER}`)

            // The pick must be resolvable next turn; the client collapses it into the worksheet.
            chatState.candidates = last.setups.candidates
        }
    }

    const setup = chatState.draft ? normalizeSetup(chatState.draft) : null
    if (!setup) { fail('no <setup> was ever emitted — nothing to verify'); return summary() }

    const price = await fetchLastPrice(setup.asset).catch(() => null)
    checkSetup(setup, price)
    checkGate(setup, price)
    if (PERSIST) await checkPersist(setup)

    summary()
}

function summary() {
    head('Summary')
    if (!findings.length) { console.log(`${C.green}  No findings — Mentor's output matches the contract.${C.off}`); return }
    for (const [level, msg] of findings) {
        const c = level === 'FAIL' ? C.red : C.yellow
        console.log(`${c}  ${level}  ${msg}${C.off}`)
    }
    console.log(`\n  ${findings.filter(f => f[0] === 'FAIL').length} fail · ${findings.filter(f => f[0] === 'WARN').length} warn`)
}

main().then(() => process.exit(0)).catch(err => { console.error('\nverify crashed:', err); process.exit(1) })
