# Mentor flow — HOW ROY WANTS IT TO WORK (2026-09-28)

**Read this as a SPECIFICATION OF INTENT, not a diff.** Roy already knows parts of it differ from
what is built, and that parts of it do not exist yet and must be built. Every numbered section is
the target behaviour. Notes headed "Today:" / "Reality check:" are only there so the implementer
knows what has to change — they are never a reason to water the intent down.

Target file unless noted: `prompts/mentor_system_prompt.md`

## 1. No name, no setup → hand off to ARGUS, not Axl
Line 11-13 reads *"point them back to Axl — Argus is the scanner, that's a different desk."*
Literally that routes to Axl with Argus as an aside. Roy: Mentor turns the user to **Argus**.
Fix: rewrite so the handoff target is unambiguous — Argus.

## 2. Guided build, rungs 2-3 (direction + horizon) — the two branches are not written
Roy's intent: with a name in hand Mentor needs **direction + horizon**, and there are exactly two
branches:
- **User gives them** → Mentor **validates** them with the tools it needs (news / fundamentals /
  technical). The validation is **soft**: the user can accept it or not, their call stands either way.
- **User does not give them** → Mentor checks with tools and **offers its own** direction + horizon.
  User accepts or not.

What the prompt does today:
- Rung 2 (Direction, ~line 415) always leads with *Mentor's* read, then asks — it has no "user
  already said" branch.
- Rung 3 (Horizon, ~line 418) always **asks** the user first, then validates against the chart —
  it has no "offer one" branch. Horizon is framed as never Mentor's to propose ("the trader's, not
  yours"), which contradicts the offer branch Roy wants.
- The "answers ahead" exception (~line 462, *"long, swing" settles two rungs; take both and move
  on*) explicitly **skips the validation** Roy wants in branch A.
- Validation depth: news / fundamentals sit at rung 3 and rung 5 (deep read, after the lens), so a
  user-supplied direction gets a technical-only check today.

Fix: rewrite rungs 2-3 as one gated pair with the two explicit branches above, soft in both, and
amend the "answers ahead" line so stated values are validated (softly) rather than banked silently.

## 3. Lens (rung 4) — justify it from the whole read, not just the chart
Roy's intent: the dir/horizon check already pulled news + fundamentals + technicals, so the lens
proposal should come off that same evidence, and fit the horizon.
Today (~line 424): *"say in a line why this **chart** earns it"* — chart-only wording. Nothing ties
the lens choice to the news/fundamentals already in hand, or to the horizon just settled.
Fix: widen the justification to the full read (structure + news/fundamentals + horizon). The
propose-name-ask-wait shape itself is correct and stays.

## 4. THE OPENING IS ONE TURN — dir + horizon + lens proposed together
**This supersedes fixes #2 and #3 above: it is how Roy wants it, regardless of what exists now.**

- **Turn 1 — the name arrives.** Mentor runs its checks (news / fundamentals / technicals, whatever
  the read needs) and comes back with **all three at once: direction, horizon, lens.**
  - Anything the user already STATED (e.g. "long, swing") is **validated** against that read, softly —
    Mentor says whether the evidence supports it, and the user's call stands either way.
  - Anything the user did NOT state is **proposed** by Mentor off the same read.
  - The lens is decided in this same pass, from the same evidence, and fitted to the horizon.
- **Turn 2 — the user verifies.** Accept all three, or overrule any of them. Overruling one rebuilds
  from there (existing detour rule applies).

Consequence to handle when editing: this **collapses rungs 2, 3 and 4 into one rung**, which breaks
the current "One rung per turn, as a rule" line (~line 460) and the separate ask-and-wait at each of
rungs 2/3/4. That rule needs an explicit carve-out for the opening rung.

## 5. After the four are confirmed — the "way in" turn (a LOOP)
Once name + direction + horizon + lens are settled, Mentor's next job is one question it asks
ITSELF, not the user:

> *What is the best way to enter a position in this name, with this direction, this horizon, this
> lens, and these technicals and fundamentals?*

It answers it with **tools** — reaching for whatever the question needs.

Roy: **this turn is a loop**, not a single pass. Details of how the loop runs are still to be
specified (TBD in a later question).

Today's equivalent: rung 5, "the deep read, under that lens" (~line 426) — same intent, but written
as one linear pass through a tool list, with no loop structure and no explicit self-question.

## 6. Scenarios, step 1 — the levels come first: "from here to there"
Inside the way-in loop (#5), choosing scenarios starts with the CHART, read through the lens:
supports, resistances, order blocks, buyer levels, seller levels — whatever that lens uses.
The output of this step is the **span**: *the trade is from here to there.*

**How to enter and how to exit is a separate question**, asked after the span is fixed.

Today: rung 5 (~line 432) collapses both into one line — *"where you get in, what has to be true
when you do, where it is wrong, where it pays"* — so the span and the mechanics are decided in the
same breath. Fix: split them into two ordered steps.

### 6a. The span may be plural and approximate — while thinking only
- There can be **several candidate spans**, not one. Mentor weighs options here.
- The spans **need not be exact prices** at this stage (a shelf, an area, "the gap fill").

BOUNDARY (do not lose in the rewrite): this looseness lives in the reasoning turn only. A setup leg
is a single `{price}` since 2026-09-24 (zones were removed from the leg shape), and Generate refuses
a premise with no target price. Approximate spans must collapse to exact numbers before the
worksheet is emitted.

### 6b. Zones — Roy's actual objection (clarified)
Roy has NO problem with a setup expressing a zone OR an exact level. The objection was only this:
**Talos must not decide when to make an expensive LLM call based on "price is in the zone."**

Status: already solved. Per `docs/desks/mentor-talos.md` (zone gate removed 2026-08-22 → finished
2026-09-23): wake cost is decided by `talos.tiers.tierFor` (cheap numbers-only read by default;
expensive only on a fired guard / first look / expiry / escalation), and the entry gate is the
**verdict**, not containment. Exact-price legs came from `computeRR` needing one number, not from
the cost concern.

=> So reviving zones in the leg shape is a SEPARATE decision from the Talos cost model. Do not
re-tie them. If zones come back, `computeRR` and `legGate` (`legPrice(leg) === price`) are what must
be answered for.

### 6c. The span's vocabulary is the LENS's vocabulary
"From here to there" may be expressed in whatever the lens actually uses:
- **discretionary** — exact prices, zones, the area a moving average sits in, other indicator levels.
- **smc** — the same latitude, in SMC concepts (order blocks, FVGs, liquidity pools, BOS/CHoCH
  levels, premium/discount, equal highs/lows).
- **institutional** — proposed: VWAP rungs (session / anchored / weekly), volume-profile POC ·
  VAH/VAL · HVN/LVN, prior-day & settlement levels, options levels (large-OI strikes, gamma flip,
  max pain), relative-strength levels vs the sector ETF / benchmark, block & dark-pool print levels.
  These fall out of the tools that lens already uses (`get_options_context`, `get_correlations`,
  `get_sector_snapshot`). NOT YET CONFIRMED BY ROY.

OPEN QUESTION for later: a **dynamic** anchor (an MA, VWAP, a ratio level) is a different price on
every candle, while Talos guards arm at an exact authored number. Needs a resolution rule —
snapshot at authoring time, or re-resolve at each wake.

### 6d. What Talos binds to (Roy: "not bound to a specific number")
Roy's intent: per scenario, **Talos decides what it binds to** — theoretically RSI alone, no prices.

Reality check (`docs/desks/mentor-talos.md`, Guards):
- **Wakes** are already free of price: Talos wakes on every candle close and the model chooses the
  next rung via `next_timeframe`. An RSI-only scenario IS watchable — the cheap read evaluates it at
  each close.
- **Guards are price-only**: `{ price, direction, means }`, and `clampGuards` drops any guard without
  a finite price. There is no RSI guard.
- Consequence: a pure-RSI setup runs, but only on the per-candle cheap read, never on the free 30s
  `guardSweep` (which prices symbols and tests crossings). Cost difference, not a capability gap.

DECISION NEEDED: leave it there, or extend guards beyond price so non-price anchors also get the
free sweep tier. Extending means the sweep must compute indicators, which is no longer free.

## 7. PRINCIPLE — we are not bound to prices
**Mentor does not have to give prices** if what moves the ticker is something else. **Talos does not
have to look at prices** — Talos looks at what Mentor said.

This is a principle, not a tweak. What it collides with today:
- `Generate` refuses a premise with no target price ("no target price = no setup", prompt ~line 22).
- Leg shape is `{price}` (2026-09-24); `computeRR` and the 1R floor need two numbers.
- `clampGuards` drops any guard without a finite price; the free 30s sweep only tests price crossings.
- The BROKER needs numbers no matter what: an entry is a real order, a stop is a real resting order.

Proposed reconciliation (to confirm with Roy): **authoring is unbound, execution is bound.**
Mentor may author the plan entirely in non-price terms; the number is resolved at FIRE time — Talos
converts the condition into a live price when it proposes the entry, rather than Mentor guessing a
level days earlier. R:R then becomes a fire-time computation too, not an authoring-time one.

### 7a. Correction — the broker does NOT need a number
Roy: if the setup is "RSI below 30" and it happens, Talos decides the scenario is fulfilled and asks
the user to confirm **entry at market**. No price ever required. Same is theoretically true for exits,
though exits are usually numbers anyway — stop losses especially.

So strike "the broker needs numbers" from #7. What remains true:
- R:R becomes a **fire-time** computation off the actual/live price, not an authoring-time one.
- A **non-price stop** cannot rest at the broker: it is a synthetic stop that only exists while Talos
  is alive and the venue is open, whereas a price stop rests at the broker and survives outages.
  Low practical cost (stops are usually numbers), but it is the one place "unbound" loses protection.

## 8. The rough spans go to the USER as options — confirm or argue
Once Mentor has "from here to there" roughly, it **presents a few options** (Roy: several options are
healthy, not a weakness) and the user confirms or argues. This is a real decision point before
anything is emitted.

Today: rung 6 (~line 435) says the scenario count is **Mentor's, "not a question"**, and the ways in
it did NOT take are filed as `alternatives` — one clause each inside the worksheet, never offered as
a choice. Fix: turn the candidate spans into an explicit user-facing menu at this rung.

FUTURE (not now): show the user a **chart with the possible trades drawn on it**. Feasibility —
`get_chart` already renders via the LLM-tag -> ChartBubble path (the only chart path), but drawing
candidate levels/arrows on it needs annotation params that do not exist yet.

## 9. Per candidate trade — HOW to enter and HOW to exit, under the lens (a LOOP)
With the possible trades on the table (#8), each one needs its **entry mechanics** and **exit
mechanics**, expressed in the lens's own vocabulary.

This is a **loop**, and it is the second loop in the build (the first is #5):
1. Mentor takes the patterns that lens offers (e.g. discretionary: pullback to the MA, break-and-
   retest, false-break reclaim; smc: OB mitigation, FVG fill, sweep + CHoCH; institutional: VWAP
   reclaim, POC rotation, RS breakout).
2. For each, it **checks whether that pattern actually works on THIS ticker** — tools, not memory.
3. It iterates until it can rank them, then **chooses the best one, or the few best ones.**

Note for the implementer: step 2 needs a way to measure a pattern's historical behaviour on the
symbol. `get_false_breaks` does this for one pattern; there is no general "does this pattern work
here" tool today. That capability is part of what has to be built.

### 9a. Correlation is decided HERE — and "no" is a valid answer
Inside the loop of #9, Mentor decides whether this name actually correlates with other names or with
an index / sector ETF, and what therefore has to be watched alongside it (`referenced_symbols`).

**"It correlates with nothing relevant" is a legitimate conclusion.** Mentor must not attach a driver
just to have one — an empty set is a real answer, and it must be measured (`get_peers` ->
`get_correlations`), not assumed from the sector.

## 10. Second user gate — show the built setups, pros and cons, confirm or argue
Mentor now holds the setups for the different candidate trades — and possibly **several entry/exit
options per trade**. It shows them to the user, **explains the pros and cons of each**, and the user
confirms or argues.

So the build has TWO user gates, not one:
- Gate 1 (#8) — the rough spans: *which trades are worth building?*
- Gate 2 (#10) — the built setups: *which way in and out do we take?*

The pros/cons are Mentor's honest read of each option (what it costs, where it is worse), not a
pitch for the one Mentor prefers.

## 11. Sizing — Mentor sees the account, and asks the user
Mentor has the account in front of it, so sizing can be expressed in any of **five** ways, and Mentor
asks the user which:
1. **Risk budget** — an amount of money at risk (e.g. $500).
2. **Risk in percent** — a share of the account at risk (e.g. 1%).
3. **Size in percent** — position size as a share of the account.
4. **Size in budget** — position size as an amount of money.
5. **Number of shares/units.**

All five resolve to the same position because Mentor knows the account balance and the stop distance.
Sizing stays the USER's call — Mentor asks, it does not decide.

## 12. The summary — everything on one screen, then Generate
With sizing settled, Mentor summarises the whole thing back to the user:
- the trade (name, direction, horizon, lens, the way in and the way out),
- **R:R**,
- **possible gain — in dollars AND as a percent of the account**,
- **possible loss — in dollars AND as a percent of the account.**

Then the user presses **Generate setup** when ready. Mentor does not press it and does not rush it.

Note: the dollar/percent figures are only computable because sizing (#11) and the account are known
by this point — which is why the summary comes after sizing and not before.

## 13. After Generate — Mentor is done, Talos takes over
Generate emits the setup; from there Talos does its thing (wakes, guards, verdicts, entry proposal at
the user's confirm). Mentor's job ended at a well-built setup — unchanged from today.

---

# THE FLOW IN ONE PLACE

0. **No name in hand** → Mentor hands off to **Argus**. It never screens or invents a candidate. (#1)
1. **Name arrives** → Mentor reads (news / fundamentals / technicals) and comes back in ONE turn with
   **direction + horizon + lens**: validating softly anything the user already stated, proposing the
   rest. (#4)
2. **User verifies** — accepts all three or overrules any; an overrule rebuilds from there. (#4)
3. **The way-in loop** — Mentor asks itself *what is the best way into this name, with this direction,
   horizon, lens and these technicals and fundamentals?* and answers it with tools. (#5)
4. **Spans** — lens-appropriate levels give *from here to there*: several candidates, roughness
   allowed, the lens's own vocabulary (prices, zones, MAs, OBs, FVGs, VWAP, POC...). Not bound to
   price at all. (#6, 6a, 6c, 7)
5. **Gate 1** — the candidate trades go to the user: confirm or argue. (#8)
6. **The mechanics loop** — per candidate, HOW to enter and HOW to exit under the lens; patterns
   tested against THIS ticker; ranked; best one or few chosen. Correlation decided here, and "no
   correlation" is a real answer. (#9, 9a)
7. **Gate 2** — the built setups shown with pros and cons: confirm or argue. (#10)
8. **Sizing** — Mentor sees the account; user picks the unit (risk $ · risk % · size % · size $ ·
   shares). (#11)
9. **Summary** — trade, R:R, gain and loss in dollars AND in percent of account. (#12)
10. **User presses Generate** → Talos takes over. (#13)

# WHAT THIS REQUIRES THAT DOES NOT EXIST YET
- One-turn opening rung (dir+horizon+lens together) vs today's three separate ask-and-wait rungs,
  plus a carve-out in the "one rung per turn" rule.
- Soft VALIDATION of user-stated direction/horizon (today they are banked silently and skipped).
- Non-price authoring end to end: `Generate`'s "no target price = no setup" rule, the `{price}` leg
  shape, `computeRR` / the 1R floor, and `clampGuards`' finite-price requirement all assume numbers.
  Entry at MARKET on a fulfilled condition is the model to build toward; R:R becomes fire-time.
- Non-price guards on the free 30s sweep, or an explicit decision to leave non-price conditions on
  the per-candle cheap read. (6d)
- A resolution rule for dynamic anchors (MA/VWAP/ratio levels move every candle). (6c)
- Candidate spans surfaced as a user-facing menu, not filed as `alternatives` prose. (#8)
- A "does this pattern work on this ticker" measurement beyond `get_false_breaks`. (#9)
- Gain/loss in dollars and account-percent at the summary. (#12)
- FUTURE: a chart with the candidate trades drawn on it (needs annotation params on the chart tag).

---

# ADDITIONS (same session)

## 14. Which turns are MANDATORY user turns, and which are optional
**Three turns always belong to the user and can never be skipped:**
1. **The opening turn** — verifying direction + horizon + lens (#4).
2. **The sizing turn** (#11).
3. **The summary + Generate turn** (#12, #13).

**Everything else is offered, not imposed.** The intermediate gates — Gate 1 on the candidate spans
(#8) and Gate 2 on the built setups with pros and cons (#10) — are pauses the user may waive. Mentor
must **give the user the choice**: *"go on without asking me."* If they take it, Mentor runs those
rungs on its own and the build stops only at the three mandatory turns.

Notes:
- This is stricter than today's *"go all the way"*, which lifts every pause except size. Under this
  spec, "go all the way" can never swallow the opening turn or the summary — the user still confirms
  direction/horizon/lens, still sizes, and still presses Generate.
- The waiver is per-build, offered by Mentor rather than only volunteered by the user. Natural place
  to offer it is right after the opening turn is confirmed, since that is where the optional gates
  start. (Offer timing not explicitly fixed by Roy — confirm.)

## 15. Several names in one chat — a build loop, then GENERATE ALL
A user may arrive with **more than one name**. The chat then becomes an outer loop:

> first name -> full build -> finished -> next name -> full build -> ... -> **Generate all**

Each name gets the whole flow (#4 through #12). Nothing is generated one at a time; the emit happens
once, for all of them, at the end.

**The fast path.** If the user arrives with several names AND their setups already prepared, they
simply hand them over: Mentor takes each down (the interview path), and **if nothing is missing —
sizing above all — it goes straight to Generate all.** No walk, no gates, no invented rungs. A
complete plan the user brought is complete.

To build:
- **Generate all** — a batch emit across N setups. Today Generate is per-setup.
- Mentor must track which names are done and which are pending across a long chat, and say so.
- Missing-piece detection on a handed-over batch: Mentor asks only for what is actually absent
  (usually size / account), per name, and nothing else.
- Worth deciding: does the batch get a cross-name check before emit (same direction stacked,
  correlated exposure, total risk as a percent of the account)? The prompt already has a
  same-name/correlated-exposure warning for single setups (~line 551); a batch makes it sharper.

## 16. The prepared setups may arrive from ANOTHER USER, via social chat
A message in social chat carrying several setups is a valid input to Mentor:

> another user's message (N setups) -> Mentor -> if everything is there, sizing included -> **Generate all**

Same fast path as #15 — the only difference is where the plans came from. Mentor takes them down, asks
only for what is genuinely missing, and emits the batch.

Existing ground to build on: setup sharing was built 2026-09-21 (DM card, fork, blueprint). What is
new here is a **multi-setup message** treated as one batch intake rather than one card forked at a time.

One thing to settle: **whose sizing?** A risk percentage transfers between accounts; a share count and
a dollar budget do not (the sender's account is not the receiver's). Safest reading of Roy's rule —
"if we have it all including sizing" means the receiver's sizing is derivable, so a shared setup
carrying `1% risk` is complete, while one carrying `300 shares` should be re-asked.

## 17. After Generate — REVISE or CANCEL, and Talos decides which question to ask
While a setup is monitored, Talos may conclude the setup is **no longer valid**, or that **price went
without us**. It does not silently kill the setup — it asks the user, and the question is one of two:

- **REVISE** — direction and horizon still stand, the ENTRY does not. The trade is still the right
  trade; the way in is stale.
- **CANCEL** — direction or horizon no longer stand. The thesis itself broke: *this company looks like
  a short now, not a long.*

Talos picks which question to ask by exactly that test: **are direction and horizon still valid?**

Consequence for the flow: a **revise re-enters the build below the opening turn** — direction,
horizon and lens are settled and must not be re-litigated, so Mentor resumes at the spans / mechanics
loops (#6, #9) and runs forward to sizing and summary. A **cancel** ends the setup; a new trade on the
same name starts at the top (#4).

Existing ground: the "away question" already asked at authoring time (*if it goes without you, a ping
to redraw or let it go?*) is the user's pre-answer to the REVISE case; Talos's invalidation verdict is
the trigger for the CANCEL case.

---

# DESIGN DECISIONS (2026-09-28)

## D1. The flow is SERVER-ENFORCED, not prose
The stage machine lives in the server (`mentor.agent.service.js`), not only in the prompt. The server
knows which stage each name is at, tells the model what it may do this turn, and refuses illegal
jumps. Prose alone fails silently — a skipped gate is invisible.

Atlas is NOT this today: `makePhaseCapture(6)` captures a `<phase>` tag the MODEL emits, and nothing
validates it (which is why phases leak into Atlas's free chat). A middle option reusing that seam:
the model declares its stage, the server validates it. Roy chose enforcement for Mentor; Atlas is a
separate decision.

## D2. The Talos contract MAY CHANGE
"Keep the schema" is not binding. If the non-price principle (#7) requires changing the leg shape,
the guard shape or `computeRR`, change them. Tools stay; the schema bends.

## D3. Timeframes are chosen in the SECOND loop
Nothing earlier fixes a timeframe. Mentor picks the timeframes as part of the **entry/exit mechanics
loop** (#9) — the rung an entry trigger is read on, and the rung an exit is read on, are part of the
mechanics, not of the horizon or the span. (The horizon says how they trade; the timeframe says what
Talos reads. Talos's `next_timeframe` then rides on this.)

## D4. Free conversation vs. not forgetting steps — enforce SETTLEMENT, not SPEECH
The stage machine is a **ledger of what is settled**. It is never a gate on what may be discussed.
This is the resolution of the tension: the ledger stops things being FORGOTTEN, and never stops
things being SAID.

Rules:
1. **Free talk never moves the ledger.** The user asks about the company, the macro, a peer, anything
   — Mentor answers it fully, in the middle of the build, and no stage advances and nothing is
   recorded. No *"let's finish this first"*, ever.
2. **The server refuses illegal SETTLEMENTS, not illegal TOPICS.** Sizing cannot be recorded before a
   direction exists; talking about sizing at any time is always allowed.
3. **Go back** — the user may reopen any settled stage. Unsettling stage X unsettles everything below
   it (the existing detour cascade), and the server states in one line what just became unsettled.
4. **Move forward** — resume at the FIRST unsettled stage. The server always knows which that is and
   always tells the model, so the model never has to remember where it was.
5. Each free-talk turn ends with one soft re-entry line (*"say the word and we're back at the entry"*),
   offered, never insisted on.

Implementation note: this is why the stage lives in the server. The model reads "first unsettled
stage = X" from the turn context; the user's topic is irrelevant to that number.

---

# STEP 1 — THE FIRST TURN (design)

## Intake: three arrivals, ONE machine
1. **Name + setup** — a plan the user already has (any degree of completeness).
2. **Name, no setup** — with or without direction / horizon / lens.
3. **Nothing** -> handed to **Argus** -> comes back with a name (and what Argus knows).

These are not three code paths. They differ only in **what arrives pre-filled**, so:

> whatever arrived is written into the ledger as **CLAIMED, not settled** -> the opening turn
> validates every claim (softly) and proposes every blank -> the build resumes at the first
> unsettled stage.

One machine, one behaviour, no drift between branches.

## What Argus can actually hand back
The seed (`_buildSeedSection`) carries `ticker`, `direction`, `thesis`, `analysis` and
`recommended_mode` (the lens). **There is no horizon in it** — horizon is the trader's, so arrival 3
always returns with at least one blank. And the seed's own framing already matches this design:
Argus's direction is *a lean to test*, its lens *a recommendation*, i.e. claims, never settlements.

## Claimed vs settled — the core distinction of step 1
- **Claimed** = someone asserted it (the user, or Argus). Mentor must VALIDATE it against its read,
  softly, and say what it found. The claim stands unless the user changes it.
- **Settled** = the user has confirmed it this build. Only settled values are carried forward
  untouched and never re-litigated.
- A claim becomes settled at the opening turn's confirmation (#4), together with everything Mentor
  proposed for the blanks.

## PRINCIPLE — always cheap before expensive (applies to every stage)
Reach for the cheapest tool that can settle the question, and **stop as soon as it is settled**. Escalate
only on a genuine conflict or a genuine blank. Escalating to a stronger model (`consult`, Opus 5.5) is
a legitimate rung of that ladder, not a last resort — it is just the most expensive one.

## Step 1's tool ladder — what the opening turn actually calls
The turn owes three answers: direction, horizon, lens.

**Tier 0 — always. The quick read.** `get_quote`, `get_candles` (daily + one intraday), `get_key_levels`
or `get_structure`, one `get_chart`. Usually settles DIRECTION on its own.

**Tier 1 — the window. Cached and dated, so still cheap.** `get_news` (`companies`, ticker as subject)
and `get_earnings_calendar`: what sits inside the horizon, and the catalyst check on a claimed
direction. `get_fundamentals` only when the horizon is weeks and not hours. Settles HORIZON.

**Tier 2 — lens PROBES, never the deep read.** Circularity to name: the lens decides what you measure,
but you need measurement to choose the lens. So one cheap probe per candidate lens —
`get_orderblocks`/`get_fvg` (is this an SMC chart?), `get_indicators` (does it respect its MAs/VWAP?),
`get_analyst_actions`/`get_short_interest` (is there a flow story?). Enough to JUSTIFY a lens. The full
lens-specific read belongs to loop 1 (#5), not here.

**Tier 3 — expensive, only on a real conflict.** `web_search` (uncached, billed), `flip_test` (the
direction is genuinely contested), `consult` -> Opus 5.5. `consult`'s existing contract already names
this case: *"two readings that genuinely disagree ... most often the direction call, when the structure
leans one way and momentum or positioning the other."*

Stopping rule: a tier is skipped entirely when the previous tier already answered. A claimed value the
read agrees with needs no escalation — only a claim the read CONTRADICTS earns tier 3.

## Step 1's output — the close of the opening turn
Mentor ends the turn with ONE message carrying two asks:
1. **Direction + horizon + lens** — suggested where blank, confirmed-with-findings where claimed —
   *"right?"*
2. **The waiver** — *"want me to run all the way to sizing, or stop at the checkpoints?"*

One user reply answers both. This FIXES the offer timing left open in #14: the waiver is asked in the
opening turn itself, not later and not only when the user volunteers it.

"All the way" means: Mentor runs the spans, Gate 1, the mechanics loop and Gate 2 on its own, and the
build stops next at **sizing** — which is mandatory and can never be waived, like the summary and
Generate (#14).

Note on what the user hears: when Mentor ran a rung on their behalf it must SAY so at the next stop,
in one line per call it made, so any of them can be overturned. A call the user never heard is one
they never made.

## Arrival 1 (name + setup) — the conversation is DIFFERENT
When the user brings the plan, Mentor does not run the ladder. **It asks only for what is missing**
(usually sizing) and goes to the summary.

This needs no second code path — it is the ledger machine with different data: a brought plan arrives
with most stages already SETTLED BY THE USER, so "resume at the first unsettled stage" lands on sizing
by itself. The difference between arrival 1 and arrival 2 is the contents of the ledger, not the
machine.

Three details:
- **No waiver question** on this path. Nothing is waivable when there are no gates left to reach —
  asking is noise.
- Mentor still **names the lens** from the conditions they gave (downstream needs it), and still says
  its piece **once** if it disagrees. Then it builds their plan as given.
- Validation still happens and is still soft, but it is a REMARK, not a gate: *"noting your stop sits
  under earnings on the 12th"* — then straight on to what is missing.

---

# STEP 2 — LOOP 1: THE POSSIBLE TRADES (design)

**Input:** name + direction + horizon + lens, settled. **The question Mentor asks itself:** *where
does this thing actually go from here, under this lens?*

**Per iteration:**
1. **Read under the lens, at the horizon's rung** — now the FULL lens read (this is where the deep
   read lives): the SMC engine for `smc`; key levels + indicators for `discretionary`; VWAP / volume
   profile / flows for `institutional`.
2. **Harvest anchors** in that lens's own vocabulary. Non-price anchors allowed (#7).
3. **Form spans** — from-here-to-there, each one a claim about where price travels.
4. **Sanity-check every span** on three things:
   - **Room** — is the distance worth trading at all?
   - **Invalidation** — is there a clean one near the start?
   - **Time to travel** — does it fit the horizon? A span that needs three weeks is not an intraday
     trade.
5. **Stop** when new reads stop producing new anchors, or when the candidates fill the cap.

**CAP: 4 candidates maximum.** Past four the user is choosing from noise.

**Filtering: Mentor shows what survived step 4**, and names in one clause each what it discarded, so
the user can pull a rejected span back. (Agreed with Roy.)

## The news and fundamentals carry into the room check
Step 1 already fetched news, the earnings window and (when the horizon earned it) fundamentals.
**Do not re-fetch them** — carry them forward, and use them to judge HOW FAR this ticker can travel:
a catalyst inside the window widens the plausible span, a name with no catalyst and a tight range does
not get a span that assumes one. The chart says where the levels are; the news and fundamentals say
whether price has a reason to cross them.

## PRINCIPLE — fetch once per build, reuse after (applies to every stage)
If a later stage needs something an earlier stage already fetched, it does NOT fetch or re-analyse it.

1. **Store the conclusion, not just the payload.** The server keeps an EVIDENCE LEDGER for the build:
   every fetch with its timestamp AND what Mentor concluded from it. Later stages cite the conclusion.
   Analysed once, cited many.
2. **Staleness is per data class, scaled by the horizon** — freshness matters only where it changes an
   answer:
   - `get_quote` · `get_candles` · `get_indicators` — **always refresh** before placing or testing a level.
   - `get_news` — reuse within the build; refresh sooner on an intraday horizon than on a swing.
   - `get_earnings_calendar` · `get_fundamentals` · `get_sec_filings` — days; effectively once per build.
   - `get_peers` · `get_correlations` — days; once per build.

This does not break the prompt's *"Tools, not memory"* rule: that forbids carrying knowledge across
CONVERSATIONS. Reuse inside one build is still this conversation's own tool output.

Pairs with the cheap-before-expensive principle: the cheapest call is the one already made.

---

# STEP 3 — GATE 1: THE USER SEES THE POSSIBLE TRADES (design)

The user confirms here, and to confirm they must SEE it. The gate delivers two things:

## 1. A DAILY CHART WITH THE TRADES DRAWN ON IT
- Each candidate trade drawn as lines: **enter roughly here -> exit roughly here**, per trade.
- Indicators drawn only when they are part of the read (the lens decides).
- "Roughly" is honest at this gate: these are spans, not the final levels (#6a).

Feasibility (checked 2026-09-28): charts are rendered IN-HOUSE — KLineCharts over our own candles in
`services/chartRender/klineRender.provider.js`.
- **Indicators: already supported.** `studyTranslate.js` maps to `overlays` (MA/EMA/BOLL/VWAP on the
  candle pane) and `panes` (RSI/MACD/ATR stacked).
- **Drawn trade lines: NOT supported yet.** `_inPageRender` only calls `chart.createIndicator`; it
  never calls `createOverlay`. Adding horizontal price lines / segments per trade is a small addition
  to an EXISTING renderer, plus a levels parameter on `get_chart`. Not a new pipeline.
- Vision budget applies (`ctx.visionBudget`), so this is one chart per gate, not one per candidate.

## 2. A TABLE OF THE TRADES — INCLUDING THE REJECTED ONES
Rows: each surviving candidate (span, why, what kills it), and beneath them the **discarded** ones
with the one clause that discarded each. The user can pull a rejected one back into play.

To build: a structured emit tag + an FE card for the table (the chart already rides the LLM-tag ->
ChartBubble path, which is the only chart path).

---

# STEP 4 — LOOP 2: HOW TO ENTER (design)

**Input:** direction + horizon + lens + the confirmed possible trades (up to 4 spans).

## 1. Per trade, in the LENS's vocabulary, test the entry techniques
Enumerate the ways in that lens offers — indicators, chart patterns, price action, SMC techniques,
institutional techniques — **and the timeframes they are read on** (timeframes are chosen here, D3).
For each candidate technique, answer two questions:
- **Does it work on THIS ticker?** — measured on its own history, not assumed.
- **Can it work going forward?** — is the condition that made it work still in place?

## 2. Output: about THREE entry possibilities per trade
Each carries its trigger (in lens vocabulary, price or not), its timeframe, and the evidence that it
works on this name.

## 3. The user chooses — or hands the choice back
At Gate 2 the user gets the summary and either **picks the entries himself** or tells **Mentor to
choose**. Mentor may choose **one entry per trade, or several**: *"we go in if this, or this, or this."*

## Open questions to settle
- **OR-semantics.** Several entries on one trade are alternatives — the first to trigger takes the
  position, and the rest must be cancelled, or the user ends up in twice the intended size. Needs an
  explicit rule at the monitor (mutually exclusive entries within a trade).
- **Volume.** 4 trades x 3 entries = 12 rows at Gate 2. Needs either a cap or a two-level table
  (trade -> its entries) so the gate stays readable.
- **Exits.** #9 says this loop settles entry AND exit mechanics; this step as stated covers entries
  only. Do exits get the same three-candidate treatment, or do they follow from the span's far end?

### 4.1 Multiple entries — ALTERNATIVES by default, SCALE-IN only when said
Resolved (Roy): when Talos sees *"this or this or this"*, that is **not** scaling in.

- **Alternatives (OR) — the default.** The first entry to trigger takes the **full** position; every
  other entry on that trade is cancelled at that moment. Talos never infers scaling from a list.
- **Scale-in — only when Mentor states it.** Each entry then carries **its share of the size** (e.g.
  false break = half, break-up = the other half) and all of them may fire, in sequence.

**New capability for Mentor: scaling in is an option it can propose.** It must be able to split one
trade's size across several entries deliberately, and say so in the setup.

Shape note: this is symmetric with what already exists on the exit side — `target_legs` each carry a
share of the size. Entry legs get the same `share` field, and a per-trade flag (`alternatives` vs
`scale_in`) tells Talos which semantics apply.

### 4.2 Gate 2 presentation — nested, with Mentor's pick highlighted (1 + 3 combined)
Resolved (Roy): the table is **two-level** — one block per trade, its 2-3 entries nested underneath —
**and Mentor's recommended entry is expanded** while the others sit collapsed behind "other ways in".
The user reads 4 things, not 12, and drills into whichever they want.

### 4.3 Exits — four different questions, four different answers
Resolved (Roy):
1. **The stop is a PRICE LEVEL.** Not a menu, not a condition — one number, with its reason. (It comes
   out of the span's invalidation check anyway.) Note: this is the one place the non-price principle
   (#7) is deliberately NOT applied, and it is also what keeps the stop restable at the broker (7a).
2. **Targets may be SEVERAL LEGS**, each with its share of the size — `target_legs` as it exists today.
3. **Management is NOT decided at build time.** No break-even rule, no trailing rule authored in the
   setup. **Talos offers management in real time**, when the position is live and the situation is in
   front of it.
4. **Time exits ARE offered at build time** (flat before earnings, flat by the close on an intraday
   horizon) — and Talos may also raise one in real time: *"this isn't working, close it."*

Consequence: exits do not multiply Gate 2. One exit plan per entry (stop + target legs + any time
exit), not three. The combinatorial blow-up (4 x 3 x 3) never happens.

---

# STEP 5 — SIZING (design)

Mentor asks once, in whatever unit the user prefers — risk $ · risk % · size % · size $ · shares (#11)
— and converts. All five resolve exactly, because by now the account balance is known and the stop is
a hard price (4.3).

**On a scale-in trade the user sizes the TRADE, not the legs.** Mentor splits that size across the
entries by their shares (4.1). One sizing question per trade, never one per entry.

Resolved (Roy):
1. **The account is NOT chosen here.** The user picks it in the account menu above the chat; Mentor
   simply SEES what is already picked. That choice also fixes the workspace (`live` / `paper` /
   `manual`), since an account belongs to one. Mentor never asks which account and never switches it.
2. **All names in one chat go to the SAME account** (for now). A multi-name build is one account.
3. **Mentor MAY check total risk across the batch** — the sum of what is at risk across all names, and
   correlated exposure among them — and say so before the summary. Per-trade sizing stays the user's;
   this is a remark, not a veto.

---

# STEP 6 — THE SUMMARY AND GENERATE (design)

**The arithmetic belongs to the SERVER, not the model.** R:R and every money figure are computed in
code (`computeRR` and its siblings) and handed to Mentor to narrate. A model doing sizing arithmetic
on real money must never be the source of the number.

**Per trade:** direction · horizon · lens · the way in · the stop · the target legs · R:R · gain in $
and in % of account · loss in $ and in % of account.
**Per batch (multi-name):** total risk in $ and %, plus the correlated-exposure remark from step 5.
**Alternative entries each get their own R:R line** — in practice they are different trades.

Then one press: **Generate all**.

Resolved (Roy):
1. **Non-price entries show an ESTIMATE.** With an entry like *"RSI below 30, enter at market"* the
   fill is unknown at authoring, so the summary shows gain/loss estimated off the current price, marked
   as an estimate; the real figures are computed at fire.
2. **Partial failure on Generate all: the good ones STAND.** If 3 of 4 pass validation and 1 fails, the
   3 are emitted and monitored, and the 4th comes back for fixing. The batch never rolls back what
   already succeeded.

---

# STEP 7 — THE EMIT AND THE TALOS CONTRACT (design)

Diff against the current `<setup>` schema (prompt ~line 880):

1. **A LEVEL IS MISSING.** Today `scenarios[]` IS the flat list of ways in. This design is two-level:
   **trade (span) -> its entries**. Either `scenarios[]` gains a `trade_id` grouping, or a `trades[]`
   wrapper holds them. Gate 1 chooses trades; Gate 2 chooses entries within a trade.
2. **`entry_legs[].price` must accept a NON-PRICE trigger** — `{ trigger, share, timeframe }`, where a
   fulfilled non-price trigger means **enter at market** (7a).
3. **Entry semantics flag, per trade** — `alternatives` (default: first fires, rest cancel) vs
   `scale_in` (shares, all may fire). `entry_mode` is already taken (`limit` / `conditional`), so this
   needs its own field name.
4. **Timeframe moves DOWN to the entry.** It is setup-level today; D3 puts the rung on each entry.
5. **A TIME-EXIT FIELD IS MISSING.** `valid_until` kills an unfilled setup; nothing flattens a LIVE
   position before earnings or at the close (4.3.4).
6. **Unchanged:** `stop_legs[].price` stays a price (4.3.1); `target_legs` with shares already exist
   (4.3.2); management rules are absent from the schema today and stay absent (4.3.3).
7. **Generate all needs a BATCH emit.** One `<setup>` per asset today. Naming warning: `<setups>` is
   already taken — it means *a menu of candidates to choose from*, not a batch to generate.
8. **Server-side changes:** `clampGuards` must accept non-price guards or non-price entries must ride
   the per-candle cheap read (6d, still open); `computeRR` must produce an estimate at authoring and
   the real figure at fire (step 6).

---

# STEP 8 — WHAT COMES OUT OF THE PROMPT (deletion list)

Section by section against `prompts/mentor_system_prompt.md` (1074 lines today).

**DELETE outright**
- `## The guided build` (402-488) — the whole 8-rung ladder, the detour rule, *"one rung per turn"*,
  *"go all the way"*. All four become SERVER STATE (D1/D4): the turn context says which stage, what is
  settled and what is first-unsettled. Prose that duplicates server state is prose that will drift
  from it.
- `## No phases — invariants` (34-81) as a section. Its live content (always soft; never a form;
  answer anything at any time) folds into D4, which says it better and is now enforced.
- `### The interview` (236-401) shrinks to a paragraph: a brought plan arrives with stages already
  settled, so ask only for what is missing. 165 lines of interview choreography are what the ledger
  now does.
- `## Offering candidates — only when they ask for options` (990-1013) — candidates are no longer
  exceptional. Gate 1 and Gate 2 ARE the candidate offers, every build.

**REWRITE**
- `## Levels, not bands` (132-159) — zones and non-price anchors are allowed again in authoring
  (6b/6c/7). What stays: **the stop is a price** (4.3.1), and no invented band breadth.
- `- **And no target price = no setup either**` (~line 22) — replaced by: every premise names where it
  pays, in the lens's vocabulary; a non-price exit is legal, a missing exit is not.
- `## Size comes from the user` (527-596) — five units (#11), account taken from the account menu and
  never asked (step 5), size set per TRADE and split across scale-in legs.
- `## scenarios[]` (597-640) + `### alternatives[]` (641-674) — two-level shape (step 7.1), and
  rejected spans surface in the Gate 1 table rather than only as `why_not` prose.
- `### <setups> is a CHOICE` (1014-1031) + `## Ready to Generate` (1032-1047) — Generate all, batch
  emit, partial success (step 6).
- `## Tools` (82-131) — reorganised into the cheap-before-expensive tiers, with the fetch-once rule.

**KEEP (with small edits)**
- `## How you think` (16-33) minus the target-price line.
- `### Name the way in / what each level is measured from` (160-196) — extended to non-price anchors.
- `### Conditions on a stop or a target` (197-235), `## conditions[]` + its gate + `persistence`
  (675-741), `## validity` / `on_away` (785-867) — aligned with REVISE vs CANCEL (#17).
- `### referenced_symbols` (742-784) — plus "no correlation is a real answer" (9a).
- `### Arriving from a runaway` (489-526) — this is the REVISE re-entry (#17).
- `## The setup is a live worksheet — emit it every turn` (868-950) — extended to the batch.
- `## The flip test` (951-989) — it is a tier-3 tool in the new ladder.
- `## Tags` / `## Response format` (1048-1074).

**Net effect:** roughly 350-400 lines leave the prompt, because the ladder, the interview
choreography and the candidate-offer rules become server state and stage instructions. The prompt
keeps what only a model can hold — judgment, vocabulary, honesty rules — and stops holding the flow.

---

# BUILD LOG

## Phase 1 — the ledger core (DONE, `services/mentorBuild.util.js`)
Pure, no I/O, no clock. `STAGES` (opening · spans · entries · sizing · summary) with the two gates
marked waivable; `claim` / `settle` / `unsettle`; `stageOf` / `firstUnsettled`; multi-name via
`upsertName` / `putName`; `claimsFromDraft` as the bridge for a brought plan.

Two rules carry it: **claimed is not settled**, and **nothing settles out of order** (a settled field
changes only through `unsettle`, which cascades to every stage below). 26 unit tests.

**Decided while building:** the LEDGER owns the flow, the DRAFT owns the content. They both hold
direction/horizon/lens, so they can diverge — an emitted draft that contradicts a settled value is
REFUSED, not silently accepted. (To implement in phase 2.)

**Open for phase 2:** `emptyMentorState()` gains `build`, which changes the `chatState` the client
round-trips. The frontend ships as a prebuilt bundle in `public/` — if it echoes `chatState`
verbatim this is free; if it reconstructs it, `build` is dropped every turn and the ledger resets.
Check before wiring.

## Phase 2 — the ledger is wired (DONE)
`services/mentorBuild.util.js` gains the turn: `normalizeBuild` (the door — the ledger comes back
through the client every turn and is untrusted), `sanitizeBuildOps` (model output, dropped by type
and never coerced), `applyBuildOps` (unsettle -> derived claims -> explicit claims -> settle, in
that order, because a flip-and-confirm is ONE turn) and `settledConflicts`.

`mentor.agent.service.js` threads it: a new `<build>` tag (registered in `ALL_EMIT_TAGS`, suppressed
like every other), claims derived from the emitted worksheet so a forgotten tag still records what
was PROPOSED, and `_buildLedgerSection` in the turn context — where the build is, what is settled,
what was refused last turn, and the line that says talking never moves any of it.

**How the ledger survives:** it rides ON THE DRAFT. The frontend rebuilds `chatState` from the
fields it was sent (`active_asset: e?.asset || n?.ticker || ''`), so a new top-level key would be
dropped every turn. A turn that emits no worksheet RE-ISSUES the previous draft rather than skipping
it, or a confirmation given in prose would be lost. `build` is also returned at the top level and
forwarded by the controller — inert until a frontend uses it.

**Still true after phase 2:** a settlement made before any worksheet exists has nothing to ride on.
That is why the opening turn must emit one (phase 3: the nucleus it proposes IS the worksheet).

54 new tests (`mentorBuildOps.test.js`, `mentorLedgerWiring.test.js`); suite 3582/0.

## Phase 3 — the prompt learns the new flow (DONE)
`prompts/mentor_system_prompt.md`: 1074 -> 973 lines.

**Out:** `## No phases — invariants` (the section), the whole 8-rung `## The guided build` with the
detour rule, "one rung per turn" and "go all the way", and 165 lines of interview choreography.
Every stale cross-reference to rungs and the ladder is gone (a test now asserts that).

**In:** `## How a build runs — the ledger, and what is yours to do in it` (the five stages, claim vs
settlement, reopen cascades, three stops that are the user's, two gates that can be waived);
`## The opening turn — one turn, three answers` (the cheap-to-expensive tool ladder, validate the
claimed / propose the blank, close with the two asks); `## The stages after the opening` (spans,
entries, sizing, summary in brief — phases 4-6 deepen each); and the `<build>` tag contract under
`## Tags`.

**Kept deliberately:** the coverage dimensions, "a setup always carries levels" (until phase 7),
"name the lens, never blend it", and the two grounding rules that were buried in the deleted
ladder — **Tools, not memory** and **Live before levels** — which are grounding, not flow.

**Fixed while building:** the prompt says to emit the worksheet on the opening turn, but "the model
did as it was told" is not a storage strategy. The service now falls back to a bare `{asset}` stub
when a turn has ledger content and no worksheet of any kind, so opening-turn claims cannot be lost.

**Known duplication, for phase 6:** `## Size comes from the user` still lists three sizing inputs
while the new stages section lists Roy's five. Not contradictory, but two sources of truth.

Suite 3589/0.

## Phase 4a/4b — the spans gate, and the trade drawn on the chart (DONE, backend)
**The candidates.** `normalizeSpans` / `spanIds` in `mentorBuild.util.js`, emitted as `<spans>`:
each candidate is `{id, label, archetype, from, to, from_price?, to_price?, why, invalidation}` and
the DISCARDED travel with them, one clause each. `from`/`to` are WORDS in the lens's vocabulary;
the prices are optional and exist only so the chart can draw a line. **Four candidates, hard** —
the cap is the server's, not the prompt's. Spans are CONTENT, so they ride on the draft
(`draft.spans`) while the ledger holds only their ids.

**The picture.** `get_chart` gains `levels: [{price, kind, label}]`, threaded through `cachedChart`
(in the cache key — two charts with different lines are different pictures) to
`renderChartImage` -> `normalizeChartLevels` -> klinecharts `priceLine` overlays. `kind` is what the
line MEANS and therefore its colour: `from` blue, `to` green, `stop` red and solid while the rest
are dashed.

Two things learned by rendering it rather than trusting the API:
- The price tag shows the NUMBER; `extendData` does not draw the label. The words stay in the table.
- **An overlay does not stretch the price axis.** A level outside the candles' range was silently
  invisible — the worst failure for a picture of a trade. Fixed by feeding the levels in as an
  invisible `LEVELS` indicator, so the axis has to include them. Verified: 170 and 268 on a chart
  whose candles run 189–235 now both draw, axis 170–280.

Also: the tool reports the lines actually DRAWN (normalised, capped), and says plainly when the
chart-img fallback served the render, because that renderer cannot draw them at all.

`tests/fixtures/agentTools.snapshot.json` updated deliberately in the same commit — `levels` is on
the SHARED get_chart, so portfolio, scanner, kairos and mentor all see it.

Suite 3605/0. Still to come for this phase: the FE table card (4c).

## Phase 4c — the gate's own card (DONE, frontend)
`botmarket-frontend/src/cmps/MentorPanel/SpanTable.jsx` + `.scss` + tests, mounted in
`MentorPanel` where the candidate picker sits, reading `pendingSetup.spans` (the spans ride on the
draft, so there is no parallel state to fall out of step).

Rows, not cards, and deliberately NOT the CandidatePicker beside it: that offers complete
alternative PLANS and picking one replaces the worksheet, while this offers the trade itself and
picking one says which trades are worth building mechanics for. Prices render only when the data
has them. The invalidation gets its own line. The rejects are folded, one clause each, and
clickable.

Both gate actions SPEAK — they send a message rather than setting state — because the ledger only
moves on a `<build>` emit, so a silent local change would leave the server holding an open gate.

FE suite 1099/1099; bundle rebuilt into `botmarket-backend/public` (prod ships the committed build).
Pre-existing FE lint warnings on main are untouched and none are in the new files.

## Phase 5 — the entries gate (DONE)
`<entries>`: per trade, up to three tested ways in — `{id, label, technique, trigger, timeframe,
evidence, share?, recommended}` — normalised by `normalizeEntries`, scoped to the spans on the
table (an entry for a trade nobody agreed to look at is an entry for nothing), and carried on the
draft as `draft.entries` with the ledger holding `tradeId:optionId`.

**`semantics` is the field that changes what the broker does**, so it defaults to `alternatives`
— the reading that cannot put on more risk than the user agreed to. `scale_in` requires a `share`
per option, and `entryProblems` reports shares that do not add to 100 through the existing
problems block: not a missing field but a stated plan that would fill the user for a size nobody
chose. Exactly one `recommended` survives normalisation, because two picks expand two rows and ask
the user the question Mentor was supposed to answer.

Timeframes live on the ENTRY (D3): the rung a trigger is read on is a property of the mechanic.

**Bug found and fixed while building:** a reopened stage cleared its ledger entry but left its
CONTENT on the draft — the gate would be open again while the user was still looking at the answers
to it. `fieldsClearedBy` answers "what is being reopened" from the ops BEFORE they are applied
(the content is also what the claims derive from), and the reopened stage's content is dropped
unless the same turn emits a replacement.

Prompt: the entries stage written out (test on THIS ticker and count it — "a measurement, not a
feeling"; stop is a price; targets may be legs; time exits offered; management NOT authored, Talos
raises it live), plus a rule both gates needed — **re-emit the narrowed set when the user chooses**,
because the ledger records the agreement, not the menu.

FE: `EntryTable.jsx` — trade blocks with entries nested, Mentor's pick expanded, the rest folded,
the semantics stated in words, the share shown when scaling in.

Suites: backend 3622/0, frontend 1106/1106.

**Still not built for this stage (noted in #9):** a general "does this pattern work on this ticker"
measurement. Mentor evidences it today from `get_candles` / `get_false_breaks` / `get_orderblocks`
and is told to say so when it cannot measure.
