import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    emptyBuild, upsertName, applyBuildOps, sanitizeBuildOps, claimsFromDraft,
    activeName, stageOf, buildComplete, STAGES,
} from '../../services/mentorBuild.util.js'
import { applySizing } from '../../services/mentorSummary.util.js'
import { normalizeSetup, allowedVerdicts } from '../../services/setup.schema.js'
import { mentorAgentService, emptyMentorState, _mergeDrafts, _buildTurnContext } from '../../services/agents/mentor.agent.service.js'

// The code review of feat/mentor-flow-v2 (2026-09-29) found eight gaps that 3671 passing tests did
// not. Every one of them is here, driven the way the REAL client drives it — the lesson of finding
// 3, whose original test hand-fed the server a field the client never sends and proved nothing.

const SETUP = (asset = 'NVDA', over = {}) => ({
    asset, direction: 'long', type: 'swing', trade_mode: 'smc', timeframe: '1hr',
    scenarios: [{
        id: 's1',
        entry_legs:  [{ price: 200, quantity: 10 }],
        stop_legs:   [{ price: 196 }],
        target_legs: [{ price: 210, quantity: 10 }],
    }],
    ...over,
})

const turn = (raw, chatState = emptyMentorState(), accounts = [{ id: 'a1', balance: 50000 }]) =>
    mentorAgentService.chatStream({ messages: [{ role: 'user', content: 'hi' }], chatState, accounts, _run: async () => raw })

/** Settle every stage up to (not including) `stop`, the way a real build does. */
function upTo(stop) {
    let b = upsertName(emptyBuild(), 'NVDA')
    const V = { direction: 'long', horizon: 'swing', lens: 'smc', spans: ['t1'], entries: ['t1:e1'] }
    for (const stage of STAGES) {
        if (stage.key === stop) break
        for (const f of stage.fields) {
            if (!(f in V)) continue
            b = applyBuildOps(b, { claim: { [f]: V[f] }, settle: [f] }).build
        }
    }
    return b
}

// ─── 2. The sizing stage could never settle ───────────────────────────────────

test('the size op becomes a CLAIM, so the settlement the prompt prescribes is accepted', () => {
    const ops = sanitizeBuildOps({ size: { unit: 'risk_pct', value: 1 }, settle: ['size'], source: 'user' })
    const { build, refused } = applyBuildOps(upTo('sizing'), ops)
    assert.deepEqual(refused, [], 'this is the exact op the prompt tells the model to emit')
    assert.deepEqual(activeName(build).settled.size, { unit: 'risk_pct', value: 1 })
    assert.equal(stageOf(activeName(build)), 'summary')
})

// ─── 6. The build could never complete ────────────────────────────────────────

test('the summary stage settles on the FIGURES, and the build can finish', async () => {
    // The figures are computed on the turn the size is given, and the stage settles on them existing
    // — with no "yes" asked for (STAGES settles: 'shown'; Marce's INTC build, 2026-10-01).
    const priced = await turn(`<setup>${JSON.stringify(SETUP())}</setup>`
        + '<build>{"size":{"unit":"risk_cash","value":500}}</build>',
    { active_asset: 'NVDA', draft: null, coverage: [] })
    assert.ok(priced.setup.summary.lossCash, 'there is money to show')

    let b = upTo('summary')
    b = applyBuildOps(b, { asset: 'NVDA', size: { unit: 'risk_cash', value: 500 } }).build
    // The claim for it is DERIVED from the figures, exactly as the service does it — and nothing
    // asks to settle it.
    const withSummary = applyBuildOps(b, {
        asset: 'NVDA',
        derived: { summary: { rr: 2.5, gain: 1250, loss: 500, estimated: false } },
    })
    assert.deepEqual(withSummary.refused, [])
    assert.equal(stageOf(activeName(withSummary.build)), null, 'the build is finished')
    assert.equal(buildComplete(withSummary.build), true)
})

// ─── 5. A lens nobody proposed was settled at the opening turn ────────────────

test('the schema default lens is NOT claimed — only a lens someone actually stated', () => {
    const noLens = normalizeSetup({ asset: 'NVDA', direction: 'long', type: 'swing' })
    assert.equal(noLens.trade_mode, 'discretionary', 'the schema still defaults it')
    assert.equal('lens' in claimsFromDraft(noLens, { lensStated: false }), false)
    assert.equal(claimsFromDraft(noLens, { lensStated: true }).lens, 'discretionary')
})

test('a worksheet with no trade_mode leaves the lens blank in the ledger', async () => {
    const out = await turn(`<setup>${JSON.stringify({ asset: 'NVDA', direction: 'long', type: 'swing' })}</setup>`)
    const name = activeName(out.build)
    assert.equal('lens' in name.claimed, false, 'the opening turn would otherwise settle a lens nobody heard')
    assert.deepEqual(Object.keys(name.claimed).sort(), ['direction', 'horizon'])
})

// ─── 3 & 8. A multi-name build lost the first name ────────────────────────────

test('the second name keeps the first, driven the way the CLIENT actually drives it', async () => {
    const nvda = await turn(`<setup>${JSON.stringify(SETUP('NVDA'))}</setup>`)
    assert.equal(nvda.drafts, undefined, 'one name, nothing extra to send')

    // EXACTLY what the frontend sends on the next turn: the draft it holds, and no `drafts` map,
    // because the server has never sent it one. Seeding from `drafts` alone lost NVDA here.
    const amd = await turn(`<setup>${JSON.stringify(SETUP('AMD'))}</setup>`,
        { active_asset: 'AMD', draft: nvda.setup, coverage: [] })

    assert.deepEqual(Object.keys(amd.drafts).sort(), ['AMD', 'NVDA'])
    assert.equal(amd.drafts.NVDA.scenarios[0].entry_legs[0].price, 200)
})

test('a parked name keeps its gate content and its money across the round trip', () => {
    const parked = { ...normalizeSetup(SETUP('NVDA')), spans: { candidates: [{ id: 't1' }] }, entries: { trades: [] }, summary: { lossCash: 500 } }
    const merged = _mergeDrafts(null, normalizeSetup(SETUP('AMD')), parked)
    assert.deepEqual(merged.NVDA.spans, { candidates: [{ id: 't1' }] })
    assert.equal(merged.NVDA.summary.lossCash, 500)
    assert.equal(merged.NVDA.build, undefined, 'but not the ledger — one build has one')
})

// ─── 7. The gates leaked across an asset switch ───────────────────────────────

test('candidate trades do not follow the user to another name', async () => {
    const nvda = await turn(`<setup>${JSON.stringify(SETUP('NVDA'))}</setup>`
        + '<spans>{"candidates":[{"id":"t1","label":"the shelf","from":"a","to":"b"}]}</spans>')
    assert.ok(nvda.setup.spans)

    const amd = await turn(`<setup>${JSON.stringify(SETUP('AMD'))}</setup>`,
        { active_asset: 'AMD', draft: nvda.setup, coverage: [] })

    assert.equal(amd.setup.spans, undefined, "AMD must not inherit NVDA's trades")
    // AMD may claim ids off its OWN worksheet; what it must never hold is NVDA's t1.
    const claimedSpans = activeName(amd.build)?.claimed?.spans?.value ?? []
    assert.equal(claimedSpans.includes('t1'), false, "nor claim NVDA's span ids")
    assert.deepEqual(amd.drafts.NVDA.spans.candidates.map(c => c.id), ['t1'], 'NVDA keeps its own')
})

// ─── 4. The contract multiplier was ignored ───────────────────────────────────

test('a futures contract is not sized as if one unit were one dollar of price', () => {
    const es = normalizeSetup({ ...SETUP('ES'), asset_class: 'futures' })

    // Without the point value: refused by name, not silently sized at 125 contracts.
    const blind = applySizing(es, { unit: 'risk_cash', value: 500 }, { balance: 50000 })
    assert.deepEqual(blind.quantities, [])
    assert.match(blind.problems[0], /futures contract — tell me its point\/contract value/)

    // With it: $500 against a 4-point stop on a 50x contract is 2 contracts.
    const sized = applySizing(es, { unit: 'risk_cash', value: 500, multiplier: 50 }, { balance: 50000 })
    assert.equal(sized.quantities[0].quantity, 2)
    assert.equal(sized.quantities[0].riskCash, 400)
})

test('shares are unaffected — a unit IS the price there', () => {
    const { quantities } = applySizing(normalizeSetup(SETUP('NVDA')), { unit: 'risk_cash', value: 500 }, { balance: 50000 })
    assert.equal(quantities[0].quantity, 125)
})

test('the multiplier survives sanitisation, and nonsense does not', () => {
    assert.equal(sanitizeBuildOps({ size: { unit: 'risk_cash', value: 500, multiplier: 50 } }).size.multiplier, 50)
    assert.equal('multiplier' in sanitizeBuildOps({ size: { unit: 'risk_cash', value: 500, multiplier: 'fifty' } }).size, false)
})

// ─── 1. The clock exit was unreachable ────────────────────────────────────────

test('a time-exit wake can actually answer with the exit it was woken for', () => {
    // A position of plain levels watches no stop, so `exit_now` was not on the menu — a read woken
    // by the user's own deadline that may only say `hold`.
    const plain = { stop: null, targets: [], entries: [] }
    assert.deepEqual(allowedVerdicts(plain), ['hold'])
    assert.deepEqual(allowedVerdicts(plain, { timeExit: true }), ['hold', 'exit_now'])
    // And it is not added twice where a watched stop already offers it.
    const watched = { stop: { id: 's1' }, targets: [], entries: [] }
    assert.deepEqual(allowedVerdicts(watched, { timeExit: true }), ['hold', 'move_stop', 'exit_now'])
})

// ─── From the first LIVE run (2026-09-29): two turns wasted, and why ──────────
// The smoke build found what no stub could: told "still blank" on the turn the user said yes,
// the model re-read the name, re-proposed the same three values and asked the same question
// again. Both defects were one missing piece of STATE, not two prompt slips.

import { firstUnsettled, recordReads, ALWAYS_REFETCH } from '../../services/mentorBuild.util.js'
import { _buildLedgerSection } from '../../services/agents/mentor.agent.service.js'

test('a stage whose fields are all claimed is AWAITING an answer, not blank', () => {
    let b = upsertName(emptyBuild(), 'NVDA')
    b = applyBuildOps(b, { claim: { direction: 'long', horizon: 'swing', lens: 'smc' } }).build
    const at = firstUnsettled(activeName(b))
    assert.equal(at.awaiting, true)
    assert.deepEqual(at.blank, [], 'there is nothing left to work out')
    assert.deepEqual(at.fields, ['direction', 'horizon', 'lens'], 'they are still unsettled')
})

test('the turn context tells the model the answer is in front of it, and not to start again', () => {
    let b = upsertName(emptyBuild(), 'NVDA')
    b = applyBuildOps(b, { claim: { direction: 'long', horizon: 'swing', lens: 'smc' } }).build
    const text = _buildLedgerSection({ build: b })
    assert.match(text, /ALREADY PROPOSED, AWAITING THEIR ANSWER/)
    assert.match(text, /Their message IS the answer/)
    assert.match(text, /settle it now: <build>\{"settle":\["direction","horizon","lens"\]/)
    assert.match(text, /DO NOT re-derive these, do not re-read the name/)
})

test('a half-claimed stage is still reported as having work left', () => {
    let b = upsertName(emptyBuild(), 'NVDA')
    b = applyBuildOps(b, { claim: { direction: 'long' } }).build
    const at = firstUnsettled(activeName(b))
    assert.equal(at.awaiting, false)
    assert.deepEqual(at.blank, ['horizon', 'lens'])
    assert.match(_buildLedgerSection({ build: b }), /still blank: horizon, lens/)
})

test('what was read is recorded, and the price tools are exempt', () => {
    const b = recordReads(emptyBuild(), ['get_news', 'get_fundamentals', 'get_quote', 'get_candles'])
    assert.equal(b.turn, 1)
    assert.deepEqual(Object.keys(b.reads).sort(), ['get_fundamentals', 'get_news'])
    assert.deepEqual(ALWAYS_REFETCH, ['get_quote', 'get_candles', 'get_indicators', 'get_chart'])

    const next = recordReads(b, ['get_macro_snapshot'])
    assert.equal(next.turn, 2)
    assert.equal(next.reads.get_news, 1, 'the turn it was read on is kept')
    assert.equal(next.reads.get_macro_snapshot, 2)
})

test('the model is TOLD what it already has — the rule it could not previously check', () => {
    let b = recordReads(upsertName(emptyBuild(), 'NVDA'), ['get_news', 'get_fundamentals'])
    b = applyBuildOps(b, { claim: { direction: 'long' } }).build
    const text = _buildLedgerSection({ build: b })
    assert.match(text, /ALREADY READ THIS BUILD \(turn 1\)/)
    assert.match(text, /get_news \(turn 1\)/)
    assert.match(text, /cite what you concluded instead of calling again/)
    assert.match(text, /Re-read only get_quote \/ get_candles/)
})

test('the read record survives the round trip through the client', async () => {
    const out = await turn(`<setup>${JSON.stringify(SETUP())}</setup>`)
    assert.equal(out.build.turn, 1)
    const second = await turn('and?', { active_asset: 'NVDA', draft: out.setup, coverage: [] })
    assert.equal(second.build.turn, 2, 'the counter is not reset by the client')
})

// ─── The press, not the prose ─────────────────────────────────────────────────
// The durable answer to the one defect the live smoke could not fix with prompting: the client
// knows what was pressed, so the ledger moves BEFORE the model reads the turn.

import { sanitizeUserOps, applyUserOps, gateView } from '../../services/mentorBuild.util.js'
import { _buildPressSection } from '../../services/agents/mentor.agent.service.js'

test('a press settles deterministically, with no model involved at all', async () => {
    const proposed = await turn(`<setup>${JSON.stringify(SETUP())}</setup>`)
    assert.equal(stageOf(activeName(proposed.build)), 'opening', 'proposed, not settled')

    // The client sends what the user pressed. The model emits NOTHING this turn.
    const confirmed = await turn('Right.', {
        active_asset: 'NVDA',
        draft: proposed.setup,
        coverage: [],
        ops: [{ settle: ['direction', 'horizon', 'lens'] }],
    })
    assert.equal(stageOf(activeName(confirmed.build)), 'spans', 'settled without a <build> tag')
    assert.equal(activeName(confirmed.build).settled.direction, 'long')
})

test('a press is validated like anything else — it cannot skip a stage', () => {
    const ops = sanitizeUserOps([{ settle: ['size'] }])
    const { build, settled } = applyUserOps(upsertName(emptyBuild(), 'NVDA'), ops)
    assert.deepEqual(settled, [], 'nothing claimed for size, and the opening is still open')
    assert.equal(stageOf(activeName(build)), 'opening')
})

test('a press is always the USER — a client cannot claim to be Argus', () => {
    const [op] = sanitizeUserOps([{ claim: { lens: 'smc' }, source: 'argus' }])
    assert.equal(op.source, 'user')
})

test('junk from a client is dropped, not trusted for being client-side', () => {
    assert.deepEqual(sanitizeUserOps([{ settle: ['vibes'] }, 'yes', null]), [])
    assert.deepEqual(sanitizeUserOps(null), [])
    assert.equal(sanitizeUserOps([{ settle: ['direction'] }])[0].settle[0], 'direction')
})

test('the model is TOLD what was pressed, so it does not ask again', async () => {
    const proposed = await turn(`<setup>${JSON.stringify(SETUP())}</setup>`)
    const text = _buildPressSection(['direction', 'horizon', 'lens'], { draft: proposed.setup })
    assert.match(text, /THE USER JUST PRESSED A BUTTON/)
    assert.match(text, /ALREADY RECORDS IT/)
    assert.match(text, /direction, horizon, lens are SETTLED/)
    assert.match(text, /NOTHING about a settled stage is outstanding/)
    // The press answers the pacing question too — that is what the button means.
    assert.match(text, /stop at the checkpoints/)
    assert.equal(_buildPressSection([]), '', 'and nothing is said when nothing was pressed')
    assert.ok(proposed.gate, 'the card has something to draw')
})

test('the gate view tells the client what to draw without teaching it what a stage is', async () => {
    const out = await turn(`<setup>${JSON.stringify(SETUP())}</setup>`)
    assert.deepEqual(out.gate, {
        asset: 'NVDA', stage: 'opening', awaiting: true,
        fields: ['direction', 'horizon', 'lens'],
        values: { direction: 'long', horizon: 'swing', lens: 'smc' },
    })
    assert.equal(gateView(emptyBuild()), null)
})

test('the ledger is the LAST thing in the turn context, not buried under the worksheet', async () => {
    const out = await turn(`<setup>${JSON.stringify(SETUP())}</setup>`)
    const ctx = _buildTurnContext({ active_asset: 'NVDA', draft: out.setup, coverage: [] })
    assert.ok(ctx.lastIndexOf('BUILD LEDGER') > ctx.lastIndexOf('Setup so far'),
        'the instruction has to be the last thing read before the model writes')
    // And the worksheet no longer repeats what the prose sections already say.
    const plan = ctx.slice(ctx.indexOf('Setup so far'), ctx.indexOf('BUILD LEDGER'))
    assert.equal(plan.includes('"build"'), false)
    assert.equal(plan.includes('"summary"'), false)
})
