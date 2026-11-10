# archive/

**Frozen code. Nothing here is imported, mounted, started, linted or tested.** It is kept whole so a
desk can come back as a decision rather than as an archaeology project.

## What is in here

**Kairos** (the `call` desk) and **Hermes** (its monitor) were archived here on 2026-08-18 and
**deleted on 2026-11-10** with their data (`scripts/delete-kairos.mjs`). `git log` before that date
has them. A new trade is always Mentor's.

**Minos** — the monitor for the legacy `idea` kind — was deleted outright earlier. Its one piece of
live behaviour was lifted out first, to `monitoring/preflightEntry.js`.

### The Hotlist's day columns (archived 2026-10-25)

| | |
|---|---|
| `services/dailyScreener.checkpoint.js` | the CHECKPOINT pass — 08:00 · 09:20 · 10:30 · 14:30 · 15:30 ET, the pool, the quotes, the grades, Argus's read per board |
| `services/hotlistBacktest.day.js`, `scripts/replay-hotlist-day.mjs` | the day replay (open · mid · eod · tomorrow over past sessions) |
| `services/hotlist.news.js` | the checkpoint pool's news labeller (a cheap model call per board) — moved after the code review: nothing live read it |
| `tests/dailyScreenerCheckpoint.test.js`, `argusPool.test.js`, `hotlistBacktestDay.test.js`, `hotlistCheckpoint.test.js`, `hotlistNews.test.js` | their tests — the last gathered from the live suites, its `rig` fixture noted as left behind |

**Why:** the screener lab (`docs/design/screener-lab.md`) replayed them — every day column lost to the names it passed
over (30 sessions: open −0.74%, tomorrow −1.98%), and Argus, replayed blind on 48 weeks with the headlines and the chart,
picked no better than he avoided. Roy: archive the short-term part; This week rebuilt on the one rule that held, the
run-up (`services/hotlist.week.js`, overnight). Plan and record: `docs/design/hotlist-day-archive.md`.

**What stayed live, lifted out first:** the boards' indexes, `latestBoard`, `etDate`, `BOARD_STALE_MS`, `withNews` →
`services/hotlist.boards.js`. **What stayed live as it was:** `hotlist.columns.js` (pure; the week replay and the lab use
its week rule and free range), `hotlist.argus.js` (the lab's Argus replay calls `argusRead`), `hotlist.outcomes.js`
(scores the boards still in Mongo — the day boards age out in 10 days, their outcomes in 168 — and the week board), and
the frontend's day views, shown only on a past day that still has day names. Reviving: put the checkpoint back in the
monitor's tick (`monitoring/dailyScreener.monitor.service.js`, its `checkpoint` dep, and the week hand-off's board id in
`hotlistResearch.service.js`), its import in `server.js` if its indexes move back.

### Argus's list-building chat and the scan list (archived 2026-11-09)

| | |
|---|---|
| `api/scanner/` | the `scan` HTTP surface — routes (`/api/scanner/scans` CRUD), controller, `scan.service.js` (the `scans` collection, staleness) |
| `services/desks/actions/scanner.actions.js` | Generate / Update / Later on a list, the Prometheus read applied to it (`applyRead`), the lens and `fresh` edits |
| `services/agents/scanner.agent.service.js`, `services/desks/scanner.desk.js`, `services/desks/scannerMode.js` | **SNAPSHOTS** of the desk as it was — all three profiles/modes, the `<scan_list>` capture, `_normalizeScan`, the server-side scoring, edit mode, the radar board. The live files of the same name are the slimmed hand-off-only desk |
| `services/aetherScanUniverse.service.js`, `services/aetherBatchRead.service.js`, `api/aether/aether.scan.controller.js` | the radar cut: the board handed to Argus (`GET /api/aether/scan-universe`) and Prometheus's read over the cut (`POST /api/aether/batch-read`) |
| `prompts/scanner_profile_investing.md`, `scanner_mode_radar.md` | the investing profile and the radar mode. `scanner_system_prompt.md` and `scanner_mode_handoff.md` are copies — both are still live |
| `tests/` | the tests of all of the above (`scanStale`, `aetherBatchRead`, `aetherScanUniverse`, `sessionPhase8Argus`, `scannerRadarMode`, `scannerProfiles`, and the archived cases of the mixed files) |

**Why:** Roy — archive Argus's chat for building scan lists, and the list. The Aether board's "Scan with Argus" went with
it (Roy's call, the same day). **What stayed live:** Argus as **Mentor's single-pick helper** — Mentor sends a user with no
name to Argus, he finds ONE and emits `<argus_pick>` (named `<kairos_pick>` until 2026-11-10), the chain carries it back (`services/chain/rules.js` `emitted`).
That is now the desk's only mode (`scannerMode()` returns it unconditionally), and only Mentor may route there
(`registry.js` `routedFrom: ['mentor']`, gated in `routing.util.js` `mayRoute` — the capture drops Axl's `<route>scan`
and the route rule leaves Argus off every other desk's prompt). Argus the HOUSE agent never was this desk and is
untouched: the house scan (`houseScan.argus.js`), the Hotlist's reads (`hotlist.argus.js`), Book timing, and Atlas's
sleeve screen (`sleeveSource.service.js`, code shown as Argus's line in the chat).

**What went with it, outside these files:** the chain's "Argus has a list" decision and its *Research the top N* choice
(`rules.js` `decisionFor` / `researchQueueFrom`, `runner.js` `research` — the `next` queue walk stays, dormant: nothing
builds a queue now); `scan` as an editable entity kind (`<edit>scan`), `<show>watchlists`, `scan` in
`get_watched_items`; the `radarBoard` turn input; Axl's `<route>scan`. **The data stays:** every `scans` document is in
Mongo untouched, unread. `KINDS.SCAN` (vocabulary) and the `scan` watch-row projector still describe it.

**Reviving:** move `api/scanner/` back and remount it in `server.js`; restore the snapshot desk/agent/mode over the live
slim ones (they are a superset — the hand-off path is identical); put `scan` back as the scanner's `entityKind` with
`editable: true` and drop `routedFrom`; restore the chain's list decision and `research` choice (`git log -- services/chain`),
`<show>watchlists`, `scan` in `DEFAULT_KINDS` and the tool enum, the two aether routes; and the frontend's half (its own
`archive/README.md`).

## Drift: what "kept whole" costs, and how it is checked

The archive imports symbols from the LIVE tree. Nothing lints it and `npm test` skips it, so a
dead-code sweep that deletes an export no LIVE caller reaches breaks the archive silently — and the
sentence above, that the imports "resolve as they stand", quietly stops being true. It had already
stopped being true twice before anyone looked (2026-09-15).

**`npm run check:archive`** imports every file in here and fails on the first that cannot resolve.
Run it after any sweep that removes an export. It checks IMPORTS only.

### What was deleted rather than repointed

`archive/tests/unit/` held three Aether tests (`aetherExposure`, `aetherShockFeed`,
`aetherShockPredictions`) stranded here by `c6e6fa8`, which retired eleven Aether tools. Every
symbol they imported was deleted on purpose and the engine they covered was rebuilt in the Python
repo — no desk revives through them, so they were not a revival path, only a permanently red suite
sitting in the archive's test folder. `git log` has them.
