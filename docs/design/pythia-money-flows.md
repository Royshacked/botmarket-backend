# Pythia step 8 — the rest of the money: insiders, funds, government

**Status: DESIGN, nothing built (2026-10-12).** Step 8 of [pythia-assessment.md](./pythia-assessment.md) §12;
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
| FMP `stable/insider-trading/latest` (Starter plan) | 200; 1,000 rows a page; **6,000 rows = one week** of Form 3/4/5 lines (filed Oct 5–9). 392 open-market purchases (`P-Purchase`) in **80 symbols**, 61 of them ≥ $1M. Owner type, filing and transaction dates, price, shares, link | **Live feed.** ~6–8 calls a week |
| FMP `insider-trading/search`, `/statistics` | 200, per symbol | Not needed — the latest feed covers everyone |
| FMP `institutional-ownership/*` (13F) | **402**, Premium | Not usable (as fmp.provider.js already notes) |
| FMP `profile` | `cusip` per symbol; `profile-bulk` is 402 | The CUSIP→symbol map, one call per company |
| SEC **Form 3/4/5 data sets**, quarterly zip | 8.6 MB for 2026q3; `SUBMISSION` carries `ISSUERTRADINGSYMBOL` and **`AFF10B5ONE`**; `NONDERIV_TRANS` the code, shares, price; `REPORTINGOWNER` the relationship. 5,184 purchases in 1,047 symbols in the quarter | **History** (2006 →) for the tested base rate |
| — 10b5-1 share, same file | purchases: **136 of 5,184 (2.6%)** planned; sales: **~66%** planned | FMP's missing flag does not matter for BUYS; sells are mostly scheduled noise, as §4.3 said |
| SEC **13F data sets**, quarterly zip | 100 MB (396 MB `INFOTABLE.tsv`); 3.83M holdings rows, 34,951 CUSIPs, `VALUE` in dollars, CUSIP + FIGI; 10,940 of the filings report one period (the rest late/amended); streamed in **22 s** | **Funds.** One file a quarter, ~45 days after quarter end |
| USAspending `search/spending_by_category/naics` | 200, no key; one call per quarter returns obligated dollars per 6-digit NAICS (Q2 2026 top: commercial building $18.3B, missiles & space $16.7B, R&D $16.0B, aircraft $14.7B, ships $14.5B) | **Government**, by what was bought — no recipient resolution needed at industry level |

## 3. The three inputs

### 3.1 Insiders — "are the people who run these companies buying with their own money?"

- **Source.** Weekly: FMP latest feed, paged back until the previous run's last filing date (~6–8 calls).
  History: the SEC quarterly data sets, downloaded once for the test (§6), never stored in Mongo.
- **What counts.** Open-market purchases only (`P`, acquired, price > 0). Officers and directors are
  INSIDERS; 10% owners are a separate line (often funds — a different kind of money). Awards, option
  exercises, gifts and in-kind are not purchases. A purchase reported more than 30 days after the trade
  counts on its trade date, never as "new this week".
- **Per sub-industry, trailing 90 days:** companies with an insider buying, distinct insiders buying, dollars
  bought, the largest buys (name, role, $, date) — and the **cluster** flag: insiders at ≥ 3 different
  companies of the sub-industry bought in the window. Selling is recorded as a count only, never featured.
- **Read as:** clustered buying across several companies is the rare informative case (§4.3); one CEO buying
  is a company fact, Prometheus's, not an industry one.

### 3.2 Funds (13F) — "who is already in?"

- **Source.** The SEC quarterly 13F data set, on each new file. Streamed row by row (never loaded whole —
  Render's memory); only rows whose CUSIP is in our universe are kept.
- **CUSIP → symbol.** `gics_companies` gains `cusip`, from FMP `profile` (one call per company: ~2,650 once,
  then only new names at classification; paced like `classify_gics.py`, off-hours — the key is shared with
  live loops).
- **Hygiene.** Shares only (`SH`), not options (`PUTCALL` rows dropped) or bonds (`PRN`); one filing per filer
  per period — a restatement amendment replaces the original, a new-holdings amendment adds to it; filings
  for older periods go to their own period.
- **Per sub-industry, per quarter:** the institutional share (13F value ÷ market cap at period end), the
  quarter's change in SHARES held (price-neutral), the change in holder count, and the share's percentile
  against the sub-industry's own history.
- **Read as:** CROWDING, never a lead (§4.3). At the extremes it is a warning; it never says "follow".

### 3.3 Government — "where does public money land?"

- **Source.** USAspending, contracts (award types A–D), obligated dollars per NAICS per completed quarter —
  one call a quarter plus pages. The latest quarter is incomplete for weeks (the provider's trap 3), so
  quarters are re-read for two quarters after they close and upserted.
- **NAICS → GICS sub-industry.** A crosswalk file in the engine (`config/naics_gics.yaml`) for the NAICS
  codes that make up ~95% of contract dollars (a few hundred), drafted by an LLM pass from the two
  definitions and REVIEWED by Roy — the same shape as the 710 split companies. A NAICS line may feed more
  than one sub-industry, with a weight.
- **Per sub-industry:** the last 4 quarters against the 4 before, the same change a year earlier, the top
  NAICS lines behind it, and the top recipients (names only, from `spending_by_category/recipient` with the
  NAICS filter — resolving them to tickers is the opportunist doc's `recipientResolve`, not this step).
- **Not here:** grants and loans (CHIPS, IRA), budgets and tariffs stay with news (§4.1); the contract
  ledger is what is cheap, dated and complete.

## 4. Where it lands

- **Engine jobs, aggregates only** (§9 of the parent). Three scripts, one per input, each writing a block
  onto the industry node the money job already writes: `money.insiders`, `money.funds`, `money.government`
  beside step 2's companies' money. ~270 nodes × a few hundred bytes a block — well inside the M0 quota.
  Themes take theirs from the chain, as companies' money does today (`themeFacts`).
- **Schedule.** Insiders weekly, before Pythia's week (so the change scan sees it); funds on a new SEC file
  (checked weekly by `Last-Modified`); government monthly.
- **Pythia.** `get_industry_money` returns the new blocks; the prompt reads them by §3's "read as" lines;
  the facts freeze on each assessment like the others; the board's money section gains three rows.
- **Change scan** (step 6) gains three triggers: an insider cluster appears or ends; the institutional share
  crosses its 90th percentile; contract dollars' 4-quarter change crosses ±25%.
- **Hand-offs, later.** Prometheus's opening could name a company's own insider buys; Atlas's review could
  name a crowded holding. Not in step 8.

## 5. Cost

All free sources. FMP: ~6–8 calls a week, plus ~2,650 profile calls once. SEC: one 9 MB and one 100 MB file a
quarter (transient). USAspending: a few calls a month. No model calls in the jobs; Pythia's assessments grow
by the three blocks' tokens (~300).

## 6. The tests, declared before they run

Same discipline as industry-screener.md §5: the question, the data, the bar, written down first; the result
recorded in the yaml the code reads, not in code.

- **T1 — insider clusters (the one most likely to pass).** Do industries with clustered insider buying beat
  the market over the next 6 and 12 months? Data: SEC Form 4 data sets 2006 → 2026; issuers mapped to Ken
  French's 49 industries by SIC (from EDGAR submissions, one call per issuer CIK), so the returns come from
  the no-survivorship French 49 history already in `data/history/`. Bar: top-decile cluster months beat
  their industry's own average by ≥ 2pp a year with t ≥ 2 on 2016–2026 held out. Pass → the base rate rides
  on every flagged assessment. Fail → the cluster still rides, as awareness, with "no tested edge".
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
