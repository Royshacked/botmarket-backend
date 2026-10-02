// House cards are ONE ask posted once per admin. When one admin settles their copy, the others'
// copies settle with it (2026-10-02: Marce opened Prometheus cards and Roy's copies sat pending).
// Only a `done` carries over — dismiss is personal. These pin the pure halves of that rule; chat.service.resolveMessage applies them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { houseTwinQuery, houseTwinPatch } from '../../api/chat/chat.service.js'

const HOUSE = { type: 'coverage_refreshed', visibility: 'admin', subject: { kind: 'coverage', id: 'cov_BAC_1' } }

test('a house card finds the other admins\' pending copies of the same ask', () => {
    assert.deepEqual(houseTwinQuery(HOUSE, 'msg_1'), {
        id:             { $ne: 'msg_1' },
        type:           'coverage_refreshed',
        visibility:     'admin',
        status:         'pending',
        'subject.kind': 'coverage',
        'subject.id':   'cov_BAC_1',
    })
})

test('a personal card has no twins — one user\'s card never settles another\'s', () => {
    assert.equal(houseTwinQuery({ ...HOUSE, visibility: 'own' }, 'm'), null)
    assert.equal(houseTwinQuery({ ...HOUSE, visibility: 'all' }, 'm'), null)
    assert.equal(houseTwinQuery({ ...HOUSE, visibility: undefined }, 'm'), null)
})

test('a card that names no subject is left alone rather than guessed at', () => {
    assert.equal(houseTwinQuery({ ...HOUSE, subject: null }, 'm'), null)
    assert.equal(houseTwinQuery({ ...HOUSE, subject: { kind: 'coverage' } }, 'm'), null)
    assert.equal(houseTwinQuery({ ...HOUSE, type: null }, 'm'), null)
    assert.equal(houseTwinQuery(null, 'm'), null)
})

test('the type is part of the ask — a verdict card and a re-model card on one name are different asks', () => {
    assert.equal(houseTwinQuery({ ...HOUSE, type: 'coverage_event' }, 'm').type, 'coverage_event')
})

test('dismiss is personal — one admin waving a card away leaves the other admin copy standing', () => {
    assert.equal(houseTwinQuery(HOUSE, 'm', 'dismissed'), null)
    assert.equal(houseTwinQuery(HOUSE, 'm', 'pending'), null, 'a touch is not a settlement either')
    assert.ok(houseTwinQuery(HOUSE, 'm', 'done'))
})

test('the twin carries the same settlement and says who made it', () => {
    assert.deepEqual(houseTwinPatch('done', 'opened', 'marce', 42), { status: 'done', resolvedAt: 42, resolveOutcome: 'opened', resolveNote: 'by marce' })
    assert.deepEqual(houseTwinPatch('done', null, null, 7), { status: 'done', resolvedAt: 7, resolveOutcome: null, resolveNote: null })
})
