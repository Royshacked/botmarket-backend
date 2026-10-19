# Atlas builds on industries — plan

Status: **BUILT 2026-10-19** (BE 8124cf2, FE f091654), branch `feat/unified-chat`. Live-checked up to the
architecture gate; the empty-sleeve research loop is NOT yet run live (see the end).

## Why

Roy, 2026-10-19, on how Atlas builds a book:

1. **Sector rotation is noise.** Atlas's phase 2 still gives last week's sector leaders "real weight on a tactical or
   swing mandate". That contradicts the 2026-10-10 verdict: every industry-forecasting idea was tested and failed; the
   edge is events, big-money flows and contrarian reading — not momentum in sector ETFs.
2. **We have industries, Atlas plans in sectors.** Pythia's whole output is per GICS **sub-industry** (demand,
   economics, cycle, and a verdict per book). Atlas's architecture is eleven sector buckets ("Technology 38%"); the
   industry views only *question* a bucket. The house's real judgment is never what the plan is made of.
3. **A sleeve is screened by sector, not industry** — and not by Argus. `<screen_request>` calls the FMP screener on
   the sector (industry only if Atlas passed one), with Pythia's long-term industries moved to the front.

## Today (what the code does)

| Step | Where | What |
|---|---|---|
| Market read | `prompts/portfolio_system_prompt.md` phase 2 | NOW (rotation, curve, quotes) · TREND (weekly/monthly charts of 3–5 sector ETFs vs SPY) · FORWARD (web search, as a view). Plus `get_industry_views`. |
| Architecture | phase 3 | Sector targets vs the benchmark's real sector weights; house views as an input; user sign-off. |
| Names | phase 4, `get_coverage` | Only from coverage, filtered by **sector** + school; the read comes back grouped by sector. |
| Empty sleeve | `<screen_request>` → `services/sleeveSource.service.js` | `screenFiltersFor(sector, school, { industry })` → FMP `screenCandidatesRaw`; `houseFirst` puts Pythia's long-term sub-industries first (a preference). Queued to Prometheus; a "Resume build" card when the sleeve settles. |
| House limits | on save (platform) | HYPE → half weight · ≤ ⅓ of the book per GICS sub-industry · AVOID saved only on the user's OK. Looked up per name — **the plan's ideas carry no sleeve**, so the output shape does not change. |

What already exists and the plan reuses:

- `industryAssessmentService.listForBook('long_term' | 'swing', { sector })` — the house's industries for a book.
  Argus reads it as `get_house_industries`.
- `gics_companies` (`api/strategy/industryData.service.js`): `readCompanies('sub_industry', code)` lists a sub-industry's
  companies by market cap; `readCompaniesBySymbol(symbols)` gives each symbol's `sub_code`. **Our own GICS table** — no
  FMP industry names involved.

## The new flow

1. **Mandate** — unchanged. The horizon picks the house book: under a year → `swing`, otherwise `long_term`.
2. **Read** — the house's industries for that book (`listForBook`): code, name, verdict, thesis, named companies. Plus
   FORWARD (events, as a view) and the macro numbers (curve, CPI, rates) as background. **No rotation. No sector-ETF
   trend charts** (sector-level momentum, the same thing slower).
3. **Architecture — sleeves are GICS sub-industries**, each with a weight.
   - FOR <book> industries are the candidates. WATCH only with the date it waits on, said. AVOID only when the user
     asks for it (the platform still asks for the OK). HYPE allowed — the platform halves it; say so.
   - The user outranks the house, as today: a theme or industry they ask for is taken; one they rule out is ruled out
     (explained once, never rebuilt through a proxy).
   - **Sectors stay as a check, not a plan**: the tilt against the benchmark is still stated (the benchmark ETF's sector
     look-through — it has no sub-industry one), and the ⅓-per-industry cap is unchanged.
   - User sign-off on the sleeves before names, as today.
4. **Names** — `get_coverage` filtered by **sub-industry** + school, grouped by sub-industry (a coverage name's
   sub-industry is joined from `gics_companies` at read — no migration of coverage docs).
5. **Empty sleeve** — `<screen_request>` names the sub-industry (`industry_code`). Its names come from
   `gics_companies` for that code, Pythia's named companies first, the school's market-cap floor applied
   (`SCHOOL_SCREEN`); liquidity checked on the shortlist. FMP's sector screen only as a fallback when the sub-industry
   has too few rows. Then Prometheus, then the card — wording names the industry.
6. **Sizing → plan → save** — unchanged.

## Changes

| # | Repo | Change |
|---|---|---|
| 1 | BE prompt | Phase 2: drop NOW-rotation and TREND sector charts; read the house industries for the mandate's book; FORWARD + macro numbers stay. |
| 2 | BE prompt | Phase 3: sleeves are sub-industries (verdict rules above); sectors as the benchmark/diversification check. Phase 4 + Sleeve Sourcing Output: by sub-industry. |
| 3 | BE tools | Atlas gets `get_house_industries` (Argus's spec, shared — one tool, two readers). `get_coverage` gains an `industry` filter (GICS code or name) and groups by sub-industry. |
| 4 | BE sleeve | `screen_request.industry_code` → names from `gics_companies` (house-named first, school floor), FMP sector screen as fallback; the old sector-only request still accepted. Card copy names the industry. |
| 5 | FE | PortfolioSurface / the sleeve card: show the industry name where the sector showed. |
| 6 | Tests | Prompt guards (no rotation, sleeves by industry), coverage filter + grouping, sleeve sourcing from `gics_companies` + fallback, card copy. |
| 7 | Live | A full Atlas build under the unified chat, **including one empty sleeve end to end** (screen → Prometheus → card → Resume build). That loop has not been run live since the chat was unified. |

## Decided (Roy, 2026-10-19)

1. **Horizon → book:** under about a year `swing`, a year or more `long_term` — **with some flexibility**: in between,
   Atlas judges (a 9-month book on a multi-year cycle reads `long_term`) and says which it read.
2. **Sector-ETF trend charts:** dropped, with rotation.
3. **Industries the house has not listed:** **both** — when the user asks, and when Atlas states the reason.
4. **Names per empty sleeve:** at most 12 (`SLEEVE_HITS`).

## Built

- Prompt phases 2–4 + the Sleeve Sourcing Output rewritten; gates and phase tags follow. Review mode untouched.
- `get_house_industries` for Atlas — Argus's handler and formatting, Atlas's own description and closing note
  (`ATLAS_WORDS`; Argus's `SCAN_WORDS` unchanged). `get_macro_snapshot`'s description says to ignore its rotation.
- `get_coverage` takes `industry` and groups every read by sub-industry (`makeCoverageHandler`, joined from
  `gics_companies`; a name the table lacks falls back to its sector, marked).
- `<screen_request industry_code>` → `sourceSleeve({ industryCode })`: `industryPick` (named first, school floor, ≤ 12),
  the sector screen as a same-sub-industry fill under `MIN_INDUSTRY_NAMES` (4). The old sector request still works.
- The sleeve's label is its industry in the card (BE copy + FE bubble) and in the chain's hand-back to Atlas.
- Tests: `atlasIndustrySleeves`, `portfolioCoverage`, `sleeveSource`, `chain`, `houseIndustries`, the tool snapshot.

## Live check (2026-10-19, real model, axl_dev)

- Data: the house lists **4** long-term industries and **32** swing ones today; an industry sleeve from
  `gics_companies` comes back sound (Systems Software → MSFT, ORCL, PANW, CRWD, FTNT, …). None of the current
  assessments name companies, so "named first" is untested on real data.
- A build to the architecture gate: Atlas read the long-term list with codes, gave a forward view, used the macro
  numbers as background only, proposed industry sleeves with codes and weights (four from outside the list, each
  with a reason), named the ⅓ cap, checked the sectors against SPY in points, and stopped for sign-off.

## Still open

- **The empty-sleeve loop live** (sleeve → Prometheus → the hand-back to Atlas) — not run: it writes real house
  coverage and spends Prometheus minutes per name (up to 12). Run it on Roy's go.
- **A junk symbol in `gics_companies`**: the payments sleeve picked `BSQKZ`. The table needs a clean-up pass (or a
  symbol-shape filter) before sleeves are sourced from it at scale.

## Not in scope

Prometheus's research itself; review mode (Themis) beyond the copy that names sectors; the house limits (unchanged).
