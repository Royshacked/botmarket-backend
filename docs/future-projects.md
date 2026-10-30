# Future projects

Roy's list of what to build next, as he gave it (2026-10-28). Not designed yet — each line is the ask
plus what the code already has to start from. When one is picked up, it gets its own doc in `design/`
and its line here points to it.

---

## 1. A currencies desk — fundamentals, macro and trading

An agent that analyses currency pairs: the macro and fundamental case (rates, inflation, growth,
current account, central-bank path) and the trade itself.

Starting points:
- cTrader is already a live venue and trades FX — the broker side exists.
- Aether's channels already carry the macro (policy rates, rate expectations, FRED proxies) — the
  house view of the drivers is there to read, not rebuild.
- Open question: its own desk, or a Mentor mode (Mentor trades; a currency desk would *research*,
  like Prometheus does for companies).

## 2. A futures desk — the same, for futures

Fundamentals, macro and trading for futures (indices, rates, energy, metals, ags).

Starting points:
- Aether's channels again for the macro; commodities add supply/demand and the curve (contango /
  backwardation, roll).
- Needs contract specs (multiplier, tick, expiry, roll) in the entity model — a leg's size is
  contracts, not shares.
- Venue: IBKR (in progress) is the natural one; cTrader carries some index/commodity CFDs.

## 3. An options desk — the same, for options

Analysis and trading of options: the view on the underlying plus volatility (IV vs realised, skew,
term structure), and the structure that expresses it (calls/puts, spreads, covered calls).

Starting points:
- The underlying's view can come from what the house already has — Prometheus's coverage
  (target, horizon) is a direction and a time frame an option structure can be fitted to.
- Needs an options chain + greeks data source, and multi-leg orders at the venue (IBKR).
- Hardest of the three for monitoring: a leg's value moves with time and vol, not only price.

## 4. Talos — change the plan while managing, without a new analysis from Mentor

Today Talos manages a filled setup inside a fixed menu (`docs/design/talos-per-candle.md`,
`allowedVerdicts`): `hold`, `move_stop` (tighten only), `exit_now`, `take_partial`, `add_leg` — and
any real change to the plan (moving a target out, a new leg, a different stop logic) is an edit of
the plan, which is Mentor's. Roy wants Talos able to adapt the original plan himself as the trade
goes, without a fresh Mentor analysis.

To decide when designed:
- Which edits Talos may make on his own (move a target, widen a stop?, re-size, add/remove a leg)
  and which still go to Mentor — `let_run` was deleted on purpose (2026-09-17) because moving a
  target out was ruled a plan edit.
- The trail: every Talos plan change written as a revision with his reason, so the original plan
  and the changed one are both kept (trust-gaps-todo §1 — the thesis must not be rewritten in place).
- The user's say: a proposal card to confirm, or applied and reported, per workspace (live vs
  paper/manual).

## 5. Test a pattern on one ticker's history — with the lab we built

> **SUPERSEDED 2026-10-30** by [design/stock-playbook.md](design/stock-playbook.md) — Roy restarted the question
> from scratch: a system that gets to know a stock and says how to trade it. Kept below as the earlier thinking.

Roy (2026-10-29): "the ML we have built — can we use it to check a certain pattern in one ticker,
historically?" E.g. "NVDA after a 3-day pullback into earnings", "XOM when oil gaps up".

What exists (`docs/design/screener-lab.md`):
- **The trade and its cost** — `screenerLab` `trade`: a pattern's entry and exit, net vs SPY after
  cost; the 5-session block ranges; the luck check (shuffle the outcomes, the real result must
  clear the 95th percentile).
- **The facts per trade** — `services/runupModel.service.js` (40 facts known before the entry:
  the tape, the report, short interest, dark pool, insiders, the sector's season, the regime).
- **The model** — `scripts/lab-runup-ml.py` (LightGBM + logistic, walk-forward, a held-out year).
- **The price history** — the lab's caches and the engine's daily prices (Parquet, 2018 →).

The catch, to design around: **one ticker has too few events for the model.** Eight years of
one stock is ~30 earnings reports, or a few dozen pullbacks — the model needs hundreds (≥ 200 a
leaf). So for one ticker the right tool is the lab's TEST, not its model:
- An event study: find every time the pattern happened, the move after it vs SPY (and vs the
  stock's own ordinary days), the block range, the luck check — "it happened 23 times, up 15,
  median +2.1% vs SPY over 5 days, range −0.4 … +4.0, not distinguishable from luck".
- Where the model fits: train it across ALL names on the pattern, then read its score for this
  ticker — "does the pattern work in general, and does this name look like the ones it worked on".

### How it works with Mentor (Roy, 2026-10-29)

**Mentor calls it as a TOOL** — `test_signal`, like `get_earnings`. The rule: the agent turns words
into a signal; CODE computes the answer — the model never estimates a number.

Three ways in:
1. **His own plan, checked.** User: "I want to swing TSLA." Mentor builds the plan (say: buy the
   pullback to the 50-day, target the last high, ~3 weeks), then tests that entry on TSLA's history
   before handing it back — "19 times since 2018, 12 up, median +3.4% vs SPY over 15 sessions,
   range −1.0 … +7.5; all names +0.6%; passes the luck check; your −8% stop would have cut 4 of 19
   winners, −12% kept 18." The verdict changes the plan (keep it / a different entry / size down /
   a wider stop), and the numbers go on the setup card.
2. **The user's idea, tested.** "Do false breaks work as an entry on TSLA?" "What about the
   50-day?" Mentor pins the definition down first ("a close over the 20-day high, back under within
   2 sessions — right?"), runs it, and answers: "31 since 2018; 5 days later lower 55% of the time;
   median −0.8% vs TSLA's ordinary 5 days, range −2.9 … +1.1 — no different from an ordinary day."
3. **Mentor offers his own.** "Want me to see what has worked on TSLA?" He runs a FIXED MENU — every
   entry signal in the set, with its standard settings, the same menu for every name — and shows
   the few that stood out, each with its range and the luck check made for the whole menu
   ("12 tried; the best, the 50-day touch, +1.9% vs ordinary days — one that good turns up by luck
   1 time in 4 among 12"). A fixed menu is MORE honest than trying entries one by one: the number
   of tries is known in advance, not grown until something looks good. He can also offer the
   CONDITIONS that made a signal work on this name ("it worked when SPY was over its 200-day, not
   under") — the same luck check, the conditions counted as tries.

**The baseline is the stock's ORDINARY day**, not zero and not only SPY: TSLA mostly rose, so "it
went up after the signal" proves nothing. Every result is against TSLA's other days, against SPY
over the same days, and against the same signal on all names (a TSLA thing or a general one?).

**The tool's contract:**
- In: `{ symbol, signal: { kind, ...settings }, direction, horizons: [1, 5, 10, 20], since }`.
  `kind` from a fixed set — false break, moving-average touch / cross, gap, pullback, new high,
  the earnings run-up; a few settings each. Not in the set → Mentor says it cannot test that yet.
- Out: `{ events, dates, by_horizon: { median_vs_ordinary, up_share, range }, all_names, luck,
  tries_this_session, path (the typical move after — how far against, how far for), worst }`.
- Under ~15 events → "too few to judge", not a verdict.
- The tool counts the session's tries itself, and Mentor must say the count.

**Where each part runs:**
- One ticker's test: the backend, on demand — one FMP call for its full adjusted history, then
  the event study (seconds).
- The all-names number per signal: an engine job, weekly — it needs every name's history (the
  Parquet on the laptop; Render has only a recent window).
- The ML score ("does TSLA look like the names it worked on?"): an engine job — the model is
  Python (LightGBM); the tool reads the stored score, or says there is none.

**Later:** Talos uses the tested path as his yardstick ("day 10 — behind this pattern's usual
path") — project 4.

**Limits Mentor states:** few events → wide ranges; TSLA of 2019 is not TSLA today; adjusted
prices and costs assumed; past is not a promise.
