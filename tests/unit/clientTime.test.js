import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _formatClientTime } from '../../services/idea.agent.service.js'

// _formatClientTime renders the browser instant in its IANA zone so the idea agent can
// convert "enter at 16:40" (local) to a correct UTC `after`/`before`. Pins the piece we
// own; the LLM conversion itself can't be unit-tested. See project_timestamp_ideas (P2).

// 2026-07-13T13:24:00Z — a fixed instant (no Date.now()).
const NOW = Date.parse('2026-07-13T13:24:00Z')

test('renders local wall-clock + IANA zone + offset for a +offset zone', () => {
    const s = _formatClientTime({ clientNow: NOW, clientTz: 'Asia/Jerusalem' })
    // 13:24 UTC → 16:24 in Jerusalem (UTC+3 in July / DST).
    assert.match(s, /16:24/)
    assert.match(s, /Asia\/Jerusalem/)
    assert.match(s, /GMT\+03:00/)
})

test('renders a -offset zone correctly (US Eastern, DST)', () => {
    const s = _formatClientTime({ clientNow: NOW, clientTz: 'America/New_York' })
    assert.match(s, /09:24/)          // 13:24 UTC → 09:24 EDT
    assert.match(s, /GMT-04:00/)
})

test('null when timezone is missing', () => {
    assert.equal(_formatClientTime({ clientNow: NOW }), null)
    assert.equal(_formatClientTime({ clientNow: NOW, clientTz: '' }), null)
    assert.equal(_formatClientTime(null), null)
    assert.equal(_formatClientTime(undefined), null)
})

test('null on an invalid IANA timezone (never throws)', () => {
    assert.equal(_formatClientTime({ clientNow: NOW, clientTz: 'Not/AZone' }), null)
    assert.equal(_formatClientTime({ clientNow: NOW, clientTz: 'garbage' }), null)
})

test('falls back to a valid instant when clientNow is absent/bad', () => {
    // No throw, and still renders the zone (uses Date.now() internally).
    const s = _formatClientTime({ clientTz: 'UTC' })
    assert.match(s, /UTC/)
    assert.equal(_formatClientTime({ clientNow: NaN, clientTz: 'UTC' }).includes('UTC'), true)
})
