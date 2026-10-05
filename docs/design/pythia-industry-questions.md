# Pythia — three questions per industry (2026-10-05)

**BUILT 2026-10-05 (steps 1–5); step 6 = the docs.** Supersedes `pythia-industries-and-channels.md`
and the deleted tilt contract (`docs/desks/pythia-tilt.md`). Decided with Roy on 2026-10-05. The
living contract is `docs/desks/pythia-industries.md`; this doc keeps the reasoning and the decisions.

**Read with `horizons.md`.** A sourced check found no evidence that structural growth predicts
returns, and Ritter and Siegel found the opposite when the price is high. So the three answers are a
DESCRIPTION. They count toward returns only paired with price, and only once that pairing passes the
backtest (`horizons.md` §1 and §3).

The one line: **Pythia tells a 5-year book which industries are worth owning and on what terms. It
answers three structural questions per GICS sub-industry from measured data, and it never forecasts
the next six months.**

---

## 1. Why the old desk goes

The old Pythia published active weights against SPX, sized from Pythia's own forecasts of macro
channel moves. A source check on 2026-10-05 found four problems:

- No published method reliably forecasts the LEVEL of a macro channel six months out.
  - Professional rate forecasts do not beat a random walk at 6–12 months (Blue Chip study, Applied
    Economics 2015).
  - Leading indicators call turning points, not levels: OECD CLI 6–9 months, yield curve 2–6 quarters.
  - Forwards are the market's forecast, biased by a risk premium and slow at turning points
    (Piazzesi & Swanson, NBER w10547).
- Every public input Pythia had is already priced in. That includes the FRED readings, the
  breakevens and the base rate (IC −0.05, measured 2026-10-01).
- So the channel call was an LLM opinion on public data, and an opinion is not an edge.
- A 6-month tilt table is the wrong product for a 5-year book anyway. Over 5 years a holding returns
  earnings growth + payout + change in multiple. All three are decided by the company and its
  industry's STRUCTURE, not by next quarter's macro.

## 2. The three questions

Asked of every GICS sub-industry. Answered from data first and research second.

| # | Question | Measured from | Research adds |
|---|---|---|---|
| 1 | **Long-term demand**: is the industry's market growing or shrinking structurally? | Industry revenue, 10-year CAGR and its steadiness; share of the economy | Whether the trend is breaking (substitution, regulation, a technology shift) |
| 2 | **Industry economics**: is it a good industry to own? | Median and spread of ROIC versus cost of capital; margin level and stability; concentration (top-5 revenue share) and its trend | Pricing power, intensity of competition, capital needs |
| 3 | **Cycle position**: where are current earnings against the cycle? | Current margins against the 10-year range; earnings against 10-year average earnings | Only for cyclical industries: what would turn the cycle |

**What Pythia publishes per sub-industry:**
- each question's answer as a grade with its numbers and a short rationale;
- the normalised (cycle-adjusted) margin that valuation uses;
- the conditions that would reopen the question early;
- the evidence date.

**What Pythia never publishes:** a weight, a price direction, or a 6-month view.

## 3. The unit: GICS sub-industry, rolled up when thin

- **The taxonomy is GICS (2023):** 11 sectors / 25 groups / 74 industries / 163 sub-industries.
  The structure comes from MSCI via Wikipedia; it is saved as `pythia-industry-questions/gics-2023.csv` and
  becomes a vocabulary table.
- **A sub-industry is answered on its own when it holds at least 5 companies** in the universe.
- **Below that, it rolls up:** to its GICS industry, then to its industry group. The row records the
  level it was answered at.
- **Universe (measured 2026-10-05):** US-listed companies above $300M market cap, excluding ETFs and
  funds. That is 2,971 names. 90 of them are shells or closed-end funds and are excluded.

## 4. Classifying companies into GICS

No free source tags companies with GICS; MSCI and S&P license the per-company assignment. FMP tags
each company with one of its own 155 industries.

**1. An industry-level map.** A drafted map (`pythia-industry-questions/fmp-to-gics.draft.py`) sends each FMP industry to
one GICS sub-industry. With that map alone, measured 2026-10-05:
- 107 sub-industries are answered on their own;
- 47 roll up to their industry and 9 to their group;
- none is left unanswerable.

**2. Per-company classification where the map is too coarse.** 29 FMP industries span several GICS
sub-industries. They hold 710 companies. Examples:
- FMP "Semiconductors" holds the chip-equipment makers.
- "Credit Services" holds the payment networks.
- "REIT - Specialty" holds towers, data centers, self-storage and timber.

Because of these, 42 sub-industries show zero companies under the industry map alone. Those 710 are
classified once, company by company, from the business description in FMP's profile. The result is
stored with the company, reviewed by Roy, and applied to new listings as they enter the universe.

SEC SIC codes do not solve this: they are coarser than GICS (every REIT has the same code).

**Expected outcome:** roughly 130–140 sub-industries answered on their own. This is an estimate, not
yet measured.

## 5. Data

FMP Starter, verified 2026-10-05:
- 15 years of annual and quarterly income statements, balance sheets and cash flows, plus key
  metrics and ratios.
- Statements carry `filingDate` and `acceptedDate`, so a point-in-time backtest is possible.
- Bulk endpoints return 402 (locked), so data is fetched one company at a time: about 9,000 calls per
  full refresh. The per-minute rate limit is not known; FMP sent no headers. Check it before writing
  the job.
- The refresh is a background job with a Mongo cache. It runs once after each earnings season and
  incrementally as companies file.

## 6. Cadence and triggers

**Scheduled work:**
- **Numbers** are recomputed quarterly by code, with no LLM cost.
- **Full review** of questions 1 and 2 happens once a year per sub-industry, staggered so about 14 run
  each month.
- **Question 3** is reviewed quarterly for cyclical sub-industries only.

**Triggers that reopen a sub-industry early:**
- industry revenue growth negative for two quarters in a row;
- the industry's ROIC crossing below the cost of capital;
- margins reaching the top or bottom of their 10-year range;
- a thesis break on a held name, which sends the check up to its industry;
- a structural news event: regulation, a technology shift, lasting trade policy, consolidation.

News is a trigger to review, never an answer. Aether's shock pipeline is the candidate feed.

## 7. Who consumes it

- **Argus funnel (5-year book):** universe → hard filters → quality → valuation, all computed by
  code. Pythia's answers weight the industry layer, and the normalised margins feed valuation. The
  LLM only rejects names, with a reason, and never adds them.
- **Prometheus:** the per-name 5-year case cites the industry's three answers.
- **Atlas:** uses industry caps for diversification. An explicit industry bet must be written down
  with its evidence and kill conditions, and it gets a capped weight.
- **Portfolio review (Themis):** a changed industry answer on a held name's sub-industry replaces
  today's `sector_view` trigger.

## 8. What gets removed

The full map is the dependency sweep of 2026-10-05, file and line in the session notes. Summary:

**Removed:**
- **Backend:** all of `api/strategy/*` (tilt, sizing, channel calls/state/exposures, industry reads,
  fund universe, series); `monitoring/tilt.*`; `tiltNotify`; the strategy agent and prompt; six
  registry tools; the tilt scripts and tests.
- **Tags, cards and routes:** the `<tilt>` emit tag, the `tilt_review` and `tilt_event` cards, and
  the `tilt` loop in `server.js`.
- **aether-engine:** `channels/`, the channel-state and channel-beta builders and their three Render
  crons. Those crons fail at startup once `pythia_fund_universe` is no longer written.
- **Collections orphaned:** `tilt` and every `pythia_*` collection. Keep them read-only until
  archived.
- **Frontend:** the SectorView stance rows, sparklines and channel calls, StrategyPanel's publish
  flow, and TiltReviewBubble.

**Must change:**
- **House scan:** `houseScan.service.js` is driven by overweight tilt rows and needs a new input.
- **Atlas review:** `portfolioChat.service.js` (`getCurrentTilt`), `portfolioReview.util.js`
  (`diffStances`, the fingerprint) and the portfolio prompt.
- **Axl:** the shared `get_sector_view` tool and the Axl prompt.
- **Docs:** CODE_MAP, APP_SPEC and the desk docs.

**Kept (shared):**
- `houseArtifact.repo.js`, `dueLoop.js`, `revisionTrail.js`, `forecastClock.js`;
- the admin gating;
- the vocabulary's `SECTORS` and normalisers;
- the coverage sector/industry sweep;
- possibly `industry/reads.py`, for its beat-rate and valuation evidence.

## 9. Decisions

Decided by Roy on 2026-10-05:
1. **The old Pythia code is DELETED, not archived.** Git history keeps it.
2. **The 710 split-industry companies** are classified once by an LLM pass from their business
   descriptions, with Roy reviewing the result.
3. **The Argus house scan is PAUSED** until the 5-year funnel is built.
4. **Cost of capital** for question 2 comes from Aswath Damodaran's (NYU Stern) annual cost of
   capital by industry. It is published every January and refreshed once a year, mapped onto GICS.
   Confirm the dataset is still downloadable before building.

## 10. Build order

1. GICS vocabulary table, FMP→GICS map, and per-company classification of the 710, with tests.
2. Statement fetch job and cache, after checking the rate limit.
3. Industry aggregates for the three questions (code), with tests on known industries.
4. The Pythia desk on the new contract: prompt, artifact repo and review loop. **BUILT 2026-10-05**:
   - **artifact:** `industry_view` (`api/strategy/industryView.service.js`), one house document per
     sub-industry, with a revision trail. A departure from a measured grade is refused at publish unless
     it is argued (`override_reason`).
   - **readers:** `api/strategy/industryData.service.js` reads the engine's database
     (`services/engineDb.js`).
   - **desk:** the rewritten `strategy.agent.service.js` and prompt, emitting `<industry_view>`.
   - **headless review:** `services/industryReview.service.js`; a changed answer posts an admin card
     (`industryNotify.service.js`).
   - **monitor:** `monitoring/industryView.monitor.service.js` seeds and brings views forward on new
     triggers every 6h, and reviews due views at most 3 an hour, but only when `INDUSTRY_REVIEWS=true`.
   - **API:** `GET /api/strategy/industries`, `GET /api/strategy/industries/:code` and
     `POST /api/strategy/industries/:code`.

   The old tilt services, routes and monitor stay until step 5; nothing can publish a new tilt.
5. Consumers: Argus funnel, Atlas caps, Themis trigger. Then retire the old desk.
6. Docs: CODE_MAP, APP_SPEC, the desk doc.

## Found during the sweep

`researchOpening` (`services/researchRun.service.js:263`) reads `context.sector`, but the house scan
writes `context.bucket` (`houseScan.service.js:127`). Every house-scan research item therefore falls
back to the generic "Research X for coverage" opening and loses the house's reason. The impact is
low; it disappears with the house scan's rework, or it is a one-line fix now.
