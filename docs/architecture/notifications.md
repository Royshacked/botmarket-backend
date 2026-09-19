# Notifications: the card, the socket, the device

**Every alert in this app is a card in social chat. Web push is that same card, delivered a
second time, to the devices the user is not looking at.** Nothing is authored for push; nothing
decides on the server whether the user needs it.

Built 2026-09-19, with the PWA (the frontend is installable on desktop and Android; iOS is
deferred). The decision record is the session that built it; this is the contract.

## The path

```
desk / monitor
   │  builds ITS OWN card (copy, payload, actions)         tradeNotify · coverageNotify · manualNotify · …
   ▼
postCard → postBotCard                                     services/notifyCard.js · api/chat/chat.service.js
   │  writes the message, supersedes the stale card about the same subject
   ▼
_deliver(userId, msg)                                      chat.service — the ONE "a message reached this user" step
   ├─ socket  `new_message`  → the open app (toast + badge, or the panel live)
   └─ push    every subscribed device, ALWAYS            services/push.service.js
                 │
                 ▼
         service worker on each device                     FE src/sw.js
           focused window here?  → quiet (the card just slid into chat in front of them)
           anything else         → OS notification
                 │  tap
                 ▼
         open window → postMessage { open-chat }  |  no window → open  /?chat=<conv>&msg=<id>
         useChatWs lands both on the message — the same landing a preview-toast click gives
```

A human DM takes the same `_deliver` step (with the sender's name); a message TO a bot takes
neither socket nor push beyond what it always did.

## The rules, and why each is a rule

**The server sends to everyone, always.** A socket count says nothing about where the human is —
the desktop is open in the study while they wash dishes. Presence is a fact only the device
knows: the worker checks whether the app is *focused* in a window there and stays quiet if so.
This is also exactly the exemption Chrome grants to a push that shows nothing (a visible tab of
the origin); anything less than focused shows.

**Every card pushes, not only the asks.** The app should feel alive: Argus finishing a scan, the
morning brief, a coverage revision. The cards' own supersede rule keeps this from nagging — one
live ask per type per subject — and an actionable card's notification carries exactly that as
its `tag`, so the OS replaces the stale notification the same way chat replaces the stale card.
A plain statement never tags, so it cannot swallow a pending ask about the same setup.

**The notification is the message.** Title = the desk's brand (`BOT_BRAND` in push.service;
a human's name for a DM), body = the card's `content`, cut to one line. The desk wrote it; the
transport forwards it. No second copy to drift.

**Push never throws, and never delays the card.** Same contract as `notifyCard`: an alert is
ABOUT a state change, never part of it. `pushToUser` is fire-and-forget from `_deliver`; a
monitor posting a card does not wait on Google. A 404/410 from the push service is a dead
subscription and is dropped; anything else is logged and the row kept.

**A tap lands on the card, not on the desk.** The card's own button then routes onward (a
setup's entry-confirm opens the confirm modal). One extra tap, and no way for a notification to
place an order.

## The device side

- **One subscription per browser profile**, stored on the user (`pushSubscriptions[]`, keyed by
  endpoint ACROSS users: a browser has one subscription per origin, so an endpoint turning up
  under a second account is a shared browser changing hands and the row moves). Sign-out
  unsubscribes this browser. Profile → Alerts is the one switch, per device.
- The permission prompt is only ever raised from that button — a prompt on page load is what
  gets a site blocked.
- `/api/push/config` hands the browser the public VAPID key; the private key never leaves the
  backend. Payloads are encrypted end-to-end by web-push with the subscription's own keys; the
  push services carry ciphertext.
- Off without `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY`. Rotating the pair orphans every existing
  subscription until its device next turns alerts on (the client compares the subscription's key
  with the server's and re-subscribes; the push service's 400/403 in between is NOT the drop
  path). Don't rotate casually.

## The PWA, and what the worker will never do

The frontend's service worker (`src/sw.js`, built by vite-plugin-pwa in injectManifest mode)
exists so the browser offers Install and so push has somewhere to land. It precaches the app
shell — the built js/css/html and the icons — and **nothing else**:

- `/api` and the two socket upgrade paths (`/ws`, socket.io) are on the navigate denylist and
  have no runtime rule. Every data request goes to the network, exactly as before the worker
  existed. A trading app that answers from a cache is worse than one that fails — a stale price,
  a stale card, a "pending" that already fired.
- A pop-out window (an idea or a setup opened bare) is not "the app" to the worker: it has no
  chat to open a card in, and its being focused says nothing about whether a card was seen.
- The one runtime cache is Google Fonts.
- `autoUpdate`: a new deploy's worker takes over on the next load. Nothing local is lost — a
  desk's draft lives on the server.
- Off under the Vite dev server (it fights HMR and the proxy). Push is therefore tested on a
  deployed build, not on localhost:5173.

The rules live in `src/pwa/rules.js`, read by the worker and held by `src/pwa.config.test.js`.

## Not built

- **Email** as the fallback for users who decline the permission — decided, not built. It is one
  more sender under the same `_deliver` step.
- **iOS**: Safari delivers web push only to a home-screen-installed PWA (16.4+). Nothing here
  prevents it; nothing here has been tested on it.
- **Quiet hours / per-desk opt-out.** Every card, every device, for now.
