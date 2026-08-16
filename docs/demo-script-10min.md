# TRADVICE — 10-minute investor demo

> Not an architecture doc. This is a recording script, written **2026-08-16** against the app
> as it stood that day. It names screens and claims capabilities; both drift. Re-walk it
> before recording rather than trusting it.

**Format:** screen recording + voiceover. ~1,400 spoken words ≈ 140 wpm.
**Spine (the one sentence the whole video defends):** *every other product turns a
conversation into an answer — this one turns a conversation into a supervised object that
keeps working after you close the chat.*

---

## Before you hit record

**Stage the data.** The demo dies on empty screens, not on bugs.

- A `live` book with 2–3 open positions, at least one in profit, one near its stop.
- A `paper` book with a different set — the workspace switch must visibly change the world.
- One `manual` item, so the third mode isn't a claim.
- One `setup` already **triggered** with Talos assessments on it — you need history to scroll.
- One **queued** off-hours action sitting in the queue.
- A recent Argus scan with results, one live `coverage` from Prometheus, a current `tilt`.
- Earnings/Fed rows in the Radar calendar for the next few days.

**Pre-warm.** Open every tab you'll visit once before recording so nothing cold-loads on camera.

**The latency problem — read this.** Agent turns are real LLM calls. A Mentor build is ~2
round trips; a scan is longer. Do **not** sit through them live. Two options:

- *Preferred:* record each agent turn as its own take, then cut the dead air. The stream is
  the payoff — you want the reasoning and tool chips visibly landing, just not in real time.
- *Fallback:* re-open a thread that already has the turn in it and scroll it. Say "I ran this
  a moment ago" — investors forgive a warm cache, they don't forgive 40 seconds of spinner.

**Don't demo:** anything from `docs/design/` that isn't built (Opportunist/Tyche, IBKR
trading). Roadmap goes in words at 9:00, never on screen.

---

## 0:00 – 0:40 — Cold open: the problem

**SCREEN:** Start on the app **already open**, Floor mode, live positions in the left rail.
Don't show a login. No slides.

> Everyone has now seen a chatbot that talks about markets. You ask it about Nvidia, it
> writes you four paragraphs, and then it forgets you exist. The gap isn't intelligence —
> the models are good enough. The gap is that nothing survives the conversation.
>
> This is TRADVICE. The conversation is the input. The output is a monitored object — it has
> levels, it has conditions, and something is watching it at three in the morning whether or
> not I'm here.

---

## 0:40 – 1:45 — Axl: one door

**SCREEN:** Click the Axl bot mark in the header. Type: *"what's worth my attention today?"*
Let the brief stream. Then type something that routes — *"I want to trade oil"* — and let Axl
hand off to Mentor. Stop before the desk does work.

> There are six desks in here — scanning, trading, portfolio, research, strategy — and the
> user should never have to know which one they need. So there's a reception. Axl.
>
> Axl doesn't trade. It reads your book, it knows what desks exist, and it decides where you
> belong. Watch — I say "I want to trade oil" and it doesn't answer me, it *opens the trading
> desk* and carries my own sentence in as the first message.
>
> That's a small thing that matters commercially: the surface area a new user has to learn is
> one text box.

**If the routing take is flaky:** show the market brief instead and say the routing line over
a pre-recorded clip.

---

## 1:45 – 4:15 — The pipeline: scan → build → supervise

This is the heart. Give it the time.

### Argus (the scanner) — ~40s
**SCREEN:** Scanner panel with a completed scan. Open one candidate's scorecard.

> First desk: the scanner. It works a universe against a thesis and scores every name on the
> same scale, and — this is the part that matters — it shows its work. Every score has the
> data that produced it attached. If a number came from a stale quote, it says stale.
>
> I'm not asking anyone to trust a black box. I'm asking them to audit it.

### Mentor (the trading desk) — ~70s
**SCREEN:** Hand a candidate to Mentor. Let it build. Show the **ZoneEditor / ScenarioBlock**
and the **ConditionList**.

> Second desk: Mentor. Not an oracle — a trader who works on what I brought. It pushes back.
> If I can't tell it where I'm wrong, it won't build.
>
> And look at the shape of what comes out. Not one entry — *scenarios*. Rivals. If it breaks
> up, here's the plan; if it flushes first, here's the other plan. They're alternatives, so
> the size is never double-counted.
>
> Then the conditions. These are written in plain English — "hold above the level on a
> four-hour close, with volume." There is no dropdown of thirty condition types, and that's
> deliberate: a menu can only ever narrow what you're allowed to check. The sentence stays a
> sentence, and the monitor is smart enough to read it.

### The confirm gate — ~25s
**SCREEN:** Press to arm/confirm. Show the confirm dialog with entry / stop / target / risk /
R:R and per-account quantity.

> Nothing reaches a broker without this. Entry, stop, target, the actual dollar risk, the
> ratio, the size per account. The agent proposes. The human commits. Every time.

### Talos (the monitor) — ~45s
**SCREEN:** Open the triggered setup. Scroll its assessment history.

> Now the part nobody else does. The conversation is over — and this thing is still alive.
>
> Talos wakes up on its own schedule, pulls fresh data, re-reads those English conditions and
> writes down what it decided and why. This is a log of a supervisor doing its job overnight.
> And once a fact is settled it's never re-litigated — it doesn't burn tokens asking the same
> question every hour.

---

## 4:15 – 5:30 — It manages, not just watches

**SCREEN:** An in-position item. Show the management assessment, the TP window, and a
notification card with actions on it.

> A trade isn't done when it fills — that's when the real work starts, and it's the work
> retail traders reliably get wrong. They sit through the giveback.
>
> So Talos keeps going after entry. It watches the position, it watches the target window,
> and when something changes it doesn't just tell me — it comes back with a *decision to
> make*. Accept, edit, or ignore, right there on the card.
>
> That's the difference between an alert and an assistant.

---

## 5:30 – 6:45 — Three books, one machine

**SCREEN:** Use the mode switcher: `live` → `paper` → `manual`. Let the book visibly change.
Then open the queued action and the QueuedActionDialog.

> Three workspaces. Live is real money at a connected broker. Paper is simulated — same
> engine, same monitors, fake fills. Manual is real money somewhere we can't reach, your
> bank, your pension account: we build it, we watch it, we tell you when to act, you place it
> and confirm the fill.
>
> Manual is the one investors should look at twice. It means the product works for people
> whose money we will never touch — which is most people, and it's a distribution story, not
> a feature.
>
> One rule underneath all of it: **nothing fires while the venue is shut.** Not even paper. If
> a condition triggers at 2am, the order is *queued* — not fired into a dead market, and not
> silently dropped. It's waiting here when the bell rings.

---

## 6:45 – 8:00 — The rest of the institute

Move fast — these are proof of breadth, not deep dives. ~25 seconds each.

**SCREEN:** Atlas portfolio panel → Prometheus coverage → Pythia tilt.

> Trading one name is one desk. Here's the rest.
>
> Atlas builds and reviews portfolios — it doesn't screen, it allocates, and it'll tell you
> when your book has drifted from the mandate you gave it.
>
> Prometheus is the research desk. It maintains a living thesis on a name with our own price
> target — and the number that actually matters is the gap between ours and the Street's.
>
> And Pythia is the house view. One top-down call, published to everyone, with a track record
> it isn't allowed to delete. A desk that can erase its own bad calls doesn't have a record.

---

## 8:00 – 9:00 — Why this is hard to copy

**SCREEN:** Positions rail with accounts expanded; optionally the Radar calendar.

> Quick word on what's underneath, because the demo makes it look easier than it is.
>
> Every broker sits behind one adapter with capability flags, so the desks don't know or care
> who's executing. There's a reconciler that treats the broker as the only truth — if the app
> and the broker disagree, the app is wrong, always.
>
> And the agents are separated on purpose: they share *data* freely and they never share
> *judgment*. The scanner's opinion doesn't leak into the portfolio's. That sounds academic
> until you've watched a single super-agent talk itself into a position across six turns.
>
> The moat isn't the model. Anyone can call the same model I do. The moat is eleven
> background loops, the queue, the reconciler, and the shape of what the conversation
> produces.

---

## 9:00 – 10:00 — Close

**SCREEN:** Back to the Floor. Full app, populated, quiet.

> So: six desks, three books, real brokers, and work that keeps running after you close the
> laptop.
>
> What's next is [**your roadmap — 2–3 items, e.g. second broker, mobile companion, the
> premium autonomous mode**], and what we're raising is [**the ask**].
>
> Thanks for watching.

---

## Timing sheet

| | segment | run |
|---|---|---|
| 0:00 | cold open | 0:40 |
| 0:40 | Axl reception | 1:05 |
| 1:45 | Argus → Mentor → confirm → Talos | 2:30 |
| 4:15 | in-position management | 1:15 |
| 5:30 | workspaces + off-hours queue | 1:15 |
| 6:45 | Atlas / Prometheus / Pythia | 1:15 |
| 8:00 | architecture + moat | 1:00 |
| 9:00 | close | 1:00 |

**Overrun plan.** Cut in this order: Pythia → Prometheus → the Axl brief. Never cut the
Mentor build, the confirm dialog, or Talos — those three are the product.

## Recording notes

- 1080p minimum, browser at ~1440px wide, zoom so text is legible on a phone.
- Hide bookmarks, notifications, and any second monitor.
- Move the mouse deliberately and **pause a full beat** after each click before speaking —
  cuts are easier and it reads as confidence.
- Record voiceover separately if you can. Live narration while clicking always sounds rushed.
- Have a still of the confirm dialog and one of the Talos history as safety frames.
