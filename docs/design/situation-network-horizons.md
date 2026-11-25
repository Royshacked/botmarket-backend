# The situation network: horizons and the cap (2026-11-25)

Status: steps 1–2 (§2–3) built 2026-11-25; the rest is DESIGN. Parent: [situation-network.md](situation-network.md),
[situation-network-layers.md](situation-network-layers.md), [situation-network-outcomes.md](situation-network-outcomes.md).
To land BEFORE the forward test starts: every step changes what is being tested.

Windows agreed by Roy (2026-11-25): **near = 0–6 months, far = 6–24 months**.

## 1. What is wrong today

Read from the dev network, run_54c4ab11 (weekly, 2026-11-24): 57 live questions, 25 macro and 32 sector.

1. **Questions are short.** 46 of 57 resolve within 6 months, 2 after 12. The code has no limit; the prompts' examples
   ("by the end of Q1", "at the next FOMC", a calendar of 3–6 months) set the length.
2. **An effect has no time.** It has a direction, a size and a reason. When a question is ANSWERED and how long its
   effect LASTS are different things, and only the first is stored (`resolve_by`). `lag` mixes the two ("until the
   question resolves or its effect shows") and no score reads it. A year of capex cuts and one month's retail sales
   count the same.
3. **A resolved effect never ends.** `walkOrder` leaves out only dropped and split questions; a resolved one is drawn
   at 100% in every sample, with no expiry.
4. **The cap cuts the wrong questions.** Macro is full (20 open); 39 of the 47 cap drops are macro (some
   near-duplicates): the December and January Fed decisions, CPI, payrolls, the 10-year, an Iran strike, Brent, the
   US-China truce, chip export controls. Kept: Netflix's January guidance, packaged-food volumes. The rank is impact ×
   uncertainty, so a coin-flip on a narrow topic beats a likely Fed move. 3 of the 20 places hold promoted sector
   questions.
5. **The scores are sensitive to it.** Lowering the macro cap from 20 to 15 on the same run keeps 6 of the 12 calls at
   60% or more (correlation 0.79); sectors from 3 to 2 keeps 9 of 12 (0.94). This shows sensitivity, not that a higher
   cap makes better calls.

## 2. The ranking and the places (`layers.holdCaps`)

- **Rank = impact × uncertainty × reach.** Reach = how many industries the question's branches move (from its mapped
  effects), scaled 0.5 (none or one) to 1.5 (10 or more; measured 2026-11-25: the widest question of a build reaches 9). An unmapped question gets 1.
- **Reach needs the mapping first.** An update already maps before it caps. A build caps in `network.assemble`, before
  mapping: it keeps up to 1.5 × the cap there, maps those, then `holdCaps` applies the real cap.
- **Macro cap 20 → 30** near questions. Sectors stay at 3 each, 30 in all.
- **Reserved places:** the best 2 open questions of each core tree (`inflation_fed_rates`, `growth_jobs`, `energy`,
  `tariffs_trade`, `geopolitics`) are kept before the rest compete. A tree with fewer gives its places back.
- **At most 6 open questions per tree** in the macro layer: scores add up, so many questions on one story count it many
  times. A dropped one says so (a new drop reason, `story_full`).
- `tree` is free text in the update; code matches the core list by exact name only. No schema change.
- **A promoted question** competes for a macro place like any other.

## 3. When an effect starts and how long it lasts (`industries.mapBranches`)

Two fields on each effect, in the MAPPING call's schema (the update schema is at the API's grammar limit):

| Field | Values | Read as (days) |
|---|---|---|
| `starts` (after the branch happens) | `now` / `months` / `next_year` | 0 / 60 / 365 |
| `lasts` | `weeks` / `quarters` / `years` | 45 / 270 / 730 |

- The branch happens on its `resolved.on`; while it is live, on its `resolve_by`. The effect is active from that date
  + `starts`, for `lasts`. A live question with no `resolve_by` counts from the run's date.
- The two mapping runs must agree on industry and direction, as now. Where they differ on time, the LATER start and the
  SHORTER length are kept (the same caution as the smaller size).
- **Expiry, per effect:** a resolved question's effect that has ended leaves the scoring; its longer ones stay. The question
  stays in the records.
- A question answered this quarter with a long effect (Roy's example) becomes expressible: `resolve_by` February,
  `starts: months`, `lasts: years`.
- `lag` is not used for this. It stays as it is.
- **No migration:** the live branches have neither field, and a missing field reads as `now` + `quarters`. Step 6's fresh
  BUILD maps everything anew (it must be a build: a rebuild carries old questions over, and the first build's have no
  impact saved).

## 4. Two scores (`industries.scoreIndustries`)

- The same samples, two sums per industry: **near** (0–183 days from the run) and **far** (184–730 days). An effect
  counts in a window when its active period overlaps it by at least 30 days.
- The size in a window is the effect's bucket, not scaled by the overlap. Whether to scale is a later measurement.
- Each row keeps `near` and `far`: p_win, p_lose, size, agreement, paths. The existing top-level fields stay and hold
  NEAR, so the board, the entries and the old runs keep reading. `macro` is kept for both.
- Axl says which window a call is for; the Industries tab shows a Near / Far switch, Near first.

## 5. Grading (`scorecard.js`, `control.js`)

- Near: 3 and 6 months, as declared. **The pass rule (situation-network.md §11.5) is on NEAR, unchanged.**
- Far: the return from month 6 to month 24, with an early read at month 12 (months 6–12). Reported, never in the
  12-month verdict: the first full far grade comes 24 months in.
- The control is asked for both windows, so far has its own baseline.
- Questions: Brier and calibration also split by how far out the question was when set (under 6 months, 6–12, over 12).
  A long question that has not resolved is not graded and counts towards nothing.

## 6. Long questions

- **Up to 8 open long questions** (macro layer), in places of their own: `resolve_by` over 183 days away. When a long
  question comes within 183 days it competes as a near one.
- The state prompt asks for 5–8 of them, 6–24 months out (the Fed's path through 2027, hyperscaler capex in 2028, a
  tariff regime that stays or is struck down), each with an answer checkable by a date.
- **Checkpoints, not bare guesses:** a long question should be linked from at least one near question, so near answers
  move it. One without is kept, and flagged on the board.
- The network prompt asks for a base rate on a long question; without one, confidence is `low`.
- The due check, the resolution check and the outcomes review apply to them unchanged.

## 7. Cost

Weekly runs are $2.40–2.56 at 57 questions. Estimate at about 75: $3–3.50. The $10 weekly budget holds. One-off: the
re-mapping plus a rebuild to fill the new places. To be measured on dev before prod.

## 8. Build order

1. Ranking, reserved places, the per-tree limit, macro 30 (§2).
2. `starts` / `lasts`, agreement, expiry (§3). Probe the mapping schema live before building on it.
3. Near and far scores, the board, Axl's tool (§4).
4. Grading and the control (§5).
5. Long questions (§6).
6. Dev: re-map, rebuild, two weekly runs, cost measured. Then prod is aligned again, then the forward test.

After step 1, compare on dev: which calls changed, and whether the Fed, inflation, jobs, oil and trade are all in.

## 9. Open, for Roy

1. **What the far score claims.** Prices move when news arrives: a cut answered in February that hurts for years may
   move the industry in February and not after. The far score says the industry keeps lagging in months 6–24, a stronger
   claim. Proposed: keep it, graded on its own, and let the record say. The alternative: grade long effects from the
   day they are known.
2. **Numbers that are judgment, not measured:** macro 30, 8 long, 2 reserved per core tree, 6 per tree, the reach
   scale, the day values in §3.
3. **Dropped questions are not reconsidered** until the monthly rebuild, which writes fresh ones. Proposed: leave it.
