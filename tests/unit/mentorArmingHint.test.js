import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _missingWithHow } from '../../services/agents/mentor.agent.service.js'

// drive:all 2026-11-18: "arming price" alone left Mentor asking the user for six turns for a price he already had.

test('the arming items say which field to set, and from what; every other item is unchanged', () => {
    const out = _missingWithHow(['arming price', 'arming floor on B', 'validity range'])
    assert.match(out, /arming price \(set `arm_close` .*daily close above X" is X\)/)
    assert.match(out, /arming floor on B \(set `arm_floor`.*their stop\)/)
    assert.match(out, /, validity range$/)
    assert.equal(_missingWithHow([]), '')
})
