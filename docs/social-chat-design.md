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
  type:           'text',          // 'text' | 'portfolio_card' | 'idea_card' | 'scan_card' | 'action_card' (future)
  payload:        null,            // future: { portfolioId } | { ideaId } | { scanId } | { actions[] }
  createdAt:      epoch ms,
  readAt:         epoch ms | null, // null = unread
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

## Build order

1. **Data layer.** `conversations` + `messages` collections, indexes, `sendBotMessage` helper, bot user seed.
2. **REST API.** All five endpoints above. Verify with curl before touching WS.
3. **WS server.** Attach to Express, JWT auth on upgrade, in-memory socket map, `new_message` push.
4. **Bot conversation seeding.** Wire to user signup; back-fill for existing users.
5. **Frontend.** WhatsApp layout, WS client, conversation list, active chat, header badge.
6. **Portfolio managing integration.** Replace Phase 1 badge/dropdown with bot message + action card in the chat thread.

Start with step 1 and verify `sendBotMessage` end-to-end (writes to DB, pushes to socket) before building any UI.
