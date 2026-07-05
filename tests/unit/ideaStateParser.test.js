import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _parseResponse, emptyAnalysisState } from '../../services/idea.stateParser.js'

// Builds a raw agent turn with a <state> block wrapping the given pending_trade.
function turn(pendingTrade, { asset = 'AAPL', reply = 'ok.' } = {}) {
    const state = {
        recent_chat_summary: '',
        structured_state: { active_asset: asset, pending_trade: pendingTrade },
    }
    return `<asset>${asset}</asset>\n<phase>4</phase>\n${reply}\n<state>${JSON.stringify(state)}</state>`
}

const basePt = {
    direction: 'long',
    entry_conditions: [], stop_conditions: [], tp_conditions: [],
}

test('rr: parsed through when the model emits it', () => {
    const { updatedState } = _parseResponse(turn({ ...basePt, rr: 2.5 }), null, 'aapl long')
    assert.equal(updatedState.structured_state.pending_trade.rr, 2.5)
})

test('rr: carried forward when a later turn omits it (no flicker)', () => {
    const first = _parseResponse(turn({ ...basePt, rr: 2.5 }), null, 'aapl long')
    // next turn re-emits pending_trade but drops rr
    const { updatedState } = _parseResponse(turn(basePt), first.updatedState, 'tighten stop')
    assert.equal(updatedState.structured_state.pending_trade.rr, 2.5)
})

test('rr: a string ratio is coerced to a number', () => {
    const { updatedState } = _parseResponse(turn({ ...basePt, rr: '1.8' }), null, 'aapl long')
    assert.equal(updatedState.structured_state.pending_trade.rr, 1.8)
})

test('rr: recomputed value overrides the carried-forward one', () => {
    const first = _parseResponse(turn({ ...basePt, rr: 2.5 }), null, 'aapl long')
    const { updatedState } = _parseResponse(turn({ ...basePt, rr: 1.2 }), first.updatedState, 'wider stop')
    assert.equal(updatedState.structured_state.pending_trade.rr, 1.2)
})

test('rr: 0 (never a valid reward-to-risk) is normalized to null', () => {
    // Guards the intentional `Number(pt.rr) || null` behavior — a real R:R is
    // always > 0, so a 0 emitted by the model is treated as "not measurable yet".
    const { updatedState } = _parseResponse(turn({ ...basePt, rr: 0 }), null, 'aapl long')
    assert.equal(updatedState.structured_state.pending_trade.rr, null)
})

test('emptyAnalysisState seeds rr as null', () => {
    assert.equal(emptyAnalysisState().structured_state.pending_trade.rr, null)
})
