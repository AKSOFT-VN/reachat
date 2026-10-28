# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may contain breaking changes).

## [Unreleased]

### Changed
- **New visual design**: navigation rail (chats, contacts, channels, meetings, LAN; settings and account at the bottom), green
  colour palette, new logo and app icon, larger rounded bubbles and list rows, single-frame composer, redesigned sign-in screen;
  on phones the rail becomes a bottom tab bar. Direct chats show the contact's display name.
- Renamed "My Cloud" to **Private notes** and "Moments" to **Stories**.
- Licensed under **Apache-2.0**; added contributor, security and self-hosting documentation.
- Desktop installer no longer bundles server-side dependencies of the speech-recognition library.
- The desktop app's application ID is now `vn.aksoft.reachat` (the installer GUID is kept, so existing installs upgrade in place).
- The release script re-runs the UI smoke test against the **packaged** app; the smoke test also checks that the CSP allows
  WebAssembly and blob workers (needed by voice-to-text).

### Security
Fixes from a pre-release security review (regression tests in `server/test/test-hardening.mjs`):
- **Google sign-in** is bound to the initiating device with a confirmation code shown in the browser; 2FA attempts in that flow are
  rate-limited; linking Google no longer sets the recovery email.
- **Blocking** now applies to every 1:1 path (sending by conversation id, scheduled messages, call signalling).
- **Scheduled messages** follow the same permission rules as normal messages, re-checked when they are delivered.
- Clients can no longer send server-only message types (`system`, `call`, `autoreply`) or edit non-text messages.
- Self-destructing / view-once messages can only delete files uploaded by their sender.
- Channel followers are read-only for pins, shared notes and tasks, and no longer see each other's online status.
- Only call participants can end a call; signalling payloads are size-limited; blocked users' signals are dropped.
- Stories are visible only to mutual friends who have not blocked each other.
- Sensitive account changes require re-entering the password on sessions older than 10 minutes; wrong-password answers no longer
  sign the user out; tokens without a session are rejected.
- Login lockout is per (account, IP) so others cannot lock you out; per-day limits on verification codes.
- SSRF: IPv4-embedded IPv6 addresses are blocked; bot webhooks are SSRF-protected and do not follow redirects.
- DoS: multi-range requests to `/updates` are bounded and streamed; message rate limit and per-account connection limit by default;
  disk space reserved by unfinished uploads is accounted for; anonymous request bodies are limited to 64 KB; link-preview cache is
  bounded by size.
- Uploaded files are served as attachments with `nosniff`; global `X-Frame-Options` / `Referrer-Policy` headers.
- Client IP is taken from the last `X-Forwarded-For` entry (or `IP_HEADER`), not a client-supplied value.
- Desktop: sandboxed renderer, IPC accepted only from the app page, navigation away from the app blocked, auto-update only over HTTPS,
  channel deep links no longer auto-join.
- Group invite codes use a cryptographic RNG.
- Updated dependencies with known vulnerabilities: **Electron 32 → 42**, electron-builder 26, Express 4.22, ws 8.22, nodemailer 10,
  nanoid 5.1; pinned patched `js-yaml` / `log4js` used by `node-turn`. `npm audit --omit=dev` reports no vulnerabilities.
  Remaining advisories affect development tools only (Vite's dev server; `sharp`, a Node-only dependency of transformers.js
  that is not shipped in the app).
- `JWT_SECRET` is no longer defaulted to a constant: if unset, a random secret is generated and stored next to the database.
- Terms / privacy pages are templates filled from `OPERATOR_NAME`, `OPERATOR_CONTACT`, `LEGAL_UPDATED`.
- Release script reads the deployment target from `deploy/deploy.env` (not committed).

## [0.9.0] — 2026-10-28

### Added
- Encrypted **sync across devices** (pins, mutes, archive, labels, drafts, hidden and starred messages).
- **Threads**, self-hosted **sticker packs**, **on-device voice-to-text** (Whisper, WebAssembly), **group events with RSVP** and reminders,
  image **albums**, **starred messages**, **advanced search** filters, **custom status + auto-reply**.
- **Moderation**: blocked keywords / domains for server-readable content, **admin audit log**.
- One-command **release & deploy** (`npm run release`) with automated UI smoke test, build-failure detection and automatic rollback.
- Web app message cache moved to **IndexedDB**.
- SQLite tuning (indexes, statement cache, slow-query monitor).

## [0.8.1] — 2026-10-28
### Added
- Self-hosted **GIF library** managed from the admin dashboard; no limit on group size.
### Fixed
- Users were signed out when reopening the app (0.8.0 regression).

## [0.8.0] — 2026-10-28
### Added
- Sounds (ringtone, ringback, message alert), drafts, delete chat, link previews, friend search, group roles (deputies, ownership transfer,
  join approval, admin-only), group avatars, hide presence / read receipts, profile bio / birthday / cover, archive and labels,
  video notes, live location, message translation, app PIN lock.

## [0.7.x] — 2026-10-28
### Added
- Device / session management, account deletion, terms & privacy pages, `/health`, password reset by email / SMS,
  Cloudflare TURN with per-call credentials and monthly quota, captcha and per-IP registration limits, Google sign-in,
  alerting (webhook / email) and client error reporting.

## [0.6.0] and earlier
- Core messaging with end-to-end encryption (Double Ratchet for 1:1, group keys), calls and group calls, screen sharing,
  call recording, chunked uploads and P2P file transfer, stories, channels, bots, meetings, invite links, Web Push / PWA,
  2FA and recovery codes, admin dashboard, auto-update.
