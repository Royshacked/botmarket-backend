# The Assessed board's light list

**Status: PLAN, 2026-10-13. Decisions §4: both as recommended (Roy, 2026-10-13) — building now.** Open item 2 of [pythia-assessment.md](./pythia-assessment.md) §13
("A light assessment list", left for later on 2026-10-11). First of the "Next builds" in
[deploy-2026-10.md](../deploy-2026-10.md).

## 1. The problem, measured (axl_dev, 166 assessments, 2026-10-13)

`GET /api/strategy/assessments` sends every assessment whole, minus its revision trail:

| | Raw | Gzipped |
|---|---|---|
| The list today | 780 KB | 205 KB |
| The list with only what a closed row shows | 107 KB | 24 KB |
| One assessment, opened | median 4.6 KB, max 10.7 KB | — |

The weight is in what only the OPEN panel shows: `evidence` 219 KB, `moved` 86, `money` 76, `risks` 50,
`second_order` 45, `change_view_if` 44 (plus `flows`, `geopolitics`, `base_rates`, `structure`).

**Two things make it worse than one slow load:**
- **The poll.** While a week runs, the board re-reads the whole list once a minute (`useCalendarEvents`,
  `WEEK_POLL_MS`), for every user who has it open. The first prod week runs about an hour: ~60 full downloads each.
- **No compression.** Express has none; whether Render's proxy compresses is not verified.

**What is NOT known:** the time on prod. The ~9 s was the laptop, where the Mongo read crosses home internet to
Atlas. Render sits near Atlas, so the server side is probably fast there; the browser's download is not.

## 2. The design

**The list carries what a closed row shows; an opened row fetches the rest.**

### 2.1 Backend

- `industryAssessmentService.listAssessmentRows()`: the list with a projection. A closed row reads
  `id`, `subject`, `verdict`, `horizon`, `decides_by`, `thesis` (the row's one line), `cause.kind` (the "news not
  checked" chip), `moved.hype` (the hype chip), `expires_at` (stale), `assessed_at` (the detail cache key, §2.2).
- `GET /assessments?view=rows` returns those rows (still with `record`, still through `visibleAssessments`).
  **Without the parameter, the route keeps sending the full list**: an installed phone runs the old bundle until
  it reopens (PWA `autoUpdate`), and an old bundle given light rows would open empty panels. The full form can be
  retired a few weeks later, once no client asks for it (the request log shows it).
- Industry detail: `GET /assessments/:code` already exists (without the trail for a trader).
- **Theme detail is new:** `GET /assessments/theme/:id`, the theme's assessment without its trail, only while the
  theme is approved (the board's rule, `visibleAssessments`). Registered before `/assessments/:code`.

### 2.2 Frontend

- `strategyService.listAssessments()` asks for `?view=rows`.
- **The open row fetches its detail**: a small hook (`useAssessmentDetail(row)`) called inside the row's
  DetailPanel content, so the fetch starts when the panel opens.
  - Cached per `id` + `assessed_at`: reopening a row is free, and a re-assessment (a new `assessed_at` in the
    next poll) fetches the new detail.
  - While loading, the panel shows its header (name, verdict, horizon from the row) and the thesis, which the row
    already has, then the rest. A failed read says so in the panel with a retry, and never blanks the board.
- Nothing else reads the full list: the search (`groupByVerdict`) uses only `subject` and `verdict`, the
  summary bar only counts, Themes reads `GET /themes`. Atlas and Axl read the service, not this route.

### 2.3 Not in this build

- **Compression.** The list's own gzip is 24 KB after this, so it matters less. A global `compression()`
  middleware would also touch every SSE agent stream (it buffers unless each write flushes), which is a separate
  change with its own risk. Leave it; check whether Render compresses at its edge.
- **Polling less.** With a 107 KB list, a minute's poll during a running week is tolerable. Sending only what changed
  since the last poll (`?since=`) would cut it further; not needed yet.

## 3. Build order

1. **Only if building waits for a measurement (§4, decision 1):** after the first prod week (about 165
   assessments), the list's size and time in the browser's network tab, on a desktop and on a phone.
2. Backend: `listAssessmentRows`, `?view=rows`, the theme detail route. Tests: the rows carry every field a closed
   row reads and none of the heavy ones; theme visibility unchanged; the theme route hides a retired theme and the
   trail from a trader; the full form unchanged without the parameter.
3. Frontend: the list asks for rows; `useAssessmentDetail` in the panel. Tests: one fetch per open, cached on
   reopen, refetched after a new `assessed_at`, the header and thesis while loading, the error line with retry.
4. Drive in a browser: the board loads, a row and a theme row open, a reopen does not refetch (network tab), the
   phone page.
5. Bundle, docs (pythia-assessment.md open item 2, the Pythia desk doc, CODE_MAP), the deploy checklist.

Size: half a day. No migration, no environment variable.

## 4. Decisions for Roy

1. **Build now, or measure on prod first?** Recommended: build now. The poll during the first week downloads the full
   list every minute whatever prod's latency turns out to be, and the change is small and backward compatible.
2. **When to retire the full form** of the route. Recommended: leave it until a later deploy shows no client
   asking for it.
