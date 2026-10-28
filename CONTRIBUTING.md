# Contributing to ReaChat

Thank you for your interest in ReaChat! Bug reports, ideas, documentation and code are all welcome.
By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

> Đóng góp bằng tiếng Việt hoàn toàn được chào đón — issue, pull request và thảo luận có thể viết tiếng Việt hoặc tiếng Anh.

## Reporting bugs and requesting features

- Search [existing issues](https://github.com/AKSOFT-VN/reachat/issues) first.
- Use the issue templates (bug report / feature request) and include versions, steps to reproduce and what you expected.
- **Security issues:** never in public issues — see [SECURITY.md](SECURITY.md).

## Development setup

```bash
git clone https://github.com/AKSOFT-VN/reachat.git && cd reachat
npm install
npm run seed          # demo accounts nam / binh, password 123456 (development only)
npm run dev:server    # http://localhost:4000
npm run dev:desktop   # Vite + Electron
```

Requirements: Node.js 24, npm 10. `better-sqlite3` needs a C/C++ toolchain where no prebuilt binary exists.

## Making changes

1. Fork the repository and create a branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep changes focused — one feature or fix per pull request.
3. **Add or update tests** for behaviour changes:
   - server: a suite in `server/test/` (each suite talks to a real temporary server — see `run-all.mjs`);
   - desktop logic: `desktop/test/unit.mjs`;
   - UI flows that could break login / startup: extend `scripts/smoke-ui.mjs`.
4. Run everything before pushing:
   ```bash
   npm test            # server suites + desktop unit tests
   npm run smoke-ui    # needs a desktop session (Electron window)
   ```
5. Update the docs (`README.md`, `docs/`, `CHANGELOG.md` under *Unreleased*) when behaviour or configuration changes.
6. Open a pull request using the template; describe *what* and *why*, and how you tested it.

## Code style

- Plain modern JavaScript (ES modules on the server, React function components in the UI). No TypeScript, no build step for the server.
- Match the surrounding code: naming, comment density, small focused functions.
- Comments in the existing code are mostly in **Vietnamese**; new comments may be in Vietnamese or English.
- User-visible strings are written in Vietnamese in the UI and translated in `desktop/src/i18n.js` — add the English entry for new strings.
- See `.editorconfig` (2-space indentation, LF line endings, UTF-8).

## Security-sensitive changes

Changes to cryptography (`desktop/src/crypto.js`, `ratchet.js`), authentication, sessions, the Content-Security-Policy
or anything that changes what the server can see need extra review. Explain the threat model impact in the pull request and
update [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

## Licensing of contributions

ReaChat is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution you agree that it is licensed under
the same terms (Apache-2.0 section 5) and that you have the right to submit it.
