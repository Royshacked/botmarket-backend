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
const { mentorAgentService, emptyMentorState } = await import('../services/agents/mentor.agent.service.js')
const { normalizeSetup, setupReadiness, computeRR, buildLadder, buildCadence, validityProblems,
    scenarioLabel, scenarioView, declaredConditions } = await import('../services/setup.schema.js')
const { scenarioGate, liveEntryZones, proximityGapMin, zoneDistance } = await import('../monitoring/talos.monitor.service.js')
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
    // A fourth turn, because turn 3 legitimately does not always end in a worksheet: told to size a
    // thin plan, Mentor is supposed to push back rather than ship it, which leaves the conversation
    // on a question. This answers it AND exercises the rival-premise path — two scenarios, each with
    // its own stop, targets and death line, which is where the projection has to pick a winner.
    `Build both as rival scenarios, each with its own stop and targets, and finish the setup.`,
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

    // conditions — the monitor's instruction sheet, and the whole quality tradeoff of the kind.
    // TWO TIERS: the setup-wide list plus each premise's own. A wake judges root ∪ the armed
    // scenario's, so both are checked here and ids must be unique across the WHOLE document.
    const scenarios = setup.scenarios ?? []
    const everyCond = [...(setup.conditions ?? []), ...scenarios.flatMap(sc => sc.conditions ?? [])]
    const n = everyCond.length
    if (n === 0)      fail('no conditions anywhere — the monitor has nothing to verify against the thesis')
    else if (n > 6)   warn(`${n} conditions declared — over-declaring pays for a look at every one on EVERY wake`)
    else              ok(`${n} condition(s): ${setup.conditions?.length ?? 0} setup-wide + ${n - (setup.conditions?.length ?? 0)} across ${scenarios.length} scenario(s)`)

    const ids = everyCond.map(c => c.id)
    new Set(ids).size === ids.length
        ? ok(`ids are unique document-wide (${ids.join(', ')})`)
        : fail(`duplicate condition ids ${ids.join(', ')} — ONE ledger keys off these, so a finding would answer for the wrong condition`)

    for (const c of everyCond) {
        if (!c.text || c.text.length < 15) warn(`condition ${c.id} is too vague to verify: "${c.text}"`)
        // The checkability gate is Mentor's, and this is the only signal we have that it ran.
        if (!['measured', 'discretionary'].includes(c.mode)) {
            warn(`condition ${c.id} carries no mode — Mentor never settled whether it is a named test or handed-over judgment`)
        }
        if (c.persistence === 'latching' && c.weight === 'primary') {
            warn(`condition ${c.id} is a latching PRIMARY — once met the trigger is permanently satisfied; check that is intended`)
        }
    }

    // Referenced symbols must cover any name the conditions mention, or the monitor can't look.
    const refs = setup.referenced_symbols ?? []
    refs.length ? ok(`referenced_symbols ${refs.join(', ')}`) : ok('no referenced symbols (own asset only)')

    // ── Scenarios: one block per way in, each owning its legs, conditions and death line ──
    head(`Scenarios — ${scenarios.length} way(s) in`)
    if (!scenarios.length) fail('no scenarios — a setup with no premise is not a plan')

    let sumQty = 0
    for (const [i, sc] of scenarios.entries()) {
        const label = scenarioLabel(sc)
        console.log(`\n   ${C.bold}${i + 1}. ${label}${C.off}${sc.name ? '' : `${C.dim} (unnamed — cards will say "${sc.id}")${C.off}`}`)
        if (!sc.name) warn(`scenario ${sc.id} has no name — the monitor's cards name the premise that fired`)

        // Legs. ONE entry per premise: it takes the whole position, and two entries would be
        // scaling in, which execution can't do yet.
        for (const [key, gLabel] of [['entry_zones', 'entry'], ['stop_zones', 'stop'], ['tp_zones', 'tp']]) {
            const zones = sc[key] ?? []
            if (!zones.length) { (key === 'tp_zones' ? warn : fail)(`${label}: no ${gLabel} zone`); continue }
            if (key === 'entry_zones' && zones.length > 1) fail(`${label}: ${zones.length} entry zones — that is scaling in; two premises are two scenarios`)
            for (const z of zones) {
                const width = z.upper - z.lower
                const pct   = price ? (width / price) * 100 : null
                const size  = pct == null ? '' : ` (${pct.toFixed(2)}% of price)`
                console.log(`      ${gLabel} ${z.id}: ${z.lower} – ${z.upper}${size} qty=${z.quantity ?? '—'}`)
                if (width === 0) warn(`${label}: ${gLabel} ${z.id} is a zero-width band — an exact level, not a zone`)
                if (pct != null && pct > 6)    warn(`${label}: ${gLabel} ${z.id} spans ${pct.toFixed(1)}% of price — implausibly wide`)
                if (pct != null && pct > 0 && pct < 0.02) warn(`${label}: ${gLabel} ${z.id} spans ${pct.toFixed(3)}% — too tight to ever fill`)
                if (key === 'entry_zones' && !z.quantity) fail(`${label}: entry ${z.id} has no quantity — this premise can't be sized`)
            }
        }
        sumQty += Number(sc.quantity) || 0

        // A premise with nothing to check arms blind — unless the setup-wide tier carries it.
        const declared = declaredConditions(setup, sc)
        declared.some(c => c.weight === 'primary')
            ? ok(`${label}: a primary trigger is named`)
            : warn(`${label}: nothing marked primary — the monitor has confirmations but no trigger`)
        console.log(`      ${C.dim}judges: ${declared.map(c => `${c.id} ${c.text}`).join(' · ') || '(nothing)'}${C.off}`)

        // Its own death line, checked against its OWN stop.
        if (!sc.validity) {
            warn(`${label}: no validity range — Talos can only ever say "price is outside my zones", never "this is dead"`)
        } else {
            const v = sc.validity
            ok(`${label}: valid [${v.lower ?? '-'}, ${v.upper ?? '-'}] · away ${v.approach ?? '-'} · on_break ${v.on_break} · ${v.timeframe ?? 'no rung'} close`)
            if (!v.timeframe) warn(`${label}: no timeframe on the range — which close decides is undefined, so a wick could kill it`)
        }

        const scRR = computeRR(scenarioView(setup, sc))
        if (scRR == null)     warn(`${label}: rr could not be computed (a leg is missing, or entry sits inside the stop)`)
        else if (scRR < 1.5)  warn(`${label}: rr ${scRR} is thin — the prompt says to push back below ~1.5R`)
        else                  ok(`${label}: rr ${scRR} (worst entry edge), size ${sc.quantity ?? '—'}`)
    }

    // Coherence is per premise, and the message names which one.
    const problems = validityProblems(setup)
    problems.length ? problems.forEach(p => fail(`validity: ${p}`)) : ok('every range is coherent with its own stop')

    // THE bug this shape exists to kill: rivals are not legs, so their sizes are never added.
    if (scenarios.length > 1) {
        setup.quantity !== sumQty
            ? ok(`document size ${setup.quantity} is ONE premise's, not the ${sumQty} sum — rivals never add`)
            : fail(`document size ${setup.quantity} equals the SUM of every scenario — the double-count is back`)
    }

    head('Execution projection')
    const projected = scenarios[0]
    JSON.stringify(setup.entry_zones) === JSON.stringify(projected?.entry_zones ?? [])
        ? ok(`flat zones project ${scenarioLabel(projected)} — what execution will actually place pre-arm`)
        : fail('the flat zones match no scenario — execution would place something nobody authored')

    // Derived fields must be the server's, not the model's.
    head('Derived fields')
    JSON.stringify(setup.ladder) === JSON.stringify(buildLadder(setup.timeframe))
        ? ok(`ladder ${setup.ladder.join(' → ')}`)
        : fail('ladder does not match the derivation — the model authored it')
    JSON.stringify(setup.cadence) === JSON.stringify(buildCadence(setup.type))
        ? ok(`cadence ${setup.cadence.min}–${setup.cadence.max} min`)
        : fail('cadence does not match the derivation')

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
    // Across every LIVE premise — the gate answers which one price reached, not merely that it did.
    const hit  = scenarioGate(setup, price)
    const dist = zoneDistance(liveEntryZones(setup), price)
    const gap  = proximityGapMin(setup, price)

    console.log(`   distance to the nearest premise: ${dist?.toFixed(2)} zone-widths`)
    console.log(`   next check in: ${gap} min  (cadence ${setup.cadence.min}–${setup.cadence.max})`)

    if (hit) ok(`price is INSIDE ${scenarioLabel(hit.scenario)} (${hit.zone.id}) — this would trigger an assessment + confirm card right now`)
    else     ok('price is outside every premise\'s zone — the cheap gate holds, no LLM spend this wake')

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

    // Cleanup runs in a `finally`: every early return here (generate refused, arm refused) and any
    // throw used to leak a real paper account — and a real setup — into the developer's Mongo.
    const trash = { setupId: null, acctId: null }
    try {
        await persistRun(setup, { setupService, _checkSetup, _testDeps, paperBrokerService, trash })
    } finally {
        if (trash.setupId) await setupService.deleteSetup(trash.setupId, VERIFY_USER).catch(() => {})
        if (trash.acctId)  await paperBrokerService.deleteAccount(VERIFY_USER, trash.acctId).catch(() => {})
        if (trash.setupId || trash.acctId) ok('cleaned up (setup + paper account)')
    }
}

async function persistRun(setup, { setupService, _checkSetup, _testDeps, paperBrokerService, trash }) {

    // A REAL paper account in the store. The order-plan builder resolves account ids against the
    // paper store, so an invented id silently yields an empty plan ("no placeable accounts") and
    // the money path goes untested — which is exactly what happened on the first --persist run.
    const acct = await paperBrokerService.createAccount(VERIFY_USER, { mode: 'paper', name: 'verify', startingBalance: 100000 })
    const acctId = acct.accountId
    trash.acctId = acctId
    ok(`paper account ${acctId} created`)
    const accounts = [{ id: acctId, broker: 'paper', name: 'verify', balance: 100000, currency: 'USD' }]

    const gen = await setupService.generateSetup(setup, { userId: VERIFY_USER, accounts, mainAccountId: acctId })
    if (!gen.ok) { fail(`generate rejected: ${gen.reason}`); return }
    // `{ ok, doc }` — the ONE shape every service in api/ answers in since the entity-CRUD refactor.
    // This script still read `.setup` and crashed on the first run that got far enough to find out.
    const saved = gen.doc
    trash.setupId = saved.id
    ok(`generated ${saved.id} — status ${saved.status}, mode ${saved.mode}, broker ${saved.broker}`)
    saved.event_risk?.length
        ? ok(`event_risk stamped: ${saved.event_risk.map(e => `${e.date} ${e.label}`).join(' · ')}`)
        : ok('event_risk stamped: none in the next ~10 days')

    const armed = await setupService.patchSetup(saved.id, { status: 'looking' }, VERIFY_USER)
    armed.ok ? ok('armed → looking') : fail(`arm refused: ${armed.reason}`)
    if (!armed.ok) return

    // The assessment and the card are stubbed — we're verifying the gate and the EXECUTION
    // handoff here, not spending an LLM call or posting into the user's chat. The order plan is
    // the real one.
    let carded = null
    // The assessment's VERDICT is the second gate, so the harness drives it explicitly rather than
    // hard-coding one answer. A zone trip is not an entry: only `enter` asks the user to confirm.
    let verdict = 'wait'
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
        // `next_timeframe` is the only pacing field: the rung the read asks to open on next sets the
        // gap, clamped to the setup's cadence. An off-ladder value falls back to the eager floor.
        assess:      async () => ({ verdict, read: `(stubbed) ${verdict}`, warning: verdict === 'enter' ? null : 'Stubbed objection.', next_timeframe: setup.timeframe }),
        onCard:       async (_s, a) => { carded = a },
        onManualCard: async () => {},
        buildOrderPlan: buildOrderPlanForIdea,
    })

    // Tick 1 — the real live price. Almost certainly outside the zone; proves the cheap path.
    const real = await _checkSetup(armed.doc, Date.now(), tickDeps(() => fetchLastPrice(setup.asset)))
    ok(`tick @ live price → ${real.reason}${real.fired ? ` (FIRED, orderState=${real.orderState})` : ''}`)

    // Tick 2 — force price into the LAST premise's entry zone so the EXECUTION handoff runs AND the
    // projection is proved: with rivals, the zone that fires is deliberately not the one the
    // document was projecting, so the order plan must come back with that premise's size and stop.
    const target = saved.scenarios?.[saved.scenarios.length - 1]
    const z = target?.entry_zones?.[0] ?? setup.entry_zones[0]
    const inZone = (z.lower + z.upper) / 2

    // THE SECOND GATE. A zone trip only says price is WHERE the setup lives; whether the setup is
    // FULFILLED is what the conditions are for. So a `wait` in the zone must keep watching and post
    // NOTHING — asking the user to confirm an entry Talos just declined is the one thing this gate
    // exists to prevent.
    head(`In zone @ ${inZone} on a "wait" verdict (inside ${scenarioLabel(target)} / ${z.id})`)
    const held = await _checkSetup(armed.doc, Date.now(), tickDeps(async () => inZone))
    held.watching ? ok('stayed looking — the zone alone is not an entry') : fail(`a "wait" in the zone returned ${JSON.stringify(held)}`)
    carded ? fail('a declined setup posted a confirm card') : ok('no card on a declined setup')

    // Now the setup actually fulfils, and the EXECUTION handoff runs for real.
    verdict = 'enter'
    head(`Forced trigger @ ${inZone} on an "enter" verdict`)
    const fired = await _checkSetup(armed.doc, Date.now(), tickDeps(async () => inZone))

    fired.fired ? ok(`triggered on ${z.id}`) : fail(`price inside ${z.id} did not trigger`)
    fired.orderState === 'awaiting_confirm'
        ? ok(`orderState ${fired.orderState}`)
        : fail(`orderState is ${fired.orderState} — a 'hit' with no plan dead-ends at the dialog`)
    carded ? ok(`confirm card fired on "${carded.verdict}"`) : fail('no confirm card')
    if (carded?.warning) fail(`an "enter" carried a warning ("${carded.warning}") — a hedged confirm is what the gate prevents`)

    // Read it back: this is what the confirm dialog would actually receive.
    const read = await setupService.getSetup(saved.id, VERIFY_USER)
    const after = read.doc ?? read
    console.log(`   status=${after.status} orderState=${after.orderState} armed_zone=${after.armed_zone_id} armed_scenario=${after.armed_scenario_id}`)
    // The projection must have MOVED to the premise that fired, or execution places the wrong plan.
    if (target) {
        after.armed_scenario_id === target.id ? ok(`armed_scenario_id is ${target.id}`) : fail(`armed_scenario_id is ${after.armed_scenario_id}, expected ${target.id}`)
        JSON.stringify(after.stop_zones) === JSON.stringify(target.stop_zones)
            ? ok('the stop that will rest at the broker belongs to the premise that fired')
            : fail(`stop_zones are ${JSON.stringify(after.stop_zones)} — the losing premise's stop would rest behind this position`)
        after.quantity === target.quantity
            ? ok(`size ${after.quantity} is that premise's own — never a sum`)
            : fail(`size ${after.quantity} is not ${scenarioLabel(target)}'s ${target.quantity}`)
    }
    console.log(`   pendingOrder.plan: ${JSON.stringify(after.pendingOrder?.plan ?? null)}`)
    after.pendingOrder?.plan?.length
        ? ok('a placeable order plan is persisted')
        : fail('no pendingOrder.plan persisted — nothing for the confirm dialog to place')
    // `reason`, not `kind` — journalEntry's field. Reading the wrong one printed an empty timeline
    // on every run and made a working journal look broken.
    const timeline = after.monitor_state?.timeline ?? []
    console.log(`   timeline: ${timeline.map(t => t.reason).join(' → ') || '(empty)'}`)
    timeline.length ? ok(`journal wrote ${timeline.length} line(s): "${timeline.at(-1)?.note ?? ''}"`) : fail('nothing journalled')
    console.log(`   memo: ${after.monitor_state?.memo ?? '(none)'}`)

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
