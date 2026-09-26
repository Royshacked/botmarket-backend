// A setup BLUEPRINT — the plan, detached from whoever is going to trade it.
//
// `setup.schema.js` is the contract for a setup that BELONGS to someone: it binds to an account,
// carries a broker symbol, a workspace mode, a monitor state and a size. A blueprint is the other
// half of that sentence — the part that is true regardless of whose money is behind it. Prices,
// conditions, direction, horizon, lens. Nothing else.
//
// ── THE CALLER: A SHARED SETUP (wired 2026-09-21) ────────────────────────────
// It was built for the EXPRESS SETUP FORM, which is gone (2026-08-21): a user who arrives with the
// plan already made is INTERVIEWED for it instead — Mentor asks one question at a time and draws
// the bands from the answers (see "The interview" in its prompt). The blueprint was never the
// form's idea, though. It is the answer to a separate question — how a plan travels between two
// people — and that is what it does now: `setupShare.service.shareSetup` snapshots an owned setup with
// `toBlueprint` and posts it as a `setup_shared` card into a social-chat DM; the recipient's
// "Open in Mentor" runs it back through `/api/setups/blueprint` (`hydrateBlueprint` +
// `normalizeSetup` + `blueprintProblems`) and lands the draft in THEIR Mentor worksheet.
//
// The copy is a FORK. The card carries the blueprint inline, so it keeps opening after the sender
// revises or deletes the original, and nothing links the two documents afterwards. `from` is the
// only trace, and it is provenance, not a pointer.
//
// ── QUANTITY IS THE FIELD A BLUEPRINT CANNOT HOLD ────────────────────────────
// Stripped on the way out AND on the way in, which is deliberate belt-and-braces rather than an
// oversight: size is a function of the account it rides, the risk the holder is willing to take
// and the balance behind it. It is the one number in a setup that is JUDGMENT about a person
// rather than DATA about a trade (see the data-vs-judgment principle in CLAUDE.md). Stripping it
// on hydrate is also the security property — a blueprint that arrived from somewhere else cannot
// hand you a pre-sized position, however it was authored.
//
// The practical consequence is worth stating because it looks like a bug the first time: a
// hydrated blueprint ALWAYS fails `setupReadiness` on `quantity`. That is the feature. Nobody
// generates, arms or fires someone else's plan without having typed the size themselves.
//
// ── What else is deliberately absent ─────────────────────────────────────────
// Everything the save path stamps for itself (setup.finalize / setups.service): accounts, broker,
// broker_symbol, basis_offset, mode, event_risk, status, monitor_state, armed_*, ownership, and
// the flat `entry_legs`/`stop_legs`/`target_legs` projection — those are OUTPUT of `projectScenario`,
// re-derived on every normalise, so carrying them would only ever let a stale copy travel.

/**
 * Bumped when a blueprint's SHAPE changes in a way an older reader would get wrong. A reader that
 * sees a higher version refuses rather than guesses — half-understanding someone else's trade plan
 * is worse than declining to open it.
 */
export const BLUEPRINT_VERSION = 1

/**
 * The top-tier fields a blueprint carries verbatim. Everything else is derived or personal.
 *
 * `entry_mode` is part of the plan, not of the person: a limit setup that travelled without it
 * would hydrate as `conditional` (the normaliser's default) and readiness would then demand a
 * condition the author never wrote — the recipient would be handed a different way in.
 *
 * `pace_rungs` travels for the same reason. "Watch this on the 15min" is the author's decision about
 * the plan, and a blueprint arriving without it would silently hand the recipient the horizon's
 * default ladder instead of the rung the sender deliberately chose. `market_cap` and `read_mode` do
 * NOT travel: the first is re-derived at Generate, the second is Talos's to own.
 */
const CARRIED = [
    'asset', 'asset_class', 'direction', 'type', 'trade_mode', 'timeframe', 'pace_rungs', 'entry_mode',
    'thesis', 'conviction', 'active_from', 'valid_until', 'referenced_symbols',
]

/**
 * Snapshot a setup (or a live draft) as a portable blueprint.
 *
 * `at` is passed in rather than read from the clock so this stays pure and testable; callers hand
 * it `Date.now()`. `from` is PROVENANCE and nothing reads it to decide anything — the same rule
 * the pipeline envelope follows (services/pipeline artifact `from`). It is there so a recipient can
 * be told whose plan they are looking at, which matters rather a lot when it isn't a desk's.
 */
export function toBlueprint(setup, { at = 0, from = null } = {}) {
    if (!setup || typeof setup !== 'object' || Array.isArray(setup)) return null

    const bp = { version: BLUEPRINT_VERSION, drawn_at: Number(at) || null, from: from ?? null }
    for (const k of CARRIED) if (setup[k] != null) bp[k] = setup[k]

    bp.conditions = _carryConditions(setup.conditions)
    bp.scenarios  = (Array.isArray(setup.scenarios) ? setup.scenarios : []).map(sc => ({
        id:          typeof sc?.id === 'string' ? sc.id : null,
        name:        typeof sc?.name === 'string' ? sc.name : '',
        // The way in, and what each level is measured from, travel: they are facts about the PLAN,
        // not about the author. A recipient who cannot see that the stop is anchored to structure has
        // to re-derive the one thing that makes the level challengeable. `alternatives` does NOT
        // travel — that is the author's reasoning about what they didn't take (setup.schema.js).
        archetype:   sc?.archetype ?? null,
        entry_legs:  _carryLegs(sc?.entry_legs),
        stop_legs:  _carryLegs(sc?.stop_legs),
        target_legs: _carryLegs(sc?.target_legs),
        conditions:  _carryConditions(sc?.conditions),
        validity:    sc?.validity ?? null,
        // `quantity` absent BY OMISSION — see the header. So are `rr` and every monitor field:
        // rr is derived from the levels and would be re-computed anyway, and monitor state is a
        // record of one person's position in one account.
    }))
    return bp
}

/**
 * A blueprint → a raw draft for `normalizeSetup`. NOT normalised here: normalisation has exactly
 * one home and this module is not it, so the route composes the two and a blueprint can never
 * drift from what a Mentor-authored draft is put through.
 *
 * A null/empty blueprint hydrates to the blank skeleton — which is what makes "I have the exact
 * setup" and "someone sent me a setup" the same code path with a different payload.
 */
export function hydrateBlueprint(bp) {
    const src = bp && typeof bp === 'object' && !Array.isArray(bp) ? bp : {}

    const draft = {}
    for (const k of CARRIED) if (src[k] != null) draft[k] = src[k]

    draft.conditions = _carryConditions(src.conditions)

    // Junk entries are DROPPED, not turned into empty premises. Coercing `null` into a blank way in
    // would leave a plan that looks complete and quietly has one fewer route into the trade than the
    // sender drew — and it would hide the drop from blueprintProblems, whose whole job is to say so.
    const scenarios = (Array.isArray(src.scenarios) ? src.scenarios : []).filter(isPlainObject)
    draft.scenarios = (scenarios.length ? scenarios : [{}]).map((sc, i) => ({
        id:          typeof sc?.id === 'string' && sc.id.trim() ? sc.id.trim() : `s${i + 1}`,
        name:        typeof sc?.name === 'string' ? sc.name : '',
        archetype:   sc?.archetype ?? null,
        entry_legs:  _carryLegs(sc?.entry_legs),
        stop_legs:  _carryLegs(sc?.stop_legs),
        target_legs: _carryLegs(sc?.target_legs),
        conditions:  _carryConditions(sc?.conditions),
        validity:    sc?.validity ?? null,
        // Explicitly null rather than omitted: `normalizeSetup` derives a scenario's size from its
        // entry legs, and writing the absence down is how the form knows to ask for it.
        quantity:    null,
    }))
    return draft
}

/**
 * What is wrong with this blueprint, said OUT LOUD at open time.
 *
 * The normaliser is deliberately forgiving — an unreadable leg is dropped, an unknown lens falls
 * back to `discretionary`. That is right for a model's own emit, which it can be told to fix on the
 * next turn. It is wrong for a plan that arrived from somewhere else: silently dropping two of
 * someone's four price levels hands the user a DIFFERENT trade wearing the same name, and the only
 * moment they could have noticed was this one.
 *
 * So this compares what was sent against what survived. Pure; takes both.
 */
export function blueprintProblems(bp, normalized) {
    const problems = []
    if (bp != null && (typeof bp !== 'object' || Array.isArray(bp))) return ['That is not a setup blueprint.']

    const version = Number(bp?.version)
    if (Number.isFinite(version) && version > BLUEPRINT_VERSION) {
        return [`This plan was drawn by a newer version of the app (v${version}). Update before opening it.`]
    }
    if (!normalized) return ['The plan could not be read at all.']

    const sent     = Array.isArray(bp?.scenarios) ? bp.scenarios : []
    const survived = normalized.scenarios ?? []
    // Counted DIRECTLY rather than as a length difference: hydrate substitutes one blank premise for
    // a blueprint with no readable ways in at all, so `sent.length - survived.length` would report
    // "1 of 2" when both were junk. Ask the same question hydrate asked.
    const unreadable = sent.filter(sc => !isPlainObject(sc)).length
    if (unreadable > 0) {
        problems.push(`${unreadable} of ${sent.length} ways in could not be read and ${unreadable > 1 ? 'were' : 'was'} dropped.`)
        // AND STOP THERE. What follows matches sent[i] against survived[i], which only means
        // anything while the two lists line up: drop scenario 0 and survived[0] is what was sent[1],
        // so every leg comparison after it comes from a different premise. It would invent losses
        // and hide real ones. The dropped-scenario line above is the honest report in that case.
        return problems
    }

    // Zones, per scenario, matched by position. Safe only because of the early return above: every
    // sent premise was readable, so nothing shifted and survived[i] IS sent[i]. The normaliser
    // preserves order, so a count that shrank names the group that lost a level.
    for (let i = 0; i < survived.length && i < sent.length; i++) {
        for (const [key, label] of [['entry_legs', 'entry'], ['stop_legs', 'stop'], ['target_legs', 'target']]) {
            const before = (Array.isArray(sent[i]?.[key]) ? sent[i][key] : []).length
            const after  = (survived[i]?.[key] ?? []).length
            if (before > after) {
                problems.push(`${before - after} ${label} level${before - after > 1 ? 's' : ''} could not be read as a price${survived.length > 1 ? ` (way in ${i + 1})` : ''}.`)
            }
        }
    }

    // A lens that isn't one of ours silently becomes `discretionary`, which is a claim about how the
    // trade was built. Say so rather than relabel someone's plan behind their back.
    if (bp?.trade_mode && normalized.trade_mode !== bp.trade_mode) {
        problems.push(`Unknown lens "${bp.trade_mode}" — opened as ${normalized.trade_mode}.`)
    }
    // Same for the horizon and the timeframe, which drives the monitor's ladder and so its pace.
    if (bp?.type && !normalized.type)           problems.push(`Unknown horizon "${bp.type}" — pick one.`)
    if (bp?.timeframe && !normalized.timeframe) problems.push(`Unknown timeframe "${bp.timeframe}" — pick one.`)

    return problems
}

// ─── carriers (pure) ──────────────────────────────────────────────────────────

/** An object we can actually read fields off — not null, not an array. */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * A leg's PRICE without its size. `note` travels because it is the author's word about the level —
 * "the shelf from Tuesday" is exactly the kind of thing a recipient needs and cannot re-derive.
 * So do a leg's own `conditions`: a target that only prints "if the day closes above" is a
 * different target without that sentence (`normalizeLeg` keeps them per leg).
 *
 * Deliberately NOT coerced to a number here: `normalizeLeg` owns that, and a second coercion in
 * this file is a second opinion about what a price is. It carried `lower`/`upper` until the band
 * shape was deleted (2026-09-24); a blueprint written before then hydrates with no legs, which is
 * what `blueprintProblems` is for — it reports every level it could not read.
 */
function _carryLegs(arr) {
    if (!Array.isArray(arr)) return []
    return arr.map(z => ({
        id:     typeof z?.id === 'string' ? z.id : null,
        price:  z?.price ?? null,
        note:   typeof z?.note === 'string' ? z.note : null,
        // What the price is measured FROM (setup.taxonomy.js). Plan, not person — and the
        // normaliser drops it if the recipient's vocabulary ever stops holding the word.
        anchor: z?.anchor ?? null,
        conditions: _carryConditions(z?.conditions),
    }))
}

/** Conditions travel whole: the text IS the instruction, and its three tags change how it's judged. */
function _carryConditions(arr) {
    if (!Array.isArray(arr)) return []
    return arr.map(c => ({
        id:          typeof c?.id === 'string' ? c.id : null,
        text:        typeof c?.text === 'string' ? c.text : '',
        weight:      c?.weight ?? null,
        mode:        c?.mode ?? null,
        persistence: c?.persistence ?? null,
    })).filter(c => c.text.trim())
}
