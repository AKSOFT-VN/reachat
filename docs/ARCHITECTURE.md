# Architecture

## Components

```
desktop/ (Electron)                         server/ (Node.js)
┌─────────────────────────────┐             ┌──────────────────────────────────────────┐
│ electron/main.cjs           │             │ src/index.js   Express REST API, static   │
│  · window, tray, CSP, TLS   │             │                web app (/app), admin UI  │
│    pinning, auto-update     │  HTTPS/WSS  │ src/ws.js      WebSocket: messages, sync, │
│  · localdb.cjs (sql.js)     │◀───────────▶│                calls signalling, presence │
│  · lan.cjs (LAN fallback)   │             │ src/db.js      SQLite (better-sqlite3, WAL)│
│ src/ (React UI, shared with │             │ src/turn.js    built-in TURN / Cloudflare │
│      the web app / PWA)     │             │ src/push.js    Web Push (VAPID)           │
│  · crypto.js, ratchet.js    │             │ src/*.js       accounts, groups, search,  │
│  · call.js, groupcall.js    │             │                moderation, GIFs, sync…    │
│  · stt-worker.js (Whisper)  │             └──────────────────────────────────────────┘
└─────────────────────────────┘
```

The **same React UI** runs in Electron (with a preload bridge to the local SQLite cache) and in the browser
(`webshim.js` provides the same API on top of IndexedDB).

## Message flow

1. The sender encrypts on the device (Double Ratchet for 1:1, group key for groups) and sends the ciphertext over WebSocket.
2. The server stores it with a global, monotonically increasing `seq`, delivers it to members' open connections and sends Web Push
   to members who are offline. It never sees plaintext.
3. Clients keep a cursor (`maxSeq`); on reconnect they `sync` everything after it, so devices converge after being offline.
   Edits, recalls and reactions bump a separate `mod_seq` so changes to old messages also sync.
4. Each device decrypts and stores plaintext only in its **local cache** (SQLite in Electron, IndexedDB on the web), which is
   also what powers search and summaries — the server cannot search encrypted content.

## Files

Small files: one upload request. Large files: **chunked** (4 MB chunks, encrypted separately, resumable, no size limit),
downloaded with HTTP Range. Alternatively **P2P**: a WebRTC data channel between the two devices; the server only relays the
(sealed) signalling.

## Calls

WebRTC. 1:1 calls are peer-to-peer when possible, otherwise relayed by TURN (built-in node-turn, your coturn, or Cloudflare TURN
with credentials granted only to the participants of a real call). Group calls are a full mesh (up to `GCALL_MAX`, default 6).
SDP and ICE candidates are sealed with the identity keys so the server cannot tamper with them.

## Multi-device

Every device of a user shares the same identity key, restored from an encrypted key backup at login.
Preferences (pins, archive, labels, drafts, starred…) sync as one document encrypted with the user's personal key, merged
per item (last writer wins) — see `desktop/src/syncdoc.js`.

## Storage

SQLite in WAL mode with tuned pragmas, indexes for the hot queries, a prepared-statement cache and a slow-query monitor
(`server/src/dbtune.js`). This comfortably serves a single server; a PostgreSQL backend for multi-server deployments is on the roadmap.

## Testing

- `server/test/run-all.mjs` starts a temporary server (fresh database, its own port) and runs every suite against it over real
  HTTP / WebSocket. Some suites start their own server with special settings (limits, fake Cloudflare / Google providers).
- `desktop/test/unit.mjs`: crypto, ratchet, scam detection, summaries, LAN, sync merge.
- `scripts/smoke-ui.mjs`: launches the built Electron app with a temporary server and drives the UI through the Chrome DevTools Protocol.
