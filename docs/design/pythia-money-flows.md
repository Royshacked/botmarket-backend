# Pythia step 8 — the rest of the money: insiders, funds, government

**Status: 8a BUILT 2026-10-12 (the weekly job; T1 run — FAILED, so the cluster is awareness only, §6); 8b BUILT and backfilled 2026-10-12 (§3.2); 8c BUILT and run 2026-10-12, its crosswalk accepted as drafted (§3.3); 8d BUILT 2026-10-12 (§7) and
live-driven the same day (Regional Banks reassessed, $0.014: the cluster written as "awareness only", funds as "a
crowding fact, not a signal"; the board's rows driven as a trader and an admin). QA cycle 2026-10-12 fixed (§10). T2 (crowding)
declared, NOT run — so crowding is a fact only, never a tested warning, and is not scanned. Decisions §9: all
six as recommended (Roy, 2026-10-12). Where a design bullet below and its "as built" note disagree, the
note is what runs.** Step 8 of [pythia-assessment.md](./pythia-assessment.md) §12;
the input it fills is §4.3 ("Where the money goes"). Step 2 built companies' own money (capex, buybacks,
dividends, deals); this adds the other three rows of that table. Decisions for Roy are in §9.

Relates to: [pythia-assessment.md](./pythia-assessment.md) §4.3, §5 (guardrails), §9 (storage);
[industry-screener.md](./industry-screener.md) §5 (the tests that failed, and why every claim here is tested
before it is believed); [opportunist-money-flow.md](./opportunist-money-flow.md) (USAspending, per AWARD — a
different use of the same source); `providers/usaspending.provider.js` (three API traps, verified).

---

## 1. What this is, and what it is not

It is **awareness of big money**: who is putting their own cash into an industry, who is already crowded
into it, and where public money lands. That is the edge Roy named on 2026-10-10 after every forecasting
idea failed (industry-screener.md §5.1–§5.6): events, big money, reading it differently.

It is **not a forecast**. Each input rides on the assessment as a FACT, with a base rate attached by code
where one was tested (§6), and the words "no tested edge" where none passed. Pythia reads it; the verdict
stays hers.

## 2. What was sampled (2026-10-12, before any design)

| Source | What came back | Verdict |
|---|---|---|
| FMP `stable/insider-trading/latest` (Starter plan) | 200; 1,000 rows a page; **6,000 rows = one week** of Form 3/4/5 lines (filed Oct 5–9). 392 open-market purchases (`P-Purchase`) in **80 symbols**, 61 of them ≥ $1M. Owner type, filing and transaction dates, price, shares, link | Sampling only — superseded by the next row |
| FMP `insider-trading/search` | 200; per symbol, OR across everyone with `transactionType=P-Purchase` (found while building 8a): ~1,000 purchases a page ≈ two weeks, back to 2024 | **The live feed as built:** the whole 90-day window re-read in 5–7 calls a run |
| FMP `institutional-ownership/*` (13F) | **402**, Premium | Not usable (as fmp.provider.js already notes) |
| FMP `profile` | `cusip` per symbol; `profile-bulk` is 402 | The CUSIP→symbol map, one call per company |
| SEC **Form 3/4/5 data sets**, quarterly zip | 8.6 MB for 2026q3; `SUBMISSION` carries `ISSUERTRADINGSYMBOL` and **`AFF10B5ONE`**; `NONDERIV_TRANS` the code, shares, price; `REPORTINGOWNER` the relationship. 5,184 purchases in 1,047 symbols in the quarter | **History** (2006 →) for the tested base rate |
| — 10b5-1 share, same file | purchases: **136 of 5,184 (2.6%)** planned; sales: **~66%** planned | FMP's missing flag does not matter for BUYS; sells are mostly scheduled noise, as §4.3 said |
| SEC **13F data sets**, quarterly zip | 100 MB (396 MB `INFOTABLE.tsv`); 3.83M holdings rows, 34,951 CUSIPs, `VALUE` in dollars, CUSIP + FIGI; 10,940 of the filings report one period (the rest late/amended); streamed in **22 s** | **Funds.** One file a quarter, ~45 days after quarter end |
| USAspending `search/spending_by_category/naics` | 200, no key; one call per quarter returns obligated dollars per 6-digit NAICS (Q2 2026 top: commercial building $18.3B, missiles & space $16.7B, R&D $16.0B, aircraft $14.7B, ships $14.5B) | **Government**, by what was bought — no recipient resolution needed at industry level |

## 3. The three inputs

### 3.1 Insiders — "are the people who run these companies buying with their own money?"

- **Source.** Weekly: FMP's purchase-only search (`insider-trading/search?transactionType=P-Purchase`), the
  whole 90-day window re-read each run (5–7 calls) — nothing raw stored. A run with under 30% of the
  previous run's purchases is not written (an empty answer is not a quiet week). History: the SEC quarterly
  data sets, downloaded once for the test (§6), never stored in Mongo.
- **What counts.** Open-market purchases only (`P`, acquired, price > 0). Officers and directors are
  INSIDERS; 10% owners are a separate line (often funds — a different kind of money). Awards, option
  exercises, gifts and in-kind are not purchases. A purchase reported more than 30 days after the trade
  counts on its trade date, never as "new this week".
- **Per sub-industry, trailing 90 days:** companies with an insider buying, distinct insiders buying, dollars
  bought, the largest buys (name, role, $, date) — and the **cluster** flag. A buy under $10,000 is not
  counted (token director purchases). Sales are not fetched at all (two thirds are scheduled).
- **The cluster, as built.** First written as "insiders at ≥ 3 companies of the sub-industry": the first dry
  run (2026-10-12) flagged **43** sub-industries — Regional Banks' 256 companies reach three buyers by size
  alone. Now: ≥ 3 companies AND more than the universe's buying rate would give a node that size by chance,
  binomial p < 0.01 (not 0.05: ~163 nodes are tested a week, and 0.05 lets ~8 through on chance — the run at
  0.05 flagged 7). That run: universe 351 of 2,788 companies buying (12.6%); clusters Regional Banks 51/256,
  Asset Management & Custody Banks 21/87, Apparel & Luxury 7/15. Banks may be STRUCTURAL (directors of small
  banks habitually hold and buy their stock) — T1 and, later, each node's own history are what can tell.
- **Read as:** clustered buying across several companies is the rare informative case (§4.3); one CEO buying
  is a company fact, Prometheus's, not an industry one.

### 3.2 Funds (13F) — "who is already in?"

- **Source.** The SEC quarterly 13F data set, on each new file. Streamed row by row (never loaded whole —
  Render's memory); only rows whose CUSIP is in our universe are kept.
- **CUSIP → symbol.** `gics_companies` gains `cusip`, from FMP `profile` (one call per company: 2,876 once,
  then only new names; paced — the key is shared with live loops). A CUSIP can change (Carnival, Exxon): before
  each new quarter, a company worth $2B+ that the last quarter showed under 5% held — or not at all — has its
  CUSIP re-checked, at most once in 80 days (61 such on 2026-10-12, many of them preferreds funds do not hold).
- **Hygiene.** Shares only (`SH`), not options (`PUTCALL` rows dropped) or bonds (`PRN`); one filing per filer
  per period — a restatement amendment replaces the original, a new-holdings amendment adds to it. A filing
  for an older period that arrives in a later file is DROPPED (a few hundred of ~11,000), not added back.
- **Per sub-industry, per quarter:** the institutional share (13F value ÷ market cap at period end), the
  quarter's change in ownership (designed on SHARES held; built on 13F dollars ÷ market cap — see "as built"),
  the change in holder count, and the share's percentile against the sub-industry's own history.
- **Read as:** CROWDING, never a lead (§4.3). Designed as "a warning at the extremes" — that needs T2 (§6),
  which has not run, so as built it is a FACT about who is already in, and the prompt says it is not tested.
- **As built (2026-10-12)** — `aether-engine money/funds.py`, `scripts/fetch_fund_holdings.py`, cron `fund-holdings`
  Sunday 04:00 UTC (fetches only when SEC posts a quarter, known by the file NAME; ~20 s to read a file plus
  ~1 min to download it). Stores `fund_holdings` (one row per
  company per quarter: shares, dollars, holders, its 10 largest filers) and `industry_funds` (per node per quarter,
  plus a `universe` row), 12 quarters kept; CUSIPs on `gics_companies` (2,865 of 2,876 found). The dry run found
  four ways the obvious arithmetic lies, each now handled and tested:
  1. **Splits.** FMP restates past share counts; the old 13F does not. Booking's 25-for-1 read as ownership
     4% → 94%. Ownership is now **13F dollars ÷ market cap** (`monthly_prices.caps`) — neither moves on a split.
  2. **Changed CUSIPs** (Carnival, Exxon) — a company "held" 0.5% one quarter, 65% the next. Ownership that more
     than doubles or halves is a data BREAK, out of the flow and counted.
  3. **Misfiled positions.** One manager reported $265B of Berkshire's class A (a quarter of the company) in
     March only — a −34% "flow" for Multi-Sector Holdings. A filer holding > 10% of a company whose ownership
     appeared, vanished or more than doubled/halved is left out of BOTH quarters (`jumpy_out`; 137 filers in
     the dry run). First written on dollars, which flagged BlackRock's steady 10% of AMAT when AMAT's price
     doubled — now on ownership.
  4. **Everyone drifts up.** Universe ownership +3.9% in one quarter (median company +3.2%; more filers, more
     money with the managers that file). So the read is **against the universe**: `flow_vs_universe`,
     `relative_share` (node ÷ universe), and the percentile ranks `relative_share`.

  Dry run, Q2 2026 against Q1: universe share 68.5%. Falling most against the universe: Fertilizers & Agricultural
  Chemicals −9.4%, Air Freight & Logistics −7.4%, Paper Products −4.2%; rising most: Diversified Capital Markets
  +7.9%, Specialized Finance +7.1%, Data Center REITs +6.4%. Known limits: a level over 100% is possible in a
  small node (two managers reporting one position under shared discretion; Timber REITs 103%), and a stale
  market cap reads high (Rayonier after its merger). Read the CHANGE and the rank, not the level.

  **Backfill (2026-10-12, into `test`):** 9 quarters (2024 Q2 – 2026 Q2) → 22,865 company rows, 2,120 node
  documents over 8 quarters. It found a fifth trap: **a manager re-filing under new CIKs** — BlackRock's holding
  company (Q3 2024: the old CIK gone from 718 companies, the new one in 747) and Vanguard Group splitting into
  Vanguard Capital Management and Vanguard Portfolio Management (Q1 2026: gone from 891). The split read as +4.9
  points of universe ownership, because the guard dropped the old CIK where it held over 10% but kept the two
  smaller successors. `FILER_SUCCESSORS` (money/funds.py) now reads each as one filer — after the change Q1 2026
  reads −0.49%, not +4.42%. The next such reorganization needs a line there (watch for a quarter whose
  jumpy-filer count jumps: 50–140 is normal). The LEVEL is also computed from holdings as filed now; the jumpy
  check cleans the flow only.

### 3.3 Government — "where does public money land?"

- **Source.** USAspending, contracts (award types A–D), obligated dollars per NAICS per completed quarter —
  one call a quarter plus pages. The latest quarter is incomplete for weeks (the provider's trap 3) — as
  built, every run re-reads 12 SETTLED quarters (100 days after each ends) rather than upserting.
- **NAICS → GICS sub-industry.** A crosswalk in the engine (as built: `money/naics_gics.yaml`, 209 codes)
  for the NAICS codes that make up ~95% of contract dollars, drafted by Claude and ACCEPTED by Roy as drafted
  (2026-10-12). A NAICS line may feed more than one sub-industry, with a weight.
- **Per sub-industry:** the last 4 quarters against the 4 before, the same change a year earlier, the top
  NAICS lines behind it. (Designed with the top recipients by name — NOT built; resolving recipients to
  tickers is the opportunist doc's `recipientResolve`.)
- **Not here:** grants and loans (CHIPS, IRA), budgets and tariffs stay with news (§4.1); the contract
  ledger is what is cheap, dated and complete.
- **As built (2026-10-12)** — `aether-engine money/government.py`, `money/naics_gics.yaml`,
  `scripts/fetch_government_contracts.py`, cron `government-contracts` monthly (the 2nd). Re-reads 12 settled
  quarters a run → `industry_government` per node per run date (6 runs kept); top recipients are NOT in v1.
  - **The crosswalk** was drafted by Claude and accepted by Roy as drafted (2026-10-12): the 209 NAICS codes in the top 95% of any
    quarter's dollars (96.9% of eight quarters'), each weighted by where its money lands among listed companies
    as OUR universe classifies the contractors (Amentum/V2X/BWXT/HII → A&D; KBR/Jacobs/Fluor/AECOM → C&E;
    Leidos/SAIC/CACI/Parsons → IT consulting; Booz Allen/ICF → research & consulting; Maximus → data processing).
    The service lines (541330 engineering, 561210 facilities, 541715 R&D, 541512/541519 IT) carry the most
    dollars and the most judgment; lines marked `check:` are the least sure. ~3% of dollars are on unlisted
    codes (logged each run; above 10% a warning), ~4% land on no listed company. The node's dollars are money on
    the lines it sells into, NOT its revenue — read the change.
  - **Settled quarters only.** The dry run 12 days after Sep 30 read the Jul–Sep quarter at $137B against $290B a
    year earlier: Defense Department contract data reaches USAspending 90 days late. A quarter counts 100 days
    after it ends. A settled quarter under half the same quarter a year earlier stops the run unwritten (the
    lowest real ratio seen was 0.91).
  - **Dry run, four quarters to June 2026 vs the four before:** rising — Automobile Manufacturers +84%, Health
    Care Services +72%, Construction & Engineering +48% ($132B of line money); falling — Environmental &
    Facilities Services −57% (DOE cleanup lines), Construction Machinery −35%, Life Sciences Tools −19%.

## 4. Where it lands

- **Engine jobs** (§9 of the parent). Three scripts, one per input, each writing ITS OWN collections — not a
  block on the metrics node, so no job waits on another's clock; the reader (8d) joins them by code:
  - `industry_insiders` + `industry_insiders_runs` — per node per run date (~270 at four levels), complete-run
    marker, 8 runs kept;
  - `fund_holdings` (per COMPANY per quarter: ~2,700 rows a quarter, 12 quarters ≈ 33,000 small rows, ~4 MB —
    company aggregates, not filings), `fund_holdings_runs`, and `industry_funds` (per node per quarter plus a
    `universe` row; the universe row written LAST, which is how a reader knows the quarter is whole);
  - `industry_government` + `industry_government_runs` — per node per run date (273), 6 runs kept.
  Well inside the M0 quota.
  Themes take theirs from the chain, as companies' money does today (`themeFacts`).
- **Schedule.** Insiders weekly, before Pythia's week (so the change scan sees it); funds on a new SEC file
  (checked weekly by file name — a corrected file SEC re-posts under the same name needs `--refetch-before`);
  government monthly.
- **Pythia.** `get_industry_money` returns the new blocks; the prompt reads them by §3's "read as" lines;
  the facts freeze on each assessment like the others; the board's money section gains three rows.
- **Change scan** (step 6), as designed: an insider cluster appears or ends; the institutional share crosses
  its 90th percentile; contract dollars' 4-quarter change crosses ±25%. As built (§7, QA §10): a cluster
  STARTING only; contract money ±25% on $1B+ either year, outside a gap from the frozen change; crowding off.
- **Hand-offs, later.** Prometheus's opening could name a company's own insider buys; Atlas's review could
  name a crowded holding. Not in step 8.

## 5. Cost

All free sources. FMP: 5–7 calls a week (insiders), 2,876 profile calls once, then ~60 CUSIP re-checks a
quarter. SEC: one ~100 MB 13F file a quarter (transient); the Form 4 data sets were downloaded once, for T1.
USAspending: ~120 calls a month (12 quarters × ~10 pages). No model calls in the jobs; Pythia's assessments grow
by the three blocks' tokens (~300).

## 6. The tests, declared before they run

Same discipline as industry-screener.md §5: the question, the data, the bar, written down first. A result
that passes becomes a `BASE_RATES` entry (`api/strategy/industryAssessment.service.js`), attached by code.

- **T1 — insider clusters (the one most likely to pass).** Do industries with clustered insider buying beat
  the market over the next 6 and 12 months? Data: SEC Form 4 data sets 2006 → 2026; issuers mapped to Ken
  French's 49 industries by SIC (from EDGAR submissions, one call per issuer CIK), so the returns come from
  the no-survivorship French 49 history already in `data/history/`. Bar: cluster months beat their
  industry's own average by ≥ 2pp a year with t ≥ 2 on 2016–2026 held out. Pass → the base rate rides on
  every flagged assessment. Fail → the cluster still rides, as awareness, with "no tested edge".

  **Exactly how, declared 2026-10-12 BEFORE any test code or result.** "Top-decile cluster months" is
  replaced by THE LIVE FLAG ITSELF, so the test measures what ships:
  1. *Purchases:* SEC Form 3/4/5 data sets 2006q1–2026q3; `TRANS_CODE` P, acquired, price > 0, value ≥
     $10,000, `AFF10B5ONE` not true, reporting owner a Director or Officer. One count per issuer.
  2. *Industry:* issuer CIK → SIC (EDGAR submissions) → French 49 (Ken French's `Siccodes49`). Issuers
     with no SIC or outside the 49 are dropped and counted.
  3. *Signal* at each month end t: B = issuers with a purchase TRADED in the trailing 3 months; N = the
     industry's firm count that month (`french49_nfirms`); the universe rate = ΣB / ΣN. **Cluster** = B ≥ 3
     and binomial P(X ≥ B | N, rate) < 0.01 — the live rule.
  4. *Outcome:* the industry's value-weighted return over months t+1…t+12 minus the market's
     (`ff_market`) over the same months; the 6-month version reported beside it, not judged.
  5. *Comparison:* each cluster's outcome minus that industry's mean outcome over all its months from
     2006 up to t (expanding — nothing from the future). Each month's clusters averaged into one number;
     the mean of that series, with a Newey-West t (11 lags: the windows overlap).
  6. *Judged on* t in 2016-01 … 2025-08 (the last month with 12 months after it); 2008-01 … 2015-12
     reported, not judged. **Pass:** mean ≥ +2pp and t ≥ 2.
  7. *Reported, not judged:* how many industry-months flagged; 10% owners alone (the holder line) as a
     second signal; the universe rate's own top decile (market-wide buying waves) against the market's next
     12 months.

  **Result (run 2026-10-12, `aether-engine scripts/run_insider_cluster_test.py`): FAILED.**
  Data: 408,807 qualifying purchases 2006q1–2026q3 from 12,728 issuers; SIC found for 11,618, inside the 49
  for 11,548 (91%). 1,057 of 12,054 industry-months flagged.

  | | 12 months vs own mean | t (NW) | months / flags |
  |---|---|---|---|
  | **Insiders, judged 2016-01…2025-08** | **+0.6pp** | **0.25** | 116 / 451 |
  | Insiders, 2008–2015 (reported) | −3.2pp | −1.68 | 95 / 458 |
  | Insiders, 6 months, judged | +0.5pp | 0.38 | 116 / 451 |
  | 10% owners alone, judged | −0.3pp | −0.10 | 112 / 210 |

  Year by year the judged series swings from −16pp (2019) to +13pp (2016) — no sign that holds. Market-wide
  buying waves (the universe rate's top decile, 25 months: late 2007–early 2008, late 2008, 2011, 2015, Dec
  2018, spring 2020, May 2022) were followed by a market up +3.3% over 12 months against +12.5% for all
  months — insiders buy into falls, and in 2007–08 the fall kept going. Reported, not judged.

  **So:** the cluster ships as AWARENESS only, as declared — `BASE_RATES` gains nothing, and 8d's prompt and
  board must say "no tested edge" beside it. What the test does NOT cover (each would need its own
  declaration first, not a rerun of this one with a new knob): single companies (the literature's insider
  effect is per firm — Prometheus's ground), GICS sub-industries instead of French 49 (163 nodes vs 49, and
  our own price history is short), dollars instead of counts.

  **Two flaws found in review (QA 2026-10-12), neither able to turn the FAIL into a pass:** (1) "the test
  measures what ships" is not exact — B counts every Form 4 issuer with a French-49 SIC, OTC registrants
  included (small bank holding companies above all), while N is `french49_nfirms`, exchange-listed firms only;
  the live rule takes both from one universe. (2) The month-end signal counts trades by trade DATE, including
  ones filed after the month end — a small look-ahead that would favour a pass. Any re-declared test filters B
  to listed issuers and to filings made by the signal date.
- **T2 — crowding.** Do industries at the top of their institutional-ownership history have worse forward
  returns or a higher crash rate (as hypes do: 22% vs 9%)? Data: 13F data sets back to 2013 (~50 files).
  The returns are the open part: our industry index may not reach back that far, and French 49 needs each
  CUSIP mapped to an SIC code, including companies that no longer exist — not checked yet. Bar: crash rate
  ≥ 1.5× base, t ≥ 2. Pass → the warning carries the rate. Fail → crowding is a fact only.
- **T3 — government.** Not tested: the series is short in this form, and the claim is not a return forecast
  but "this money is landing here" — awareness only, said so.

## 7. Build order

1. **8a Insiders:** the weekly job, the block, T1 on the bulk history.
2. **8b Funds:** `cusip` on `gics_companies`, the quarterly job with a backfill of 8 quarters (for the
   percentile), T2.
3. **8c Government:** the crosswalk draft → Roy's review, the monthly job.
4. **8d Pythia:** tool, prompt, board rows, change-scan triggers, frozen facts. Docs.

8a alone is useful; each later part ships on its own.

**8d as built (2026-10-12).** One reader, beside step 2's: `industryData.readFlowNodes / readAllFlows` (the
latest COMPLETE run of each collection, at the sub-industry's OWN node — insiders, funds and contracts are
counted per company or per line, so a thin sub-industry has them), `flowFacts` (what an industry assessment
freezes as `flows`, beside `money`; a theme's links stay on companies' money), `formatFlows` (appended to
`get_industry_money`, each with its reading). The prompt's money paragraph reads them: the insider cluster is a
fact and never the verdict's reason (T1 failed); funds are crowding, never "follow"; contracts are a `money`
cause only when the change is large and the lines are core. The board shows three rows under "where its
companies put money". The change scan gains `flowChanges`, compared ONLY against frozen flows — an assessment
made before 8d (or a theme) has none, so nothing is flagged for crowding it was never assessed on:
- `insider_cluster` / `insider_cluster_ended` (weights 2 / 1);
- `contracts_shift`: four quarters' contract money ±25% on the four before, on at least $1B, and not already
  shifting that way when assessed (weight 2);
- `crowded` — **built but OFF** (`SCAN.CROWDED_SCANNED`): on the first live read 66 of 163 sub-industries sat at
  the top of their own seven quarters at once, so the trigger would buy dozens of reassessments a week on a
  drift. Turn it on once the history is long enough that the top of the range is rare, and record how rare.

The live read also fixed three words: insider dollars in $M/$K (a single $B unit printed "$0.0B"), the ownership
LEVEL unsigned, and an industry no contract line maps to said once instead of "$0.0B, n/a".

## 8. Risks

- **The universe.** Only our ~2,650 companies count; a cluster at small caps outside it is invisible.
- **FMP display licensing** (fmp.provider.js header): insider rows SHOWN to users count as display.
  SEC and USAspending are public domain.
- **13F is late** (~45 days after the quarter, up to 4.5 months after a position was built) — read as
  where funds WERE.
- **NAICS is the contracting officer's label**, not always what was bought; the crosswalk review is where
  that is caught.

## 9. Decisions for Roy

1. **Insiders' live source:** FMP's feed (recommended — it works on our plan, covers all filers, and the
   10b5-1 flag it lacks touches 2.6% of buys) vs parsing EDGAR's Form 4 XML ourselves (free, has the flag,
   much more code).
2. **Who counts:** officers and directors as insiders, 10% owners as a separate line (recommended) — or
   10% owners mixed in.
3. **13F history:** 8 quarters for the percentile (recommended to start), or back to 2013 for T2 now
   (~5 GB of downloads, transient).
4. **Government scope:** contracts only (recommended) vs contracts + grants (CHIPS/IRA money is mostly
   grants and loans — but those are lumpy, slower and better caught by news).
5. **The crosswalk:** an LLM draft that you review (recommended), or built by hand.
6. **The bars in §6** — as written, or different.

## 10. QA cycle (2026-10-12)

Three reviews (engine jobs; backend wiring; board and docs), every finding checked against the code, all fixed:
- **An empty answer is not a run.** Insiders: under 30% of the previous run's purchases → not written.
  Government: a settled quarter under half the same quarter a year earlier → not written. Either would have
  been a COMPLETE run of zeros, firing `insider_cluster_ended` or `contracts_shift` across the board.
- **A half-written funds quarter is never read.** The engine writes each quarter's universe row last, and the
  reader takes the latest quarter that HAS sub-industry rows.
- **Stale CUSIPs are re-checked** (§3.2). **A mislabelled 13F file** is skipped by its file name, not
  re-downloaded weekly. **Page caps** log a warning instead of cutting a window silently.
- **The scan:** a cluster ending buys no run (only a start does); `contracts_shift` needs the frozen change
  under half the line (revisions near 25% do not re-fire) and counts a fall below $1B (the floor reads either
  year).
- **The prompt:** crowding is a fact, not a warning (T2 has not run); the scan list no longer names crowding.
- **The words:** real ordinals (43rd, not 43th); no rank on fewer than 4 quarters; $K amounts and "$0"; a fall to
  zero read as −100%, not "no lines map"; null fields left out on the board; "insiders bought at N companies".
- **Insiders' personal names** are no longer frozen on assessments (symbol, title, dollars, date only).
- **A failed flows read** is logged, and never fails an assessment or the weekly scan.
- Not changed: the reviewer's memory estimate for the 13F job (150–250 MB) — measured locally at 95 MB peak
  Python heap; unmeasured on Render.
