# Argus on Pythia — the house's industries as the first place to look

**Status: PLAN, 2026-10-13. Nothing built. Decisions §5: all three as recommended (Roy, 2026-10-13).**
Roy's decision (2026-10-13): Pythia's verdicts are a
**PREFERENCE, not a filter** — Argus looks in the industries Pythia rated for the user's book first, says
so on every name it finds there, and still screens the rest of the market. A strong name outside the
house's industries is never dropped for being outside them.

Relates to: [pythia-assessment.md](./pythia-assessment.md) §10 (hand-off — "Argus reads `swing` /
`long_term` subjects as its hunting ground") and §11 open item 3 (Argus choosing names);
`services/houseScan.service.js` (step 7, the code that queues names on the verdicts today);
`services/sleeveSource.service.js` (Atlas's sleeve screen); `prompts/scanner_system_prompt.md`,
`prompts/scanner_mode_handoff.md`.

## 1. The flow Roy described

- Pythia rates industries (and approved themes) **for swing**, **for long term**, watch, avoid, no case.
- A user who wants a **swing** trade goes Mentor → Argus. Argus starts from Pythia's swing industries.
- A user building a **long-term** book in Atlas sends a sleeve to be sourced. The screen starts from
  Pythia's long-term industries inside that sector.

## 2. What runs today (read 2026-10-13)

| Path | Who picks names | Reads Pythia? |
|---|---|---|
| Argus chat scan (user at the desk, or Mentor's hand-off with direction + horizon seeded) | Argus (model) — `screen_candidates`, movers, sector snapshot, analyst actions, earnings calendar | **No.** Argus has no Pythia tool. |
| Atlas sleeve sourcing (`<screen_request>` → `sourceSleeve`) | **Code**, not a model: `screenFiltersFor(sector, school)` → FMP screener | **No.** Whole GICS sector; `industry` narrows on FMP's industry string, which is not GICS. |
| House scan (step 7) | Code: each swing / long-term industry's largest uncovered names → Prometheus | **Yes** — but for the shared coverage pool, not for any user's request. |

Already aligned: Pythia's verdicts (`swing`, `long_term`) and Argus's `style` (`swing`, `long term`) are
the same horizon words, so a request maps to the right industries by lookup.

Note: Atlas already benefits indirectly — the house scan fills coverage from long-term industries, and
Atlas reads coverage BEFORE it sources a sleeve. This plan makes the preference explicit when coverage
is empty.

## 3. The design

### 3.1 One read — the house's industries for a book (shared by both paths)

`industryAssessmentService.listForBook(book, { sector = null, now })` in
`api/strategy/industryAssessment.service.js`, beside `verdictsForCodes` (same expiry rule, same
`LEGACY_VERDICTS` mapping):

- `book` ∈ `swing` · `long_term`. Industries whose standing, unexpired verdict is that book.
- Approved themes rated that book contribute their links of order 1 and 2 (supplier links first, as
  the house scan does), each tagged with the theme it came from.
- `sector` narrows to one GICS sector (for Atlas's sleeve).
- Returns `[{ code, name, sector, verdict, horizon, hype, thesis (≤300 chars), top_risk, via_theme? }]`,
  biggest 12-month move first. Small — no revisions, no facts blobs.

Intraday / day horizons map to **no** book: Pythia's verdicts run weeks to years and say nothing about
a session. Argus is told so rather than handed a list that doesn't fit.

### 3.2 Argus's tool — `get_house_industries`

`services/tools/houseIndustries.tools.js` (next to `industryViews.tools.js`; unbound, read-only):

- `get_house_industries({ book, sector? })` → the list from 3.1, one line each: name, sector, HYPE when
  flagged, the thesis, the top risk, "via theme X" when it came from a theme.
- `get_house_industries({ industry })` → that sub-industry's companies, largest first, coverage marked —
  **reusing the formatter behind Pythia's `get_industry_companies`** (move it from
  `strategy.agent.service.js` into the shared tool file; one mechanism, two desks).
- Wired into BOTH Argus profiles (`TOOLS` and `INVESTING_TOOL_NAMES`).
- **Grounding:** add it to `DISCOVERY_TOOLS` (`services/scanner.grounding.js`). A name it lists came from
  the house's own classified universe, which is a grounded source; the per-name validation rules still
  apply to it unchanged.

### 3.3 Argus's prompt — the preference, in words

`prompts/scanner_system_prompt.md` Stage 0 and Phase 2, and `scanner_mode_handoff.md`:

- When the scan's style is **swing** or **long term**, call `get_house_industries` for that book first.
  Screen INSIDE those industries first (via `{ industry }` or `screen_candidates` narrowed to them),
  then run the usual discovery across the market.
- Every name that came from a house industry carries the label **"on the house's swing / long-term
  list"** in its reason. A HYPE industry is named as such on its names.
- **Preference, not filter**: relative strength, tradability and the catalyst still decide the
  ranking. A house industry does NOT add to the score (§5, decision 1). A name outside the house's
  industries that wins on the tape stays on the list.
- No house industries for that book (none rated, or all expired) → say so in one line and scan normally.
- A name in an industry Pythia rates **AVOID** is marked, not dropped (matching Atlas's `avoid` flag).

### 3.4 The labels on the wire

`<scan_list>` items and `<kairos_pick>` gain an optional `house: { book, industry, via_theme? }`.
`_normalizeKairosPick` and the scan-list normaliser keep it when it names an industry the tool actually
returned this turn (checked against the grounding ledger — the model cannot invent the label). Mentor's
seeded opening reads it ("Argus found this on the house's swing list: <thesis>"), so the trade starts
with the house's reason attached. Frontend: one chip on the scan list row and the pick card.

### 3.5 Atlas's sleeve — code, preference first

`sourceSleeve` (no model involved):

1. `listForBook('long_term', { sector })` → the house's long-term industries in the sleeve's sector.
2. Their members from `gics_companies` (the same `largestCompanies` the house scan uses), filtered by
   the school's floor (`SCHOOL_SCREEN` market cap; the dividend floor checked where the screener's
   fields are on the row, otherwise left to Prometheus as it is today).
3. The usual sector screen fills the remaining slots up to `SLEEVE_HITS`, de-duplicated.
4. The sleeve records which names came from the house's list (`house: true`), and the card says so
   ("4 of 10 from the house's long-term industries").

A sector with no long-term industries runs exactly as today.

### 3.6 Optional, later — Pythia names companies

The `names: [{ symbol, why }]` field on `<industry_assessment>` (discussed 2026-10-13): checked against
`gics_companies` and the subject's sub-industries, frozen on the assessment, and listed FIRST by
`get_house_industries({ industry })` and by the house scan. Costs nothing extra (Pythia already reads the
evidence). Separate step — it changes Pythia's contract and `checkAssessment`.

## 4. Build order

1. **3.1** `listForBook` + tests (expiry, theme links, sector narrowing, legacy verdicts, empty).
2. **3.2** the tool + moving the companies formatter + grounding entry + tests.
3. **3.3** the prompt wording. Replay one swing hand-off and one long-term scan; read that the house
   industries were looked at first AND that an outside name still made the list.
4. **3.5** the sleeve ordering + tests (house-first, fill, de-dup, school floor, no-industries fallback).
5. **3.4** the wire labels + normaliser checks + Mentor's opening + the FE chip; bundle `public/` and
   drive the scan list and pick card in a browser.
6. Docs: `pythia-assessment.md` §10/§11 item 3, `docs/desks/` for Argus and Pythia, CODE_MAP.
7. (Optional) **3.6**.

Cost: steps 1, 2, 4 are code — no model spend. Step 3 adds one tool call (and a few `{industry}` reads)
to a swing / long-term scan.

## 5. Decisions for Roy

1. **Does the house list add to a name's score?** Recommended: **no**, label only, until the verdicts
   have a graded record (first 3-month grades land ~January 2027). Revisit then.
2. **Watch industries** — included as a weaker "on the watch list" label, or left out? Recommended:
   left out; watch means the question is still open.
3. **Atlas's sleeve share** — how many of the `SLEEVE_HITS` slots the house's industries may take.
   Recommended: up to half, so the sector screen always contributes. A ceiling, not a quota (a short
   house list takes what it has, the screen fills the rest); one config value, so it moves without code.

**Decided (Roy, 2026-10-13): 1 no — label only; 2 left out; 3 up to half (6 of 12).**

## 6. Risks

- **Concentration:** the same house industries feed every user's scan. The label makes it visible; the
  half-share cap (decision 3) bounds it on Atlas's side.
- **Stale verdicts:** an expired assessment must never surface — the read uses the same expiry rule as
  `verdictsForCodes`.
- **Shared mechanism:** the companies formatter moves rather than being copied; `listForBook` sits
  beside the existing reads rather than in a new service.
