import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    _zoneGate, _isExpiring, _isPastExpiry, _effectiveVerdict, _computeNextCheckAt, _nextStatus,
    _snapToReference, _finalizeProposal, _applyAssessment, _scheduledPatch, _checkCall,
    _timelineEntry, _zonesLabel, _withTimeout, _thinkingConfig, _assessText,
} from '../../monitoring/hermes.monitor.service.js'

function call(extra = {}) {
    return {
        id: 'call_TSLA_x', asset: 'TSLA', bias: 'long', trade_type: 'day',
        cadence: { min_gap_min: 5, max_gap_min: 60 },
        entry_zones: [
            { id: 'ez1', side: 'long', anchor: 248, lower: 247.4, upper: 248.6 },
            { id: 'ez2', side: 'long', anchor: 245, lower: 244.8, upper: 245.2 },
        ],
        reference_levels: [
            { id: 'rl1', kind: 'support',    price: 245.2 },
            { id: 'rl2', kind: 'resistance', price: 252.0 },
            { id: 'rl3', kind: 'target',     price: 255.5 },
        ],
        sizing: { max_size: 300 },
        monitor_state: { check_count: 2, memo: 'prior note', armed_zone_id: null },
        valid_until: '2026-07-09T20:00:00Z',
        ...extra,
    }
}

const NOW = Date.parse('2026-07-09T15:00:00Z')

// ── _zoneGate: multi-zone first-wins ──────────────────────────────────────
test('zoneGate: price inside the first zone arms that zone', () => {
    assert.equal(_zoneGate(call(), 248.0)?.id, 'ez1')
})
test('zoneGate: price inside the second zone arms it when the first misses', () => {
    assert.equal(_zoneGate(call(), 245.0)?.id, 'ez2')
})
test('zoneGate: overlapping-eligible price returns the FIRST matching zone', () => {
    const c = call({ entry_zones: [
        { id: 'ez1', lower: 244, upper: 249 },
        { id: 'ez2', lower: 244.8, upper: 245.2 },
    ] })
    assert.equal(_zoneGate(c, 245.0)?.id, 'ez1')   // first wins even though both contain 245
})
test('zoneGate: price outside every band → null; non-finite → null', () => {
    assert.equal(_zoneGate(call(), 250), null)
    assert.equal(_zoneGate(call(), NaN), null)
    assert.equal(_zoneGate(call(), undefined), null)
})

// ── _isExpiring ───────────────────────────────────────────────────────────
test('isExpiring: far from valid_until → false', () => {
    assert.equal(_isExpiring(call(), Date.parse('2026-07-09T15:00:00Z')), false)
})
test('isExpiring: within threshold → true; already past → true', () => {
    assert.equal(_isExpiring(call(), Date.parse('2026-07-09T19:50:00Z')), true)
    assert.equal(_isExpiring(call(), Date.parse('2026-07-09T21:00:00Z')), true)
})
test('isExpiring: no / bad valid_until → false', () => {
    assert.equal(_isExpiring(call({ valid_until: null }), NOW), false)
    assert.equal(_isExpiring(call({ valid_until: 'not-a-date' }), NOW), false)
})

// ── _computeNextCheckAt: clamp both ends ──────────────────────────────────
test('computeNextCheckAt: clamps below min, above max, passes through in-range', () => {
    const cad = { min_gap_min: 5, max_gap_min: 60 }
    assert.equal(_computeNextCheckAt(NOW, 1,   cad), new Date(NOW + 5 * 60_000).toISOString())   // clamped up to 5
    assert.equal(_computeNextCheckAt(NOW, 999, cad), new Date(NOW + 60 * 60_000).toISOString())  // clamped down to 60
    assert.equal(_computeNextCheckAt(NOW, 20,  cad), new Date(NOW + 20 * 60_000).toISOString())  // in range
})
test('computeNextCheckAt: non-finite request → max gap', () => {
    assert.equal(_computeNextCheckAt(NOW, undefined, { min_gap_min: 5, max_gap_min: 60 }), new Date(NOW + 60 * 60_000).toISOString())
})

// ── _isPastExpiry ───────────────────────────────────────────────────────────
test('isPastExpiry: before valid_until → false; at/after → true; bad → false', () => {
    assert.equal(_isPastExpiry(call(), Date.parse('2026-07-09T19:59:00Z')), false)  // 1m before
    assert.equal(_isPastExpiry(call(), Date.parse('2026-07-09T20:00:00Z')), true)   // exactly at
    assert.equal(_isPastExpiry(call(), Date.parse('2026-07-09T21:00:00Z')), true)   // after
    assert.equal(_isPastExpiry(call({ valid_until: null }), NOW), false)
    assert.equal(_isPastExpiry(call({ valid_until: 'nope' }), NOW), false)
})

// ── _effectiveVerdict: two off-menu guards ────────────────────────────────────
test('effectiveVerdict: let_expire on a zone trip is downgraded (never kill a live call)', () => {
    assert.equal(_effectiveVerdict('let_expire', 'zone_trip', false), 'stand_aside')
})
test('effectiveVerdict: let_expire on an expiry review is honored', () => {
    assert.equal(_effectiveVerdict('let_expire', 'expiry_review', false), 'let_expire')
    assert.equal(_effectiveVerdict('let_expire', 'expiry_review', true),  'let_expire')
})
test('effectiveVerdict: PAST-expiry review that won\'t commit is forced to let_expire (hard cutoff)', () => {
    assert.equal(_effectiveVerdict('wait',        'expiry_review', true), 'let_expire')
    assert.equal(_effectiveVerdict('stand_aside', 'expiry_review', true), 'let_expire')
})
test('effectiveVerdict: within the pre-expiry window (not past), wait/stand_aside are preserved', () => {
    assert.equal(_effectiveVerdict('wait',        'expiry_review', false), 'wait')
    assert.equal(_effectiveVerdict('stand_aside', 'expiry_review', false), 'stand_aside')
})
test('effectiveVerdict: enter/edit always pass through', () => {
    assert.equal(_effectiveVerdict('enter', 'expiry_review', true), 'enter')
    assert.equal(_effectiveVerdict('edit',  'expiry_review', true), 'edit')
    assert.equal(_effectiveVerdict('enter', 'zone_trip',     false), 'enter')
})

// ── _nextStatus ───────────────────────────────────────────────────────────
test('nextStatus: verdict → status transitions', () => {
    assert.equal(_nextStatus('enter', 'zone_trip'), 'ready')
    assert.equal(_nextStatus('edit', 'expiry_review'), 'expiring')
    assert.equal(_nextStatus('let_expire', 'expiry_review'), 'expired')
    assert.equal(_nextStatus('wait', 'zone_trip'), 'watching')
    assert.equal(_nextStatus('stand_aside', 'scheduled'), 'waiting')
})

// ── _snapToReference ──────────────────────────────────────────────────────
test('snapToReference: long stop snaps to nearest level BELOW entry', () => {
    const refs = call().reference_levels
    assert.deepEqual(_snapToReference(245.0, refs, 'below', 248), { price: 245.2, ref: 'rl1' })
})
test('snapToReference: long TP snaps to nearest level ABOVE entry', () => {
    const refs = call().reference_levels
    assert.deepEqual(_snapToReference(251.0, refs, 'above', 248), { price: 252.0, ref: 'rl2' })
})
test('snapToReference: no level on the required side → keep price, ref null', () => {
    const refs = [{ id: 'rl1', price: 245 }]
    assert.deepEqual(_snapToReference(260, refs, 'above', 248), { price: 260, ref: null })
})

// ── _finalizeProposal ─────────────────────────────────────────────────────
test('finalizeProposal: snaps stop/TP to structure, clamps size, computes R:R (long)', () => {
    const p = { entry: 248.3, stop: 245.0, take_profit: [{ price: 251.8 }], size: 500, rationale: 'reclaim' }
    const out = _finalizeProposal(p, call(), call().entry_zones[0])
    assert.equal(out.stop, 245.2)
    assert.equal(out.stop_ref, 'rl1')
    assert.equal(out.take_profit[0].price, 252.0)
    assert.equal(out.take_profit[0].ref, 'rl2')
    assert.equal(out.size, 300)                                   // clamped to max_size
    assert.equal(out.rr, Math.round((Math.abs(252 - 248.3) / Math.abs(248.3 - 245.2)) * 100) / 100)
})
test('finalizeProposal: default size = max when none proposed', () => {
    const out = _finalizeProposal({ entry: 248, stop: 245, take_profit: [{ price: 252 }] }, call(), call().entry_zones[0])
    assert.equal(out.size, 300)
})
test('finalizeProposal: short inverts snap sides (stop above, TP below)', () => {
    const c = call({ bias: 'short', reference_levels: [
        { id: 'a', price: 250 }, { id: 'b', price: 245 },
    ] })
    const zone = { id: 'ez1', side: 'short' }
    const out = _finalizeProposal({ entry: 248, stop: 249.5, take_profit: [{ price: 246 }] }, c, zone)
    assert.equal(out.stop, 250)        // nearest ABOVE entry
    assert.equal(out.stop_ref, 'a')
    assert.equal(out.take_profit[0].price, 245)   // nearest BELOW entry
})
test('finalizeProposal: null proposal → null', () => {
    assert.equal(_finalizeProposal(null, call(), null), null)
})

// ── _applyAssessment ──────────────────────────────────────────────────────
test('applyAssessment: enter → ready, arms zone, clamps next check, fires card', () => {
    const raw = {
        verdict: 'enter', timeframe_used: '15min', next_check_min: 999,
        market: { score: 'supportive' }, price_action: { strength: 'strong' },
        proposal: { entry: 248.3, stop: 245, take_profit: [{ price: 252 }] },
        memo_update: 'reclaim confirmed',
    }
    const { set, fireCard, lastAssessment } = _applyAssessment(call(), call().entry_zones[0], raw, NOW, 'zone_trip')
    assert.equal(set.status, 'ready')
    assert.equal(set['monitor_state.armed_zone_id'], 'ez1')
    assert.equal(set['monitor_state.chosen_timeframe'], '15min')
    assert.equal(set['monitor_state.check_count'], 3)                     // 2 → 3
    assert.equal(set['monitor_state.memo'], 'reclaim confirmed')
    assert.equal(set['monitor_state.next_check_at'], new Date(NOW + 60 * 60_000).toISOString())  // clamped to max
    assert.equal(fireCard, true)
    assert.equal(lastAssessment.proposal.stop, 245.2)                     // snapped
    assert.equal(lastAssessment.verdict, 'enter')
})
test('applyAssessment: wait carries the prior memo when no memo_update', () => {
    const raw = { verdict: 'wait', next_check_min: 10 }
    const { set, fireCard } = _applyAssessment(call(), call().entry_zones[0], raw, NOW, 'zone_trip')
    assert.equal(set.status, 'watching')
    assert.equal(set['monitor_state.memo'], 'prior note')   // carried across the wake
    assert.equal(fireCard, false)
})
test('applyAssessment: let_expire → expired, no proposal, fires the expiry card', () => {
    const { set, fireCard, lastAssessment } = _applyAssessment(call(), null, { verdict: 'let_expire', next_check_min: 5 }, NOW, 'expiry_review')
    assert.equal(set.status, 'expired')
    assert.equal(fireCard, true)   // now notifies (expiry card) instead of expiring silently
    assert.equal(lastAssessment.proposal, undefined)
})
test('applyAssessment: edit → expiring + fires card + carries edit_proposal', () => {
    const raw = { verdict: 'edit', next_check_min: 30, edit_proposal: { why: 'roll', changes: {} } }
    const { set, fireCard, lastAssessment } = _applyAssessment(call(), null, raw, NOW, 'expiry_review')
    assert.equal(set.status, 'expiring')
    assert.equal(fireCard, true)
    assert.deepEqual(lastAssessment.edit_proposal, { why: 'roll', changes: {} })
})
test('applyAssessment: let_expire on a zone trip does NOT expire — call keeps watching, no card', () => {
    const { set, fireCard, lastAssessment } = _applyAssessment(call(), call().entry_zones[0], { verdict: 'let_expire', next_check_min: 15 }, NOW, 'zone_trip')
    assert.equal(set.status, 'watching')          // downgraded to stand_aside → watching, not expired
    assert.equal(fireCard, false)                 // no misleading "thesis expired" card
    assert.equal(lastAssessment.verdict, 'stand_aside')
})
test('applyAssessment: PAST-expiry review still on wait → forced expired + fires the expiry card', () => {
    const PAST = Date.parse('2026-07-09T20:30:00Z')   // 30m past valid_until (20:00Z)
    const { set, fireCard, lastAssessment } = _applyAssessment(call(), null, { verdict: 'wait', next_check_min: 5 }, PAST, 'expiry_review')
    assert.equal(set.status, 'expired')           // hard cutoff — no infinite re-assessment loop
    assert.equal(fireCard, true)
    assert.equal(lastAssessment.verdict, 'let_expire')
})

// ── _scheduledPatch ───────────────────────────────────────────────────────
test('scheduledPatch: idle reschedules at max gap; failure retries at min gap', () => {
    assert.equal(_scheduledPatch(call(), NOW)['monitor_state.next_check_at'], new Date(NOW + 60 * 60_000).toISOString())
    assert.equal(_scheduledPatch(call(), NOW, true)['monitor_state.next_check_at'], new Date(NOW + 5 * 60_000).toISOString())
    assert.equal(_scheduledPatch(call(), NOW)['monitor_state.check_count'], 3)
})

// ── _checkCall orchestration (injected IO, no DB/LLM) ─────────────────────
function fakeDb() {
    const updates = []
    return { updates, collection: () => ({ updateOne: async (q, u) => { updates.push({ id: q.id, set: u.$set, push: u.$push }) } }) }
}
const pushedEntry = (u) => u.push?.['monitor_state.timeline']?.$each?.[0]

test('checkCall: no zone + not expiring → cheap scheduled path, no assessment', async () => {
    const db = fakeDb()
    let assessed = false
    const deps = { getPrice: async () => 250, assess: async () => { assessed = true; return {} }, onCard: async () => {}, isAssetOpen: () => true }
    const out = await _checkCall(db, call(), NOW, deps)
    assert.equal(out.reason, 'scheduled')
    assert.equal(assessed, false)                                   // gate short-circuited the LLM
    assert.equal(db.updates[0].set['monitor_state.next_check_at'], new Date(NOW + 60 * 60_000).toISOString())
})

test('checkCall: price in a zone → assessment runs, verdict persisted, card fired on enter', async () => {
    const db = fakeDb()
    let carded = null
    const deps = {
        getPrice: async () => 248.0,   // inside ez1
        assess:   async (c, zone) => ({ verdict: 'enter', timeframe_used: '15min', next_check_min: 20, proposal: { entry: 248, stop: 245, take_profit: [{ price: 252 }] }, memo_update: 'go' }),
        onCard:   async (c, a) => { carded = a },
        isAssetOpen: () => true,
    }
    const out = await _checkCall(db, call(), NOW, deps)
    assert.equal(out.reason, 'zone_trip')
    assert.equal(out.verdict, 'enter')
    assert.equal(db.updates[0].set.status, 'ready')
    assert.equal(db.updates[0].set['monitor_state.armed_zone_id'], 'ez1')
    assert.equal(carded.verdict, 'enter')
})

test('checkCall: failed assessment → retry-soon reschedule, no card', async () => {
    const db = fakeDb()
    let carded = false
    const deps = { getPrice: async () => 248.0, assess: async () => null, onCard: async () => { carded = true }, isAssetOpen: () => true }
    const out = await _checkCall(db, call(), NOW, deps)
    assert.equal(out.failed, true)
    assert.equal(carded, false)
    assert.equal(db.updates[0].set['monitor_state.next_check_at'], new Date(NOW + 5 * 60_000).toISOString())  // min gap
})

test('checkCall: near expiry runs assessment even with no zone tripped', async () => {
    const db = fakeDb()
    const expiringCall = call({ valid_until: new Date(NOW + 5 * 60_000).toISOString() })  // 5m from now
    const deps = { getPrice: async () => 250, assess: async () => ({ verdict: 'let_expire', next_check_min: 5 }), onCard: async () => {}, isAssetOpen: () => true }
    const out = await _checkCall(db, expiringCall, NOW, deps)
    assert.equal(out.reason, 'expiry_review')
    assert.equal(db.updates[0].set.status, 'expired')
})

test('checkCall: market CLOSED + not expiring → skipped (no price, no assess), rescheduled', async () => {
    const db = fakeDb()
    let priced = false, assessed = false
    const deps = {
        getPrice: async () => { priced = true; return 248.0 },
        assess:   async () => { assessed = true; return {} },
        onCard:   async () => {},
        isAssetOpen: () => false,   // market shut for this asset
    }
    const out = await _checkCall(db, call(), NOW, deps)
    assert.equal(out.reason, 'closed')
    assert.equal(priced, false)
    assert.equal(assessed, false)
    assert.equal(db.updates[0].set['monitor_state.next_check_at'], new Date(NOW + 60 * 60_000).toISOString())
})

test('checkCall: a watching call that leaves the zone resets to waiting', async () => {
    const db = fakeDb()
    const deps = { getPrice: async () => 250, assess: async () => ({}), onCard: async () => {}, isAssetOpen: () => true }
    await _checkCall(db, call({ status: 'watching' }), NOW, deps)   // 250 is in no zone → scheduled path
    assert.equal(db.updates[0].set.status, 'waiting')
})

test('checkCall: market CLOSED sleeps until the next open + clears stale watching', async () => {
    const db = fakeDb()
    const openMs = NOW + 3 * 3600_000
    const deps = { getPrice: async () => 248, assess: async () => ({}), onCard: async () => {}, isAssetOpen: () => false, nextOpenMs: () => openMs }
    const out = await _checkCall(db, call({ status: 'watching' }), NOW, deps)
    assert.equal(out.reason, 'closed')
    assert.equal(db.updates[0].set.status, 'waiting')                                            // stale watching cleared
    assert.equal(db.updates[0].set['monitor_state.next_check_at'], new Date(openMs).toISOString())  // sleeps to the open
})

test('checkCall: market CLOSED but EXPIRING → expiry review still runs', async () => {
    const db = fakeDb()
    const expiringCall = call({ valid_until: new Date(NOW + 5 * 60_000).toISOString() })
    const deps = {
        getPrice: async () => 250,
        assess:   async () => ({ verdict: 'let_expire', next_check_min: 5 }),
        onCard:   async () => {},
        isAssetOpen: () => false,
    }
    const out = await _checkCall(db, expiringCall, NOW, deps)
    assert.equal(out.reason, 'expiry_review')
    assert.equal(db.updates[0].set.status, 'expired')
})

// ── _zonesLabel + _timelineEntry (the live monitor journal) ────────────────
test('zonesLabel: joins bands and flags multi', () => {
    assert.deepEqual(_zonesLabel(call()), { text: '247.4–248.6, 244.8–245.2', multi: true })
    assert.equal(_zonesLabel(call({ entry_zones: [{ lower: 100, upper: 101 }] })).multi, false)
    assert.equal(_zonesLabel(call({ entry_zones: [] })).text, '(no zones)')
})

test('timelineEntry: closed wake → holding note, no price, deterministic at', () => {
    const e = _timelineEntry('closed', { nowMs: NOW, call: call(), nextAt: new Date(NOW + 3600_000).toISOString() })
    assert.equal(e.reason, 'closed')
    assert.equal(e.price, null)
    assert.equal(e.verdict, null)
    assert.equal(e.at, new Date(NOW).toISOString())
    assert.match(e.note, /closed/i)
})

test('timelineEntry: scheduled heartbeat → price, zones and gap in the note', () => {
    const e = _timelineEntry('scheduled', { nowMs: NOW, price: 250, call: call(), nextAt: new Date(NOW + 30 * 60_000).toISOString() })
    assert.equal(e.price, 250)
    assert.match(e.note, /250/)
    assert.match(e.note, /247.4–248.6/)
    assert.match(e.note, /30m/)
})

test('timelineEntry: assessment uses the model read + carries verdict/axes', () => {
    const raw = { verdict: 'wait', read: 'coiling under the zone, no trigger yet',
        market: { read: 'calm', score: 'neutral' }, patterns_seen: [{ id: 'p1', present: true, note: 'flag' }] }
    const e = _timelineEntry('zone_trip', { nowMs: NOW, price: 248, zone: call().entry_zones[0], call: call(), raw, nextAt: new Date(NOW + 15 * 60_000).toISOString(), fetched: 'chart 15min' })
    assert.equal(e.verdict, 'wait')
    assert.equal(e.note, 'coiling under the zone, no trigger yet')
    assert.equal(e.zone_id, 'ez1')
    assert.equal(e.fetched, 'chart 15min')
    assert.equal(e.axes.market.score, 'neutral')
    assert.equal(e.axes.patterns_seen.length, 1)
})

test('timelineEntry: assessment with no read → verdict fallback note', () => {
    const e = _timelineEntry('zone_trip', { nowMs: NOW, price: 248, zone: call().entry_zones[0], call: call(), raw: { verdict: 'stand_aside' }, nextAt: null })
    assert.match(e.note, /standing aside/i)
})

test('timelineEntry: failed assessment → retry note, no verdict', () => {
    const e = _timelineEntry('zone_trip', { nowMs: NOW, price: 248, call: call(), failed: true, nextAt: null })
    assert.match(e.note, /failed/i)
    assert.equal(e.verdict, null)
})

// ── _checkCall appends a journal entry on EVERY wake ──────────────────────
test('checkCall: scheduled heartbeat appends a capped journal entry', async () => {
    const db = fakeDb()
    const deps = { getPrice: async () => 250, assess: async () => ({}), onCard: async () => {}, isAssetOpen: () => true }
    await _checkCall(db, call(), NOW, deps)
    const entry = pushedEntry(db.updates[0])
    assert.ok(entry)
    assert.equal(entry.reason, 'scheduled')
    assert.equal(entry.price, 250)
    assert.equal(db.updates[0].push['monitor_state.timeline'].$slice, -50)   // append-only, capped
})

test('checkCall: assessment wake appends an entry with the verdict + read', async () => {
    const db = fakeDb()
    const deps = { getPrice: async () => 248, assess: async () => ({ verdict: 'wait', read: 'not yet', next_check_min: 15 }), onCard: async () => {}, isAssetOpen: () => true }
    await _checkCall(db, call(), NOW, deps)
    const entry = pushedEntry(db.updates[0])
    assert.equal(entry.reason, 'zone_trip')
    assert.equal(entry.verdict, 'wait')
    assert.equal(entry.note, 'not yet')
    assert.ok(entry.fetched)
})

test('checkCall: closed wake appends a holding entry', async () => {
    const db = fakeDb()
    const deps = { getPrice: async () => 248, assess: async () => ({}), onCard: async () => {}, isAssetOpen: () => false, nextOpenMs: () => NOW + 3600_000 }
    await _checkCall(db, call(), NOW, deps)
    assert.equal(pushedEntry(db.updates[0]).reason, 'closed')
})

// ── _withTimeout: a hung check can't wedge the loop ────────────────────────
test('withTimeout: rejects a hung promise after ms (loop self-heals)', async () => {
    await assert.rejects(_withTimeout(new Promise(() => {}), 20), /timed out/)
})
test('withTimeout: passes a fast resolve straight through', async () => {
    assert.equal(await _withTimeout(Promise.resolve('ok'), 1000), 'ok')
})
test('withTimeout: a rejecting check surfaces its own error', async () => {
    await assert.rejects(_withTimeout(Promise.reject(new Error('boom')), 1000), /boom/)
})

// ── _thinkingConfig: reasoning-effort → adaptive thinking ─────────────────
test('thinkingConfig: off / undefined / invalid → null (no thinking, zero cost)', () => {
    assert.equal(_thinkingConfig('off'), null)
    assert.equal(_thinkingConfig(undefined), null)
    assert.equal(_thinkingConfig('bogus'), null)
})
test('thinkingConfig: low/high → adaptive thinking with matching effort (never budget_tokens)', () => {
    assert.deepEqual(_thinkingConfig('low'),  { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } })
    assert.deepEqual(_thinkingConfig('high'), { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } })
    assert.ok(!('budget_tokens' in _thinkingConfig('high').thinking))
})

// ── _assessText: find the text block even past a thinking block ────────────
test('assessText: returns the text block when it is first (no thinking)', () => {
    assert.equal(_assessText({ content: [{ type: 'text', text: '{"verdict":"wait"}' }] }), '{"verdict":"wait"}')
})
test('assessText: skips a leading thinking block to find the JSON text', () => {
    const msg = { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '{"verdict":"enter"}' }] }
    assert.equal(_assessText(msg), '{"verdict":"enter"}')
})
test('assessText: no text block / malformed → empty string (safe for _extractJSON)', () => {
    assert.equal(_assessText({ content: [{ type: 'thinking', thinking: 'x' }] }), '')
    assert.equal(_assessText({}), '')
    assert.equal(_assessText(null), '')
})
