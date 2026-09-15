// Prometheus's quick read on an Aether name.
//
// A verdict, not coverage: credible, priced in, contradicted, or unclear — phases 1–2 on Sonnet,
// a few cents, optional and per name. What is guarded here: the opening traces to stored fields
// and never upgrades a silent filing; the block is checked rather than trusted; one read per name
// per event and one in flight; the read joins the list; the route is a broadcast, not admin-gated.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
    quickRead, quickReadOpening, attachReads, QUICKREAD_MODEL,
} from '../../services/aetherQuickRead.service.js'
import { _parseQuickRead, _buildSystemPrompt, MODES } from '../../services/agents/analyst.agent.service.js'
import { ALL_EMIT_TAGS } from '../../services/llmStream.util.js'

const CAND = {
    run_id: 'Strait of Hormuz:2026-09-13', ticker: 'FRO', company: 'Frontline plc', side: 'helped',
    subject: 'Strait of Hormuz', event: 'Saudi Arabia shut its East-West oil pipeline',
    event_date: '2026-09-13', mechanism: 'Replacement barrels must come by sea.',
    press_evidence: 'Frontline operates the largest listed VLCC fleet.', source_url: 'https://x/fro',
    verdict: 'silent', excess_pct: 0.012, extension: 0.4, price_asof: '2026-09-14',
    expires_at: '2026-10-28', next_earnings: '2026-10-28',
}

// ── the opening ──────────────────────────────────────────────────────────────

test('the opening names the ticker, the side, the event and asks the one question', () => {
    const o = quickReadOpening(CAND, CAND)
    assert.match(o, /^Quick read on FRO \(Frontline plc\)\. Aether named it HELPED by an event — Strait of Hormuz \(2026-09-13\): "Saudi Arabia shut/)
    assert.match(o, /Is this exposure credible, already priced in, or contradicted by what FRO has said or filed since 2026-09-13\?$/)
})

test('a silent filing is said to be silent, never upgraded', () => {
    assert.match(quickReadOpening(CAND, CAND), /silent — nothing it has filed mentions this/)
})

test('a quantified filing carries its sentence', () => {
    const o = quickReadOpening({ ...CAND, verdict: 'quantified', filing_evidence: 'tariffs cost $19 million' }, CAND)
    assert.match(o, /quantified — "tariffs cost \$19 million"/)
})

test('the move is stated with its sigma, or its absence is stated', () => {
    assert.match(quickReadOpening(CAND, CAND), /Move since the event: 1\.2% vs SPY \(0\.4σ\), as of 2026-09-14\./)
    assert.match(quickReadOpening({ ...CAND, excess_pct: null }, CAND), /No move measured yet\./)
})

// ── judged against every event naming it ─────────────────────────────────────

const OTHER = { run_id: 'Iran:2026-09-10', subject: 'Iran', side: 'hurt', event_date: '2026-09-10',
                mechanism: 'War-risk premiums on its Gulf routings.', excess_pct: -0.021 }

test('with other events, the opening lists them and widens the question to the net', () => {
    const o = quickReadOpening(CAND, CAND, [OTHER])
    assert.match(o, /Aether has ALSO named FRO by 1 other live event — and they pull it in OPPOSITE directions:/)
    assert.match(o, /^- Iran \(2026-09-10\), HURT: War-risk premiums on its Gulf routings\. Move since: -2\.1% vs SPY\.$/m)
    assert.match(o, /Judge FRO against ALL of them\. Is THIS event's claim \(HELPED\) credible/)
    assert.match(o, /which way does the name go\?$/)
    assert.doesNotMatch(o, /Is this exposure credible, already priced in, or contradicted by what FRO/)
})

test('other events on the same side are listed without the opposite-directions warning', () => {
    const o = quickReadOpening(CAND, CAND, [{ ...OTHER, side: 'helped' }])
    assert.match(o, /by 1 other live event:/)
    assert.doesNotMatch(o, /OPPOSITE/)
})

test('with no other events the question is the narrow one', () => {
    assert.match(quickReadOpening(CAND, CAND, []), /Is this exposure credible, already priced in, or contradicted by what FRO has said or filed since 2026-09-13\?$/)
    assert.doesNotMatch(quickReadOpening(CAND, CAND), /ALSO named/)
})

test('survives a bare row', () => {
    const o = quickReadOpening({ ticker: 'X', side: 'hurt' })
    assert.match(o, /Aether named it HURT by an event — an event\./)
    assert.doesNotMatch(o, /undefined|null/)
})

// ── the block, checked rather than trusted ───────────────────────────────────

test('a well-formed block comes through', () => {
    const raw = 'Credible.\n<quickread>{"ticker":"FRO","verdict":"credible","confidence":0.7,"read":"It filed.","evidence":[{"fact":"8-K names it","source":"8-K 2026-09-14"}],"checked":["get_sec_filings"]}</quickread>'
    assert.deepEqual(_parseQuickRead(raw), {
        verdict: 'credible', net: null, confidence: 0.7, read: 'It filed.',
        evidence: [{ fact: '8-K names it', source: '8-K 2026-09-14' }], checked: ['get_sec_filings'],
    })
})

test('net comes through when it is one of the three, and is null otherwise', () => {
    const at = net => _parseQuickRead(`<quickread>{"verdict":"credible","net":${JSON.stringify(net)}}</quickread>`).net
    assert.equal(at('hurt'), 'hurt')
    assert.equal(at('helped'), 'helped')
    assert.equal(at('unclear'), 'unclear')
    assert.equal(at('mixed'), null)
    assert.equal(_parseQuickRead('<quickread>{"verdict":"credible"}</quickread>').net, null)
})

test('a verdict outside the four is unclear, not a fifth verdict', () => {
    const raw = '<quickread>{"verdict":"strong buy","confidence":9,"read":"x","evidence":[{"source":"y"}],"checked":"web_search"}</quickread>'
    const q = _parseQuickRead(raw)
    assert.equal(q.verdict, 'unclear')
    assert.equal(q.confidence, 1)          // clamped
    assert.deepEqual(q.evidence, [])       // no fact, no entry
    assert.deepEqual(q.checked, [])        // not an array
})

test('no block is null', () => {
    assert.equal(_parseQuickRead('just prose'), null)
    assert.equal(_parseQuickRead(''), null)
})

// ── the agent's mode ─────────────────────────────────────────────────────────

test('quick-read mode adds its module as its own cached block, between the spine and the dynamic tail', () => {
    const coverage = _buildSystemPrompt({}, null, null, MODES.COVERAGE)
    const quick    = _buildSystemPrompt({}, null, null, MODES.QUICKREAD)
    assert.equal(quick.length, coverage.length + 1)
    assert.match(quick[1].text, /QUICK READ MODE/)
    assert.match(quick[1].text, /Do not emit `<coverage>`/)
    assert.deepEqual(quick[0], coverage[0], 'the coverage prefix is untouched')
})

test('the emit tag is registered before anyone emits it', () => {
    assert.ok(ALL_EMIT_TAGS.includes('quickread'))
})

test('the read runs on Sonnet', () => {
    assert.equal(QUICKREAD_MODEL, 'claude-sonnet-5')
})

// ── the service ──────────────────────────────────────────────────────────────

function deps({ existing = null, candidate = CAND, quickread, slow = false, others = [] } = {}) {
    const calls = { read: 0, stored: [] }
    return {
        calls,
        existing: async () => existing,
        candidate: async () => candidate,
        others: async () => others,
        read: async ({ opening }) => {
            calls.read += 1
            calls.opening = opening
            if (slow) await new Promise(r => setTimeout(r, 20))
            return { reply: 'Credible — it filed.', quickread }
        },
        store: async doc => { calls.stored.push(doc); return doc },
    }
}

const Q = { verdict: 'credible', confidence: 0.7, read: 'It filed.', evidence: [], checked: ['get_sec_filings'] }

test('produces, stores and returns the read', async () => {
    const d = deps({ quickread: Q })
    const out = await quickRead({ runId: CAND.run_id, ticker: 'fro', userId: 'u1' }, d)
    assert.equal(d.calls.read, 1)
    assert.match(d.calls.opening, /^Quick read on FRO/)
    assert.equal(out.ticker, 'FRO')
    assert.equal(out.verdict, 'credible')
    assert.equal(out.read_by, 'u1')
    assert.equal(out.model, QUICKREAD_MODEL)
    assert.equal(d.calls.stored.length, 1)
})

test('a stored read is returned without a model call', async () => {
    const d = deps({ existing: { run_id: CAND.run_id, ticker: 'FRO', verdict: 'priced_in' } })
    const out = await quickRead({ runId: CAND.run_id, ticker: 'FRO' }, d)
    assert.equal(out.verdict, 'priced_in')
    assert.equal(d.calls.read, 0)
})

test('a read is judged against the other live events, and records which', async () => {
    const d = deps({ quickread: { ...Q, net: 'hurt' }, others: [OTHER] })
    const out = await quickRead({ runId: CAND.run_id, ticker: 'FRO' }, d)
    assert.match(d.calls.opening, /ALSO named FRO by 1 other live event/)
    assert.equal(out.net, 'hurt')
    assert.deepEqual(out.considered, ['Iran:2026-09-10'])
})

test('with one event naming it, net is null whatever the model said', async () => {
    const d = deps({ quickread: { ...Q, net: 'hurt' }, others: [] })
    const out = await quickRead({ runId: CAND.run_id, ticker: 'FRO' }, d)
    assert.equal(out.net, null)
    assert.deepEqual(out.considered, [])
})

test('a stored read is served while the set of other events is unchanged, in any order', async () => {
    const existing = { run_id: CAND.run_id, ticker: 'FRO', verdict: 'credible', considered: ['b', 'a'] }
    const d = deps({ existing, others: [{ run_id: 'a', side: 'hurt' }, { run_id: 'b', side: 'hurt' }] })
    assert.equal(await quickRead({ runId: CAND.run_id, ticker: 'FRO' }, d), existing)
    assert.equal(d.calls.read, 0)
})

test('a stored read is read again when a new event has since named the ticker', async () => {
    // The stored read never saw the second event; serving it would be a verdict on a story
    // that has changed. This is the one re-read there is.
    const existing = { run_id: CAND.run_id, ticker: 'FRO', verdict: 'credible', considered: [] }
    const d = deps({ existing, quickread: { ...Q, verdict: 'contradicted', net: 'hurt' }, others: [OTHER] })
    const out = await quickRead({ runId: CAND.run_id, ticker: 'FRO' }, d)
    assert.equal(d.calls.read, 1)
    assert.equal(out.verdict, 'contradicted')
    assert.deepEqual(out.considered, ['Iran:2026-09-10'])
})

test('a read stored before `considered` existed is re-read only if there are other events now', async () => {
    const legacy = { run_id: CAND.run_id, ticker: 'FRO', verdict: 'credible' }
    const d0 = deps({ existing: legacy, others: [] })
    assert.equal(await quickRead({ runId: CAND.run_id, ticker: 'FRO' }, d0), legacy)
    const d1 = deps({ existing: legacy, quickread: Q, others: [OTHER] })
    await quickRead({ runId: CAND.run_id, ticker: 'FRO' }, d1)
    assert.equal(d1.calls.read, 1)
})

test('two presses mid-run share one model call', async () => {
    const d = deps({ quickread: Q, slow: true })
    const [a, b] = await Promise.all([
        quickRead({ runId: 'r-dedupe', ticker: 'FRO' }, d),
        quickRead({ runId: 'r-dedupe', ticker: 'FRO' }, d),
    ])
    assert.equal(d.calls.read, 1)
    assert.equal(a, b)
})

test('no block from the model is stored as unclear with the reply as the read', async () => {
    const d = deps({ quickread: null })
    const out = await quickRead({ runId: 'r-noblock', ticker: 'FRO' }, d)
    assert.equal(out.verdict, 'unclear')
    assert.equal(out.read, 'Credible — it filed.')
})

test('an unknown candidate is a 404, a bad ticker a 400', async () => {
    await assert.rejects(quickRead({ runId: 'r-404', ticker: 'FRO' }, deps({ candidate: null })), e => e.status === 404)
    await assert.rejects(quickRead({ runId: 'r', ticker: 'not a ticker!!' }, deps()), e => e.status === 400)
    await assert.rejects(quickRead({ ticker: 'FRO' }, deps()), e => e.status === 400)
})

// ── the join ─────────────────────────────────────────────────────────────────

test('reads attach to their candidate by run and ticker, and only there', () => {
    const runs = [
        { run_id: 'a', candidates: [{ ticker: 'FRO' }, { ticker: 'XOM' }] },
        { run_id: 'b', candidates: [{ ticker: 'FRO' }] },
    ]
    const reads = new Map([['a|FRO', { verdict: 'credible' }]])
    attachReads(runs, reads)
    assert.equal(runs[0].candidates[0].quick_read.verdict, 'credible')
    assert.equal(runs[0].candidates[1].quick_read, undefined)
    assert.equal(runs[1].candidates[0].quick_read, undefined)
})

test('the route is a broadcast write, not admin-gated', () => {
    const src = readFileSync(new URL('../../api/aether/aether.routes.js', import.meta.url), 'utf8')
    const line = src.split('\n').find(l => l.includes("'/quickread'"))
    assert.ok(line)
    assert.ok(!line.includes('requireAdmin'))
})
