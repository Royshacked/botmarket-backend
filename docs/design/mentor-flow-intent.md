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

## Phase 6 — sizing in five units, and the money said out loud (DONE)
**`services/positionSize.util.js`** (pure): `SIZE_UNITS` = risk_cash · risk_pct · size_cash ·
size_pct · shares, all resolving to one quantity from the entry, the stop, the balance and the
contract multiplier. Two things it REFUSES rather than guesses — a percentage with no visible
balance, and a risk budget when entry and stop are the same price — and a budget smaller than one
unit is said out loud instead of being floored to a silent zero.

**`services/mentorSummary.util.js`** (pure): `summarizeTrade` → R:R, gain and loss in cash and as a
percent of the account; `summarizeBatch` for the multi-name line; `applySizing` resolves the user's
answer PER SCENARIO, because two ways into one trade have different stops and therefore different
sizes for the same risk budget.

**Wired:** `<build>{"size":{"unit":"risk_pct","value":1}}</build>` is now an op. The server sizes
every premise, writes the quantity onto the worksheet, and returns a refusal (not a guess) when it
cannot. `_mainBalance` picks the marked account's deployable cash and returns null when several
accounts are marked with no main — ambiguous is not a number. `_buildMoneySection` hands the model
the figures to READ OUT, under a line telling it never to recompute them.

**A judgment call worth knowing:** when the target ladder's legs do not add up to the size the user
chose (the plan was drawn at 100 and they sized 125), the whole position is priced to the NEAREST
target instead of scaling the legs or leaving a remainder unsold. Both of those invent a plan
nobody agreed to; pricing it all to the first target can only understate the good case, which is
the direction to be wrong in — and it is the rule `rr` already follows.

**Caught by the bug hunt:** `resolveSize` had no caller. The prompt said "the server computes it"
and nothing did. That is what the `size` op above fixes.

FE: the money line on `SetupSummary`, upside and downside at the same weight, estimates marked.

Suites: backend 3643/0, frontend 1109/1109.

## Phase 7 — an entry need not be a price (DONE)
**The scope collapsed once the code was read, and that is the headline.** Two things this phase was
scoped to build already existed:
- **The two-level shape.** Scenarios were ALWAYS rivals ("the first to fulfil takes the whole trade
  and the others die") and legs INSIDE one scenario were always the scale-in. That is exactly
  `alternatives` vs `scale_in` (4.1). So no restructure: scenarios gained `trade_id` as grouping,
  and the gate artifacts carry the two levels for the UI.
- **Entry at market.** A confirmed `conditional` entry already places `type: 'market'`
  (`buildOrderPlan`), and `firingLeg` already falls back to the first unfilled leg instead of
  resolving a level. Nothing downstream had to learn a new way to execute.

What actually shipped:
- `normalizeLeg` accepts `{trigger, timeframe, about}` on ENTRY legs only; stops and targets stay
  prices, because they rest at a broker.
- **`legText` returned null for a priceless leg** — the trigger would have been INVISIBLE to the
  read that judges it. That was the bug that would have made the whole feature quietly useless.
- `entry_mode: limit` is forced to `conditional` when any entry is a trigger.
- **`about`** (roughly where it fills, never an order) + `legReference`, because risk-per-unit needs
  an entry: without it *"risk 1%"* was refused on a perfectly good plan. Everything off it is an
  estimate. `legPrice` keeps answering null forever — that separation is the safety property.
- `time_exit` authored on the setup, and WIRED: `_isTimeExit` on an open position makes the wake
  reason `time_exit`, which is always-expensive like `expiry_review`, and the in-position prompt
  says `exit_now` is the default answer to it.
- The watch row and the scenario card show a trigger entry instead of a blank cell.

**Open decision 6d is now resolved by the shape of the thing:** guards stay price-only. A trigger
entry arms no guard and is read on every candle close by the cheap tier — the right clock for "a
15m close above X" — and teaching the free 30s sweep to compute indicators would make tier 0 cost
money, which is the one thing it must not do.

Suites: backend 3661/0, frontend 1112/1112.

## Phase 8a — revise vs cancel, and Generate all (DONE, backend)
**REVISE or CANCEL (#17).** The re-entry section of the prompt is rewritten around the one question
that decides which conversation this is: *do the DIRECTION and the HORIZON still stand?* Yes →
revise, and the opening stays settled while the build reopens at `spans` (or `entries` when only
the way in moved). No → cancel: say the thesis broke, and do not re-draw a trade that no longer
exists; a new one on the same name starts at `opening`.

No new mechanism was needed — the cascade from phase 1 IS the re-entry, and Talos's cards already
carry the user back with the plan loaded. What was missing was the TEST and the two different
answers to it.

**Generate all** — `POST /api/setups/generate-all`, capped at 10 (the ledger's own name cap).
Sequential, not parallel: each generate resolves accounts and checks the venue, and a burst of
those against one broker is how you get rate-limited into a false refusal. **Partial success is the
contract**: three of four saving returns 200 with `{saved, failed}`, the three are monitored, and
the fourth comes back with its reason and its index. Rolling back finished work because a later one
was unsized would throw away what the user did; an error status would tell the client to discard a
response carrying real documents.

Suite 3668/0.

### Still open for phase 8b
- **The client carries ONE draft.** A multi-name build needs N, plus a list in the panel and a
  Generate-all button; the endpoint above is ready for it.
- **Social-chat batch intake** (#16): a DM carrying several setups, taken down as one batch. Setup
  sharing (2026-09-21) is the ground to build on; what is new is the multi-setup message.

## Phase 8b — several names in one build (DONE)
The client held ONE draft, so a user who moved from NVDA to AMD lost the NVDA plan. Now the server
returns `drafts` (keyed by asset) whenever a build holds more than one name, the panel keeps them
and sends them back, and `_mergeDrafts` re-normalises everything that comes through the client.
**Only the active draft carries the ledger** — one build has one ledger, and a copy per plan is
several records of one truth.

FE: a `Generate all (N)` button beside the single one (generating just the name in front of you is
still a thing a user may want), and partial success handled as the contract it is — the saved ones
are gone from the table, the refused ones stay on it with their reasons, and the conversation picks
up exactly what failed.

Prompt: a multi-name build is an ordinary build run once per name, with a one-line tally of where
each stands, because the user is holding four builds in their head and Mentor is not.

Suites: backend 3671/0, frontend 1115/1115.

### The one piece of the design still unbuilt
**Social-chat batch intake (#16)** — a DM carrying several setups, taken down as one batch. Setup
sharing (2026-09-21: DM card, fork, blueprint) is the ground; what is new is a multi-setup message
and the "whose sizing?" rule (a risk percentage transfers between accounts, a share count does not).

## Code review of the branch (2026-09-29) — eight findings, all fixed
A full review of `feat/mentor-flow-v2` found eight gaps that 3671 passing tests had not. Worth
recording, because most of them are the same shape: **the piece worked, and nothing connected it.**

1. **`time_exit` was unreachable.** `_checkSetup` hands every position status to `_checkPosition`
   long before the pre-entry reason is chosen, so the clock was tested where a filled position
   never arrives. Moved to the position path — and two deeper holes came out of it: a position of
   plain levels is marked DORMANT and never read at all (so a `time_exit` on one still would not
   fire), and `allowedVerdicts` only offers `exit_now` when a STOP is watched, so the read woken by
   the user's own deadline could only have answered `hold`. A setup carrying a `time_exit` now
   never goes dormant, and that wake is always allowed to exit.
2. **The sizing stage could never settle.** `sanitizeBuildOps` produced `ops.size`, `applyBuildOps`
   never claimed it, and the exact op the prompt prescribes came back `nothing claimed for size`.
3. **A multi-name build lost the first name.** `_mergeDrafts` seeded only from `chatState.drafts`,
   which the client only has once the server sends it — and the server only sends it at two names.
   So "Generate all" was unreachable. **The test that should have caught it hand-fed the server a
   field the real client never sends.** Now seeded from the draft being sent back, and the
   regression test drives it the way the frontend does.
4. **The contract multiplier was ignored** — `applySizing`/`summarizeTrade` defaulted it to 1, so
   an ES future with a 4-point stop and a $500 budget sized 125 contracts risking $25,000. It now
   travels with the size op, and futures/forex are REFUSED by name rather than assumed.
5. **The lens was auto-claimed as `discretionary`** because `normalizeSetup` defaults `trade_mode`,
   so the opening turn settled a lens the user never heard — the precise failure claimed-vs-settled
   exists to prevent. Only a stated lens is claimed now.
6. **The build could never complete.** The summary stage's field was `generate`, which nothing
   could ever claim (pressing Generate happens outside the conversation), so `buildComplete` was
   permanently false and every settle of it was refused. The stage now settles on the FIGURES.
7. **The gates leaked across an asset switch** — AMD inherited NVDA's candidate trades when a turn
   emitted none. Carry-forward is now scoped to the same name.
8. **Parked names lost their gate content** every round trip, because `normalizeSetup` returns a
   fixed shape. `spans`/`entries`/`summary` are carried explicitly; the ledger deliberately is not.

Suite 3682/0 (11 new regression tests, one file: `mentorReviewFixes.test.js`).

## The first LIVE smoke (2026-09-29, claude-sonnet-5) — what it proved and what it did not
Five runs of a real two-to-three turn build on a paper account, real tools, nothing stubbed but the
venue line. **Nothing here was findable by a unit test**, and one of it is still open.

### Works, seen with my own eyes
- The opening turn: cheap-first ladder, all three values CLAIMED not settled, worksheet emitted,
  both asks in one message.
- **The chart presentation.** At the spans gate Mentor drew both candidate trades on one daily
  chart — 224.94 and 216.76 blue (where each starts), 229.98 and 234.76 green (where each pays) —
  from a single `get_chart` call with `levels`. This is the thing to look at if you want to see the
  feature working.
- The spans gate itself: two SMC candidates as `FVG → order block`, stopping to ask which to carry.
- Settlement, cascade, refusals and the money section all behaved as built.

### Three defects found, with their ROOT causes (not the symptoms)
1. **The stage said "still blank" when it was actually waiting for an answer.** The ledger had no
   state between blank and settled, so on the turn the user said "yes" the model was told the work
   had not been done — and duly re-read the name and re-proposed all three. Fixed in state:
   `firstUnsettled` now reports `awaiting`, and the turn context says the user's message IS the
   answer.
2. **"Never fetch twice" was prose about a fact nothing recorded.** Fixed by building the evidence
   ledger the design promised: `recordReads` keeps what was read and on which turn, the context
   lists it, and only quote/candles/indicators/chart are exempt.
3. **An empty earnings window was read as evidence against a date outside it.** The model had
   NVDA's 18 Nov date, asked the calendar for a window ending the 17th, got nothing, and
   "corrected" a date that was right. Fixed in the TOOL: an empty filtered window now says what it
   does and does not mean.

### ~~STILL OPEN~~ — RETRACTED, see below
**The model does not reliably settle the opening turn.** Across five runs it emitted the settle tag
zero times on the confirmation turn: first no tag at all, then — once the tag was made mandatory
like `<asset>` — a dutiful `<build>{}</build>` while re-reading twelve tools. The tool re-reading is
better and still not reliable (one run: zero tools; the next: fourteen).

Three prompt-level fixes were tried and are all KEPT, because each is right on its own terms: the
opening turn rewritten as two explicit beats, the mandatory `<build>` tag, and the awaiting state
above. None of them made it dependable.

**The conclusion is architectural, and it should be Roy's call.** Every other confirmation in this
app is a card the user presses — Generate, Arm, every Talos verdict, both build gates. The opening
turn is the ONE place we ask the model to notice agreement in prose and report it, and it is the
one place that fails. The durable fix is to make the proposal a card with a confirm button, so the
CLIENT tells the server what was agreed and the server settles deterministically; the model's tag
becomes a fallback rather than the mechanism. Until then a user may be asked the same question
twice, which is a poor first impression of the desk but harms nothing — the ledger simply stays
open, and nothing is recorded that the user did not agree to.

## CORRECTION (2026-09-29, same day): the "model never settles" finding was WRONG
It was the SMOKE HARNESS, not the desk. `buildDeskMessages` ignores `userPrompt` when `messages`
is a non-empty array, because the real client puts the new user turn INSIDE `messages`. The
harness appended the assistant's reply to `messages` and passed the user's words separately — so
from turn two onward **the user's reply was dropped on the floor**, and the turn context was
attached to the model's own last message.

The model was therefore asked to continue from its own sentence with no answer in front of it. Its
"failure" — re-proposing the same three values and asking again — was the correct response to what
it actually received. Five runs of evidence, all of it measuring the harness.

**Re-run with a correct harness, prose only, NO ops:** settles `direction`/`horizon`/`lens`,
advances to `spans`, calls nine tools all belonging to the NEW stage, re-reads none of the news,
fundamentals or macro, and returns two candidate spans as a table. The flow works as designed.

### What survives, and why it was still worth doing
- **The `awaiting` state** — the ledger genuinely lacked a state between blank and settled, and the
  turn context genuinely said "still blank" about work already done. Right on its own terms.
- **The read record** (`recordReads`) — "fetch once" was a rule about a fact nothing recorded. Still
  true, still worth having, and now the context can say what was read and when.
- **The earnings-window fix** — that one was real and happened inside a single model turn: an empty
  filtered window was read as evidence against a date outside it.
- **Recency and de-duplication** — the ledger now sits last, and the worksheet dump no longer
  repeats `build`/`spans`/`entries`/`summary` in JSON above their own prose sections.
- **The press path** (`chatState.ops` → server settles before the model reads anything, plus the
  `StageConfirm` card). Its JUSTIFICATION changed: not "the model cannot do this" but "a button
  should not depend on a model noticing anything". It is how every other confirmation in this app
  works, it is deterministic, and it is tested — but it was not the necessity I claimed.

**The lesson worth keeping:** a test harness that drives the desk differently from the real client
does not test the desk. The harness never sent what the frontend sends, and five runs of confident
diagnosis followed from that one line.

## The five-turn live build (2026-09-29, on the house model = Luna)
All five stages settled end to end — opening → spans → entries → sizing → summary — with the two
gates rendering real content (a candidate table, then two entry options with `alternatives`
semantics and the evidence for each) and the chart drawn at the spans gate. Turn 2 used **4 tools**
where the earlier runs used 12–14: the read record doing its job.

**The earlier "turn 4 stalls" report was wrong too** — that run was piped through `head -70`, which
closes the pipe and kills the writer at line 72. Re-run to a file: five turns, no stall.

### What the run DID find: the ledger said "sized" over a worksheet with no size
At the summary stage, `settled: …,size` and `qty: -`, `money: -`. Three causes, all fixed:
1. **Sizing only ran on the turn the op arrived.** It is derived state and is now re-derived every
   turn from the ledger — which also means a stop that MOVES re-sizes the position, where before
   the stale share count looked identical on the page.
2. **`clampValue` nulled object values**, so a settled `{unit, value}` did not survive the round
   trip through the client. The ledger now carries a flat object of scalars.
3. **A derived claim overwrote a stated one.** `claimsFromDraft` derives `size` from the
   worksheet's own share count, and that plain number landed on top of the user's "risk 1%" —
   after which the intent was gone and nothing could re-derive it. Derived claims are defaults now:
   they never overwrite an existing claim.

### Two blemishes for a prompt pass, not flow defects
- It quotes a stale price as current (it says the market is shut, then talks as if the last close
  is live).
- Earnings framing drifts turn to turn ("pre-earnings swing" vs the expiry reasoning), even though
  the retraction bug itself is fixed at the tool.

## Prompt pass (2026-09-29) — the two blemishes the live builds left
Both were fixed at their source rather than by adding an instruction on top:

- **A shut market quoted as a live price.** "The market is closed" in one sentence and "NVDA is at
  228.86" in the next is the same mistake with a disclaimer attached. `Live before levels` now
  carries the speech rule: when the market is shut the newest number is a CLOSE with a date, and it
  is spoken as one — a number in the present tense is a number somebody may act on.
- **Earnings framing drifting turn to turn.** Two causes. The prompt sent the model to
  `get_earnings_calendar` for ONE ticker's date, which is the wrong tool (its own description says
  to prefer `get_earnings`) and is how a window ending before the date became "evidence" the date
  was wrong. And nothing said what to DO about an event inside the horizon, so it was mentioned
  every turn and decided never. It is now a decision with exactly two honest answers — out before
  it, or hold through it — which must then be reflected in `valid_until` / `time_exit`.

Also in the pass: the `<build>` tag section now says some answers arrive as a PRESS and are already
recorded (the cards settle server-side before the model reads the turn), and two stray H1 headings
I introduced mid-document became subsections.

**Verified live on the same conditions that produced both defects:** "Monday's September 28 close of
$228.86", and "Next earnings … November 18, 2026; I'd plan to be out beforehand, with the setup
expiring before then." Five new prompt-contract tests; suite 3709/0.

## The deeper read (2026-09-29) — what eight edits in one day left behind
Reading all 1,195 lines as one document, rather than as the eight places I had touched. Every
finding is the same shape: a section that reads correctly on its own and disagrees with another.

1. **Argus.** The very first correction of the design conversation — *Mentor turns the user to
   Argus* — was logged as fix #1 and never applied. The prompt still said "point them back to Axl".
   Ten hours of building on top of a doc whose first line was never done.
2. **"Levels, not bands" contradicted the trigger entry.** It opens "Every level you author is an
   exact price. Entry, stop, target — one number each", which is the opposite of what the entry
   section now says. Carved out, with the trigger shape shown beside the price shape.
3. **Scale-in was described as alternatives.** "Multiple entry levels = scale-in. All are armed;
   whichever price reaches first acts" — which is scaling in by name and rivalry by behaviour, and
   it collides with the entries stage. Now: legs inside ONE scenario are the scale-in and both are
   meant to fill; rival SCENARIOS are the alternatives and the first to fulfil takes the position.
4. **The Generate gate predated both changes**: it demanded "an entry price" (a trigger entry has
   none) and "a quantity THE USER GAVE YOU" (the user gives a unit and a number; the server gives
   the quantity).
5. **"The tag is the move" became half-false** the moment the press path landed — scoped now to
   answers that arrive as words.
6. **"Three things about the ledger" over four bullets** — I added the fourth.
7. **`get_chart` "once per asset/timeframe"** ruled out the second chart the spans gate exists to
   draw. Excepted.

Six new prompt-contract tests pin the ones a future edit could quietly undo. Suite 3715/0.

**Not done, and deliberately:** a tone/redundancy pass over the ~700 lines this session never
touched (conditions, validity, the worksheet, the flip test). They are coherent with the new flow —
that was checked — but they carry the density of the Kairos fork and would read better shorter.
That is a separate job, on a fresh read, not at the end of a ten-hour session.

## De-duplication (2026-09-29): the two things the new flow said twice
Roy's read: most of the old sections are covered by the new flow. Measured, that is true of two of
them and false of the rest — `conditions[]`, `persistence`, `referenced_symbols`, `validity`,
`on_away`, the worksheet and the tags are the EMIT CONTRACT Talos reads, and the stage sections
never restate any of it.

**1. The rejects were authored twice, in the same `why_not` key.** Once as `<spans>.discarded` at
the gate, again as `alternatives[]` on the worksheet. The gate is where the judgment is actually
made, in front of the user, so that is where it is written: `alternativesFromSpans` derives the
setup field from it, and the prompt section is now "you do not author this" plus the two rules the
server cannot derive (a reject promoted into a scenario, and EMPTY on a plan the user brought).
A discarded span may now carry an optional `archetype` so the derivation keeps it.

**2. The scenario count was stated twice, differently** — "up to four" at the spans stage and "as
many as the chart offers" in `scenarios[]`. The gate owns the rule; the schema section points at it
and keeps only what is its own (the same premise at two levels is two scenarios).

Prompt 1,195 -> 1,181 lines, and more to the point one fewer thing for the model to be inconsistent
about on every re-emit. Suite 3718/0.

**Kept, by Roy's call:** `<setups>` and the candidate picker. Largely superseded by the spans gate
— the prompt says so itself — but removing it retires a user-facing path, which is a product
decision and not a cleanup.

## Running it live (2026-09-29, after the merge) — seven defects, and one new rule
Roy built setups in the real app on the house model (Luna) while this was on main. Everything the
flow is *for* held: the opening turn came back with direction, horizon and lens together; the gates
opened in order; the ledger never lost its place across a digression. What broke was the seam
between the server and the screen — and I wrote most of it.

1. **`web_search` was named in every desk prompt and could not be called on a non-Anthropic model.**
   The compat translation dropped the Anthropic server tool and sent OpenRouter's `web` plugin
   instead, which augments the prompt silently and is not callable. Luna said so out loud: *"web
   search tool isn't available."* Now substituted as a real function tool backed by GNews
   (`services/tools/webSearchCompat.tools.js`), with the handler injected by the compat loop
   because no desk toolset has ever carried one. **Not mine — it predates this build.**
2. **The picture did not follow the house model.** The vision route was pinned while the chat model
   was a selector. Both follow `house_settings/models` now.
3. **The gate's chart could not be reached** — the spans card drew above a chart the user could not
   scroll to, and the routes were single-click radio behaviour. Both fixed together: the chart got
   a fixed aspect ratio, and the routes became **checkboxes**, because more than one way in is a
   real answer even without scaling.
4. **A settled gate stayed on the screen.** The card was keyed to its content, not its stage.
5. **Then BOTH gates vanished** — the controller never forwarded the `gate` field the panel had just
   started keying off. That is the SECOND field dropped there (`build` was the first), so the
   shaping is a pure function with a test now (`_mentorResponse`).
6. **A zero balance read as "a balance I cannot see"**, and the sizing blocker sent the build back
   to the entries gate. Zero is a balance; a sizing problem is answered at sizing.
7. **Two entries could not be sized.** Sizing set a leg quantity only when there was exactly one
   leg, while readiness demands one per leg — so the honest answer ("I'd take it either way") made
   the build unsizable. Every leg is sized now: a scale-in splits by share, and two rivals filed
   inside one scenario are refused by name.

A last one was found by looking rather than by asking: the blockers line read *"Still needs: …,
trading account, trading account"*, because the gap is known on both sides and both said it.

**The rule this leaves (Roy's).** Three of these had green tests when I handed them back. The FE
tests mock the service layer, so nothing exercised server → controller → panel as one path, which
is where all three lived. **Drive the app in a browser before reporting a frontend change done.**
`scripts/drive-mentor-ui.mjs` is that drive, committed rather than improvised: it makes the
throwaway user, signs in, opens Mentor, sends an opening turn, presses the confirm and screenshots
the gate. Look at the screenshots. Two traps worth knowing: a resumed thread starts past the
opening stage (state, not a defect), and a local server run with `NODE_ENV=production` disables the
8.8.8.8 DNS pin, which reads exactly like a Mongo outage.

### Still open after this session
- **Batch intake from social chat** — several finished plans in one DM, straight to "generate all".
  The receiver is built (the blueprint hydrates and lands on a turn); what is missing is a sender
  for more than one.
- **A candidate pick settling the opening** — shipped as an interim fix; Roy is redoing it with the
  sending part and the two may collide.
- **Argus stalled mid-conversation** on one live run. Reported, not diagnosed, not this desk.
- **Labels on the drawn spans** — the lines are there, the names are not.
- **Reasoning on Luna.** The `reasoningEffort` knob is Anthropic-only; OpenRouter takes a
  `reasoning` parameter nobody has wired.


## Marce's builds (2026-10-01) — what the ledger could not record, and the Generate path

Reported by Marce: *"Mentor forgets and asks questions again and again, and there are problems
clicking Generate."* Read from his prod threads first (INTC, PACB, plus FCX/ERO/CAT), then replayed
live against the real model and driven in a browser. Every cause below was reproduced before it was
fixed.

**Why it asked again — the ledger had no word for three answers the user really gave.**
1. **"You decide."** Spec'd at #3 ("or tells Mentor to choose") and never built into the ledger: the
   `You choose` button sent words with no op, and the prompt only knew the opening-turn waiver.
   PACB: Mentor picked the limit pullback in prose, the gate stayed open, and his `$20K` size was then
   **refused** — `entries must be settled before size`. → `delegate` (op and tag), settled by the
   server on Mentor's own `recommended` option (`delegationPicks`). The build-wide waiver now settles
   the same way; before, it too waited on a `settle` the model had to remember.
2. **A size given early.** Refused for being out of order, the refusal shown as REFUSED LAST TURN,
   and Mentor asked for the size again. → sizing `settles: 'answer'`: a user's size is HELD and settles
   by itself the moment the stages before it do. Sizing settles only on a `user` claim.
3. **The summary.** Spec #12 makes its answer pressing Generate; the build made it a prose "yes", so
   INTC ended on *"confirm this summary, then it will be ready"* — with Generate already lit, after he
   had asked twice. → `settles: 'shown'`: the server settles it on this turn's figures, and the turn
   context carries the button's own verdict (GENERATE lit / dark + what is missing once every stage is
   settled).

`settleInOrder` replaces the order-sensitive settle: one walk over the stages, requested fields plus
the ones that settle by themselves. Derived claims that mirror content now follow Mentor's newer
content (`claim(..., {overwrite: 'own'})`) — before, a narrowed `<entries>` was dropped against the old
menu and a settle agreed to every option ever offered.

**Sizing became a tool** (`size_position`). A tag is read after the model writes, so the sizing turn
could never read its own figures and ended on a promise. The tool answers in-turn per scenario —
quantity, risk, position value, pays/costs, `cashFit` against deployable cash (PACB's "$36,667 against
$22,624" had been the model's own arithmetic), and the Generate verdict. Found on the way: float noise
under-sized by a share (2.20 − 2.14 → 4,999 for $300, not 5,000), fixed in `resolveSize`.

**The entries gate came out EMPTY.** Live, the model keyed `<entries>` by scenario id (`s1`) where the
span id (`t1`) belongs; `normalizeEntries` dropped every trade. No table, nothing to press, nothing for
a hand-back to settle on — his PACB ledger shows exactly this ("nothing claimed for entries"). →
`resolveEntryTrades` re-keys only that slip; anything else unresolved is told to the model by name; the
ledger names the span ids at the entries stage.

**Generate — four defects, all driven, none caught by a green test:**
1. **A trigger entry lit Generate and was refused at save** — `invalid_leg`, "a level is missing its
   price". The save-path check (Sep 25) predated "an entry need not be a price" (Sep 28, f17b02f) and
   was never told. Every trigger-entry plan since Sep 28 hit it. Entry legs may be a trigger; stop and
   targets stay prices. Generate and Arm share the one `validateSetup`.
2. **The refusal said "Request failed with status code 400"** — the panel printed axios's message, not
   the server's. All three Mentor alerts now go through the shared `apiError`.
3. **Marking an account did not light Generate** until another message — the verdict was the last
   turn's. The panel composes the account gap both ways now (the gate reads the account only as "is one
   marked"), lighting only when the account was the sole blocker.
4. **A reopened conversation** — from the threads list or a restore — landed with no verdict and no
   gate card. Both doorways are now one function (`_openConversation`) that asks `/api/setups/validate`
   once (which now also returns the open gate), guarded so a late answer never overwrites a turn's.

Plus, on the Lists card: a trigger entry printed **"in null"**, and a generated (unwatched) setup said
**"Armed"** — the status copy predated the shared ladder. One entry reader for every surface
(`setupPlan.utils.entryText`); the copy keyed to `waiting/looking/hit/long/short/closed`.

**Voice.** Whisper detected the language and heard accented English as Romanian, French, Polish and
Spanish; each such turn was stopped and dictated again. The language is told now (`en`, or a client's
two-letter code), with a vocabulary hint.

### Still open after this pass
- **History window.** Mentor keeps 8 messages and trims at 24 (`MAX_RECENT_MESSAGES`). A long build
  loses its opening — "mind the balance, leave money free" — past that; the ledger keeps the settled
  facts but not stated constraints. Not hit in Marce's threads (14–19 messages); worth a decision.
- **Two "available cash" sources.** Sizing uses the client-sent account's `freeMargin`; the venue
  section reads it fresh per turn. They agreed in every real thread, but they are two reads of one fact.
- **The money line covers the first scenario only** (`carrier.summary`); the sizing tool reports per
  scenario, the panel does not yet.
