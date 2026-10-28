# Configuration

The server is configured entirely with **environment variables** (for Docker: an `--env-file`).
A commented template is in [`server/.env.example`](../server/.env.example). Only `PUBLIC_URL` and `TRUST_PROXY` are
usually needed for a basic installation behind a reverse proxy — everything else has a safe default or is optional.

## Core

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP / WebSocket port |
| `PUBLIC_URL` | — | Public base URL, e.g. `https://chat.example.com` (Google sign-in, links) |
| `DB_PATH` | `server/data.db` (Docker: `/data/reachat.db`) | SQLite database file. Other data folders default to its directory |
| `JWT_SECRET` | random, stored in `.jwt-secret` next to the DB | Session signing key. Set explicitly when running several replicas |
| `JWT_TTL` | `30d` | Token lifetime (sessions are also revocable and expire after `SESSION_IDLE_DAYS` of inactivity) |
| `SESSION_IDLE_DAYS` | `30` | Inactive sessions are signed out |
| `TRUST_PROXY` | `loopback` | Trust the client-IP header only from loopback. `all` when the port is only reachable from your proxy (e.g. Docker `-p 127.0.0.1:4000:4000`) |
| `IP_HEADER` | `x-forwarded-for` | Header holding the client IP set by your proxy. For `X-Forwarded-For` the **last** entry is used (the one your proxy appended). Behind Cloudflare you may use `cf-connecting-ip` |
| `TLS`, `TLS_CERT`, `TLS_KEY` | off | Serve HTTPS directly (`TLS=1` uses `server/certs/` from `npm run gencert`). Usually a reverse proxy does TLS |
| `WEB_DIR` | `desktop/dist` (Docker: `/app/web`) | Built web app served at `/app` |
| `UPDATES_DIR` | `server/updates` (Docker: `/data/updates`) | Desktop auto-update files (`latest.yml`, installer, blockmap) |

## Limits and abuse protection

| Variable | Default | Description |
|---|---|---|
| `MAX_FILE_MB` | `25` | Max size of a single-request upload (larger files use chunked upload — no size limit) |
| `MAX_MSG_KB` | `256` | Max size of one (encrypted) message |
| `USER_QUOTA_MB` | `0` (off) | Per-user storage quota — **recommended on public servers** |
| `MAX_UPLOAD_GB` | `0` (off) | Max size of one chunked upload (each user can also have at most 5 unfinished uploads) |
| `MIN_FREE_GB` | `2` | Refuse uploads when free disk space (minus space reserved by unfinished uploads) drops below this |
| `ORPHAN_HOURS` | `24` | Delete uploaded files no message references after this time |
| `GROUP_MAX_MEMBERS` | `0` (unlimited) | Max members per group |
| `GCALL_MAX` | `6` | Max participants in a group call (WebRTC mesh) |
| `RING_TIMEOUT_MS` | `45000` | Unanswered call timeout |
| `RATE_<GROUP>` | see below | Token buckets `burst/perSecond` for `MSG` (120/20 per user — messages, edits, reactions), `CREATE` (10 / 1 per 30 s), `SIGNAL` (400/60), `UPLOAD` (20/0.1), `FRIEND` (20 / 1 per min), `FRAME` (300/50 per connection) |
| `WS_MAX_PER_USER` | `20` | Simultaneous WebSocket connections per account |
| `LOGIN_MAX_FAILS` | `8` | Failed logins per account **from one IP** in 15 min before a temporary lock (×5 per IP, ×5 per account across all IPs); captcha is required after 3 failures |
| `VERIFY_DAILY_MAX` | `5` | Verification codes per day per account and per destination email / phone |
| `BOT_WEBHOOK_PRIVATE` | off | `1` allows bot webhooks to private / loopback addresses (bots on the same host). Off: blocked (SSRF protection) |
| `CAPTCHA` | on | `0` disables the built-in captcha (registration, password reset, after failed logins) |
| `REG_PER_IP_HOUR`, `REG_PER_IP_DAY` | `3`, `10` | Accounts created per IP (`0` = unlimited) |
| `SEARCH_PER_MIN` | `30` | Friend searches per user per minute |

## Calls (STUN / TURN)

| Variable | Default | Description |
|---|---|---|
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN servers |
| `TURN_BUILTIN` | on | Built-in TURN server (node-turn). `0` to disable |
| `TURN_PORT` | `3478` | Built-in TURN UDP port |
| `TURN_MIN_PORT`, `TURN_MAX_PORT` | `49160`, `49200` | Relay port range — open it (UDP) on every firewall |
| `TURN_EXTERNAL_IP`, `TURN_PUBLIC_HOST` | — | Public IP / host of the TURN server when behind NAT or a proxy that does not carry UDP |
| `TURN_URLS`, `TURN_SECRET` | — | Use your own coturn (`static-auth-secret`, TURN REST credentials) instead of the built-in server |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | — | Use **Cloudflare TURN** (granted only for real calls, revoked when the call ends) |
| `CF_TURN_TTL_S` | `21600` | Cloudflare credential lifetime — must exceed your longest call |
| `CF_GRANTS_PER_HOUR` | `30` | Cloudflare credentials per user per hour |
| `CF_WASTE_MAX` | `3` | Credentials per user per hour that may be requested **without** a real call before further grants are refused |
| `TURN_MONTHLY_GB`, `TURN_USER_MONTHLY_GB` | `900`, `50` | Stop handing out Cloudflare TURN when the measured monthly usage reaches these (Cloudflare's free tier is 1,000 GB) |

## Accounts: email, SMS, Google

| Variable | Description |
|---|---|
| `SMTP_URL`, `MAIL_FROM` | SMTP for verification codes / password reset / alerts, e.g. `smtps://user:pass@smtp.example.com:465` |
| `SMS_HTTP_URL`, `SMS_HTTP_METHOD`, `SMS_HTTP_BODY`, `SMS_HTTP_HEADERS` | Any HTTP SMS gateway. URL / body templates may use `{to}` and `{text}`; headers are JSON |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in (OAuth client of type *Web application*, redirect URI `<PUBLIC_URL>/auth/google/callback`) |

## Features

| Variable | Default | Description |
|---|---|---|
| `KLIPY_API_KEY` / `GIPHY_API_KEY` | — | External GIF search in addition to the self-hosted library (Tenor's API was shut down in 2026) |
| `GIF_DIR`, `GIF_MAX_MB` | `gifs/` next to the DB, `10` | Self-hosted GIF / sticker library (managed in the admin dashboard) |
| `MODELS_DIR` | `models/` next to the DB | Speech-recognition model — `npm run fetch-stt-model` (~77 MB, Whisper base) |
| `TRANSLATE_PROVIDER` | `mymemory` | `mymemory` \| `libre` (`LIBRETRANSLATE_URL`, `LIBRETRANSLATE_KEY`) \| `google` (`GOOGLE_TRANSLATE_KEY`) \| `off`. `MYMEMORY_EMAIL` raises the free quota |
| `AUTO_REPLY_HOURS` | `6` | At most one auto-reply per sender per N hours |
| `VAPID_FILE` / `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | generated | Web Push keys (generated on first start) and contact (`mailto:`) |
| `OPERATOR_NAME`, `OPERATOR_CONTACT`, `LEGAL_UPDATED` | generic | Filled into the terms / privacy page templates (`server/legal/`). Have them reviewed for your jurisdiction |

## Monitoring, backups

| Variable | Default | Description |
|---|---|---|
| `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_BODY` | — | POST alerts as `{"text": …}` (Google Chat, Slack). Body template with `{text}` for Discord / Telegram |
| `ALERT_EMAIL` | — | Send alerts by email (needs `SMTP_URL`) |
| `ALERT_NAME`, `ALERT_COOLDOWN_MIN`, `ALERT_5XX`, `ALERT_CLIENT_ERRORS` | host, `30`, `10`, `30` | Alert label, repeat interval, thresholds |
| `SLOW_QUERY_MS` | `50` | Log database queries slower than this (shown in the admin dashboard) |
| `BACKUP_DIR`, `BACKUP_KEEP` | `data/backups`, `14` | `npm run backup` = database snapshot + mirror of uploads and the GIF library |

## Test-only variables

`NOTIFY_LOG`, `NOTIFY_DEV_ECHO`, `CAPTCHA_DEV_ECHO`, `CF_TURN_API_BASE`, `CF_CONFIRM_MS`, `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`,
`KLIPY_API_BASE`, `PUSH_DEBUG` are used by the test suites (fake providers, codes returned in responses). **Never set them in production.**
