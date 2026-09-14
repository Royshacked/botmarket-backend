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

test('survives a bare row', () => {
    const o = quickReadOpening({ ticker: 'X', side: 'hurt' })
    assert.match(o, /Aether named it HURT by an event — an event\./)
    assert.doesNotMatch(o, /undefined|null/)
})

// ── the block, checked rather than trusted ───────────────────────────────────

test('a well-formed block comes through', () => {
    const raw = 'Credible.\n<quickread>{"ticker":"FRO","verdict":"credible","confidence":0.7,"read":"It filed.","evidence":[{"fact":"8-K names it","source":"8-K 2026-09-14"}],"checked":["get_sec_filings"]}</quickread>'
    assert.deepEqual(_parseQuickRead(raw), {
        verdict: 'credible', confidence: 0.7, read: 'It filed.',
        evidence: [{ fact: '8-K names it', source: '8-K 2026-09-14' }], checked: ['get_sec_filings'],
    })
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

function deps({ existing = null, candidate = CAND, quickread, slow = false } = {}) {
    const calls = { read: 0, stored: [] }
    return {
        calls,
        existing: async () => existing,
        candidate: async () => candidate,
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
