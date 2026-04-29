# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report them privately via [GitHub Security Advisories](https://github.com/loganmurphy/strava-mcp-server/security/advisories/new). You'll get a response within 7 days.

Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (or a proof-of-concept)
- Any suggested mitigations if you have them

## Scope

**In scope:**

- The Cloudflare Worker (`src/`)
- The D1 cache layer and how data is stored/retrieved
- The OAuth authorization flow and token storage (`OAUTH_KV`)
- The bootstrap wizard's handling of API tokens and secrets (`scripts/`)
- Strava token refresh logic and KV storage

**Out of scope:**

- Strava's own API or app (report to Strava directly)
- Cloudflare's platform (report via [Cloudflare's bug bounty](https://hackerone.com/cloudflare))

## Supported versions

Only the latest commit on `main` is actively maintained.

## Trust model

This is a single-user personal tool. The MCP_AUTH_PASSWORD is the only auth gate between the public internet and your Strava data. A compromised Cloudflare account fully compromises this server. Strava tokens are stored in OAUTH_KV (encrypted at rest by Cloudflare).
