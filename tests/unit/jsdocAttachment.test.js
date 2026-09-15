import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

// A DOC BLOCK THAT DOCUMENTS NOTHING.
//
// Two `/** … */` blocks in a row: the first describes a function that is no longer underneath it.
// It happens when code moves — a function is lifted to another file, or reordered, and its comment
// stays behind — and the result is worse than a missing comment, because the orphan now sits
// directly above the NEXT function and reads as its description.
//
// This was found in §2, again in §3, and a repo-wide sweep in the §2–§3 QA cycle moved five blocks
// and reported the scan "clean repo-wide". It was not. §5 found three more that the sweep itself
// had run straight past — in agentIO (runAgentStream's block above agentKeyFromLog), assess.shared
// (TWO blocks stacked above lensLine) and setup.schema (computeRR's above _edge). The sweep commit
// landed AFTER the commits that created two of them, so it had every chance.
//
// That is the whole reason this file exists. A one-off grep is a memory, not a check: it is correct
// on the day it is run and says nothing the day after. The same lesson the archive loader and
// STATE_PROJECTION's coverage test are already instances of.

const SKIP_DIRS = new Set(['node_modules', '.git', 'archive', 'data', 'tests'])

function jsFiles(dir, out = []) {
    for (const e of readdirSync(dir)) {
        if (SKIP_DIRS.has(e)) continue
        const p = join(dir, e)
        try {
            if (statSync(p).isDirectory()) jsFiles(p, out)
            else if (e.endsWith('.js')) out.push(p)
        } catch { /* unreadable entry — skip it, never abort the walk */ }
    }
    return out
}

/**
 * A block closer immediately followed by a block opener. Whitespace-only lines between them still
 * count: the orphan is just as stranded with a blank line under it.
 *
 * TWO shapes are legitimate stacks and neither is a finding:
 *
 *   • the MODULE HEADER — a block at the top of the file, with no code above it, describing the
 *     file rather than the declaration beneath it. Most services here open with one, and the first
 *     function's own block follows it directly. Excluded by "has any code appeared yet", not by
 *     "is it line 1", so a header after an eslint pragma or an import still reads as a header.
 *   • stacked `@typedef`s — a file-level list of type definitions documents types, not the code
 *     under it, so price.service's four in a row are correct.
 */
function strandedBlocks(src) {
    const lines = src.split(/\r?\n/)
    const hits  = []
    let sawCode = false   // has anything that is not a comment or a blank line appeared above?

    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim()

        if (!t.startsWith('/*')) {
            if (t && !t.startsWith('//')) sawCode = true
            continue
        }

        let end = i
        while (end < lines.length && !lines[end].trim().endsWith('*/')) end++

        let next = end + 1
        while (next < lines.length && lines[next].trim() === '') next++

        const stacked = next < lines.length && lines[next].trim().startsWith('/**')
        const body    = lines.slice(i, end + 1).join(' ')
        // Only a `/**` block is DOCUMENTATION. A plain `/* … */` is a pragma — klineRender's
        // `/* c8 ignore stop */` sits directly above a real JSDoc block and is not an orphan.
        const isDoc   = t.startsWith('/**')
        // `sawCode` false → this is the module header, describing the file rather than what follows.
        if (isDoc && stacked && sawCode && !/@typedef/.test(body)) {
            hits.push({ line: end + 1, preview: (lines[i + 1] ?? '').trim().replace(/^\*\s?/, '').slice(0, 72) })
        }
        i = end
    }
    return hits
}

test('no JSDoc block is left documenting nothing', () => {
    const offenders = []
    for (const file of jsFiles(ROOT)) {
        const rel = file.slice(ROOT.length + 1).split(sep).join('/')
        for (const h of strandedBlocks(readFileSync(file, 'utf8'))) {
            offenders.push(`${rel}:${h.line}  — "${h.preview}"`)
        }
    }
    assert.deepEqual(offenders, [],
        `doc block(s) with no function under them:\n  ${offenders.join('\n  ')}`)
})

// The detector itself, because a check that silently stops detecting is worse than none. Each
// fixture opens with a line of code: a stranded block at the very TOP of a file is a module header,
// which is the one shape that is never a finding.
test('the detector finds a stranded block', () => {
    const src = ['const x = 1', '/**', ' * first', ' */', '/**', ' * second', ' */', 'export function f() {}'].join('\n')
    assert.equal(strandedBlocks(src).length, 1)
})

test('the detector still finds one across a blank line', () => {
    const src = ['const x = 1', '/**', ' * first', ' */', '', '/**', ' * second', ' */', 'function f() {}'].join('\n')
    assert.equal(strandedBlocks(src).length, 1)
})

test('stacked @typedef blocks are not a finding', () => {
    const src = ['/** @typedef {string} A */', '/**', ' * @typedef {number} B', ' */', 'const x = 1'].join('\n')
    assert.deepEqual(strandedBlocks(src), [])
})

test('an ordinary documented function is not a finding', () => {
    const src = ['/**', ' * does a thing', ' */', 'export function f() {}', '', '/**', ' * another', ' */', 'export function g() {}'].join('\n')
    assert.deepEqual(strandedBlocks(src), [])
})

// The module header — a block at the top of the file describing the FILE, with the first
// declaration's own block directly under it. Most services here open exactly this way, and five of
// them (number.util, normalize, brokerSymbol, newsArticle, monitorSchedule) were the detector's
// first false positives. "Has any code appeared above it" is the discriminator, not "is it line 1",
// so a header sitting under an eslint pragma or an import still reads as a header.
test('a module header above the first function is not a finding', () => {
    const src = ['/**', ' * What this file is.', ' */', '', '/**', ' * does a thing', ' */', 'export function f() {}'].join('\n')
    assert.deepEqual(strandedBlocks(src), [])
})

test('but a stranded block AFTER code still is', () => {
    const src = [
        '/**', ' * What this file is.', ' */', '',
        'export function a() {}', '',
        '/**', ' * orphaned', ' */',
        '/**', ' * documents b', ' */',
        'export function b() {}',
    ].join('\n')
    assert.equal(strandedBlocks(src).length, 1)
})

// A pragma is not documentation. klineRender.provider has `/* c8 ignore stop */` directly above a
// real JSDoc block — a plain `/* … */` opener, so it never described anything to begin with.
test('a single-line pragma above a doc block is not a finding', () => {
    const src = ['const x = 1', '/* c8 ignore stop */', '/**', ' * documents f', ' */', 'function f() {}'].join('\n')
    assert.deepEqual(strandedBlocks(src), [])
})
