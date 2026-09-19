# Roles — what a trader gets, what an admin gets, and how an empty sleeve is filled

Decided desk by desk on 2026-09-14. Two roles, `trader` (the default) and `admin` (`users.role`,
minted into the JWT at sign-in; `scripts/promote-admin.js <username>` promotes; the promoted user
signs out and back in). Admins today: `roy_shacked`, `marce`.

## The matrix

| Desk | Trader | Admin |
|---|---|---|
| **Pythia** (strategy) | nothing — chat, tilt log, the Forecasts board and the social feed are all closed | everything |
| **Prometheus** (analyst) | chat and research; reads every coverage; runs Argus's "Research" hand-off and sees the draft | + initiate / revise / retire / delete coverage, the research queue and its headless run, the monitor's feed |
| **Atlas** (portfolio) | the full build; an empty sleeve is sourced for them on the server (below) | same, + the `<coverage_refresh>` hop (it rewrites house coverage) |
| **Argus** (scanner) | same as admin — scans are owner-scoped, no admin side | same |
| **Mentor** (setups, Talos) | same as admin | same |
| **Axl** (reception) | knows four desks; shows the house forecast; never routes to Pythia or Aether | knows every desk |
| **Aether** | reads the candidate list | + the chat and discovery |

What is NOT role-scoped, on purpose: **the house artifacts are read by everyone.** Every coverage
document, and the house sector view — Atlas reads the tilt in-process when it builds, Axl shows it
on request (`get_sector_view`). A trader cannot *author* either; they build from both.

## Where the gate is

The server owns every gate; the client hides what the server refuses, as a courtesy.

| Layer | Mechanism |
|---|---|
| Routes | `requireAdmin` (`middleware/auth.middleware.js`) — router-wide on `/api/strategy`, on the writes + queue under `/api/analyst`, on `/api/aether/stream` + discovery. `tests/unit/adminGate.test.js` pins it, and pins that scanner/mentor/setups routes are **never** gated |
| Social chat | `ADMIN_BOT_IDS = ['strategy', 'analyst']` (`api/chat/chat.service.js`, mirrored in the frontend `agentMeta.jsx`). The notifiers narrow delivery to `listAdminUserIds` and stamp `visibility: 'admin'`; `visibleConversationsFor(convs, role)` hides the threads from a non-admin on list AND on read-by-id, so a demoted admin cannot read the house desk through a thread they still own |
| Axl | `buildRoleSection(isAdmin)` in the prompt tail tells Axl who it has; `routeFor(role, route)` (`routing.util.js`, the shared routing tier every desk's controller applies) drops an admin desk for a non-admin whatever the model emitted. The desks' own route rule (`buildRouteRule`) never lists Pythia or Aether at all |
| Atlas | `<coverage_refresh>` runs only for `req.user.role === 'admin'` (`portfolio.controller.js`); a trader's ask is logged and Atlas reads the standing coverage |
| Client | `DESKS[].adminOnly` (hub cards), `FloorLists` desks (`Forecasts`, `Research queue`), the Radar's Forecasts card, `CoverageActions`, the "Initiate coverage" button, `useCalendarEvents` (no tilt fetch for traders) |

## The autonomous sleeve hop — Atlas → Argus → Prometheus → Atlas

Atlas builds a book from house coverage and nothing else (the Phase 4 hard rule in
`prompts/portfolio_system_prompt.md`). When a sleeve's filter — sector + the mandate's selection
school — finds the pool empty, Atlas emits one `<screen_request>` per empty sleeve and ends the
turn. Before this it stopped and sent the user to the research queue; the older interactive hop
drew a "send to Argus" button and a three-desk walk a trader (who cannot write coverage) could not
finish.

```
Atlas turn: get_coverage(sector, school) → empty
   └─ emits <screen_request>{ sector, lens, industry?, note? }   (portfolio.controller, any role)
        │
        ▼  services/sleeveSource.service.js   (fire-and-forget; the reply is already out)
   1. SCREEN   the sector with the FMP screener under the school's pond (SCHOOL_SCREEN — cap floors,
               a dividend for `income`; `passive` never screens; 12 names). The school filter is a
               PROXY: FMP has no valuation/quality predicate — Prometheus applies the real bar.
   2. DROP     names already in coverage. Every hit covered → the card goes out at once.
   3. QUEUE    the rest as `research_queue` rows, source 'argus', context { sector, school, sleeve }
   4. RUN      researchRun.startRun AS THE HOUSE (userId null). A run already going is waited for.
   5. SETTLE   on `onRunSettled`: absorb outcomes; every name decided → post the requester an Atlas
               card `sleeve_sourced` ("Resume build"); names still queued after a `done` run → start
               the next; an admin-STOPPED or failed run is not restarted from here.
        │
        ▼  client: SleeveSourcedBubble → RESUME_BUILD → the construction thread (threadId) or the
           book's edit (portfolioId). Atlas resumes and reads the coverage the run wrote.
```

**Why the research runs as the house.** The run bills LLM usage to its `userId`, and a user past
their monthly ceiling is degraded to the cheap model (`agentUtils.resolveAgentStream`). Coverage
is a house artifact every book builds from: it must not be researched on the cheap model because
the asker was over budget, and an hour of Prometheus is the house's spend, not the price of asking
Atlas a question. The coverage monitor's scheduled re-model goes one step further — it runs with
NO user at all (`userId: null`): no venue, no audience level, no ceiling, and — a known gap — no
spend booked to anyone, because usage is recorded per user and there is no house row yet.

**What a trader's `<coverage_request>` still does:** queues the one named ticker (`source: manual`)
for the next run — no card. Sourcing a whole sleeve is `<screen_request>`; the prompt says which is
which.

**Known limits.** Pending sleeves live in process memory like the run itself: a restart loses the
*card*, not the work (the rows stay queued; the next run researches them). The house scan
(`houseScan.service.js`, on tilt publish) uses the same screener with its own inline call — two
callers of one mechanism, worth folding onto `screenFiltersFor` when houseScan is next touched.
