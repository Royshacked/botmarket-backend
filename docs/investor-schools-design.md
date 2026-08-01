# Investor Schools (design — nothing built)

2026-08-01. Discussion only. No code, no decision locked.

Teach Atlas the **way** great investors think — not what they hold. (Tracking real holdings needs
13F: FMP's is Premium-locked, `fmp.provider.js:18`; EDGAR is reachable via `sec.provider.js` but a
13F is long-only US equity with a 45-day lag — fine for Buffett, useless for Dalio. Dropped.)

## The pattern

Copy Kairos exactly (`kairos.modes.js` + `KAIROS_MODES.md`):

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

**OPEN:** two axes, or four flat schools and live with All Weather as the odd one out?

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

## Open questions

- Two axes or four flat schools?
- Is the school visible to the user (a badge on the book), or an internal lens met only through
  Atlas's words?
