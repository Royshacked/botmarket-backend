# Argus on Pythia — the house's industries as the first place to look

**Status: BUILT 2026-10-13 — steps 1-6 (§4), live-replayed, browser-driven and code-reviewed on axl_dev; NOT pushed. Decisions §5:
all three as recommended (Roy, 2026-10-13). Where a design bullet below and §7 "As built" disagree, §7 is what runs.**
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

## 7. As built (2026-10-13)

Commits: 8497ccf (3.1), a0e20c3 (3.2), 4245cc8 (3.3), 673b087 (the screener fix), 9901373 (3.5), 1bb79a6 + frontend
73508a7 (3.4); bundle after.

- **3.1** as designed. The sector matches in either spelling (`normalizeSector`): a sleeve's sector is model text.
- **3.2** The companies formatter did NOT need moving — `formatCompanies` / `largestCompanies` were already in the
  shared industryData.service. The book list shows the first 20 in full and the rest by name (`FULL_ENTRIES`; a
  32-industry swing list ran ~18k characters). **Grounding**: only the company ROWS of an industry call reach the
  tape (`SOURCED_EXTRACT`) — the book list's prose ("AI", "ROIC") would otherwise ground an invented ticker.
- **3.3 — the GICS / FMP names.** The first live replay put 6 of 8 pool names from the house list: the house writes
  GICS names ("Information Technology", "Communications Equipment"), the FMP screener knows only its own
  ("Technology", "Communication Equipment"), so Argus's screens came back EMPTY and the house list filled the pool —
  the preference acting as a filter. Two fixes: the prompts and the tool say a house industry's companies come from
  `get_house_industries`, never the screener; and the screener now translates a GICS SECTOR through the one shared
  map (fmp.provider `normalizeScreenFilters`, 673b087 — every caller, Atlas's sleeves included). Industries are not
  mapped: about half of GICS's have no FMP twin. Replayed after: swing scan 3 of 9 from the house list, Mentor
  hand-off 2 of 11, an investing Industrials screen (no house list) said so and screened as usual (48 → 9).
- **3.4 — the label is worked out by CODE, not checked.** `services/houseLabel.service.js`: a name carries `house`
  when its GICS sub-industry is on the book's list. Nothing the model writes can set it, and Mentor recomputes it
  from the ticker. A SAVED scan keeps the labels its candidates carried when the user saved it (the client posts the
  list whole): a snapshot of that day, shown to its owner only — not refreshed when a verdict lapses. Scan candidates ask their style's book (investing with no style: long term; intraday / day: none); the
  hand-off pick asks both, swing first; Mentor's controller looks the label up from the seed's ticker. Frontend
  `HouseChip` ("House · swing" / "House · long term", amber on a hype or Avoid flag) on the Scans list, the Floor's
  scan rows and beside the hand-off pick button. A Scans list narrower than 480px drops the chip from the row (a
  tablet's ~325px column squeezed the logo to a dot) and shows it, with its line, in the expanded row.
- **3.5** The house names are found INSIDE the school screen (widened to 50, the screener's ceiling), so every floor —
  cap, dividend, volume — holds for them; a dividend check on `gics_companies` was not needed. `SLEEVE_HOUSE_MAX`
  (default 6). The card: "N of the M came from the house's long-term industries". Live (no queuing): IT → MSFT ORCL
  PANW CRWD FTNT + 7; Financials → V MA ICE PYPL COIN + 7; Communication Services → GOOG META RDDT PINS SNAP MTCH + 6.
- **3.6** (Pythia naming companies) not built.

**Code review 2026-10-13** (an independent pass over every commit above). Fixed: an industry the house rates AVOID that
arrives through a long-term theme no longer leads a sleeve (`_houseCodes` drops it; its names can still come through
the screen); a ticker of six or more characters is grounded from an industry call (the extract wanted two spaces after
the symbol, `formatCompanies` leaves one); the label reads every book from ONE read (`listForBooks`) — Mentor's
controller awaited four reads before its stream opened. Left as they are, on purpose:
  - **Covered house names count toward the sleeve's six** (the largest — MSFT, ORCL — are often covered). The sleeve
    always counted covered names as in the book; the uncovered ones lower down come through the screen.
  - **GICS vs FMP sector and spelling** (BRK.B / BRK-B, a name FMP sectors differently): a mismatch only drops the
    preference for that name, never filters.
  - **A trading scan with no style** gets no label while Argus's prose may still say "house's list" — rare: Stage 0b
    runs only on a swing or long-term style.
  - Pre-existing, not this work: at a tablet's ~325px Scans column every row's ticker is cut ("L…"), labelled or not.

## 6. Risks

- **Concentration:** the same house industries feed every user's scan. The label makes it visible; the
  half-share cap (decision 3) bounds it on Atlas's side.
- **Stale verdicts:** an expired assessment must never surface — the read uses the same expiry rule as
  `verdictsForCodes`.
- **Shared mechanism:** the companies formatter moves rather than being copied; `listForBook` sits
  beside the existing reads rather than in a new service.
