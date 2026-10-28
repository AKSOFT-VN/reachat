# Releasing

One command builds, tests and deploys a new version:

```bash
npm run release -- 1.2.0          # or --patch / --minor
```

| Step | What happens |
|---|---|
| 1 | `npm test` — server suites + desktop unit tests |
| 2 | Set the version in `desktop/package.json`, build the UI |
| 3 | `scripts/smoke-ui.mjs` — launch the **built** app against a temporary server: login, reload twice without being signed out, every settings tab, send a message, no JavaScript errors |
| 4 | Build the Windows installer (electron-builder, NSIS), re-run the UI smoke test against the **packaged** app, and publish `latest.yml` + installer + blockmap to `server/updates/` |
| 5 | Bundle the server, the built web app and `deploy/Dockerfile` |
| 6 | Copy to the server over SSH and run `deploy/remote-deploy.sh`: database backup → `docker build` (fails the release on error, retries transient network errors) → run → verify the container runs the new image → wait for `/health` → **roll back** to the previous image if it does not come up → fetch the speech model if missing |
| 7 | Check the public URL: `/health`, the update feed version, that `/app` serves the JavaScript just built, and that the new API is live |

## Configuration

Create `deploy/deploy.env` (not committed) from [`deploy/deploy.env.example`](../deploy/deploy.env.example):

```
DEPLOY_HOST=my-server          # host from ~/.ssh/config; the user must be able to run docker
DEPLOY_URL=https://chat.example.com
DEPLOY_DIR=/opt/reachat
```

On Windows the script uses `C:/Windows/System32/OpenSSH/ssh.exe` (so keys in the Windows ssh-agent work);
override with `SSH_BIN` / `SCP_BIN`.

Options: `--skip-tests`, `--skip-smoke`, `--no-installer` (server + web only), `--no-deploy` (build only).

## Code signing

Set `CSC_LINK` (path to a `.pfx`) and `CSC_KEY_PASSWORD` before releasing and electron-builder signs the installer and the app.
For EV certificates on hardware tokens or Azure Trusted Signing, configure `build.win.signtoolOptions` / `azureSignOptions`
in `desktop/package.json`. Without signing, Windows SmartScreen warns on first install.

## Auto-update

Installed desktop apps check `<server>/updates/latest.yml` at start-up and every 4 hours, download differentially,
verify the SHA-512 and offer to restart. The portable `win-unpacked` build does not auto-update.

## After releasing

Move the *Unreleased* section of [CHANGELOG.md](../CHANGELOG.md) under the new version and tag the commit:

```bash
git tag -a v1.2.0 -m "ReaChat 1.2.0" && git push --follow-tags
```
