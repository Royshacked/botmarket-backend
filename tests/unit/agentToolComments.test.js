import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../services/agents')

// A HALF-REMOVED TOOL LEAVES ITS COMMENTS BEHIND, and nothing notices.
//
// A tool block is a `name: description` entry with a paragraph above it saying when the desk should
// reach for it. Delete the entry and keep the prose — what happens when a tool is pulled in a hurry
// — and what is left is a prompt-shaped instruction attached to nothing, describing a capability the
// agent does not have. Worse, it now sits above the NEXT entry and reads as though it describes it.
//
// Found four times: mentor (§3, with `_MENTOR_AETHER_HANDLERS`), then portfolio, analyst and scanner
// (§4) — every one of them the same retired Aether block.
//
// WHAT THIS CHECK CAN AND CANNOT DO, stated plainly so nobody trusts it further than it goes.
//
// It catches the two MECHANICAL halves: a comment that names a tool the agent does not declare, and
// an empty handler map still spread into the live handlers (two of the four had one). Both are
// exact, and both are how the damage usually shows.
//
// It does NOT catch the Aether comments themselves. They never named a tool — they described one in
// prose ("channel exposure for the name under research… returns 'not yet computed' when Phase 3 has
// not run"), and no pattern separates that from any other paragraph. Those four were found by
// reading the file, which remains the only way to find the next one. A check that quietly failed to
// look for the thing it is named after would be worse than no check, so: this covers the flank, not
// the front.

const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.agent.service.js'))

/**
 * An EMIT TAG is not a tool, and the two vocabularies look alike: `screen_request` is something the
 * model writes into its answer (`<screen_request>…`), `screen_candidates` is something it calls.
 * A comment about an emit tag is not an orphan, so tell them apart by the thing that actually
 * distinguishes them — an emit tag appears in angle brackets somewhere in the same file — rather
 * than by a list of names to remember to update.
 */
const isEmitTag = (src, name) => src.includes(`<${name}>`) || src.includes(`'${name}'`)

test('no agent comments a tool it does not declare', async () => {
    const offenders = []

    for (const file of files) {
        const src  = readFileSync(join(AGENTS_DIR, file), 'utf8')
        const mod  = await import(`../../services/agents/${file}`)
        // Every desk exposes its tools as an array of {name} or a name-keyed object.
        const tools = mod.TOOLS ?? mod.SCANNER_TOOLS ?? []
        const declared = new Set(Array.isArray(tools) ? tools.flatMap(t => (t?.name ? [t.name] : Object.keys(t ?? {}))) : Object.keys(tools))
        if (!declared.size) continue

        src.split(/\r?\n/).forEach((line, i) => {
            const m = line.match(/^\s*\/\/.*?\b(get_[a-z_]+|check_[a-z_]+|screen_[a-z_]+)\b/)
            if (!m) return
            const name = m[1]
            if (declared.has(name) || isEmitTag(src, name)) return
            offenders.push(`${file}:${i + 1} mentions ${name}, which it does not declare`)
        })
    }

    assert.deepEqual(offenders, [], `orphaned tool comment(s):\n  ${offenders.join('\n  ')}`)
})

// The other half of the same failure: a handler map that survives its tools is an empty object
// spread into the live map — legal, invisible, and a promise that handlers exist.
test('no agent spreads an empty handler map into its live handlers', () => {
    const offenders = []
    for (const file of files) {
        const src = readFileSync(join(AGENTS_DIR, file), 'utf8')
        for (const m of src.matchAll(/const\s+([A-Za-z_]+)\s*=\s*\{\s*\}\s*$/gm)) {
            if (src.includes(`...${m[1]},`)) offenders.push(`${file}: ${m[1]} is empty and still spread`)
        }
    }
    assert.deepEqual(offenders, [], `empty handler map(s):\n  ${offenders.join('\n  ')}`)
})
