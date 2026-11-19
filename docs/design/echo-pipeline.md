# Echo, built to the design — the plan

Roy, 2026-11-19: "I don't care about the test. I want Echo aligned with the design." The design is
[`Event-Driven Supply Chain Simulator.docx`](Event-Driven%20Supply%20Chain%20Simulator.docx) (2026-11-18). This doc maps
every step of it to what gets built, where the data comes from, and every place we depart from it — each departure
decided by Roy, none silent.

What Echo was until now (docs/design/echo-desk.md): an LLM chain map, the rule's direction, and a day-5 "lagging" check
on bellwether earnings — the design's Steps 2 and 4 only, thinned. Step 3 (scoring) was skipped for a backtest-only
hindsight reason that does not apply to live events, and never raised. This replaces that.

## Decisions (Roy, 2026-11-19)

| Question | Decision |
|---|---|
| Bottleneck language (doc: earnings call transcripts — FMP 402 on our plan) | **SEC filings** — the same phrases in 8-K earnings releases and 10-Q / 10-K text via EDGAR |
| Bottleneck, beyond language | **The model's reasoning too** — it argues why a company controls scarce capacity; a link shows which evidence it has (reasoned / filing language / both) |
| Options implied volatility (Step 4) | **Left out**, noted for the future — no provider on our data. Volume and analyst revisions stand in |
| Where it runs | **The backend, one copy** — every step in Node; an event typed in chat gets the whole pipeline. The engine keeps its backtest tools; its nightly forward test is retired when this runs |
| Trades (Step 6) | **The user clicks the name → Mentor**, with Echo's context: the event, the link, the score, the flags, and the levels the doc's rules would set. Mentor weighs them and trades **his regular setup** |
| The doc's open decisions | **Its own defaults**, listed under each step; tuned later by Step 7 |
| The forward test's frozen rule | Not a constraint any more |

## The pipeline — one event, seven steps

Every event, whatever brought it in (the intake below, or a user in chat), runs the same steps and lands in ONE
collection, `echo_events` (a user's event carries `userId` and is theirs; the house's are everyone's).

### Step 1 — Intake

Event types, the doc's table: **demand shock, supply shock, policy, clinical/regulatory, geopolitical, capacity deal,
third-party confirmation** (the last feeds the wave watch).

| Type | Source (free unless noted) |
|---|---|
| Demand shock | Earnings and guidance of bellwethers with big chains (the doc's list + the systemic names): FMP earnings + the price-gap timing rule (ported from the engine's `event_rules.py`); big contracts in 8-Ks |
| Capacity deal | 8-K item 1.01 (material agreement) and 2.01 (acquisition) of the universe — EDGAR submissions |
| Policy | Federal Register API (tariffs, sanctions, export controls, budgets); the Defense Department's daily contract awards |
| Clinical / regulatory | FDA advisory calendar; ClinicalTrials.gov results for drug classes in the universe |
| Geopolitical, supply shock | FMP news feeds (the fallback the doc names), triaged by a model |
| Third-party confirmation | 8-Ks and earnings of MAPPED companies that mention an active event (Step 5) |

**Skip** (the doc): macro data, analyst upgrades and targets, opinion, rumours, "why X moved" recaps.

**Filter** (the doc): an item becomes an event only if it is a **surprise** vs expectations, **large** relative to the
companies it touches, and **more than a one-off**. A model triages each candidate against those three and says why.

**Fields per event** (the doc's): date and time (`timing`: before open / during / after close), type, origin (company
or country) + tickers, what changed, size, **durability** (price spike · policy follow-through · drug-class shift ·
multi-year commitment — the doc's "most important field", set by the model with its reason), effect at the origin
(demand up / down / mixed), `follow_up_of`, sources.

Defaults (the doc's open decisions): event size — the origin moves **5%+ vs SPY** on day 1, or a policy commitment of
meaningful size; **Day 0** — after the close counts from the next session's open (during the session too: no price at
the moment it lands).

Bottleneck language is the doc's "strongest single signal": the intake also searches recent 8-K / 10-Q / 10-K text
for *capacity constrained, sold out, lead times extended, on allocation, record backlog, shortage* — an origin that says
it is supply-bound is itself an event candidate, and the companies it names are bottleneck evidence in Step 3.

### Step 2 — Chain mapping

From the origin, both directions, winners AND losers:

- **Layer 0** origin · **Layer 1** direct peers and customers · **Layer 2** suppliers · **Layer 3** suppliers' suppliers
  and infrastructure (power, cooling, materials, real estate) · **loser layers** (whose demand shrinks or supply is cut).
- The model proposes the links, with the layer from what the link IS (not a fixed table per relation).
- **Each link is checked against the filings** (the doc's default: *include a link only if it is named in filings or
  10%+ of the company's revenue is exposed*): EDGAR full-text search for the origin in the linked company's filings and
  the reverse, and the 10-K major-customer disclosure (any customer above 10% of revenue) for the **revenue share**. A
  link that fails is dropped and listed with the reason.
- Each link stores: the two companies, direction (gains / loses), the **revenue share exposed**, the layer, the evidence.
- **Event templates** (the doc): a map saved per event type (AI capex, drug class, energy shock, defense spending) is the
  starting point for the next event of that type, and grows as events come in.
- Not built: BEA input-output tables (the engine sampled them on 2026-11-18 and stopped — the summary Use table has no
  infrastructure, which is capital investment, and no consumption losers); paid supply-chain datasets (none on our plan).

### Step 3 — Scoring

Every link, six factors, **0–2 each, 0–12 total, "high" at 8** (the doc's defaults), each with its reason shown:

| Factor | How it is scored | Evidence |
|---|---|---|
| Lock-in | the model: demand committed for years vs riding a price spike | its reason |
| Supply response | the model: new capacity takes years vs adjusts in a season | its reason |
| **Bottleneck** | the model's reasoning (scarce capacity, few interchangeable suppliers) **and** the filing language from Step 1 | `reasoned`, `filings`, or `both` — both scores highest |
| Directness | the model: hits revenue now and measurably vs slow, indirect; **read the other way for losers** | its reason |
| **Exposure** | the 10-K's stated share where there is one (≥10% → 2); else the model's estimate, labelled an estimate | stated / estimated |
| **Coverage** | counted: analysts on the name (FMP grades) — few → 2; and whether it is filed **outside the theme** (its sector vs the origin's — Vertiv filed as industrial) | the count and the sector |

Equal weights to start (the doc); Step 7 reweights.

**The company ledger** (the doc): every active event touching a company, with direction and score. Conflicting effects
net by directness and lock-in; if they roughly cancel, the name is skipped ("a conflicted name is a weak trade"); a
company counts once in exposure limits.

### Step 4 — Market check

For each link, from Day 0: **return vs SPY and vs its sector fund at day 1, 5 and 20; volume vs its 20-day average;
analyst notes and estimate changes since the event** (FMP grades — once revisions arrive the link is no longer hidden).
*Options implied volatility: left out (no provider) — a note for the future.*

Flags (the doc):
- **Underreacted winner** — high score, small move vs the layer-1 names. *Default: day-5 move below half the median
  move of layer 1, with a high score.* The main target.
- **Overreacted loser** — a big drop, but slow or indirect damage (low directness). A rebound candidate.
- **Fully priced** — a big move that matches the score. Skip.

### Step 5 — Wave watch and expiry

Each active event keeps a watch list of triggers for its mapped companies — policy follow-through (budgets passed,
contracts awarded), a third party confirming the effect, new results in the same drug class, earnings or 8-Ks of a
mapped company that mention the event. **Each trigger re-runs Steps 3 and 4** for the affected links.

**Expiry**, whichever comes first: the driver resolved (supply caught up, the commitment spent or reversed, a newer
event replaced it); the information absorbed (revisions arrived, the link is in mainstream coverage); prices normalised
(the links' excess return vs their sector at noise for **20–40 sessions**, triggers no longer moving them). Backstop by
durability: price spike — weeks to a few months; policy follow-through, drug-class shift — up to about a year; locked-in
multi-year commitment — years, re-checked each quarter. Expiry stops new flags and watching.

### Step 6 — Trades (Roy's way)

The user clicks a flagged name → **Mentor**, with Echo's context: the event, the link, the six scores and their
reasons, the flag, and the levels the doc's rules would set —
- winners: entry on strength (a break above the high since the event, no limits below the price); stop 1.5–2× ATR below
  entry or below the event-day low; exit by a trailing stop (close under the 21-day EMA, or an ATR trail), no fixed
  target; optional partial at 2R;
- overreacted losers: entry only after the selloff stops making new lows (a close above the prior 5-day high); stop
  under the panic low; exit by the trail or at the pre-event level;
- all: fixed-risk sizing, no new longs with SPY under its 200-day average, a cap per event.

Mentor weighs those levels and **trades his regular setup**; Talos monitors it like any setup.

### Step 7 — Validation

Kept running on every event: flagged links against random same-sector companies and against the unflagged, at 5 / 20
/ 60 / 120 sessions; the distribution (median, share up 20%+, share down 10%+), not just the mean; **each factor tested
alone** (keep what separates winners, drop the rest); walk-forward (tune on earlier events, test on later). Results
reweight Step 3 and replace Step 5's backstop lifetimes with measured ones.

## The app

- **Hotlist, Echo tab**: events of every type; an opened event's links **sorted by score**, the six factors and their
  reasons on the name's page, the flags (underreacted winner / overreacted loser / fully priced), the evidence for
  bottleneck and exposure; the analyst's read and how it trades (built).
- **The event analyst in chat** maps any event through the SAME pipeline (one copy), and answers from the scores.
- **Clicking a flagged name → Mentor** with Echo's context (Step 6).

## Build order

Each step committed, tested, driven where it shows; QA/CR/docs at the end.

1. **Spine** — `echo_events` (the doc's event fields), the return calculator in Node (Day 0, vs SPY and sector, 1 / 5 /
   20 / 60 / 120, volume vs 20-day), EDGAR full-text search + major-customer extraction (sample ten filings first).
2. **Mapping** (Step 2) — layers 0–3 and losers, the filing check, revenue share, templates. The chat's mapper becomes
   this (one copy).
3. **Scoring** (Step 3) — six factors, bottleneck from reasoning and filings, coverage counted, the ledger.
4. **Market check** (Step 4) — reaction, volume, revisions, the three flags.
5. **Intake** (Step 1) — earnings rule ported, 8-K items, Federal Register, defense contracts, FDA / trials, news triage
   with the three-part filter and durability.
6. **Wave watch + expiry** (Step 5).
7. **App** — Hotlist by score, the name's page with the factors, Mentor hand-off with the levels (Step 6).
8. **Validation** (Step 7) — grades, baselines, the factor test. The engine's nightly forward test retired.

## Cost

Per event: the map (Opus 5.5, ~$0.07 measured on GTA 6) + the scoring (one call over all links, est. $0.05–0.10) + the
intake triage (a cheaper model per candidate item, many a day — measured when built). Filings, prices, analyst counts:
free on our plan. Measured and written here as each step lands.
