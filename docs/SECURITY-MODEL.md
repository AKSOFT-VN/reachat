# Security model

This document describes what ReaChat protects, how, and — just as important — what it does **not** protect.
If you find a problem, please report it privately as described in [SECURITY.md](../SECURITY.md).

> ⚠️ The cryptographic code in this repository is a from-scratch implementation following the Signal specifications.
> It has **not been independently audited**. For high-risk use, wait for an audit or contribute to the planned migration to libsignal.

## Threat model

| Adversary | Protected? |
|---|---|
| Network attacker (Wi-Fi, ISP) | ✅ TLS for all traffic, optional certificate pinning in the desktop app; media is DTLS-SRTP |
| Someone who steals the server database / backups | ✅ Message bodies, files, key backups are ciphertext. Passwords are bcrypt hashes |
| A curious server operator (passive) | ✅ for message **content**; ❌ for **metadata** (see below) |
| A malicious server operator (active) | ⚠️ Partially. Safety numbers let users detect key substitution; but the operator can capture the account password at login (see *Key backup*) and serves the web app code |
| Another user / stranger | ✅ Blocking, message requests for strangers, scam warnings, reporting |
| Someone with the unlocked device | ❌ Out of scope (optional app PIN lock and screenshot protection reduce casual exposure) |

## What the server can and cannot see

| | Server **cannot** read | Server **can** see |
|---|---|---|
| 1:1 messages | content (Double Ratchet) | who talks to whom, when, message type and size |
| Group messages | content (group key, XSalsa20-Poly1305; rotated when a member leaves) | members, timing |
| Files, images, voice, video | content **and** original name / type / size (encrypted metadata) | ciphertext size |
| Calls | audio / video (DTLS-SRTP, P2P or via TURN); SDP / ICE are sealed with identity keys | who calls whom, when, duration |
| Shared notes, tasks, "My Cloud", synced preferences | content | update times |
| Key backups | identity keys (wrapped with a password- or recovery-code-derived key) | the wrapped blob |

**Not end-to-end encrypted, by design:** stories (broadcast to friends), poll votes (counted by the server), event RSVPs,
group system messages, **public channels**, messages to bots, content attached to abuse reports (sent by the reporter),
**auto-replies** (sent by the server while the user is away — labelled in the UI), **translated text** (only when the user
explicitly asks to translate a message), **link previews** (the server fetches the page, so it learns the URL — can be disabled).

## Cryptography

- **Identity keys:** X25519 key pairs generated on the device (TweetNaCl).
- **1:1 messages:** Double Ratchet — DH ratchet with X25519, HKDF / HMAC-SHA256 (WebCrypto) chains, XSalsa20-Poly1305 per message.
  Message keys are deleted after use (forward secrecy) and the DH ratchet heals after compromise.
  **Limitation:** sessions are bootstrapped from a DH of the two long-term identity keys — there is no X3DH / one-time prekey
  server yet, so forward secrecy starts after the first ratchet step and there is no deniability as in full X3DH.
- **Groups:** a random 256-bit group key distributed to each member sealed with their identity key; rotated when someone leaves
  so former members cannot read new messages.
- **Files:** each file has its own key (from the ratchet for 1:1, the group key for groups); large files are encrypted per 4 MB chunk.
- **Safety numbers:** 60-digit numbers / QR codes derived from both identity keys; the app warns when a contact's key changes.
- **Call signalling:** SDP / ICE candidates are sealed with identity keys, so the server cannot inject itself into a call.

## Accounts and keys

- **Passwords:** bcrypt. Login rate limiting per account and per IP, captcha after repeated failures, optional **TOTP 2FA**.
- **Sessions:** JWT bound to a server-side session (revocable per device; expire after 30 days of inactivity). The signing key is
  `JWT_SECRET` or, if unset, a random secret generated on first start and stored next to the database.
- **Key backup (multi-device):** identity keys are encrypted with PBKDF2-SHA256 (200k iterations) of the password before upload.
  **Limitation:** the password is also sent to the server to log in, so a *malicious* operator could capture it and decrypt the backup.
  This protects against database theft, not against an actively malicious server.
- **Recovery code:** 100-bit code; the server stores only a verifier and a backup wrapped with a key derived from the code.
- **Password reset by email / SMS:** resets the account but **cannot** recover old encrypted history on a new device
  (the backup was wrapped with the old password) — the UI explains this.

- **Sensitive account changes** (recovery code, recovery email / phone, replacing the identity key, deleting the account, unlinking Google)
  require the password (and the 2FA code where relevant) unless the session was created in the last 10 minutes — a stolen token alone
  cannot be turned into a permanent account takeover.
- **Google sign-in** is bound to the device that started it: the browser page shows a 6-character confirmation code that must be typed
  into the app, so a sign-in link sent to someone else cannot be used to obtain their session.

## Groups and channels

- Any group member can distribute a group key (needed to recover when nobody online has the current key). Members are therefore trusted
  with the group's confidentiality — the same as with any group chat: a member can always read and re-share what they receive.
- Public channels are not end-to-end encrypted. Followers are read-only and are not shown each other's online status.

## Desktop app and updates

- The renderer runs sandboxed with context isolation; IPC is only accepted from the app's own page, and the window cannot be navigated away.
- **Auto-update trusts the server you connect to**: installers are verified against the SHA-512 in `latest.yml` from the same server.
  Updates are only downloaded over HTTPS. Whoever controls the server can ship a new build to its users — sign your builds
  (`CSC_LINK`) and configure `publisherName` in `desktop/package.json` so electron-updater also verifies the code signature.
- **LAN mode** (messaging without Internet) does not authenticate peers on the local network. Messages are encrypted with the
  recipient's identity key, and the app warns when a key differs from the one known from the server — but a peer never seen before is
  accepted as is.

## Web app caveat

The web / PWA version loads its JavaScript from the server. A malicious operator could serve modified code that exfiltrates keys.
The desktop app is code-signed (when a certificate is configured) and updates are verified with SHA-512, which raises the bar.
This is a known limitation of all browser-based end-to-end encryption.

## Server hardening

- Strict Content-Security-Policy in the desktop app (no remote scripts; `wasm-unsafe-eval` only for on-device speech recognition).
- SSRF protection for link previews and bot webhooks (blocks private / loopback / link-local addresses including IPv4 embedded in
  IPv6, re-checked at connect time; webhooks do not follow redirects).
- Rate limits on WebSocket frames, messages, connections per account, uploads, friend requests, registration (per IP), search and
  verification codes; disk space reserved by unfinished uploads is accounted for.
- Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`); uploaded files are served as attachments with
  a safe content type.
- Keyword / domain filters and an admin audit log (see the admin dashboard).
- Content that the server can read (public channels, names, bios, statuses) is filtered; end-to-end encrypted content is not —
  users report abuse, attaching the content themselves.

## Known gaps / roadmap

1. Independent security audit; migrate to libsignal (X3DH / PQXDH, sealed sender).
2. Hide the social graph from the server (sealed sender).
3. Passkeys (WebAuthn) to avoid sending passwords to the server.
4. Reproducible builds for the desktop app.
