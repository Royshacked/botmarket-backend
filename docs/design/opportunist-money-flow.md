# Money flow — the opportunist's first hunting ground

**Status: DESIGN ONLY, nothing built.** Settled 2026-08-16. This is the concrete flow for §3.1 of
`docs/design/opportunist-desk.md` (the Tyche desk). Read that first — this document assumes its
premises (concede speed, trade the lag, precision is the product) and does not re-argue them.

Relates to: `docs/design/opportunist-desk.md` (§3.1, §8, §10, §13, §14), `api/strategy/tilt.service.js`
(baseline + clock + grading machinery), `services/priceStats.util.js` (the sigma screen's arithmetic),
`monitoring/dueLoop.js` (the ingest and grading loops), `providers/sec.provider.js` +
`services/news.service.js` (the silence check).

---

## The one line

**Public money is announced in structured form, in volume, on a schedule — and nobody reads it.
We read all of it, rank it by how much it matters *to the recipient*, and surface the handful where
the money is large relative to the company and the story has not been told yet.**

---

## 1. Why money flow is the right first ground

The parent doc's hardest open question is the **significance gate** (§15 Q2): what decides whether
the desk fires 5 times a year or 50, and it is "not specified" because for a news feed it requires a
classifier we have not built. 

**Money flow answers it for free.** Every event arrives with a dollar amount attached, and
materiality is arithmetic:

> **award value, annualized over its period of performance, divided by the recipient's revenue.**

That is the significance gate. No model, no classifier, no judgment — a sort. A desk whose first
filter is a division is a desk that can run on ten thousand items a week, which is exactly the
volume problem §2.1 says the whole design lives or dies on.

The three other properties that make it first:

| Property | Consequence |
|---|---|
| Public, structured, free APIs (no key on USAspending) | ingest is engineering, not a data deal |
| Administrative lag — money voted today is spent over 3–5 years | cannot be arbitraged by reading faster (§3.1) |
| Tedious at volume, owned by nobody | the unread, per §2's coverage corollary |

---

## 2. Sources — v1 cut

Ranked by (structured × unread × free). **v1 takes the top two and nothing else.**

| # | Source | What it is | v1 |
|---|---|---|---|
| 1 | **USAspending.gov** `/api/v2/search/spending_by_transaction/` | every federal award ACTION with its own obligated amount, plus an award-detail call for PSC/NAICS/period of performance. No API key. | **yes — alone** |
| 2 | ~~defense.gov daily contracts~~ | DoD's ≥$7.5M same-day announcements | **cut — see below** |
| 3 | FPDS-NG ATOM feed | the authoritative upstream USAspending is built from | not needed |
| 4 | Congress.gov / appropriations text | the money *before* it is awarded — longest lag, hardest parse | v2 |
| 5 | EU TED, state DOT lettings, DOE LPO, grants.gov | more of the same shape, non-US | v3 |

**One source, not two — decided on evidence, 2026-08-16.** The original plan paired USAspending
(complete, structured, assumed slow) with defense.gov (same-day, prose). Probing all three killed the
pairing:

- **defense.gov is Akamai-blocked.** `403 Forbidden` to a plain request and to a full browser
  User-Agent alike. It is reachable only through a real browser engine (we have Playwright), which
  makes the freshest source also the most brittle part of the pipeline — an HTML scrape behind bot
  management, for prose we would then have to parse.
- **FPDS-NG ATOM works** (keyless, ~37,650 transactions in a 7-day window) but buys nothing:
  USAspending is built from it, and returns JSON instead of nested ATOM XML.
- **USAspending is far fresher than assumed.** Rows exist for the same business day. The design
  said "days to weeks"; it is T+0.

So the second adapter earns its complexity only if same-day matters — and this desk concedes speed
by construction (parent §1). **Rejected for v1:** anything paid, anything needing a browser engine,
and anything unstructured enough to cost an LLM call per item at the wide end of the funnel.

### 2.1 Verified against the live API — the numbers the design now rests on

| Probe | Result | Consequence |
|---|---|---|
| `spending_by_award` over 6 weeks | top row a **$48B Lockheed award dated 1993** | award endpoint returns LIFETIME cumulative value. **Wrong endpoint** — must use `spending_by_transaction` |
| `sort` omitted | `400 Missing value: 'sort' is a required field` | not a default, an error |
| contract transactions/day, no floor | ~8,200–10,900 | the raw firehose |
| same, `award_amounts` floor $1M / $5M / $10M | 602 / 259 / 177 per day | the floor can be pushed into the query |
| same-day vs settled row counts | **1,770 vs ~8,200** (~20% reported) | agencies report over ~3 business days — **a one-shot "fetch yesterday" sees a biased fifth of the day** |
| 5-day sweep, $5M floor | 1,213 rows → **1,162 modifications**, 22 new-money ≥$10M | the `Mod` gate drops **96%** of volume |
| award detail, one contract | obligated $215.5M vs `base_and_all_options` $327.9M | obligated-vs-ceiling is machine-readable — trap #1 is preventable, not just nameable |

Built and passing: `providers/usaspending.provider.js` + 18 unit tests.

---

## 3. The flow

```
   ┌─ ingest ─────────────── USAspending trailing-window sweep, $1M floor    ~3,000/wk   NO LLM
   │                         → normalize → upsert on transaction_key
   │
   ├─ 1. RESOLVE ─────────── legal entity → parent → listed ticker          ~3,000 → ~300  NO LLM
   │                         (unresolved is LOGGED — it seeds derived mode)
   │
   ├─ 2. materiality ─────── new money? annualized value / recipient revenue  ~300 → ~15   NO LLM
   │                         + recurrence + enrichment call on survivors only
   │
   ├─ 3. silence + sigma ─── has the story been told? has the price moved?     ~15 → ~6    NO LLM
   │                         2x2 read (§5), z at 5/20/60d beta-adjusted
   │
   ├─ 4. the chain ───────── direct or derived; the ONE expensive turn          ~6 → ~4    LLM
   │
   ├─ 5. chart read ─────── shape + entry level + invalidation                  ~4 → ~2    LLM
   │
   └─ 6. surface ─────────── flow_candidate: frozen px, expiry, mechanism        ~2/wk
                             → handoff to Mentor for entry/stop/target
```

**Stages 1 and 2 are inverted from the first draft, and that is a real correction.** Materiality
needs the recipient's revenue, and revenue needs the recipient resolved to a listed company — so
resolution cannot come second, it is a precondition. It is also the cheaper gate by a wide margin:
an in-memory UEI→ticker lookup against a curated map, versus a fundamentals fetch. Most federal
recipients are private, so resolution eliminates the bulk of the feed for the price of a `Map.get`,
and only what survives is worth a revenue call at all.

**Ranking is by materiality, never by dollars — and the floor is $1M, not $10M.** The live top-8 by
absolute size over five days was Accenture Federal ($144M), AT&T ($74M), Tutor Perini ($60M), A-Mark
($40M): all listed, all resolving, and **not one of them material** — a $144M award against
Accenture's ~$65B revenue is 0.2%. That is not an accident of the sample, it is structural. *The
biggest awards go to the biggest companies, which is why they are big.* An absolute-size sort ranks
the feed in almost exactly the wrong order, and a $10M floor would have excluded the actual target:
an $8M award to an $80M-revenue microcap is 10% materiality and sits nowhere near the top of a
dollar-sorted list. The floor exists to bound ingest cost (602/day at $1M vs 8,200 unfiltered), and
for no other reason.

Volumes past stage 1 are the design target; ingest volumes are measured (§2.1). The shape is the
point: **five of six stages are arithmetic**, the model is touched twice, and the human at the end
sees roughly two a week — §14.1's precision bar, engineered rather than hoped for.

---

## 4. Stages 1–2: the arithmetic gates

### 4.1 The normalized event

One shape from both adapters. Written to `flow_events` whether or not it survives — the funnel's
audit trail *is* the rejected-names ledger (§13b) that calibrates our own strictness.

```js
{
  id, source: 'usaspending' | 'dod',
  award_id, announced_at, reported_at,          // announced ≠ reported; the gap matters (§2)
  agency, program,                              // "Air Force" / "F-35 sustainment"
  recipient_name, recipient_uei, recipient_place,
  psc, naics,                                   // what was actually bought — the chain's seed
  obligated_usd,                                // NEW money. the only number that counts
  ceiling_usd,                                  // IDIQ ceiling. headline bait, NOT a flow
  is_modification,                              // option exercise / mod → not news
  pop_start, pop_end,                           // period of performance → the annualizer
  description,
  // stamped by later stages, null until then
  ticker, resolve_confidence, materiality, silence, z_5d, z_20d, z_60d, verdict, rejected_at_stage
}
```

### 4.2 Materiality — the gate

Four checks, in order, all free:

1. **New money — and this gate is sharper than "drop every modification".** An exercised option is
   the contract we already knew about being paid on schedule, and dropping those is right. But the
   live sweep shows `Mod !== '0'` covers **96% of all rows** (1,162 of 1,213), and that bucket is
   not homogeneous: a modification that *increases scope* obligates genuinely new money, and
   `Transaction Amount` is the delta on that action either way. A blunt gate here would discard more
   real events than it keeps. So: option exercises out, scope increases in — a split that needs the
   modification's reason code and, where that is ambiguous, the batched `triage` call (§10), which
   is precisely the kind of cheap classification that stage earns its keep on.
   **v1 may ship with the blunt gate, but it must be logged as a known false-negative source**, not
   left to look like a filter that works.
2. **Obligated, never ceiling.** `obligated_usd`, not `ceiling_usd`. A $9B IDIQ ceiling shared
   across eleven awardees over ten years is a press release, not revenue. **This is the single
   easiest way to build a fake thesis and it must be impossible to do by accident** — the ceiling
   is stored for context and never enters the ratio.
3. **Annualize by period of performance.** `annual = obligated_usd / max(years(pop_end - pop_start), 1)`.
   $300M over five years to a $200M-revenue company is a 30% uplift, not 150%. Skipping this
   overstates every multi-year award by its own duration and would put the longest contracts at the
   top of the list for no reason.
4. **The ratio.** `materiality = annual / trailing_revenue` (revenue from the existing
   `get_fundamentals` path). Thresholds as starting values, to be recalibrated once the ledger has
   volume: `< 2%` drop · `2–10%` watch · `> 10%` **candidate**.

**And a recurrence check — needed at v1, not deferred.** The first draft filed this as "defer until
the ledger has two quarters". The live feed refutes that: the single largest new-money action in the
sample is **TriWest Healthcare, $799M, `Mod: '0'`, described "EXPRESS REPORT: JULY 2026"** — a
monthly operational drawdown on a fresh award id each month. It passes every gate above and looks
like a billion dollars of new business. Recurrence is not a refinement; without it the top of the
list is wrong on day one.

Two cheap tells, both free from data we already fetch, before any history exists:

- **`pop_end - pop_start ≈ one month`.** TriWest's award runs 2026-07-01 → 2026-07-31. A program
  award does not have a one-month period of performance; an operational draw does.
- **`obligated_usd === ceiling_usd`** with a short period. Nothing optional, nothing to grow into —
  it is a payment, not a contract win.

The history-based check (same recipient + same program, recurring cadence) is the durable version
and lands once `flow_events` has accumulated. The two tells cover v1.

> **Note what stage 1 does to the parent doc's depth rule.** §3.1 says *not the miner, not the
> equipment maker — the reagent supplier.* Materiality reaches a different answer: a $180M award to
> a $400M-cap company IS the trade, and it is a first-order one. Both are true, and they are two
> different modes (§6). The reconciliation: §1.1's rule is that a leg is tradeable when it only
> reprices after a human revises a model — and **a company nobody covers is one where no human has
> ever built the model at all** (§11.1). Materiality on the uncovered is the same edge as depth on
> the covered.

### 4.3 Resolve — the hard part, and the real gating work

Awards name legal entities: *"Sikorsky Aircraft Corp, a Lockheed Martin Company"*, *"Raytheon Co"*,
*"BAE Systems Land & Armaments L.P."*. None of those is a ticker, many are subsidiaries of a listed
parent, and most are private. This is unglamorous and it is where the project actually succeeds or
stalls.

Three tiers, cheapest first:
1. **Curated map** — a hand-built `recipient_uei → ticker` table for the few hundred repeat winners.
   Covers most dollars for very little work, since federal awards are extremely concentrated.
2. **Fuzzy name → company profile** through the existing FMP profile path, with a confidence score.
3. **Unresolved → recorded, not deleted.** A private recipient is not noise: it is the *seed for
   derived mode* (§6.2), because a private company delivering a $400M award buys from someone.

**The resolver is a service with one caller today and obvious callers later** (a scan mentioning a
private company, a coverage note on a subsidiary). Build it as `recipientResolve.service.js`, per the
shared-mechanism rule.

---

## 5. Stage 3 — the silence check, and the two-by-two

The sigma screen (parent §8) asks *has the price already moved?* Money flow can ask a second,
cheaper, more specific question that news-driven events cannot:

> **Has the story been told at all?**

The recipient press-releases a material award via 8-K or a newswire — usually. When it does not, the
award sits in a federal database and nowhere else. **We can check this today**: `sec.provider.js` for
recent filings, `news.service.js` for coverage, both keyed on the resolved ticker in a window around
`announced_at`.

|  | **Price moved** (`z > 2`) | **Price quiet** (`\|z\| < 1`) |
|---|---|---|
| **Story told** (8-K / news) | the fast leg ran. **Drop.** | the market read it and shrugged — either genuinely immaterial, or our materiality number is wrong. **Investigate, do not surface.** |
| **Silent** (no filing, no news) | someone knows something. **Flag, do not trade** — this is a will-it-happen shape and §1 excludes it. | **THE CANDIDATE.** Money is committed, nobody has written it down, price has not moved. |

The bottom-right cell is the entire product of this hunting ground. It is also, satisfyingly, the
literal definition of §2's *"the edge is not reading more, it is reading the unread."*

**Sigma screen specifics for this ground.** Three windows as designed (5/20/60d, beta-adjusted). The
anchor is `announced_at`, not `reported_at` — USAspending may surface an award three weeks after DoD
announced it, and measuring five days from *our* discovery would call a name untouched that finished
moving a fortnight ago. Where the two sources disagree, the earlier date wins.

---

## 6. Stage 4 — the chain, the one expensive turn

Runs on ~8 items a week. Two modes, chosen by the resolver's output, not by the model.

### 6.1 Direct — the recipient is listed and small

The chain is one link and mostly arithmetic: *this award adds X% to revenue, at roughly Y margin,
starting at period-of-performance start, and consensus does not include it.* The model's job here is
narrow and checkable: is the award actually incremental to guidance, does the company have the
capacity to deliver it, and is the segment margin plausible.

Fast, cheap, high hit rate, and honestly labelled: **this is a materiality trade, not a lag trade.**
It works because nobody screens four thousand line items for the ones that are large relative to a
$400M market cap — not because we reasoned better than anyone.

### 6.2 Derived — the recipient is private, or a mega-cap

Now the parent doc's depth rule governs. $300M to Lockheed is 0.4% of revenue and unactionable at the
prime; $400M to a private specialist is unbuyable directly. Both push the same question:

> **To deliver this specific thing, what does the winner have to buy, and from whom?**

PSC/NAICS is the seed — the award says *what was bought*, which is the input a generic supply-chain
question lacks. The chain runs to depth 2–3, each link written down, and the output is a candidate
list that goes back through **stage 3** (silence + sigma) before anything is surfaced. The screen is
not skipped just because a model produced the name.

**Derived mode is also the teardown feeding the watchlist** (parent §4, §11): a supply chain mapped
once for one award is reusable for every future award in the same program. The map compounds; the
award is just what poked it.

### 6.3 What the chain agent is told it may not do

- May not surface the prime when materiality is below the threshold, however exciting the program is.
- May not use `ceiling_usd` in any claim.
- May not assert the award is incremental without saying what it checked (guidance, backlog, prior awards).
- May not produce an M&A thesis (§11.2) — *acquirable* as a noted free option, never *about to be acquired*.
- Emits nothing when nothing survives. **A quiet week is a correct output**, and the prompt must say
  so explicitly or the desk will manufacture two candidates a week to fill the quota (§8).

---

## 7. Output — the candidate, and its clock

Same falsifiable-claim discipline as parent §10, with one improvement that is specific to this
ground.

```js
{
  id, source_event_id, mode: 'direct' | 'derived',
  instrument, direction, vs,                    // benchmark leg
  award: { agency, program, obligated_usd, annual_usd, pop_start, pop_end, materiality },
  chain: [ '...', '...' ],                      // written links; length 1 in direct mode
  mechanism: 'fiscal_allocation',               // the §13.1 aggregation tag
  silence: { filing: false, news: false, checked_at },
  z_5d, z_20d, z_60d,
  surfaced_px, surfaced_bench_px, surfaced_at,  // FROZEN — tilt.service.js stampBaselines pattern
  expires_at, expiry_basis,
  state: 'open' | 'matured', outcome
}
```

### 7.1 The expiry is earnings-anchored, not a fixed window

Parent §10 makes the expiry load-bearing because *"the market hasn't noticed"* and *"the market
disagrees"* are indistinguishable on day one. A fixed six weeks is a guess. Money flow has a real
clock:

> **The candidate expires at the first earnings report that includes revenue from the award's period
> of performance** — the moment the market is forced to look, whether or not it wanted to.

`expires_at = first earnings date after pop_start` (the calendar path already exists via
`upcomingEvents.service.js` / Finnhub earnings). Fall back to `surfaced_at + 90d` when the date is
unknown, and record which basis was used, because the two grade differently and mixing them silently
would make the record unreadable.

If the print lands and the relative move has not happened, **the chain was wrong** — not early.

---

## 8. The precision budget — a quota, not a threshold

§14.1 says twenty items a day kills the desk. Thresholds alone cannot guarantee that: a stimulus
week could clear every gate at once and dump forty candidates onto the surface.

> **The final cut is a ranked quota: the top N per week, ranked by materiality × silence × (1 − |z|/2),
> regardless of how many pass.**

Everything below the line is written to `flow_events` with `rejected_at_stage: 'quota'` — so a week
that genuinely had six good ones is *visible in the record* rather than invisible, and the ledger can
later tell us whether the quota was costing us trades. Thresholds drift and get argued with; a quota
is enforced. Start at **N = 3/week**.

---

## 9. Storage — two collections, deliberately

| | `flow_events` | `flow_candidates` |
|---|---|---|
| Volume | thousands/week | ~3/week |
| Contents | every ingested award + why it died | surfaced claims, frozen prices, expiry |
| Purpose | the calibration ledger (§13b) | the compounding track record (§13) |
| Lifecycle | TTL ~18 months | permanent |
| Scope | broadcast, no `userId` | broadcast, no `userId` |

**Broadcast, like `tilt`, not owner-scoped like `coverage` or `scans`.** A federal contract award is
a house observation; it is identical for every user, and per the workspace rule research binds to no
account and is shared across `live` / `paper` / `manual`. This means `makeEntityCrud` is the wrong
factory here for the same reason `tilt.service.js` documents at its head — its `_scope(userId)` is
the guarantee, not an inconvenience, and a skip-ownership branch does not belong on it. Follow the
tilt precedent: a small publication-log service of its own.

The user-scoped artifact appears only at handoff, when Mentor authors a `setup`.

---

## 10. The agent surface — one desk, three call sites

Not three agents. One prompt, one key, three entry points — mirroring how Argus has a scan path and a
chat path off one `scanner` agent.

| Call site | When | Model | Cost shape |
|---|---|---|---|
| **`triage`** | nightly, after stage 2, batched ~20 events per call | cheap tier | one call per batch, not per event |
| **`chain`** | per survivor, stage 4 — the real prompt, with tools | default | ~8/week |
| **`chat`** | user opens a candidate, or pastes their own trigger (v1's manual entry, parent §6.1) | default, streaming | on demand |

`triage` exists to catch what arithmetic cannot: an award whose *description* makes it obviously
irrelevant despite a large ratio (a lease, a settlement, a bulk fuel purchase). Batching is what
keeps it affordable — twenty descriptions in one call, a verdict list back.

**A monitor, on the existing `createDueLoop`.** Grades candidates at `expires_at`, matures the row,
writes the outcome, and notifies through `sendBotMessage` like every other desk. LLM-free by
construction — it is arithmetic on frozen prices, in the Themis-as-a-doorbell mould.

**And an ingest loop**, on `createPollLoop`, daily after the 5pm ET DoD announcement.

---

## 11. Where it lands in this codebase

Nothing here is a new mechanism. Named so the shared-mechanism check is doable before code exists:

| New | Reuses |
|---|---|
| ✅ `providers/usaspending.provider.js` — **built** | `axios`, `ttlCache.util.js`, `logger.service.js` |
| ~~`providers/dodContracts.provider.js`~~ — cut (§2) | — |
| `services/recipientResolve.service.js` | `companyProfile.util.js`, FMP profile path |
| `services/sigmaScreen.service.js` — **ships first, shared (parent §14.1)** | `priceStats.util.js` (`logReturns`, `stdev`), `candleFetch.service.js` |
| `api/flow/flow.service.js` + controller + routes | `tilt.service.js` as the publication-log template; `forecastClock.js`, `revisionTrail.js` |
| `services/agents/flow.agent.service.js` | `agentIO.js`, `agentTools.registry.js`, `agentUtils.js` — identical shape to `strategy.agent.service.js` |
| `prompts/flow_system_prompt.md` | house prompt conventions |
| `monitoring/flow.monitor.service.js` | `dueLoop.js`, `pollLoop.js`, `monitorJournal.js` |
| handoff → Mentor | `talos.handoff.service.js` pattern |

**Frontend** owes a surface (a lane beside scans) and a candidate card — per the frontend-sync rule,
in the same milestone, not after.

---

## 12. Build order

Ordered so that each step is useful alone and the expensive half is last.

0. **`sigmaScreen.service.js` as a shared tool**, wired into Argus and Mentor first. This is parent
   §14 steps 1–2 and it is a **prerequisite, not part of this build** — it calibrates on hundreds of
   daily observations instead of three a week.
1. **Ingest + normalize.** ✅ **`providers/usaspending.provider.js` built and tested (18 cases).**
   Still owed: the `flow_events` collection and the sweep loop. **The loop must re-sweep a trailing
   window (7 days) on every run and upsert on `transaction_key`** — a one-shot "fetch yesterday"
   permanently sees ~20% of a day, skewed toward the fastest-reporting agencies (§2.1). The provider
   is stateless and returns duplicates by design; idempotency is the loop's job.
2. **Resolver, then materiality** (in that order — §3). The nightly job produces a ranked list of
   ~10 material awards with tickers. **Stop here and look at it for two weeks.** If the top ten are not interesting, no amount
   of chain reasoning downstream will save it, and we have spent no model tokens finding that out.
3. **Silence check + sigma screen.** The 2×2. Now the list is ~3 and each has a reason to exist.
4. **Surface + expiry + monitor.** The record starts compounding. **Still no chain agent** — the user
   reads the candidate and decides. This is a complete, shippable desk.
5. **The chain agent, last.** Direct mode first (it is nearly arithmetic), derived mode after.

**Steps 1–4 contain no LLM call at all.** That is the strongest evidence that this hunting ground was
the right one to start with: the parent doc's edge is process and automation, and here the process is
almost entirely deterministic. The model is the garnish.

---

## 13. Traps, written down before they are hit

| # | Trap | Guard |
|---|---|---|
| 1 | **Ceiling vs obligated.** A $9B IDIQ ceiling shared 11 ways is not $9B of revenue. | ceiling never enters the ratio; stored for display only |
| 2 | **Modifications look like awards.** Option exercises are the contract we already knew about — but 96% of rows are modifications and some are real scope increases. | split by reason code + `triage`; blunt gate only as a logged v1 shortcut (§4.2) |
| 2b | **Recurring operational draws look like program wins.** TriWest, $799M/month, `Mod: '0'`. | one-month PoP + `obligated === ceiling` tells; history check later |
| 2c | **Sorting by dollars ranks the feed backwards.** The biggest awards go to the biggest companies. | rank by materiality only; the size floor bounds cost, never priority |
| 3 | **Un-annualized multi-year awards** rank longest-duration first for no reason. | divide by PoP years |
| 4 | **Subsidiary ≠ parent.** "Sikorsky" is Lockheed; "BAE Systems Inc" is a UK listing. | curated UEI map + confidence score; low confidence does not surface |
| 5 | **USAspending reports on a lag**, so our "day one" may be the market's week three. | anchor sigma on `announced_at`, never on ingest time |
| 6 | **Silent + already moved** is a leak, not an opportunity. | top-right cell of the 2×2 is a flag, never a trade (§1's excluded risk) |
| 7 | **Foreign military sales and pass-throughs** show a US prime with no US revenue impact. | flagged from PSC/agency; derived mode only |
| 8 | **The desk fills its quota on a quiet week.** | prompt states an empty week is correct; quota is a ceiling, not a target |
| 9 | **Government revenue is lower margin** than the company's blended average; a 10% revenue uplift is not a 10% earnings uplift. | chain must state assumed segment margin, not use the blended one |

---

## 14. Open questions

| # | Question | State |
|---|---|---|
| 1 | Materiality threshold — is 10% the right line, or 5%? | starting value; the `flow_events` ledger answers it |
| 2 | Weekly quota N — 3 is a guess | tune against §14.1's "glad we read it" bar |
| 3 | Liquidity floor — a $60M-cap awardee may be untradeable | inherited open question from parent §15 Q4 |
| 4 | Revenue source for private-parent subsidiaries | no clean answer; likely resolve-to-parent only |
| 5 | Does the recurrence check need its own baseline table? | defer until the ledger has 2+ quarters |
| 6 | Where the surface lives in the UI — its own lane, or Axl's radar | not decided |
| 7 | Non-defense agencies (DOE, HHS, DOT) — same funnel, or different materiality lines? | assume same; verify at step 2 |

---

## 15. What is built

**`providers/usaspending.provider.js`** — the ingest source, verified against the live API
(`fetchTransactions` paged + normalized, `fetchAwardDetail` cached enrichment), with
`tests/unit/usaspendingProvider.test.js` (18 cases, passing, lint clean).

Everything downstream — the `flow_events` collection, the sweep loop, the resolver, the materiality
gate, the screen, the desk — is design only.
