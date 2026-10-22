# The Floor's stage — the chat on the left, everything else on the right

Status: decided and in build, 2026-10-22 (Roy). Frontend only, plus Axl's `<show>` kinds for the lists.

## How we got here (the same evening)

1. **Every list in the detail window** (Roy: "in floor lists — I want all of them presented in the detail window
   over the chat box, not in the right column"). Built first as a window *over* the chat.
2. **No side columns** ("if I present everything in the detail window, including positions, I don't need the
   columns"): positions and lists left their columns; a strip of list chips went under the chat header.
3. **Seen in the UI, the plan changed**: the chat column splits in two — **the chat on the left, a STAGE on the
   right** — and the stage is where a list, a list's item, a desk's working surface and a chart appear.

## The stage

The right half of the chat column (**50/50 for now**). It shows ONE thing at a time, from three channels:

| Channel | What it holds | Opened by |
|---|---|---|
| **panel** | a list (Positions, Awaiting orders, Your trades, Your portfolios, Watchlists, Hotlist, Calendar, Forecasts, the Forecast board, the admin's Research queue) — and an item opened from it, over it | the strip; Axl's `<show>`; a card |
| **surface** | a desk's working surface — Mentor, Atlas, Argus, Prometheus; Pythia, Aether and the order ticket for an admin (the old side pane, with its tabs) | the floor moving to a desk; a doorway |
| **chart** | the one live chart (`chartSurface.service`) | an agent's `<chart>`; a chart button; a ticker |

**A stack by recency** (Roy): whatever opened last covers the stage; closing it shows what was under it.

    list → open an item      → the item covers the list            ✕ → back to the list
         → talk to Mentor    → Mentor's surface covers the item    ✕ → back to the item
         → ask for a chart   → the chart covers Mentor             ✕ → back to Mentor

Opening a *different* list replaces the list (lists do not pile up). With nothing open the stage shows a
placeholder — **what the default is, Roy decides later**.

## Rules

- **Each layer has a thin bar** — a short label and ✕ (the list's own controls beside it, e.g. the Hotlist's view
  switch). No "LISTS" kicker and no count over a list (Roy: "when a list is open, no need for the header above the
  list with the count") — the strip's chip carries the count.
- **The strip stays under the chat header**, on the chat side, always in reach. A chip opens its list on the stage
  and is marked while that list is open.
- **Nothing unmounts while covered.** A covered layer is hidden, not removed: a list renders its items' panels, a
  desk's surface holds half-typed work, the chart holds its zoom.
- **Axl opens the same layers** — `<show>positions|orders|trades|portfolios|watchlists|hotlist|calendar|heatmap`
  (routing.util `SHOW_LISTS`), and says what is in the list in a line or two (`get_watched_items`,
  `get_hotlist`).
- **A hand-off keeps the list under the desk.** Build with Mentor / Ask Argus from the Hotlist, a calendar row to
  Mentor, a coverage edit, any desk doorway: on the stage the desk's surface COVERS the list (closing it comes back
  to the list); only where a panel covers the chat (another design, a phone) does the hand-off close it first
  (`stage.store` `closeForHandOff`).
- **Esc closes the layer on screen** — a covered panel or pane stands aside (DrawerShell `covered`); the chart on top
  closes on Esc too.
- **A covered chart stops polling** (its element has no boxes while its layer is hidden) and picks up on the next tick
  when it comes back, zoom intact — the FMP key is shared and at its limit in session.
- **A whole list takes the stage's width** (`detail-panel--list`); an item keeps the 72ch reading measure.
- **Handheld unchanged**: a list or item is a full-screen page, a surface a bottom sheet, as before.

## Built on

- `detailPanel.store` — one open panel; a CONTAINER (a whole list) is kept under an item opened from it, and
  closing the item steps back to it.
- `sidePane.store` — the surface channel, unchanged (tabs, pin, follow the floor).
- `chartSurface.service` — the chart channel; the chat's bottom chart dock is off on the Floor (the stage shows it).
- `stage.store` (new) — only the ORDER of the three channels, by recency. The stage shows the most recent channel
  that holds something.
