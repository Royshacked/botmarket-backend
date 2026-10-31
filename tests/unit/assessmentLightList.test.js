import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assessmentRow, industryAssessmentService, _setAssessmentIO } from '../../api/strategy/industryAssessment.service.js'
import { _setCallsIO } from '../../api/strategy/pythiaCalls.service.js'
import { _setThemeIO } from '../../api/strategy/theme.service.js'
import { listAssessments, getThemeAssessment } from '../../api/strategy/strategy.controller.js'
import { memDb } from '../helpers/memDb.js'

// The Assessed board's light list (docs/design/assessment-light-list.md): the list carries what a closed row shows,
// an opened row fetches the rest; the full list stays for old bundles; a theme's detail has its own route.

const NOW = '2026-10-13T12:00:00.000Z'
const FULL = (over = {}) => ({
    id: 'ia_ind_45301020', subject: { kind: 'industry', code: '45301020', name: 'Semiconductors', sector: 'Information Technology' },
    verdict: 'swing', horizon: 'weeks', decides_by: null, question: null, thesis: 'AI capex still rising.',
    evidence: { news: 'a long news paragraph', price: 'a long price paragraph' }, cause: { kind: 'money', text: 'capex raised' },
    second_order: 'power next', risks: ['a pause'], change_view_if: ['a cut'], confidence: 'medium',
    moved: { hype: true, ret_12m: 0.6, excess_12m: 0.45 }, money: { capex_change: 0.5 }, flows: { insiders: {} }, geopolitics: { world: 1 },
    base_rates: [{ key: 'hype', text: 'x' }], structure: { demand: 'growing' }, gaps: [], trigger: null,
    assessed_at: NOW, expires_at: '2026-10-27T12:00:00.000Z', revisions: [{ kind: 'assessment', note: 'internal' }],
    ...over,
})
const THEME_DOC = (over = {}) => FULL({ id: 'ia_th_ai', subject: { kind: 'theme', id: 'th_ai', name: 'AI compute', sector: null }, ...over })

const HEAVY = ['evidence', 'second_order', 'risks', 'change_view_if', 'money', 'flows', 'geopolitics', 'base_rates', 'structure', 'revisions', 'question', 'confidence']

function res() {
    return { code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this }, send(b) { this.body = b; return this } }
}

async function seed({ themeStatus = 'approved' } = {}) {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    _setCallsIO({ db: async () => m.db })
    _setThemeIO({ db: async () => m.db })
    for (const d of [FULL(), FULL({ id: 'ia_ind_1', subject: { kind: 'industry', code: '1', name: 'Steel', sector: 'Materials' }, verdict: 'watch', decides_by: '2026-10-20' }), THEME_DOC()]) {
        await m.db.collection('industry_assessment').insertOne(structuredClone(d))
    }
    await m.db.collection('theme').insertOne({ id: 'th_ai', name: 'AI compute', status: themeStatus, links: [] })
    return m
}

test('a closed row carries what the row shows and the cache key — nothing heavy', () => {
    const r = assessmentRow(FULL())
    assert.deepEqual(Object.keys(r).sort(), ['assessed_at', 'cause', 'decides_by', 'expires_at', 'horizon', 'id', 'long_term', 'moved', 'subject', 'thesis', 'verdict'])
    assert.deepEqual(r.cause, { kind: 'money' }, 'the chip reads the kind only')
    assert.deepEqual(r.moved, { hype: true }, 'the chip reads the flag only')
    for (const k of HEAVY) assert.equal(k in r, false, k)
    assert.deepEqual(assessmentRow({}).moved, { hype: null })
    assert.equal(assessmentRow({}).cause, null)
})

test('the light list is the same rows in the same order, far smaller', async () => {
    await seed()
    const full = await industryAssessmentService.listAssessments()
    const rows = await industryAssessmentService.listAssessmentRows()
    assert.deepEqual(rows.map(r => r.id), full.map(r => r.id))
    assert.ok(JSON.stringify(rows).length < JSON.stringify(full).length / 2)
    for (const r of rows) for (const k of HEAVY) assert.equal(k in r, false, `${r.id}.${k}`)
})

test('GET /assessments: ?view=rows sends rows; without it, the full list as before; a retired theme hidden either way', async () => {
    await seed({ themeStatus: 'retired' })
    const light = res()
    await listAssessments({ query: { view: 'rows' }, method: 'GET', originalUrl: '/x' }, light)
    assert.deepEqual(light.body.assessments.map(a => a.id), ['ia_ind_45301020', 'ia_ind_1'])
    assert.equal('evidence' in light.body.assessments[0], false)
    assert.ok(light.body.record, 'the track record still rides')
    const full = res()
    await listAssessments({ query: {}, method: 'GET', originalUrl: '/x' }, full)
    assert.deepEqual(full.body.assessments.map(a => a.id), ['ia_ind_45301020', 'ia_ind_1'])
    assert.equal(full.body.assessments[0].evidence.news, 'a long news paragraph')
})

test("GET /assessments/theme/:id: an approved theme's detail, its trail for admins only; a retired or unknown theme is 404", async () => {
    await seed()
    const trader = res()
    await getThemeAssessment({ params: { id: 'th_ai' }, user: { role: 'trader' }, method: 'GET', originalUrl: '/x' }, trader)
    assert.equal(trader.body.id, 'ia_th_ai')
    assert.equal(trader.body.evidence.news, 'a long news paragraph')
    assert.equal('revisions' in trader.body, false)
    const admin = res()
    await getThemeAssessment({ params: { id: 'th_ai' }, user: { role: 'admin' }, method: 'GET', originalUrl: '/x' }, admin)
    assert.equal(admin.body.revisions.length, 1)
    const unknown = res()
    await getThemeAssessment({ params: { id: 'th_nope' }, user: { role: 'trader' }, method: 'GET', originalUrl: '/x' }, unknown)
    assert.equal(unknown.code, 404)
    await seed({ themeStatus: 'retired' })
    const retired = res()
    await getThemeAssessment({ params: { id: 'th_ai' }, user: { role: 'trader' }, method: 'GET', originalUrl: '/x' }, retired)
    assert.equal(retired.code, 404)
})
