# Self-hosting ReaChat

This guide sets up a production server with Docker on Linux. A small VPS (1 vCPU, 1–2 GB RAM, 20 GB disk) is enough for a few hundred users.

## 1. Requirements

- Linux with **Docker**
- A domain name and a TLS reverse proxy: nginx, Caddy, Traefik, or **Cloudflare Tunnel**
- For calls across networks: open **UDP 3478 and 49160–49200** (built-in TURN) on the host *and* your provider's firewall —
  or configure Cloudflare TURN instead (see [CONFIGURATION.md](CONFIGURATION.md#calls-stun--turn))
- Node.js 24 on your workstation to build the web app

## 2. Build the image

The Docker build context contains the server and the built web app. On your workstation:

```bash
git clone https://github.com/AKSOFT-VN/reachat.git && cd reachat
npm ci
npm --workspace desktop run build              # builds the web app into desktop/dist

mkdir -p ../reachat-ctx/server
cp -r server/package.json server/src server/scripts server/admin server/legal ../reachat-ctx/server/
cp -r desktop/dist ../reachat-ctx/web
cp deploy/Dockerfile ../reachat-ctx/
docker build -t reachat:latest ../reachat-ctx
```

(Or let the release script do it and deploy over SSH — see [RELEASING.md](RELEASING.md).)

## 3. Configure and run

```bash
sudo mkdir -p /opt/reachat/data && sudo chown 1000:1000 /opt/reachat/data
cp server/.env.example /opt/reachat/.env      # edit: PUBLIC_URL, OPERATOR_NAME, OPERATOR_CONTACT, …
chmod 600 /opt/reachat/.env

docker run -d --name reachat --restart unless-stopped --env-file /opt/reachat/.env \
  -p 127.0.0.1:4000:4000 \
  -p 3478:3478/udp -p 49160-49200:49160-49200/udp \
  -v /opt/reachat/data:/data --memory 1g \
  reachat:latest

curl -s localhost:4000/health          # {"ok":true,...}
```

`/data` holds everything stateful: `reachat.db` (SQLite), `uploads/`, `gifs/`, `models/`, `updates/`, `backups/`, the Web Push keys
and the auto-generated session key.

## 4. Reverse proxy

The server speaks plain HTTP on `127.0.0.1:4000`; the proxy terminates TLS and must pass **WebSocket upgrades** (`/ws`).

**Caddy**

```
chat.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

**nginx**

```nginx
server {
    server_name chat.example.com;
    listen 443 ssl http2;            # + your certificate directives
    client_max_body_size 64m;
    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 1h;
    }
}
```

**Cloudflare Tunnel** — ingress `chat.example.com → http://localhost:4000`. Cloudflare does not carry UDP, so calls between
networks need TURN on a public IP (`TURN_PUBLIC_HOST`) or Cloudflare TURN.

Set `TRUST_PROXY=all` when the container port is published on `127.0.0.1` only, so per-IP limits see real client addresses.

## 5. First admin and optional features

```bash
docker exec reachat node scripts/make-admin.js <your-username>    # then open https://chat.example.com/admin
docker exec reachat node scripts/fetch-stt-model.js               # on-device voice-to-text model (~77 MB)
```

Users install the desktop app from your server's update feed or use the web app at `https://chat.example.com/app`
(installable as a PWA on phones).

## 6. Backups and monitoring

```bash
# daily at 02:00 — database snapshot + mirror of uploads and the GIF library into /data/backups
echo '0 2 * * * root docker exec reachat npm run backup >> /var/log/reachat-backup.log 2>&1' | sudo tee /etc/cron.d/reachat-backup
```

Copy `/opt/reachat/data/backups` **off the server** as well (object storage, another machine). Point an uptime monitor at
`https://chat.example.com/health` (returns 503 when the database fails or the disk is almost full) and configure
`ALERT_WEBHOOK_URL` / `ALERT_EMAIL` for alerts from the server itself.

## 7. Updating

Build the new image, back up (`docker exec reachat node scripts/backup-db.js`), then replace the container with the same
`docker run` command. Database migrations run automatically at start-up and never delete data.
`deploy/remote-deploy.sh` automates this including health check and rollback.
