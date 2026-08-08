# Investor Schools (BUILT 2026-08-02 — two axes)

2026-08-01 design. **Built 2026-08-02**, two axes, not live-verified.

The open question below ("two axes, or four flat schools?") is **settled: two**, and not on taste —
they land on two different mechanical seams. Selection is the only half that crosses to Argus (the
`<screen_request>.lens`), where it re-weights the investing composite; allocation never leaves Atlas,
where it is the Phase-5 weighting rule. Flattening them would have forced All Weather to fake a
stock-picking view AND left the sizing rule with nowhere to live.

Where it lives: `services/investorSchools.js` (the vocabulary, the rules text, the incoherent pairs,
the injected block, and the per-lens ranking weights — one source, read by Atlas and Argus alike).
Tests: `tests/unit/investorSchools.test.js`.

The other open question — is the school visible to the user as a badge, or met only through Atlas's
words? — is still open. Today: internal, though the lens is saved on the list.

Teach Atlas the **way** great investors think — not what they hold. (Tracking real holdings needs
13F: FMP's is Premium-locked, `fmp.provider.js:18`; EDGAR is reachable via `sec.provider.js` but a
13F is long-only US equity with a 45-day lag — fine for Buffett, useless for Dalio. Dropped.)

## The pattern

Copy Kairos exactly (`kairos.modes.js` + `docs/desks/kairos-hermes.md`):

- one source-of-truth module + one prompt file per school, injected as its own block
- a school selects **prompt profile + vocabulary**, nothing else
- the output schema stays **lens-agnostic** — `<portfolio_plan>`, `<portfolio_mandate>` and the
  order layer unchanged, so **Themis and execution never learn schools exist**
- the school is ONE field on the mandate, carried forward

Changes phases 2–4 only: selection bar · construction rule · default constraints · what review means.

## Two axes, not one enum

The four candidates aren't the same kind of thing. Quality-value / growth / income answer *which
names qualify*. Risk parity answers *how risk is spread* and has ~no stock-picking view — forcing it
into a selection enum makes it fake one.

| Axis | Values |
|---|---|
| Allocation | conviction-weighted · risk-balanced · benchmark-relative |
| Selection | quality-value · growth durability · income · passive |

Buffett = conviction-weighted + quality-value. All Weather = risk-balanced + passive.
Cost: incoherent combos exist (risk-balanced + concentrated quality-value fights itself) — Atlas must
say so, not silently build something confused.

**SETTLED — two axes** (see the header). Each axis carries a `rule` (what governs) and a `review`
question (what the book is re-read against); the review question is the part that pays, per *What it
buys* below.

**The mechanical half, which is what stops a school being a costume.** A lens that changes only the
prose is indistinguishable from a working feature in any transcript. So the selection school
re-weights Argus's four investing axes — which axis LEADS is the school:

| Lens | quality | valuation | growth | balance_sheet |
|---|---|---|---|---|
| *(none — pre-schools blend)* | .30 | .30 | .25 | .15 |
| quality-value | .35 | .35 | .10 | .20 |
| growth-durability | .30 | .15 | .40 | .15 |
| income | .25 | .25 | .15 | **.35** |

`income` leads on balance_sheet because there is no yield axis — payout *coverage* is the honest
proxy, and a high yield is the market pricing a cut. `passive` has no row: it never screens.

Absent/unknown lens → the neutral blend, byte-identical to the pre-schools set, so a book built
before this feature ranks exactly as it did. That is deliberate: **normalize returns `null`, never a
default** — a mandate must not acquire a stance by accident.

## THE TRAP — regime moves the weights, not the worldview

Fitting the school to the **mandate** = right. Fitting it to the **current market state** = a category
error. A school is a durable stance held *across* regimes; switch it on a regime signal and:

- the book churns philosophically — every review becomes a possible worldview change
- **the review breaks**: holdings are judged against their *frozen thesis*. A name bought on
  moat-and-margin-of-safety, re-read under a risk-parity lens, looks wrong for reasons that have
  nothing to do with the company
- it is performance-chasing with extra steps

Atlas already does this correctly: Phase 2 regime → Phase 3 over/underweights. Regime-awareness
*inside* a fixed philosophy. The review fingerprint already flags regime-then-vs-now instead of
re-architecting.

Market state may break a tie **at intake, once**. A later school change is a **proposal Atlas
surfaces** (with its turnover cost), never a quiet drift.

## Ownership

**Atlas owns it, on the mandate. Argus inherits it** on the existing sleeve hand-off to the investing
desk. One owner — the "judgment crosses via a pipeline hop" rule. Not Kairos/Mentor: those are
trade-timing desks.

## Selection: agent suggests, user overrides

Atlas infers at intake and **says which it chose and why**; user overrides in plain language. Then it
is **sticky** — changing it carries the same weight as changing risk tolerance. Failure mode to avoid:
a school that re-derives itself every turn from a slightly different sentence.

## Naming

Name by **method** (`quality_value`, `risk_parity`, …), not by person — same reason Kairos's lenses
are `discretionary`/`smc`/`institutional`. Prompt copy may say "the tradition associated with X". A
living person's name implies replicating what they're doing right now, which we can't. User can still
say "a Buffett-style book" and Atlas maps it.

## What it buys

Not edge — encoding the method doesn't produce the returns, and the prompts must not imply it.

**Coherence**, and a book that is *reviewable against its own criteria*: "is this still right?" becomes
has the moat eroded / has the runway shortened / is the payout covered / has risk drifted from balance.
Sharpens **Themis and the review** more than construction.

## Two traps found while building

Both are the frozen-thesis break arriving by a quieter door than a regime signal:

- **The review must not retro-fit a school.** The injected block offers its menu only when a mandate
  is being established (`buildSchoolSection(mandate, { menu: !isReviewMode })`). Offered mid-review,
  Atlas would adopt a stance the book was never built under and then judge the holdings by it.
- **An edit turn that forgets to restate the lens** would re-rank every kept name under the neutral
  blend — the order changing under the user for a school they never dropped. `_normalizeScan` falls
  back to the lens of the list being edited.

Also worth knowing: the saved-scan document whitelists its fields, so `lens` had to be added to BOTH
the create and the patch paths or the school would have been dropped at save while every in-memory
test passed.

## Open questions

- Is the school visible to the user (a badge on the book), or an internal lens met only through
  Atlas's words? Today: internal — but the lens IS persisted on the list, so a badge is a render away.
- Allocation currently reaches Atlas as prose (the Phase-5 rule it applies itself). If the weights
  ever move server-side, that rule needs a real implementation per school, not a prompt paragraph.
