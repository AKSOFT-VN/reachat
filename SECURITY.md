# Security policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately by either:

- GitHub: **Security → Report a vulnerability** on this repository (private advisory), or
- Email: **khiem.nt@aksoft.vn** (subject: `[ReaChat security] …`)

Please include: affected version / commit, a description of the issue and its impact, and steps or a proof of concept to reproduce it.

We will acknowledge your report within **3 working days**, keep you informed while we investigate, and credit you in the release
notes when the fix ships (unless you prefer to stay anonymous). Please give us a reasonable time to fix the issue before public disclosure
— we aim for **90 days** or less.

## Supported versions

Security fixes are made on the latest release only. Self-hosters should update to the newest version;
the desktop app updates itself from your server.

## Scope

In scope: the server (`server/`), the desktop / web app (`desktop/`), the deployment scripts (`deploy/`, `scripts/`),
and the cryptographic design described in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

Known limitations already documented in the security model (for example: no X3DH prekeys yet, the server sees metadata,
the web app is served by the server) are not considered new vulnerabilities — but proposals to fix them are very welcome.

## Safe harbour

We will not take legal action against good-faith research that respects users' privacy, avoids data destruction and service
disruption, and only tests against your own installation or accounts you own.
