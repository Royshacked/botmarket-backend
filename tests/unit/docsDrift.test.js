import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, check, slug } from '../../scripts/check-docs-drift.mjs'

// The docs-drift scanner's verdicts on the cases the 2026-09-19 code review found it getting
// wrong. Each one is a claim shape the docs actually use, checked against the REAL tree — so a
// case here can also start failing because the tree changed (a probe file appears), which is the
// right kind of failure: the probe names are chosen to be things this repo will never have.

const DOC = 'docs/README.md'
const verdict = raw => {
    const c = classify(raw)
    return c ? check(c, DOC).verdict : 'skipped'
}

test('a single-word filename the tree lacks is missing, not the pair of words around its dot', () => {
    // `logger.js` used to fall into the dotted check, where `js` is a member every corpus has
    assert.equal(verdict('nothingatall.js'), 'missing')
    assert.equal(verdict('logger.js'), 'missing')
})

test('a module name the tree lacks is missing, however many comments still mention its first half', () => {
    // the modelRouter drift (710c836) — `modelRouter` survives in a test comment, `service` everywhere
    assert.equal(verdict('modelRouter.service'), 'missing')
    assert.equal(verdict('broker.service'), 'ok')
})

test('a package call still reads as a call when its head is a dependency', () => {
    assert.equal(verdict('express.json'), 'ok')
})

test('a route with a trailing slash is a route, not a regex literal', () => {
    assert.equal(classify('/api/nonexistent-thing/')?.kind, 'route')
    assert.equal(verdict('/api/nonexistent-thing/'), 'missing')
    assert.equal(classify('/vwap/i'), null)
})

test('an anchor on a markdown target is a heading, not a word in the file', () => {
    assert.equal(verdict('docs/architecture/monitoring.md#overview'), 'ok')
    assert.equal(verdict('docs/architecture/monitoring.md#no-such-heading-ever'), 'missing')
})

test('a sibling repo path outside src/ resolves from the workspace root', () => {
    assert.equal(verdict('botmarket-frontend/docs/hand-offs.md'), 'ok')
})

test('the slug keeps underscores, as GitHub does', () => {
    assert.equal(slug('foo_bar'), 'foo_bar')
    assert.equal(slug('Escalation — cheapest thing'), 'escalation--cheapest-thing')
    assert.equal(slug('8. Workspaces & venue awareness'), '8-workspaces--venue-awareness')
})

test('a bare @word is prose; a dependency claim is @scope/pkg or a name in package.json', () => {
    assert.equal(classify('@param'), null)
    assert.equal(classify('@returns'), null)
    assert.equal(classify('@stoqey/ib')?.kind, 'dep')
    assert.equal(verdict('@stoqey/ib'), 'ok')
})

test("the docs' shorthand for a three-part module resolves to it", () => {
    assert.equal(verdict('tilt.monitor'), 'ok')
    assert.equal(verdict('coverage.monitor'), 'ok')
    assert.equal(verdict('nosuch.monitor'), 'missing')
})

test('a URL path to a static asset resolves against the served roots', () => {
    assert.equal(verdict('/img/prometheus-bot.svg'), 'ok')
    assert.equal(verdict('/img/no-such-glyph.svg'), 'missing')
})
