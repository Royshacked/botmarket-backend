import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _entryTimeGate } from '../../monitoring/minos.monitor.service.js'

// _entryTimeGate classifies an idea's entry tree for the off-hours monitor logic:
//   allTime  → pure scheduled entry, monitored even when the market is closed
//   after    → governing bound, drives the 'passed_earlier' / 'off_hours' card note
// See project_timestamp_ideas (Phase 4).

const AFTER = '2026-07-13T20:40:00Z'
const AFTER_MS = Date.parse(AFTER)

const tree = (...children) => ({ operator: 'AND', children })
const timeLeaf  = (after = AFTER) => ({ condition: 'on/after 16:40', type: 'time', after, before: null, timeframe: null })
const priceLeaf = () => ({ condition: 'breaks above 100', type: 'structured', timeframe: '15min' })

test('pure time entry → timeGated + allTime, after parsed', () => {
    const g = _entryTimeGate({ entry_condition_tree: tree(timeLeaf()) })
    assert.deepEqual(g, { timeGated: true, allTime: true, after: AFTER_MS })
})

test('mixed time + price entry → timeGated but NOT allTime (market still needed)', () => {
    const g = _entryTimeGate({ entry_condition_tree: tree(timeLeaf(), priceLeaf()) })
    assert.equal(g.timeGated, true)
    assert.equal(g.allTime, false)
    assert.equal(g.after, AFTER_MS)
})

test('price-only entry → not time gated at all', () => {
    const g = _entryTimeGate({ entry_condition_tree: tree(priceLeaf()) })
    assert.deepEqual(g, { timeGated: false, allTime: false, after: null })
})

test('multiple time leaves → after is the LATEST bound (AND fully open)', () => {
    const earlier = '2026-07-13T18:00:00Z'
    const g = _entryTimeGate({ entry_condition_tree: tree(timeLeaf(earlier), timeLeaf(AFTER)) })
    assert.equal(g.allTime, true)
    assert.equal(g.after, AFTER_MS)   // max(18:00, 20:40)
})

test('time leaf with no after bound (before-only / empty) → gated, after null', () => {
    const g = _entryTimeGate({ entry_condition_tree: tree(timeLeaf(null)) })
    assert.equal(g.timeGated, true)
    assert.equal(g.allTime, true)
    assert.equal(g.after, null)
})

test('legacy flat entry_conditions array is handled', () => {
    const g = _entryTimeGate({ entry_conditions: [timeLeaf()], entry_logic: 'AND' })
    assert.equal(g.timeGated, true)
    assert.equal(g.allTime, true)
    assert.equal(g.after, AFTER_MS)
})

test('no entry conditions → all false, never throws', () => {
    assert.deepEqual(_entryTimeGate({}), { timeGated: false, allTime: false, after: null })
    assert.deepEqual(_entryTimeGate(null), { timeGated: false, allTime: false, after: null })
})
