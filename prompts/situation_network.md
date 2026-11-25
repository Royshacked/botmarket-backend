You turn the house's current state and its open questions into a NETWORK of possible next events with probabilities.
Code then spreads changes through the network and scores which US industries the possible futures favour. You are
one of several independent runs; the median of the runs is kept, so give your own best numbers.

You are given the state (dated, sourced) and the questions, numbered. For EVERY question answer:

1. `probabilities`: one number per option (by its key), summing to 1. REASON FIRST, in `reasoning` (2–4
   sentences): what in the state points each way, and the base rate where one exists (how often this kind of thing has
   happened before in similar situations). Then the numbers. Use only the state: nothing from elsewhere, nothing after
   its as-of date.
2. `base_rate`: one sentence naming the base rate you used, or null when there is none.
3. `confidence`: `high` when the state settles it well, `low` when you are guessing.
4. `lag_days`: `{ min, max }` — how many days from the as-of date until the question resolves or its effect shows.
5. `resolve_by`: the date (YYYY-MM-DD) by which the question will be answered. Not before the as-of date.
6. `signposts`: for EVERY option, one sentence: the observable sign that would show it is happening (a release, a
   statement, a price, a filing). These wake the less likely branches later, so make them checkable.
7. `given`: when a question only makes sense if another question goes a particular way, name that branch
   `{ question, option }` (its number and option key) — this question's probabilities are then CONDITIONAL on it.
   Otherwise null. Use it for a FOLLOW-UP: a question that only matters once an option happens and that decides which
   way industries move then ("Who becomes CEO?" under "names a permanent CEO: Yes"). No chains just for structure:
   a question that stands alone stays alone, and a follow-up goes two levels at most.
8. `duplicate_of`: the number of an earlier question that asks the same thing, or null. The same topic at another date is
   NOT a duplicate (the next Fed meeting; the Fed's rate at the end of next year).
LONG questions (answered more than 8 months out): look hard for a base rate, and say `low` confidence when there is
none; less is known, so do not be surer than the base rate and the state allow.

Then the LINKS: where one question's option, if it happens, makes an option of ANOTHER question more or less likely.
For each: `from` `{ question, option }`, `to` `{ question, option }`, `direction` (`raises` / `lowers`), `strength`
(`small` / `medium` / `large`), `lag_days` `{ min, max }`, and `why` (one sentence). A long question should be moved by
at least one near question, whose answer is a checkpoint on the way to it: link it. Only real, direct channels — an
Iran strike raises "inflation rises" through oil; a growth scare raises "the Fed cuts". Not every pair is linked.
A link never joins a question to itself, and never repeats what `given` already says.

Answer in the JSON schema given.
