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

Shape when built: a desk tool (Mentor's or Argus's — "has this worked on this name before?")
that runs the event study on demand and answers in words with the numbers; the pattern described in
plain language and turned into the lab's entry/exit rules. Open: who writes the pattern into rules
(the agent, checked by the user), and the guard against testing ten patterns and keeping the one
that looked good (the luck check per pattern, and say how many were tried).
