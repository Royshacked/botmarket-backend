# archive/

**Frozen code. Nothing here is imported, mounted, started, linted or tested.** It is kept whole so a
desk can come back as a decision rather than as an archaeology project.

Archived 2026-08-18.

## What is in here

| | |
|---|---|
| `api/kairos/` | the `call` HTTP surface — routes, controller, service |
| `services/agents/kairos.agent.service.js` | the Kairos desk |
| `services/kairos.handoff.service.js` | confirm/edit hand-off, used only by the Kairos controller |
| `monitoring/hermes.monitor.service.js`, `hermes.assess.js` | Hermes, the monitor that watched `call` |
| `services/kairosNotify.service.js` | the four `call` social-chat cards (ready / expiry / manage / re-entry) — moved 2026-09-15, a month after their last caller came here |
| `prompts/kairos_*.md` | the system prompt and the three mode profiles |
| `tests/` | their unit tests, moved out of `tests/unit/` so `npm test` no longer runs them |

**Kairos** authored a timed `call` on one asset; **Hermes** watched it. Mentor took the trading over
(`docs/desks/trade-pipeline.md`) and Kairos returns later as a PREMIUM Mentor mode. Nothing was
deleted, because none of it was wrong — it was superseded.

**Minos** — the monitor for the legacy `idea` kind — is NOT here. It was deleted outright, because
unlike these two it had already been proven redundant: it watched a kind nothing authors and its
tick was picking up `setup` entities belonging to Talos. `git log` is where it lives now. Its one
piece of live behaviour was lifted out first, to `monitoring/preflightEntry.js`.

## Why it was safe to archive

Checked against production before the move: exactly **one** `kind: 'call'` document existed, at
status `expired`, with **zero** in-position or awaiting-confirm. Nothing was being monitored, so
nothing went dark. Re-run that count before assuming it is still true.

## What did NOT come with it

Three things carried Kairos's name but were never Kairos's, and stayed behind under better ones.
Reviving the desk means importing these, not resurrecting copies:

| Was | Is now | Why it stayed |
|---|---|---|
| `services/tools/kairos.tools.js` | `services/tools/trading.tools.js` | **Mentor's live tool kit.** Mentor imports it whole; it was named after the desk that defined it first |
| `services/kairos.modes.js` | `services/analysisModes.js` | Argus stamps a `recommended_mode` on hand-off and Mentor reads `DEFAULT_MODE`. A lens is a way of reading a chart, not one desk's property |
| `_allText`, `_formatEventRisk` (in `hermes.assess.js`) | `monitoring/assess.shared.js` | Talos imported both. Leaving them would have made the live monitor import an archived file |

`TRADING_TOOLS_FOR_MODE` has no live caller — subsetting tools by lens was Kairos's judgment, and
Mentor deliberately takes the kit un-subsetted. It is kept for the same reason as everything here.

## Reviving

The moved files' relative imports were **recomputed for their new depth**, so they resolve as they
stand, and `npm run check:archive` is what keeps that true (see **Drift** below). To bring Kairos back:

1. Move the files back to their original paths (`git log --follow` has them) and re-run the import
   fix in reverse, or simply import from `archive/` in place.
2. In `server.js`: restore the `kairosRoutes` mount, `ensureKairosIndexes()`, and
   `startLoop('hermes', hermesService)` — and add `'kairos'` back to the `agentLimiter` desk list,
   or its `/stream` endpoint is the one desk with no cost ceiling.
3. Restore `call` to `EDIT_KINDS` (`api/axl/axl.controller.js`) and `EDIT_KIND_DESKS`
   (`services/agents/axl.agent.service.js`), and put the `<edit>call` paragraph back in
   `prompts/axl_system_prompt.md` — `axlRoute.test.js` fails if the prompt and the gate disagree.
4. Restore `'call'` to `DEFAULT_KINDS` / `WORKSPACE_SCOPED_KINDS` and the `calls` source in
   `services/watchlist.service.js`, and the call record in `services/performance.service.js`.
5. Set `OWNER_BY_KIND[KINDS.CALL]` back to `'hermes'` in `services/entity/envelope.js`.
6. Move `tests/` back into `tests/unit/` and drop `archive/**` from the eslint ignores.

`KINDS.CALL` itself was deliberately **left in place** in `services/entity/vocabulary.js` and
`envelope.js`. The vocabulary describes the DATA, and a `call` document still exists in Mongo;
removing the kind would make it unreadable rather than merely unauthored.

## Drift: what "kept whole" costs, and how it is checked

The archive imports ~40 symbols from the LIVE tree. Nothing lints it and `npm test` skips it, so a
dead-code sweep that deletes an export no LIVE caller reaches breaks the archive silently — and the
sentence above, that the imports "resolve as they stand", quietly stops being true. It had already
stopped being true twice before anyone looked (2026-09-15).

**`npm run check:archive`** imports every file in here and fails on the first that cannot resolve.
Run it after any sweep that removes an export. It checks IMPORTS only.

Repointed on 2026-09-15, when the check was written:

| Was | Is now | Why it moved |
|---|---|---|
| `vocabulary.PAST_ENTRY_LEGACY` | `vocabulary.PAST_ENTRY` | the two were already identical; the alias was dropped as dead |
| `readinessGates.gradedGap` | a local copy in `hermes.monitor.service.js` | Hermes was its last caller, so it came here with the desk |
| `tradeNotify.notifyCall*` | `archive/services/kairosNotify.service.js` | the four `call` cards moved into the archive a month after their caller |
| `monitorJournal.zonesLabel` | `monitorJournal.levelsLabel`, aliased at the import | renamed upstream when zero-width levels replaced bands |
| `positionManage.manageAppliedUpdate` | `positionManage.manageApplied` → `{ update, journal }` (2026-09-19) | the accepted-action line moved from `monitor_state.timeline` to the journal collection; a revived Kairos hand-off passes `update` to its write and `journal` to the repo's seam |

### Known behavioural drift — a revival TODO, not a broken import

`journalEntry` no longer has a `'scheduled'` branch: the live monitors split that wake into
`'guard_time'` and `'backstop'` when Talos guards landed. Hermes still passes `'scheduled'`, which
now falls through to the generic branch — so a revived Hermes writes a verdict-fallback note on its
heartbeat instead of the "price, levels and gap" line, and `hermesMonitor.test.js` fails on exactly
that one assertion. Left as-is deliberately: `reason` is PERSISTED on every journal entry, so
renaming it is a data decision for whoever revives the desk, not a refactor.

### What was deleted rather than repointed

`archive/tests/unit/` held three Aether tests (`aetherExposure`, `aetherShockFeed`,
`aetherShockPredictions`) stranded here by `c6e6fa8`, which retired eleven Aether tools. Every
symbol they imported was deleted on purpose and the engine they covered was rebuilt in the Python
repo — no desk revives through them, so they were not a revival path, only a permanently red suite
sitting in the archive's test folder. `git log` has them.
