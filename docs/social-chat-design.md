# Social Chat — Design Note

> **Status: DESIGN ONLY — nothing built yet.** Captured 2026-06-26 from a design discussion. Proposal to resume from, not current architecture.

## Vision

A real-time chat layer connecting users and the platform bot. Users can message each other, share trading ideas, scans, and portfolios. The bot acts as a personal assistant — one unified thread per user — surfacing portfolio review notifications, position alerts, pre-entry signals, and any future proactive intelligence. Everything lands in one place, like a personal broker in your pocket.

**Phase 1 (build now):** WebSocket-based DMs between users + bot. Plain text messages. WhatsApp-web layout in the UI. Bot thread pre-seeded for every user.

**Phase 2 (future):** Rich message cards (share ideas, scans, portfolios). Action cards (confirm / discuss directly from chat). Group channels. Approval gate for user-to-user messaging.

---

## Locked decisions

1. **Transport: WebSockets.** Real-time push. User connects → authenticates via JWT → subscribes to their inbox. Offline messages are queued in MongoDB and flushed on reconnect.

2. **DMs first.** User-to-user direct messages only for Phase 1. Groups are a future addition. An approval gate (user must accept before another can message them) is also future — not in Phase 1.

3. **Bot as a special user.** The bot has a fixed system userId (`ar2trade_bot`) seeded at startup. It appears in every user's conversation list. When the server wants to notify a user, it writes a message as `ar2trade_bot` and emits a WS push. The user replies in the same thread. No special infrastructure — user-to-bot and user-to-user are handled identically by the chat layer.

4. **One bot thread per user.** The bot is a personal assistant that handles portfolios, positions, pre-entry alerts, and anything else the platform needs to surface. One thread keeps the relationship clean as the bot's scope grows. Rich cards (future) keep the thread navigable even with high message volume.

5. **Message types: text now, cards later.** Schema supports `type` and `payload` from day one — only the renderer changes when cards are added.

---

## Data model

### `conversations` collection
```js
{
  id:            string,           // 'conv_<timestamp>'
  participants:  [userId, userId], // always exactly 2 for DMs; one can be 'ar2trade_bot'
  createdAt:     epoch ms,
  lastMessageAt: epoch ms,
  lastMessage:   string,           // preview text for the conversation list
}
```

### `messages` collection
```js
{
  id:             string,          // 'msg_<timestamp>'
  conversationId: string,
  senderId:       string,          // userId or 'ar2trade_bot'
  content:        string,          // plain text for now
  type:           'text',          // 'text' | 'invalidation_alert' | 'portfolio_review' | …cards (future)
  payload:        null,            // e.g. invalidation_alert: { ideaId, asset, status, edge, level, inPosition, … }
  createdAt:      epoch ms,
  readAt:         epoch ms | null, // null = unread
  dismissed:      boolean,         // (as-built) actionable alert bubble acknowledged; renders collapsed, no re-prompt
}
```

### Indexes
- `conversations`: `{ participants: 1 }` — find all convs for a user
- `messages`: `{ conversationId: 1, createdAt: -1 }` — paginate messages in a conversation
- `messages`: `{ conversationId: 1, readAt: 1 }` — unread count per conversation

### Bot seeding
On user signup, one conversation is created between `userId` and `ar2trade_bot`, and an initial welcome message is written from the bot. This conversation always exists — never created on demand.

---

## WebSocket architecture

### Server side
A single WS endpoint (`/ws/chat`) authenticated by JWT query param on upgrade. On connect:
1. Verify JWT → extract `userId`
2. Register the socket in an in-memory map: `{ userId → socket }`
3. Flush any undelivered messages (messages where `recipientId = userId` and `deliveredAt = null`) — or simply re-fetch unread counts on connect and let the client pull message content via REST

On disconnect: remove from the map.

**Sending a message (user or bot):**
1. Write message to `messages` collection
2. Update `conversations.lastMessageAt` and `conversations.lastMessage`
3. Look up recipient's socket in the map
4. If connected: emit `{ event: 'new_message', data: message }` directly
5. If offline: message sits in DB; client fetches on next connect

**Bot writing a message:**
The bot is not a connected socket — it writes from the server side. A `sendBotMessage(userId, content, type, payload)` helper writes to DB and emits to the user's socket if connected. This is the single function all platform features call when they want to notify a user.

### Client side
On app load: open WS connection. Listen for `new_message` events. On receive:
- If the event's `conversationId` matches the open conversation → append to chat
- Otherwise → increment the unread badge on the conversation list entry and on the header nav icon

---

## Message types (now vs future)

| Type | Now | Future |
|---|---|---|
| `text` | Plain string between users or bot | — |
| `portfolio_card` | — | Shareable portfolio summary card; recipient can view or copy |
| `idea_card` | — | Single trade idea card with direction, entry, stops |
| `scan_card` | — | Scanner result card |
| `action_card` | — | Bot notification with CTA buttons (e.g. "Confirm" / "Review in chat") |

`action_card` is the key type for Phase 2 portfolio managing: the bot sends a proposed action with two buttons — quick confirm (places orders via `OrderConfirmDialog`) or "Discuss" (opens portfolio chat in update mode).

---

## UI layout

WhatsApp-web pattern:

```
┌─────────────────────────────────────────────────────────┐
│  Header:  [Logo]  [Nav items]  [Chat icon 🔴3]  [Profile] │
└─────────────────────────────────────────────────────────┘

Clicking the chat icon opens a panel (or dedicated page):

┌──────────────────┬──────────────────────────────────────┐
│  Conversations   │  Active conversation                  │
│  ─────────────  │  ───────────────────────────────────  │
│  🤖 ar2trade    │  🤖 ar2trade bot                       │
│     "Time to r…" │                                        │
│     🔴 2 new    │  [message bubbles]                     │
│                  │                                        │
│  👤 User A       │  [input box]          [Send]          │
│     "Hey, check…"│                                        │
│                  │                                        │
└──────────────────┴──────────────────────────────────────┘
```

- Header chat icon shows total unread count across all conversations
- Conversation list: avatar + name + last message preview + unread dot/count
- Bot conversation always pinned to top
- Active chat: message bubbles, timestamps, sent/read indicators
- Input: plain text for now; future attachment button for sharing ideas/scans/portfolios

---

## API surface

### REST (initial load + history)
| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/chat/conversations` | List all conversations for the user with unread counts |
| `GET` | `/api/chat/conversations/:id/messages?before=<cursor>&limit=50` | Paginated message history |
| `POST` | `/api/chat/conversations/:id/messages` | Send a message (also emits WS push) |
| `POST` | `/api/chat/conversations/:id/read` | Mark all messages in conv as read |
| `POST` | `/api/chat/conversations/:id/messages/:msgId/dismiss` | (as-built) persist an alert bubble's `dismissed` flag |
| `GET` | `/api/chat/users/search?q=` | Search users to start a new DM |

### WebSocket events
| Direction | Event | Payload |
|---|---|---|
| Server → Client | `new_message` | Full message object |
| Server → Client | `message_read` | `{ conversationId, readAt }` |
| Client → Server | `ping` | keepalive |

Sending messages goes through REST (not WS) — simpler error handling, guaranteed persistence before delivery.

---

## Bot integration points (known so far)

| Trigger | What the bot sends |
|---|---|
| `nextReviewAt <= now` (monthly) | "Time to review [Portfolio Name]. Here's how it's performing: [summary]. Open review →" |
| Position down X% from entry | "⚠ [Asset] is down X% since entry. Thesis still valid?" |
| Upcoming earnings in < 5 days | "📅 [Asset] reports in N days. Consider sizing or exiting before the print." |
| Phase 2: proactive rebalance proposal | Action card with "Confirm trim" / "Discuss" buttons |

All routed through the single `sendBotMessage(userId, content, type, payload)` helper.

---

## Locked decisions (continued)

6. **WS server attaches to Express.** Same process, one port. `server.on('upgrade', handler)` pattern — no separate WS process, no inter-process comms.

7. **Unread delivery on reconnect: REST re-fetch.** On WS connect the client calls `GET /api/chat/conversations` and re-renders the conversation list. No message flushing over WS on connect — avoids duplicate-message bugs and keeps the WS channel as push-only.

8. **Message pagination cursor: `createdAt` timestamp.** `?before=<epoch>&limit=50`. Stable under concurrent inserts, no offset drift.

---

## Phase 1 — Concrete implementation plan

### 1-A. Data layer + `sendBotMessage`

New file: **`api/chat/chat.service.js`**

Collections: `chat_conversations`, `chat_messages` (prefixed to avoid collision with any future general `messages` collection).

**Indexes** (created once on service init via `createIndexes`):
```js
chat_conversations: [
  { participants: 1 },                          // find all convs for a user
  { participants: 1, lastMessageAt: -1 },       // sorted list
]
chat_messages: [
  { conversationId: 1, createdAt: -1 },         // paginate history
  { conversationId: 1, readAt: 1 },             // unread count
]
```

**Exported functions:**
- `getOrCreateConversation(userIdA, userIdB)` → finds existing conv between two participants or creates one. Used for DMs and bot seeding.
- `sendMessage(conversationId, senderId, content, type = 'text', payload = null)` → writes to `chat_messages`, updates `chat_conversations.lastMessageAt` + `lastMessage`, returns the saved message object.
- `sendBotMessage(userId, content, type = 'text', payload = null)` → calls `getOrCreateConversation(userId, 'ar2trade_bot')` then `sendMessage`. This is the single function all platform features call to notify a user. After writing, it calls `chatWs.emit(userId, 'new_message', message)` to push if the user is connected.
- `getConversations(userId)` → returns all conversations with unread count per conv (aggregation over `chat_messages` where `readAt: null` and `senderId ≠ userId`).
- `getMessages(conversationId, userId, before, limit = 50)` → paginated history, verifies participant membership.
- `markRead(conversationId, userId)` → `$set { readAt: Date.now() }` on all unread messages where `senderId ≠ userId`.
- `dismissMessage(conversationId, messageId, userId)` *(as-built)* → participant-guarded `$set { dismissed: true }` on one message; used by the actionable invalidation-alert bubble so a dismissed alert stays collapsed across reload. Message-level only — never touches the idea's `invalidation_status` latch.
- `searchUsers(query, currentUserId)` → text search on `users` collection by name/email, excludes self and `ar2trade_bot`.
- `seedBotConversation(userId)` → calls `getOrCreateConversation(userId, 'ar2trade_bot')`, then if the conv is new sends a welcome message from the bot.

**Bot constant:** `export const BOT_USER_ID = 'ar2trade_bot'`

---

### 1-B. REST API

New files: **`api/chat/chat.controller.js`**, **`api/chat/chat.routes.js`**

| Method | Route | Handler | Notes |
|--------|-------|---------|-------|
| `GET` | `/api/chat/conversations` | `listConversations` | Returns convs + unread counts |
| `GET` | `/api/chat/conversations/:id/messages` | `listMessages` | `?before=<epoch>&limit=50` |
| `POST` | `/api/chat/conversations/:id/messages` | `postMessage` | Writes + WS push to recipient |
| `POST` | `/api/chat/conversations/:id/read` | `markRead` | Clears unread for caller |
| `GET` | `/api/chat/users/search` | `searchUsers` | `?q=<string>` — start new DM |

All routes behind `requireAuth`. `postMessage` verifies the caller is a participant before writing.

---

### 1-C. WebSocket server

New file: **`api/chat/chatWs.js`**

Attaches to the Express `http.Server` via `server.on('upgrade', handler)` — same process, same port. Uses the Node built-in `ws` package (already in the ecosystem for cTrader; add if not present).

**On upgrade:**
1. Parse JWT from `cookie` (preferred) or `?token=` query param — same auth as REST.
2. Reject with 401 if invalid.
3. Register socket in `socketMap: Map<userId, WebSocket>`.
4. Send `{ event: 'connected' }` — client re-fetches conversations via REST immediately after.
5. Handle `ping` → `pong` for keepalive.
6. On close → remove from `socketMap`.

**`emit(userId, event, data)`** — exported helper:
```js
export function emit(userId, event, data) {
    const socket = socketMap.get(String(userId))
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ event, data }))
    }
}
```

Called by `sendBotMessage` and `postMessage` controller to push `new_message` to the recipient.

**`attach(httpServer)`** — exported setup function called from `server.js`.

---

### 1-D. Bot seeding

Wire `seedBotConversation(userId)` into the user signup flow:
- **File:** `api/user/user.service.js` (or wherever `createUser` lives) — call `seedBotConversation` after the user doc is saved.
- **Back-fill:** one-off script `scripts/seed-bot-conversations.mjs` — queries all existing users, calls `seedBotConversation` for each, idempotent (skips if conv already exists).

---

### 1-E. Wire into server.js

```js
// In server.js — after existing imports:
import { chatRoutes }  from './api/chat/chat.routes.js'
import { attach as attachChatWs } from './api/chat/chatWs.js'

// After route registrations:
app.use('/api/chat', chatRoutes)

// After server is created (http.createServer already exists):
attachChatWs(server)
```

---

### Build sequence

| Step | What | File(s) |
|------|------|---------|
| 1 | Data layer + `sendBotMessage` | `api/chat/chat.service.js` (new) |
| 2 | REST API | `api/chat/chat.controller.js`, `api/chat/chat.routes.js` (new) |
| 3 | WS server | `api/chat/chatWs.js` (new) |
| 4 | Bot seeding + back-fill script | `api/user/user.service.js` + `scripts/seed-bot-conversations.mjs` |
| 5 | Wire into server.js | `server.js` |
| 6 | Frontend | frontend repo |
| 7 | Portfolio managing integration | Replace Phase 1 badge/dropdown with bot `sendBotMessage` call |

**Start with step 1.** Verify `sendBotMessage` writes correctly to MongoDB before adding WS or any REST routes. Test with a quick `node` script against the real DB.

---

# Axl Routing & Thread Resolution

> **Status: DESIGN (not built) — captured 2026-07-04.** Extends the Phase-1 chat layer (built) into a two-way, agent-routed assistant. Builds on the Thread abstraction (BUILT — see `services/thread.service.js`) and the Axl agent design (see the `project_axl_agent` memory node). Phase 1 above made the bot thread a one-way notifier; this section makes it *answer*.

> **PREREQUISITE — Axl does not yet exist as an agent.** There are three agent services (`trade` / `portfolio` / `scanner`); there is no `axl.agent.service.js`. Axl today is cosmetic only (hub persona, notification voice, Radar UI, `axl-bot.svg`). This whole routing design assumes an Axl *brain* that decides a domain and answers concierge/help questions — so **Layer 0 (build Axl as the 4th agent) must land before Layer 1 (this routing mechanism)**. Layer 0 = `axl.agent.service.js` cloning the scanner template + `axl_system_prompt.md` + read-only tools only (no `<trade_idea>`/order emit — the identity boundary), minimal viable = routing decision + concierge/app-guide answering. Layer 1 additionally needs a **read-only "explain" mode on the three specialists** (they answer in build-mode today, emitting artifacts; social-chat answering must explain without authoring). Scoping fork for Layer 0: full 4th-agent chat (service+SSE+frontend tab, unlocks concierge/critic/reports + the "Continue in Axl →" target) vs. agent-service brain only (callable by dispatch, chat UI deferred).

## Why this exists

Today the bot thread is a **dead-end for inbound**: `postMessage` (chat.controller.js) stores a user's message and pushes it to `ar2trade_bot` — which is not a connected socket, so nothing ever replies. `sendBotMessage` is one-way (monitor → user). This design builds the *first* inbound-answering path: a typed social-chat message gets routed by Axl to the right agent, answered into the right thread, and mirrored back Axl-voiced.

## Two surfaces linked by routing (locked)

- **Social chat = inbox / dispatcher.** Axl notifies (invalidation / review / fills) + answers questions + offers routing. Existing WS + `sendBotMessage` infra unchanged. `ar2trade_bot` persona = Axl's voice.
- **4th-agent chat = the workspace** (reports, app-help, concierge, critic; and where mutations happen). Just the 4th agent chat — SSE + chat-state, same pattern as Idea/Atlas/Argus.
- **Link = routing, not shared history.** Answers live in the subject's canonical thread; social chat renders a projection with a "Continue in …→" deep-link that routes OUT into the workspace.

## Responsibility split

- **Axl picks the *domain* agent** (idea / portfolio / scanner / itself). For an anchored reply it reads the notification payload's origin; for a spontaneous ask it infers domain from the question.
- **The specialist resolves the *thread*** within its own domain and appends the turn there. Only the Idea agent knows all the user's ideas/drafts — so thread-picking lives with it, not Axl.

Rationale: each decision sits where the knowledge is. Axl needn't know every idea; the Idea agent does. Keeps routing an agent decision, not a code classifier (`feedback_agent_decides_no_hardcoded_rules`).

## Subject binding — two layers

A typed social-chat message resolves in two independent layers:

1. **Subject binding (deterministic, client-stamped).** Every answerable notification bubble carries an **"Ask about this"** affordance. Typing from it stamps the outbound message with `replyTo: <notifMsgId>`, inheriting that notification's `payload` refs (`ideaId` / `portfolioId` / `scanId`). Explicit — no inference. A message typed into the *main* input (no `replyTo`) is **unbound** → defaults to Axl.
2. **Agent routing (Axl's LLM decision).** Given the message + bound subject, Axl decides *who answers*. The binding says *what it's about*; Axl decides *who speaks*. So a reply anchored to an NVDA idea whose text is "what does edge mean?" is app-help → **Axl** answers, even though the subject is an Idea.

## Thread resolution ladder (the specialist follows this)

Once Axl routes to a specialist, the specialist resolves the target thread in precedence order — encoded as prompt guidance + a `resolve_subject` tool, **not** a hardcoded matcher:

1. **Explicit ref** — Axl forwards the anchoring notification's `payload.ideaId`. Deterministic; skip inference, load that thread.
2. **Active binding** — the ongoing exchange's current bound thread (`chat_conversations.activeBinding = { agent, threadId, subjectId }`). Follow-ups stick to it unless the message clearly names a different subject. This is what lets "why?" → "and the stop?" stay on one idea without re-specifying.
3. **Inferred from the roster** — no ref, no binding: the specialist calls `resolve_subject` → its `listThreads({ userId, agent })` roster (asset/status joined from the artifact for `linked`, from `title` / `state` for `draft`) → matches on asset + direction + status + recency + intent.
4. **Disambiguate** — multiple plausible matches (a *live* NVDA idea **and** an NVDA *draft*) → one Axl-voiced clarifier. Default lean: most-recently-active wins; ask only when genuinely tied.
5. **Not-mine** — no match in domain → specialist returns a "not mine" signal → Axl re-routes or asks. Prevents hallucinating a subject when Axl guessed the wrong domain.

Both `draft` and `linked` threads are valid targets ("identify the related idea **or draft**").

### Roster source

`listThreads({ userId, agent })` already returns drafts + linked, newest-first, messages projected out, each carrying `threadId`, `subjectId`, `subjectType`, `title`, `phase`, `state`, `tier`, `updatedAt`. That *is* the roster. Asset/status for `linked` subjects comes from a join to the artifact doc by `subjectId`; for `draft` subjects from `title` / `state` (e.g. the idea agent's `analysisState`). Use a lean projection — `state` can be large.

## Answer model

- The resolved agent answers over the subject's canonical thread. The Q + A **append to that thread** — that's the continuable memory.
- The answer is also surfaced in social chat as an Axl-voiced bubble (`type: 'axl_answer'`, `payload: { threadId, agent, subjectId }`) via `sendBotMessage`. The bubble carries a **"Continue in Idea / Atlas / Argus →"** deep-link that routes OUT into the workspace seeded from that thread.
- **Voice = attribution, not a second model call.** The specialist's answer text goes out as `ar2trade_bot` (Axl's persona). Seamless UX ("you talk to Axl"), no restyle LLM. An optional restyle pass is deferred polish.

### New thread-service primitive required

`saveDraft` unconditionally stamps `tier: 'draft'` + re-arms the TTL — calling it on a `linked` thread would silently downgrade a live idea's thread and give it an expiry. So the thread service needs **`appendMessages({ threadId, userId, messages })`** that `$push`es + bumps `updatedAt` **without touching `tier` / `expiresAt`**. Real gap, not cosmetic.

## Conversation lifecycle — social chat is a dispatcher, not a conversation

Unlike a chat panel (which ends on **generate** / **clear** / **switch agent** because it's a build session for one artifact), the social-chat thread is a permanent inbox and **never ends**. No conversation *content* lives there — every answer is appended to its subject's thread, which keeps its existing lifecycle:

- `linked` → permanent, dies with the artifact
- `draft` → 14-day TTL / LRU cap
- Axl concierge → its own thread

The only transient state is `activeBinding` (current focus), released **implicitly, never by a user act**:

1. **Subject switch** — the next message resolves to a different subject → binding is *replaced*. The always-on terminator.
2. **Staleness** — idle beyond a window (start ~30–60 min / per-session), or a new session → binding cleared → next message re-resolves from scratch. Stops a day-later "how's it looking?" latching onto yesterday's NVDA. **This window is the one value to pick.**
3. **Subject invalidation** — the bound idea is closed/deleted → binding dangles → clear + re-resolve. (A draft *generating* into a linked artifact keeps the same thread — fine.)

New notifications don't end anything — they present their own "Ask about this" anchor; engaging one *starts* a new binding, ignoring one leaves the current binding intact.

**Open flag:** the Axl concierge thread (subject-less general/help questions) has no artifact to die with → could grow unbounded. May want session-windowing / topic segmentation. Flagged, not solved.

## Boundary — explain inline, mutate routes to the editor (locked)

Axl applies one per-message rule:

- **Ask / explain / report** ("why did it invalidate?", "how's it doing?", "what's my stop?") → answered inline, Axl-voiced, specialist under the hood.
- **Change anything** (entry conditions, size, stop, or build a new idea) → Axl does **not** form or commit it. It routes: *"Let's change that in Idea →"* — a deep-link into the Idea editor seeded with the thread. Literally "go speak to Idea."

This keeps Axl's read-only identity intact and reuses the existing route-out deep-link as the whole mutation path — no inline-commit, no action-bubble-applies-changes, no parametric-vs-structural threshold. The deep-link edit target must be reachable **on mobile** (`project_mobile_companion` already allows edit-via-deep-link — same entry as portfolio review).

**Deferred (not discarded):** an inline propose→confirm-bubble→commit path (specialist drafts the change in-thread, user confirms via an `action_card`, commit reuses the existing idea-update write path + edit-lock guards). A possible later evolution if quick mobile edits prove worth it. For v1, mutations always route out.

## The one new server piece

An **`axl.dispatch` orchestrator** — where "Axl decides which agent answers + which thread it joins" physically lives. It: receives inbound social-chat messages (new endpoint, or `postMessage` extended when the recipient is the bot), resolves subject (`replyTo` → payload refs / `activeBinding`), runs the Axl domain-routing decision, then either (a) invokes the resolved specialist's read-only answer entrypoint on the canonical thread + mirrors Axl-voiced, or (b) emits a route-out deep-link for any mutation request.

## Build sequence (Axl routing)

| Step | What | File(s) |
|------|------|---------|
| 1 | `appendMessages` (tier-preserving) + `activeBinding` on `chat_conversations` | `services/thread.service.js`, `api/chat/chat.service.js` |
| 2 | `resolve_subject` tool + roster helper (`listThreads` + artifact-status join) | new `services/axl/` |
| 3 | `axl.dispatch` orchestrator (domain routing + specialist answer entrypoints, read-only) | new `api/chat/axl.dispatch.service.js` |
| 4 | Inbound endpoint — extend `postMessage` (bot recipient → dispatch) | `api/chat/chat.controller.js` |
| 5 | Mirror answer via `sendBotMessage` (`type: 'axl_answer'`) + route-out deep-link payloads | `api/chat/chat.service.js` |
| 6 | Frontend — "Ask about this" affordance (`replyTo`), `axl_answer` bubble + Continue deep-link, mutation route-out | frontend repo |

**Start with step 1** — the append primitive is the load-bearing gap; verify it never downgrades a linked thread before wiring routing on top.
