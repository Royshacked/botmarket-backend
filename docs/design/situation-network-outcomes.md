# The situation network: missing outcomes (2026-11-24)

Status: BUILT 2026-11-24. Parent: [situation-network.md](situation-network.md), [situation-network-layers.md](situation-network-layers.md).

## 1. The miss

"Does Nvidia name a permanent CEO by the end of Q1 2027?" had two options, Yes and No. When the board brought Jensen
Huang back (2026-11-23), the update resolved it **Yes**. The label fit; the effects did not: "Yes" was mapped for an
outsider (a governance reset), not for the old CEO's return (continuity, a relief rally).

Roy's point (2026-11-24): grading it right at the end is the smaller half. **An option shapes the network from the day
it exists.** It holds probability, its effects feed the industry scores, and links run to and from it. With "Huang
returns" missing, its share sat inside Yes and No for the whole life of the question, and everything built on those two
was off. The state prompt already asked for options that "cover what can reasonably happen", and that rule failed.
Another rule in the same prompt would be a plaster.

## 2. The missing-outcomes review (`services/situation/outcomes.js`, `prompts/situation_outcomes.md`)

- A **separate call** on every weekly update and every rebuild (`update.runUpdate`), after the week's news is applied.
  It sees every live question, with each option's probability and what the option ASSUMES (its three largest industry
  effects). Its only job is to attack the options:
  - is a plausible outcome (about 5% or more) **missing**?
  - does an option **lump** two outcomes that would move industries differently?
- **`add_option`** (a question with fewer than 4 options): the outcome becomes a new option, with its share of the
  probability. Then it goes through the same paths as an option an update adds:
  - its numbers are re-set (a new anchor, logged as forecasts);
  - the node is mapped to industries;
  - the option gets **its own links** (`network.linksFor(nodes, ids, newOptions)`; until now, an option added by an
    update got no links at all).
- **`reword`** (the question is framed on the wrong thing, or it is full): a replacing question asked about what moves
  industries ("Who leads Nvidia by Q1 2027?"). The new question keeps the old one's tree, layer, origin, resolve-by
  date and lag, and gets `split_from`. The old question is dropped as `reworded`; its links go with it, and the new
  question is linked fresh. A question with sub-questions under it is not reworded. That is skipped and said.
- **Guard rails:** at most 8 changes per review; one change per question. A change that does not fit (a full question,
  probabilities that give the new option nothing) is skipped with its reason in `stats.outcomes.skipped`, never forced.
  If the review fails, the run's gaps say so and nothing else changes.
- **On the board and the card:** every added option and reworded question is listed on the Updates tab and on Roy's
  review card ("Outcome added", "reworded by the outcomes review").
- **The model:** a second vendor would share fewer blind spots, but no structured-output path to one exists yet. For
  now it is a separate Claude call (Opus, high effort) with an adversarial brief. `OUTCOMES_MODEL` is the one place to
  swap.
- **A first build is not reviewed** until its first weekly update, at most 7 days later. Every later week is reviewed.
- About $0.3–0.6 a week (one call over 50–60 questions), estimated, not yet measured.

## 3. The resolution check (the safety net)

- **The check.** The update prompt now shows each option's assumed effects. A `resolves` decision, and a DUE question
  that resolved, answer `fits`: does what happened match what the option assumed?
- **When it does not** (`fits: false`), `unforeseen` names the outcome that did happen. That outcome is added as an
  option and resolved to, and the node is mapped, so the industries get the push of what happened rather than of the
  label. If the question is full, it resolves to the named option instead.
- **Either way the resolution is marked `unforeseen`**, on the board ("⚑ not foreseen") and on the card ("NOT
  FORESEEN").

## 4. Grading and the count

- **What used to happen.** A question won by an option that a run's forecast did not have used to grade that run's rows
  all against outcome 0. That looks like a *good* forecast.
- **The fix.** `store.gradeForecasts` now adds one row per such run: `p: 0`, `outcome: 1`, `brier: 1`, `absent: true`
  (`store.absentRows`). This covers options added by an update, by the review, or by the resolution check.
- **The count.** The scorecard reports `unforeseen: { questions, of }`: how many resolved questions were won by an
  outcome missing from their options when they were forecast. It appears on the board and in Axl's scorecard view. **The
  review works if this share falls** over the forward test.

## 5. Routing "outside" stories to the sectors

- **The gap.** A macro call's `outside` story (it hits industries but no macro question) used to stop there, even when a
  sector had the question for it. The example: the 10% credit-card rate cap, which Financials had a question for.
- **The fix.**
  - `outside` now names the `sectors` it hits.
  - The macro call runs FIRST.
  - Its outside stories are passed to those sectors' calls, with their articles (`update.routeOutside`, `withRouted`).
    This includes a sector the event did not name; such a sector reads no feed of its own.
  - The outside list keeps the story and says where it went (`routed_to`, "sent to …" on the board).
- **The cost of the order:** the sector calls wait for the macro one, about a minute or two more per update.

## 6. Also

- The state and sector prompts gained one line: split an option when two ways of it happening would move industries
  differently. This is the cheap extra, not the fix.
- `fitProbabilities` and `withKind` moved to `model.js`, since the review shares them; `update.js` re-exports them.
- Tests: `tests/unit/situationOutcomes.test.js`; the board's test covers the new lines.
