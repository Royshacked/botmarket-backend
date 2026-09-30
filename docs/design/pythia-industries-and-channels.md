# Pythia — where to look, and why

**PROPOSED.** Backticked names that do not resolve are what this doc asks to create; everything
described as existing was read out of the code or the database on 2026-09-30 and the evidence is
quoted inline.

**Landed since:** the vocabulary and the resolver — `INDUSTRY_SECTOR`, `resolveBucket`,
`parentSector`, `BUCKET_PROXY`, `proxyFor` in `services/entity/vocabulary.js`, with
`tests/unit/bucketVocabulary.test.js`. ~~`SECTOR_ETF`~~ and ~~`sectorProxy`~~ were removed rather
than left beside the new table. **Vindicated 2026-09-30, after eight runs that produced only sector stances.** The doc's cascade —
"sub-industry where a proxy exists, industry where it doesn't, sector where neither does" — was
built as a REFUSAL instead, and the prompt told the desk its table would be rejected for naming a
bucket with no fund. With no way to know which of 155 industries are priceable, the only safe table
was one of sectors. Restoring the fallback produced industry stances on the next run: Semiconductors
+100bp against SMH and Biotechnology +100bp against IBB, both `bottom_up`, and Argus screened those
two industries rather than their sectors.

Also landed: the row schema itself — `grain` / `bucket` / `proxy` replacing `sector`, the
`overlappingRows` and `unpriceableRows` gates, every consumer (the monitor, `diffStances`, the
house scan, the cards, Atlas's fingerprint), the prompt, and `scripts/migrate-tilt-buckets.mjs`.
Step 1 is complete. Steps 2 onward — the sparkline and everything channel-shaped — are not.

`check:docs` scores this doc around 40% unresolved, and that is expected rather than rot. What it
cannot see splits three ways: **Mongo collections and document fields** (`aether_channel_state`,
`base_px`, `sub_industry`) which are live data whose code is gone; **channel ids** (`energy_cost`,
`discount_rate`) which are values, not symbols; and **the things this doc proposes**. Read the
dated body, not the percentage.

The one line: **Pythia publishes one table of relative bets at whatever grain the bet actually
lives at — sector or industry — sized by the gap between what the desk thinks a
macro channel will do and what the market has already priced.**

---

## 1. What is wrong today

Pythia grades cleanly and says almost nothing actionable.

- The table is **11 sectors**. "Overweight Energy" is not a place to look; it is a direction.
- **Industries cannot be expressed.** `normalizeSector` canonicalises to the eleven, so a row is
  either dropped or silently coerced. `Semiconductors` → null, dropped and logged.
  `Technology — Semiconductors` → `Technology`, priced with XLK, **not logged at all** — the drop
  warning in `publishTilt` only fires for rows that fail to canonicalise, and this one succeeds
  into the wrong thing. A semis call becomes a bet on all of Technology with no trace.
- **The grain below a sector does not exist** in the vocabulary at any level.
- The **regime is ungraded prose**. `reviewDecision` says so plainly, and correctly refuses to
  fake a verdict on free text.
- Three of the six live rows rest on `basis: rate_sensitivity` — the basis the desk's own
  vocabulary ranks last. The Real Estate rationale admits it: *"no covered names (O excepted),
  stance rests on factor alone."*

So the desk's strongest claim is its weakest-evidenced one, at a grain too coarse to trade.

## 2. The table

**One table. One benchmark. Mixed grain.**

Every row is an active weight in basis points against **SPX**, exactly as today. What changes is
that a row may name a sector or an industry. The row records which:

- `grain` — `sector` · `industry` (see **Two grains, not three** below)
- `bucket` — the name at that grain
- `proxy` — the ETF it is graded against

### Two grains, not three

Settled during implementation, 2026-09-30. **FMP's `industry` level is already sub-industry fine**,
so a third grain would have no vocabulary behind it and nothing for Argus to screen with.
`/available-industries` returns 159 names, and `Gold`, `Copper`, `Steel`, `Semiconductors`,
`Banks - Regional`, `REIT - Mortgage`, `Uranium` and `Solar` are all first-class industries there.

Every fund this doc first called a sub-industry proxy — GDX, COPX, SLX, JETS, ITB, REM — therefore
maps to an FMP **industry**. The ragged "only where a real ETF exists" level is not needed, because
the level it was reaching for is the one already in the vocabulary.

155 of the 159 are usable: each resolves to exactly one sector with no ambiguous case, and the four
dropped (`Financial - Diversified`, `Industrial - Capital Goods`, `Real Estate - General`,
`General Utilities`) have no actively trading companies, so a stance on one could be neither
screened nor graded.

Everything else on the row is unchanged: `stance`, `active_bp`, `horizon`, `basis`, `rationale`,
`set_at`, `review_date`, `base_px`, `base_bench_px`, `contribution_bp`, `state`.

The arithmetic is unchanged too. Active weights net to zero across whatever was named; anything not
named sits at benchmark weight. `active_bp × relative return` is still exact, because it is still
one benchmark.

### The gate this needs

**A parent and its own child may not both appear.** "Energy −100" plus "E&P +50", both against SPX,
double-counts E&P's energy exposure — the sum is arithmetically fine and the meaning is mud.

Enforced the same way `stanceCoherence` is: resolve each row to its parent chain, refuse the table
if any row's ancestor is also present, and say which pair. Refused at publish, where the author can
fix it. This is the sibling of the existing one-row-per-sector rule.

### Rejected: nested benchmarks

The alternative was to grade an industry against its parent **sector ETF**, netting to zero within
the sector, so a sector call and an industry pick compose and decompose separately.

It is a better instrument for **judging the desk** — it tells you whether you were right about
energy or right about E&P — and a worse one for **using** it: two tables, two benchmarks, two sets
of clocks, and "where do I look" stops being one list.

Not chosen. Revisit if and when the desk's own track record, rather than its output, is the
problem being solved.

### What is given up, stated plainly

- **No decomposition.** One number per row. A loss does not tell you which layer was wrong.
- **Coverage.** ETFs cover perhaps 25–30 distinct industries; GICS has ~74. Sector rows remain in
  the vocabulary as the fallback grain for everything with no fund — not as a layer, as a default.
- **Signal strength falls with grain.** Sector ≈ 40 names, industry ≈ 10, and the finest of them
  fewer still. The
  measured version of this: of 8,531 fitted betas only **200** cleared significance, and only 5 of
  28 industries had ≥3 names carrying an EDGAR exposure.
- **Risk is not comparable across grains.** 200bp in a 40-name sector and 200bp in a 4-name
  four-name industry fund are the same number and very different bets. `grain` is on the row so Atlas can
  treat them differently; this doc does not specify how.

## 3. Proxies

A stance is only publishable if it can be priced. All 48 candidates below were fetched through
`fetchLastPrice` on 2026-09-30 — **48 of 48 resolved**, so no provider work is implied.

```
Technology     XSD SMH IGV XITK CIBR SKYY      Energy       XOP XES OIH AMLP
Healthcare     XBI IBB XPH XHE XHS IHI         Materials    XME GDX SLX COPX LIT MOO
Financials     KRE KBE KIE KCE IAI             Industrials  ITA XAR XTN IYT JETS PAVE GRID
Cons Cyclical  ITB XHB XRT PEJ BJK             Comm Svcs    XTL VOX XWEB
Real Estate    REM REZ INDS SRVR               Cons Def     PBJ
```

### Cap-weight, not equal-weight — the decision that silently corrupts the grade

The Select **Sector** SPDRs already in use (XLB…XLU) are cap-weighted. The Select **Industry**
SPDRs (XSD, XBI, XPH, XHE, XHS, KRE, KBE, KIE, KCE, XHB, XRT, XTN, XAR, XME, XES, XOP, XTL, XWEB)
are **equal-weighted**.

Grade XBI against SPY and part of what you measure is small-cap versus large-cap, booked as a
biotech call. Where a cap-weighted twin exists, take it: **IBB** over XBI, **SMH** over XSD,
**ITB** over XHB, **IYT** over XTN. Where none exists, the row is still publishable and the
weighting is recorded on it, because a known bias that is written down is not the same failure as
one nobody sees.

### An ETF is a product, not a taxonomy bucket

JETS holds foreign airlines and some airports. XRT is not GICS Retail. The bucket named on the
stance and the thing being graded are approximately, not exactly, the same. This is the same class
of admission the `basis` field already makes, and it belongs on the row for the same reason.

### The vocabulary is FMP's screener industries

Not GICS, not the ETF names. Two reasons, and the second is decisive:

- It is the call `SECTORS` already makes — *"these are our data provider's names."*
- **Argus's screener already accepts an `industry` filter.** Its own error copy names
  *"Semiconductors, Software—Infrastructure"*. A stance written in that vocabulary is a screen
  Argus can run today. Any other vocabulary needs a mapping layer, and a mapping layer drifts.

One consequence: **`houseScan` currently screens only `over` sectors.** An overweight industry
inside an underweight sector — the normal case, not an edge case — would never reach Argus. That
has to change with this.

## 4. Channels — the reason, never a row

A channel is a macro driver with a history: 19 of them, each a z-score and a regime label per date,
**back to 2006**. They have no proxy and no tradeable form. They are never a row. They are the
*why* and the *when*.

**All of this is archived.** The `proxies`, `state` and `betas` jobs were deleted on 2026-09-09 —
*"a collection with no reader anywhere in either repo. The 200 significant pairs were a finding, not
a feed."* ~~`get_channel_taxonomy`~~, ~~`get_channel_state`~~ and ~~`get_regime`~~ went from the tool registry
the same day. The data is frozen: channel state to 2026-09-07, betas `window_end` 2026-09-07.
Using channels means reviving jobs, not wiring a tool.

### Where they attach

| Phase | What a channel contributes |
|---|---|
| 1 — Backdrop | Channel state *is* the market read. Level, trend and regime, against 20 years of its own history |
| 2 — Regime | Kill-criteria written as channel conditions. `energy_cost z > 1.5` is arithmetic; prose is not |
| 3 — Mapping | Betas say which buckets are *measurably* exposed. This is where "where to look" gets evidence |
| basis | A new `channels` value in `TILT_BASES`, ranked with `bottom_up` and `revisions` — it is measured |
| monitor | A channel moving against a stance's premise becomes a re-review trigger. Today the only triggers are the clock, the macro calendar and the 30-day floor |

### Why channels suit a mixed-grain table specifically

Every other input is grain-specific — coverage counts, the sector snapshot, the proxy. Betas are
fitted per instrument, so the same arithmetic serves a sector row, an industry row and a
row at either grain. They are the one input that does not care which grain a row is at.

### Fit the ETF, not the constituents

The archived engine fitted ~460 tickers. **Fit the ~40 proxies instead.**

- 40 × 19 ≈ 760 regressions, against 8,531. Comfortably inside the FMP rate limit that was already
  failing the old `prices` job — 306 of 460 tickers on its last run.
- 40 price series to keep current, not 460.
- It removes the roll-up step, and with it the ETF-versus-taxonomy mismatch: the beta then
  describes **the exact instrument the stance is graded on**.
- An index is less noisy than a single name, so more pairs should clear the significance bar.

The regression spec carries over unchanged. It must:

**Two-factor, market controlled.** `return = a + b_mkt·r_market + b_channel·Δz`, and `beta` is the
channel coefficient. This is why **no SPX forecast is ever needed** — the market's move is already
absorbed by the other term, so the beta is an active quantity by construction. Deliberately not
excess return (`r − r_mkt`), which *"assumes every name has a market beta of exactly 1, which
leaves half the market in an airline's residual and none of it in a utility's."*

The engine's own evidence for why this matters: on raw returns all 51 names showed a `risk_premium`
(VIX) beta at t −7 to −11. *"That was not 51 findings; it was market beta restated 51 times, and it
collapses to −2.79 once the market is a regressor."* And in reverse, controlling reveals real
exposure — AAL/`energy_cost` went t −1.76 → −2.99, becoming significant.

**Univariate in the channels, knowingly.** Channels are correlated, so a single-channel beta absorbs
shared variance and *overstates* what is priced in — understating the residual and discarding edge
rather than inventing it. *"That is the right direction to be wrong."*

**`MIN_OBS` 60, `T_THRESHOLD` 3.0** — not the conventional 2.0, because these are hundreds of
simultaneous regressions. Measured on the real panel: at t ≥ 2.0, 88 survivors against ~44 expected
false, a 50% false-discovery rate; at t ≥ 3.0, 23 survivors and 11%.

**Estimated on changes, applied to levels.** The fit is weekly return on weekly *change* in z.
Multiplying by the z *level* reads as the cumulative move from neutral to where the channel sits
now — the same convention on both sides of the subtraction below, which is the only thing that
makes the difference mean anything.

## 5. From a channel to a weight

The formula is the archived engine's, and it is better than "exposure × expected move":

```
residual = expected_impact − priced_in
         = elasticity × z  −  beta × z
```

- **`elasticity`** — what the desk thinks the channel does to this bucket. The judgment.
- **`beta`** — what the market has historically done when it moved. Measured.
- **`residual`** — the gap. The only part worth trading.
- `active_bp ∝ |residual|`, sign from the residual, demeaned across rows so the table nets to zero
  **by construction** rather than by the model doing arithmetic, then capped per row.

**Beta is not the signal. It is the subtraction.** A high beta means already priced, so less edge —
the opposite of what "highly exposed" suggests.

### Measured zero is the case that pays

*"unmeasured — we never regressed this pair. We know nothing. Claim nothing. measured — we
regressed it and the price genuinely does not move with this channel. THAT IS THE SIGNAL — a real
fundamental exposure the market does not trade is exactly the non-obvious case worth owning."*

The trap is the same one the old engine fell into: defaulting an **unknown** beta to zero looks
conservative and is the opposite. Residual becomes the full modelled impact, which clears any gate
most easily and takes the largest weight. **An unmeasured beta maximises both the signal and the
position built on it.** The two must stay distinguishable in storage and in the sizing.

## 6. Elasticity is judgment — and where to put it

There is no honest way around this at industry grain. The engine's own verdict: *"nothing is
asserted without something that could contradict it. 'Ford halted Explorer production over the
magnet shortage' is checkable. **An LLM-assigned elasticity is not.**"*

The three sources it had, and why none survives at this grain:

- **LLM judgment** — rejected above.
- **EDGAR narrative** (`aether_exposures`) — Item 7A text with `confidence` and `source_ref`. 339
  rows over 83 entities. Says a company *is* exposed, rarely how much. An ETF has no filing.
- **Fundamentals** (`aether_inner_facts` → `aether_inner_parameters`) — 186k XBRL quantities rolled
  into parameters like `operating_leverage`. Frequently `basis: "unmeasured"`, with the reason
  recorded: *"cost tag 'CostsAndExpenses' is total cost — the split cannot be read."*

So elasticity is Pythia's, stated per row. That is acceptable here in a way it was not there,
because it is **relocated to somewhere scoreable** rather than eliminated.

Today a stance is one unfalsifiable blob: "overweight Healthcare 200bp because late-cycle." Under
this, the judgment splits into two claims graded separately, against a measured third:

| Channel moved as forecast? | Bucket moved as claimed? | What was wrong |
|---|---|---|
| yes | yes | nothing — the model works |
| yes | no | the elasticity. Fixable, and specific |
| no | — | the macro call. The elasticity is untested, not refuted |
| yes | yes, but no money | nothing was wrong — it was already priced. Check the beta |

That decomposition is the actual argument for this design. It does not remove judgment; it turns
one stance nobody can grade into three claims that keep score.

## 7. Verification at the moment of the trade

The industry elasticity is an assumption. A **company** has filings. So the check that is
impossible at industry grain becomes possible at name grain, at the moment it matters.

- Pythia states the industry elasticity.
- Argus screens the industry and returns names.
- **Prometheus checks that name's filings against the claimed exposure**, before Atlas sizes
  anything. It already reads filings per name; `aether_exposures` is the extraction shape.
- The result is recorded either way.

Two rules this must obey:

- **It is not a gate.** *"Verification failing is INFORMATION, not a reason to drop the name: a
  company that is visibly exposed in the press and silent in its filings is exactly the interesting
  case."* Record it; do not silently filter.
- **Watch the selection bias.** The stance is graded on the proxy. Keep only the names whose
  filings confirm exposure and the book becomes more exposed than the ETF — P&L and grade drift
  apart. The gap exists already (the sector tilt grades XLK while Atlas holds stocks); filtering
  widens it deliberately. Decide explicitly whether the row is graded on the proxy or on what was
  held.

The payoff is a loop that does not exist today: the **aggregate verification rate across the names
Argus found is bottom-up evidence for or against the industry stance at the next review.** That
closes a gap `pythia-tilt.md` already lists as open — *"the bottom-up basis is a cross-check, not a
feed... nothing re-runs that comparison as coverage changes between reviews."*

## 8. The graph, and a correction to the record

Each row should carry a small chart, not only a number:

- **The relative line since `set_at`** — proxy ÷ benchmark, rebased to 100. This *is* the
  contribution, drawn. The row's grade as a picture.
- **The channel z-score behind the stance**, against its own history. Twenty years are available,
  so "how unusual is this" costs nothing.

**This contradicts `pythia-tilt.md`, which is stale.** That doc justifies the frozen baseline partly
on data: *"deep daily history is not reliably available here (a range fetch 403s, ~a month of bars
is cached), so a stance authored six months ago could not be re-based from data at all."* Measured
2026-09-30 through `getTickerAggregates`:

```
XLE  275 daily bars   2025-08-26 .. 2026-09-29
```

Thirteen months of clean daily bars, the same for SPY, XOP and JETS. The claim predates
`USE_FMP_CANDLES`. **The data half of that argument is dead and the doc needs correcting.** The
other half stands on its own and is the real reason to keep freezing baselines: an immutable
baseline means a provider revising history cannot silently re-score a closed call.

Cost: one range fetch per row per day against today's twelve last-price reads. At 40 rows that is a
real change to the monitor's budget and wants a cache keyed on (proxy, day).

Rendering is a frontend decision, but one constraint is already settled: the only chart path is the
LLM-tag → ChartBubble route, and that is wrong for a 40-row table. Sparklines in the table cells,
fed by a data endpoint, not forty chart bubbles.

## 9. Channels to add

Recovered from ~~`channels.yaml`~~. Nineteen run today. Two defects first:

- **`geopolitical` is defined and not running** — it needs a manual CSV from
  matteoiacoviello.com/gpr.htm, which is presumably why.
- **One `channel_id` in `aether_channel_state` is an empty string.**

Missing, ranked by how much each differentiates one sector or industry from another:

1. **Yield-curve slope** (**T10Y2Y**). The live regime is *named* "bear-steepening" and there is no
   curve channel. It is the most sector-differentiating rate variable there is — bank net interest
   margin lives here. The single biggest gap.
2. **Inflation expectations** (**T5YIE**, **T10YIE**). There is no inflation channel at all:
   `discount_rate` is the real yield, `policy_rate_expectations` the nominal short end. The
   published thesis cites breakevens moving 2.40 → 2.31 and the table cannot see them. Drives
   pricing power, real assets, staples margins.
3. **Liquidity / QT** (**WALCL**, **WRESBAL**, **RRPONTSYD**). Absent, and dominant for long-duration
   growth and small caps.
4. **High-yield spread.** `credit_access` is BAA10Y — investment grade. HY is the cyclical signal.
   The config notes ICE BAML was pulled from FRED in 2023; the **HYG/LQD price ratio** is a
   tradeable substitute with full history.
5. **Earnings-revision breadth.** `TILT_BASES` calls `revisions` *"empirically the best-supported
   signal"* and there is no channel for it. Not on FRED — compute from FMP estimates.
6. **Trade / tariff policy.** `regulatory_policy` uses the general EPU index; trade policy has its
   own sub-index from the same authors. Industrials, retail and semis deserve their own driver.
7. **Global / China demand.** `end_demand` is US retail sales and UMich sentiment. Nothing ex-US,
   which is most of what moves materials and energy.

**Deliberately not recommended:** positioning and fund flows. The data is licensed or expensive, and
it is a weeks-not-quarters signal — the wrong horizon for a desk whose shortest stance is 3 months.

Four of the seven — curve, breakevens, liquidity, the HY ratio — are single series in exactly the
shape the existing config already takes.

## 10. Naming

The channel, beta and exposure layer becomes **Pythia's**, and should be named so: `pythia_channel_state`,
`pythia_channel_betas`, `pythia_exposures`.

**But Aether is two things.** The event-exposure desk — `/api/aether/*`, `get_event_candidates`,
the discovery run, `aether_opportunities` — is a live desk with its own surface. Folding it into
Pythia is a product decision, not a rename, and this doc does not make it.

Cost of renaming the channel layer: ~33 Mongo collections (rename in place, or dual-read through a
migration), the Python package and its configs, the Node routes and tools, and docs across three
repos. The code is cheap; the collections need a script.

## 11. Open decisions

- **Is there a `1m` horizon?** `HORIZONS` is `3m · 6m · 12m · 18m · 24m`. A monthly view was asked
  for. But the review floor is 30 days, so a 1-month stance matures at almost exactly the moment
  the desk is next asked to look at it — every call due at every review, with only the 7-day
  cooldown preventing churn. A genuine monthly layer is probably a different instrument with its
  own cadence, not a shorter horizon on this one.
- **Graded on the proxy, or on what was held?** §7.
- **Does the event leg come back?** EDGAR event → predicted channel change is what turns channels
  from exposure into timing. It is also the most thoroughly archived piece —
  `aether_predicted_channel_state` holds **one row** — and ~~`run_event_channels.py`~~ is *"wired to a
  dead engine at both ends."*
- **Who caps a narrow industry row?** `grain` is recorded and a four-name fund is not a
  forty-name one; nothing here says what Atlas does with the difference.
- **Does Pythia publish both grains in one turn**, or the finer table on demand?

## 12. Build order

Each step is useful alone and none of them requires the next.

1. **`grain` / `bucket` / `proxy` on the row, plus the parent-child gate and the proxy table.** The
   table can then say "Semiconductors" and grade it. No channels involved.
   *Done 2026-09-30 — vocabulary, row schema, both gates, both migrations.*
2. **`houseScan` passes the row's bucket to the screener**, so an industry stance reaches Argus —
   and so an overweight inside an underweight sector is screened at all.
3. **The sparkline**, with its per-day cache. Independent of everything else.
   *Done 2026-09-30 — `tiltSeries.service.js`, `GET /tilt/series`, and the line on the board.*
4. **Revive `state`.** Cheapest channel work, and it is what makes the regime falsifiable.
5. **Refit `betas` on the ~40 proxies.** Upgrades the weakest basis the desk publishes.
6. **Elasticity, residual sizing, and the Prometheus verification loop.** The largest step, and the
   one that makes the judgment scoreable.
7. **The event leg**, if ever.
