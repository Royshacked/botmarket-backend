import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _checkBook, _scheduledDue, _eventSig, _nextEodMs, _cardContent } from '../../monitoring/themis.monitor.service.js'
import { computeReviewTriggers } from '../../services/portfolioReview.util.js'

// Themis — the portfolio doorbell. Pure gate helpers + the per-book check with injected
// deps (compute signals / notify / persist), and the two trigger-panel additions it relies on.

// ─── _nextEodMs ────────────────────────────────────────────────────────────────
test('_nextEodMs: before the anchor → today at the anchor hour', () => {
    const now = Date.parse('2026-01-15T10:00:00Z')
    assert.equal(new Date(_nextEodMs(now, 21)).toISOString(), '2026-01-15T21:00:00.000Z')
})

test('_nextEodMs: at/after the anchor → next day at the anchor hour', () => {
    const now = Date.parse('2026-01-15T22:00:00Z')
    assert.equal(new Date(_nextEodMs(now, 21)).toISOString(), '2026-01-16T21:00:00.000Z')
})

// ─── _scheduledDue ─────────────────────────────────────────────────────────────
const NOW = 2_000_000_000_000   // fixed far-future instant
const WEEK = 7 * 86400000

test('_scheduledDue: no nextReviewAt → false', () => {
    assert.equal(_scheduledDue({ nextReviewAt: null, reviewCadence: 'weekly' }, NOW), false)
})
test('_scheduledDue: nextReviewAt in the future → false', () => {
    assert.equal(_scheduledDue({ nextReviewAt: NOW + 1000, reviewCadence: 'weekly' }, NOW), false)
})
test('_scheduledDue: due and never notified → true', () => {
    assert.equal(_scheduledDue({ nextReviewAt: NOW - 1000, notifiedAt: null, reviewCadence: 'weekly' }, NOW), true)
})
test('_scheduledDue: due but already notified this cycle → false', () => {
    assert.equal(_scheduledDue({ nextReviewAt: NOW - 1000, notifiedAt: NOW - 2000, reviewCadence: 'weekly' }, NOW), false)
})
test('_scheduledDue: due with a stale notifiedAt from a prior cycle → true', () => {
    const staleNotified = (NOW - 1000) - WEEK - 1
    assert.equal(_scheduledDue({ nextReviewAt: NOW - 1000, notifiedAt: staleNotified, reviewCadence: 'weekly' }, NOW), true)
})

// ─── _eventSig ─────────────────────────────────────────────────────────────────
test('_eventSig: empty → null; order-independent; label-sensitive', () => {
    assert.equal(_eventSig([]), null)
    const a = _eventSig([{ kind: 'drift', label: 'X' }, { kind: 'earnings', label: 'Y' }])
    const b = _eventSig([{ kind: 'earnings', label: 'Y' }, { kind: 'drift', label: 'X' }])
    assert.equal(a, b)
    assert.notEqual(a, _eventSig([{ kind: 'drift', label: 'Z' }]))
})

// ─── _cardContent ──────────────────────────────────────────────────────────────
test('_cardContent: event leads with "Heads up"; scheduled with "Time to review"', () => {
    const book = { portfolioName: 'Core', mode: 'paper', account: 'Sim' }
    const trg  = [{ kind: 'earnings', label: 'earnings within 7d: NVDA' }]
    assert.match(_cardContent(book, 'event', trg), /^Heads up on "Core" \(Paper · Sim\)\. Flagged: earnings within 7d: NVDA\./)
    assert.match(_cardContent(book, 'scheduled', []), /^Time to review your portfolio "Core"/)
})

// ─── _checkBook branching ──────────────────────────────────────────────────────
function harness({ triggers = [], book = {} }) {
    const notifies = []
    const patches  = []
    const deps = {
        computeSignals: async () => ({ triggers }),
        notify:         async (b, payload) => { notifies.push({ portfolioId: b.portfolioId, ...payload }) },
        setLifecycle:   async (portfolioId, userId, patch) => { patches.push({ portfolioId, userId, patch }) },
    }
    const full = { portfolioId: 'p1', userId: 'u1', portfolioName: 'Core', reviewCadence: 'weekly', ...book }
    return { deps, notifies, patches, book: full }
}

test('scheduled gate: due book, no triggers → notifies (reason scheduled), stamps notifiedAt + clock', async () => {
    const h = harness({ triggers: [], book: { nextReviewAt: NOW - 1000, notifiedAt: null } })
    const r = await _checkBook(h.book, NOW, h.deps)
    assert.equal(r.reason, 'scheduled')
    assert.equal(h.notifies.length, 1)
    assert.equal(h.notifies[0].reason, 'scheduled')
    const patch = h.patches[0].patch
    assert.equal(patch.notifiedAt, NOW)
    assert.ok(patch['themis.next_check_at'] > NOW)
    assert.equal('themis.last_event_sig' in patch, false)   // no triggers → nothing to stamp
})

test('event gate: not scheduled, fresh triggers → notifies (reason event), stamps last_event_sig, no notifiedAt', async () => {
    const triggers = [{ kind: 'drawdown', severity: 'high', label: 'book down -9.0pt since last look' }]
    const h = harness({ triggers, book: { nextReviewAt: null, themis: { last_event_sig: null } } })
    const r = await _checkBook(h.book, NOW, h.deps)
    assert.equal(r.reason, 'event')
    assert.equal(h.notifies.length, 1)
    const patch = h.patches[0].patch
    assert.equal(patch['themis.last_event_sig'], _eventSig(triggers))
    assert.equal('notifiedAt' in patch, false)
})

test('event dedup: same triggers already signed → no notify, clock still advances', async () => {
    const triggers = [{ kind: 'drift', severity: 'medium', label: 'NVDA drifted +12pt from target' }]
    const h = harness({ triggers, book: { nextReviewAt: null, themis: { last_event_sig: _eventSig(triggers) } } })
    const r = await _checkBook(h.book, NOW, h.deps)
    assert.equal(r.reason, null)
    assert.equal(h.notifies.length, 0)
    assert.ok(h.patches[0].patch['themis.next_check_at'] > NOW)
})

test('quiet: nothing due, no triggers → no notify, only clock bookkeeping', async () => {
    const h = harness({ triggers: [], book: { nextReviewAt: NOW + 999999, themis: { checks: 4 } } })
    const r = await _checkBook(h.book, NOW, h.deps)
    assert.equal(r.reason, null)
    assert.equal(h.notifies.length, 0)
    assert.equal(h.patches[0].patch['themis.checks'], 5)
})

test('precedence: scheduled + triggers → ONE scheduled card, and triggers are signed (no event re-ring next day)', async () => {
    const triggers = [{ kind: 'conviction', severity: 'high', label: 'conviction fell on NVDA' }]
    const h = harness({ triggers, book: { nextReviewAt: NOW - 1000, notifiedAt: null, themis: { last_event_sig: null } } })
    const r = await _checkBook(h.book, NOW, h.deps)
    assert.equal(r.reason, 'scheduled')
    assert.equal(h.notifies.length, 1)
    const patch = h.patches[0].patch
    assert.equal(patch.notifiedAt, NOW)
    assert.equal(patch['themis.last_event_sig'], _eventSig(triggers))
})

// ─── trigger-panel additions (coverage-delta + "nuclear war" adverse-move proxy) ──
test('computeReviewTriggers: held-name coverage flips → high (broken) / medium (target hit)', () => {
    const trg = computeReviewTriggers({
        state: { ideas: [] },
        coverage: [{ symbol: 'NVDA', status: 'thesis_broken' }, { symbol: 'AAPL', status: 'target_hit' }],
    })
    const broken = trg.find(t => t.kind === 'coverage' && /NVDA/.test(t.label))
    const hit    = trg.find(t => t.kind === 'coverage' && /AAPL/.test(t.label))
    assert.equal(broken.severity, 'high')
    assert.equal(hit.severity, 'medium')
})

test('computeReviewTriggers: sharp adverse book move since fingerprint → drawdown (high)', () => {
    const trg = computeReviewTriggers({
        state:       { ideas: [], totalPnlPct: -6 },
        fingerprint: { totalPnlPct: 4 },   // 4 → -6 = -10pt, past the 8pt default
    })
    const dd = trg.find(t => t.kind === 'drawdown')
    assert.ok(dd)
    assert.equal(dd.severity, 'high')
})

test('computeReviewTriggers: a mild dip does NOT trip the drawdown gate', () => {
    const trg = computeReviewTriggers({
        state:       { ideas: [], totalPnlPct: 1 },
        fingerprint: { totalPnlPct: 4 },   // -3pt, under threshold
    })
    assert.equal(trg.find(t => t.kind === 'drawdown'), undefined)
})
