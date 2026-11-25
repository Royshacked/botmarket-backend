import { test } from 'node:test'
import assert from 'node:assert/strict'

import { happensOn, effectWindow, effectEnded, agreeTimes, START_DAYS, LAST_DAYS } from '../../services/situation/horizon.js'
import { mapSchema, shapeEffects, agreeEffects, scoreIndustries } from '../../services/situation/industries.js'
import { withMacroScores } from '../../services/situation/layers.js'
import { checkNode } from '../../services/situation/model.js'

const asOf = '2026-11-25'
const live = (resolve_by) => ({ node_id: 'n', status: 'live', resolve_by, options: [{ key: 'a', label: 'a', p: 1 }, { key: 'b', label: 'b', p: 0 }] })
const done = (on, over = {}) => ({ ...live('2026-12-31'), status: 'resolved', resolved: { option: 'a', on }, ...over })

test('happensOn: a live question on its resolve-by date (today when past or missing), a resolved one when it resolved', () => {
    assert.equal(happensOn(live('2027-02-10'), asOf), '2027-02-10')
    assert.equal(happensOn(live('2026-11-01'), asOf), asOf)
    assert.equal(happensOn(live(null), asOf), asOf)
    assert.equal(happensOn(done('2026-11-23'), asOf), '2026-11-23')
    assert.equal(happensOn(done(null), asOf), '2026-12-31')
    assert.equal(happensOn(done(null, { resolve_by: null }), asOf), null)
})

test('effectWindow: answered this quarter, felt for years (Roy, 2026-11-25); no times reads as now + quarters', () => {
    assert.deepEqual(effectWindow(live('2026-12-05'), { starts: 'months', lasts: 'years' }, asOf), { from: 70, to: 800 })
    assert.deepEqual(effectWindow(live('2026-12-05'), {}, asOf), { from: 10, to: 280 })
})

test('effectEnded: only a resolved question, only past its length; one that cannot be dated never ends', () => {
    const e = { starts: 'now', lasts: 'weeks' }
    assert.equal(effectEnded(done('2026-10-12'), e, asOf), false, '44 days')
    assert.equal(effectEnded(done('2026-10-11'), e, asOf), true, '45 days')
    assert.equal(effectEnded(done('2026-10-11'), { starts: 'now', lasts: 'years' }, asOf), false)
    assert.equal(effectEnded(live('2025-01-01'), e, asOf), false)
    assert.equal(effectEnded(done(null, { resolve_by: null }), e, asOf), false)
    assert.equal(effectEnded(done('2020-01-01'), e, null), false, 'no run date: nothing expires')
})

test('the mapping: the schema asks for both; a bad value is left out, not the effect; agreement takes the later start, the shorter length', () => {
    const item = mapSchema().properties.branches.items.properties.effects.items
    assert.ok(item.required.includes('starts') && item.required.includes('lasts'))
    assert.deepEqual(item.properties.starts.enum, Object.keys(START_DAYS))
    assert.deepEqual(item.properties.lasts.enum, Object.keys(LAST_DAYS))
    const branches = [{ node_id: 'n', option: 'a' }]
    const fx = shapeEffects({ branches: [{ branch: 1, effects: [{ code: 'X', direction: 'up', bucket: 'small', why: 'w', starts: 'now', lasts: 'forever' }] }] }, branches, new Set(['X'])).effects.get('n|a')
    assert.deepEqual(fx, [{ code: 'X', direction: 'up', bucket: 'small', why: 'w', starts: 'now' }])
    const E = (starts, lasts) => new Map([['n|a', [{ code: 'X', direction: 'up', bucket: 'small', starts, lasts }]]])
    assert.deepEqual(agreeEffects(E('now', 'years'), E('months', 'quarters')).effects.get('n|a'), [{ code: 'X', direction: 'up', bucket: 'small', starts: 'months', lasts: 'quarters' }])
    assert.deepEqual(agreeTimes({}, {}), {})
    assert.deepEqual(agreeTimes({ starts: 'months', lasts: 'years' }, {}), { starts: 'months', lasts: 'quarters' })
})

test('checkNode keeps the times through a save; an effect without them stays without', () => {
    const base = { tree: 't', question: 'Q?', options: [{ key: 'a', label: 'a', p: 0.5, effects: [{ code: 'X', direction: 'up', bucket: 'small', starts: 'months', lasts: 'years' }, { code: 'Y', direction: 'up', bucket: 'small' }] }, { key: 'b', label: 'b', p: 0.5 }] }
    const [x, y] = checkNode(base).value.options[0].effects
    assert.equal(x.starts, 'months'); assert.equal(x.lasts, 'years')
    assert.ok(!('starts' in y) && !('lasts' in y))
})

test('scoring: a resolved effect that has ended leaves the score and its industry the rows; a longer one of the same question stays; the macro score too', () => {
    const n = done('2026-01-10', { resolve_by: '2026-01-31' })
    const effects = new Map([['n|a', [{ code: 'SHORT', direction: 'up', bucket: 'large', starts: 'now', lasts: 'weeks' }, { code: 'LONG', direction: 'up', bucket: 'large', starts: 'now', lasts: 'years' }]]])
    const inds = [{ code: 'SHORT', name: 'S', level: 'industry' }, { code: 'LONG', name: 'L', level: 'industry' }]
    const rows = scoreIndustries([n], [], effects, inds, { samples: 50, asOf })
    assert.deepEqual(rows.map(r => [r.code, r.p_win]), [['LONG', 1]])
    assert.equal(scoreIndustries([n], [], effects, inds, { samples: 50 }).length, 2)
    assert.equal(withMacroScores([{ code: 'SHORT' }], [n], [], effects, inds, { asOf })[0].macro.p_win, 0)
})
