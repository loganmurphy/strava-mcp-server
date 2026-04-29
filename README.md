# strava-mcp-server

[![CI](https://img.shields.io/github/actions/workflow/status/loganmurphy/strava-mcp-server/ci.yml?label=CI)](https://github.com/loganmurphy/strava-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A lightweight [Model Context Protocol](https://modelcontextprotocol.io) server that exposes your [Strava](https://strava.com) data as tools for Claude. Runs on Cloudflare Workers with a D1 cache layer for fast repeated queries.

Tested with **Claude.ai (web), Claude Desktop, and Claude mobile** via `claude.ai/settings/connectors`. Any MCP client that supports OAuth 2.1 remote servers should work — though only Claude is officially tested and the bootstrap wizard targets Claude exclusively.

## Architecture

```
Claude (web / desktop / mobile)
     │  OAuth 2.1 (PKCE) — password login
Cloudflare Worker  (@cloudflare/workers-oauth-provider)
     ├─ KV       MCP OAuth tokens + Strava access/refresh tokens
     ├─ D1       cache (5m activity lists / 24h activities & streams / 1h stats)
     └─ Strava API  fetched only on cache miss; auto-refreshes expired tokens
```

Strava access tokens expire every 6 hours. The Worker refreshes them automatically via the stored refresh token — no redeployment required.

## Requirements

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier)
- [Strava API application](https://www.strava.com/settings/api) — set Authorization Callback Domain to `localhost`
- Node.js 24, pnpm 10 — [Volta](https://volta.sh) recommended (versions pinned in `package.json`)

## Bootstrap

```bash
pnpm install
pnpm bootstrap
```

The wizard handles everything:

1. Sign in to Cloudflare via `wrangler login`
2. Select your account and preview what will be created
3. Create D1 (`strava-cache`) and KV (`strava-oauth`) — or reuse if they exist
4. Prompt for Strava Client ID + Secret, then run the Strava OAuth flow
5. Prompt for a password for the MCP login page
6. Deploy the Worker and set secrets
7. Copy the MCP URL to your clipboard and open `claude.ai/settings/connectors` (first run only)

Re-running is fully idempotent.

### Local dev first?

```bash
pnpm connect-local   # runs Strava OAuth flow, applies local D1 schema, guides ngrok setup
pnpm dev             # keep running in a separate terminal
```

Run `pnpm bootstrap` when ready to deploy.

---

## Connect

All clients connect to the same MCP endpoint. `pnpm bootstrap` copies this URL to your clipboard on completion:

```
https://strava-mcp-server.<your-subdomain>.workers.dev/mcp
```

Customize → [Connectors](https://claude.ai/customize/connectors) → Add custom connector → paste URL → Connect → enter password → Authorize.

After connecting, click **Configure** on the Strava connector and set each tool to **Allow** — otherwise Claude may ask for permission on every use.

> Setup must be done on [claude.ai](https://claude.ai) (web) — the mobile app doesn't support adding connectors. Once added via web, it's available across all Claude clients.

---

## Local development

```bash
cp wrangler.example.jsonc wrangler.jsonc   # fill in YOUR_KV_NAMESPACE_ID + YOUR_DATABASE_ID
pnpm install && pnpm cf-typegen
cp .dev.vars.example .dev.vars             # fill in Strava credentials + MCP password
npx wrangler d1 execute strava-cache --local --file=./migrations/001_init.sql
pnpm dev   # http://localhost:8787
```

You also need to run the Strava OAuth flow to populate the local KV with tokens:

```bash
pnpm connect-local   # handles OAuth flow and writes tokens to local KV
```

### Testing with ngrok

Claude.ai (web/mobile) requires HTTPS. Use ngrok to expose the local dev server:

```bash
brew install ngrok/ngrok/ngrok
ngrok config add-authtoken YOUR_TOKEN   # free at ngrok.com

pnpm dev             # terminal 1
ngrok http 8787      # terminal 2 → https://xxxx.ngrok-free.app
```

Add `<ngrok-url>/mcp` as a custom connector at `claude.ai/customize/connectors`.

> Free tier URLs change on restart — re-add the connector in Claude when that happens.

---

## Smoke testing

```bash
BASE=https://strava-mcp-server.<subdomain>.workers.dev   # or http://localhost:8787

# Server reachable
curl -s $BASE/.well-known/oauth-authorization-server | jq .
curl -s $BASE/health

# Unauthenticated call returns 401 — expected
curl -s -X POST $BASE/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .
```

### Full OAuth flow (cURL PKCE)

No browser required — curl handles the full flow end-to-end. Run this as one block:

```bash
# Prompt for password — avoids storing it in shell history
printf "MCP password: " && read -s MCP_PASSWORD && echo

# 1. Register a client
CLIENT=$(curl -s -X POST $BASE/oauth/register -H "Content-Type: application/json" \
  -d '{"client_name":"curl-test","redirect_uris":["http://localhost:9999/callback"],
       "grant_types":["authorization_code"],"response_types":["code"],
       "token_endpoint_auth_method":"none"}')
CLIENT_ID=$(echo $CLIENT | jq -r .client_id)

# 2. PKCE challenge
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-43)
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')

# 3. GET the login form, then POST the password to complete authorization
FORM_HTML=$(curl -s "$BASE/authorize?client_id=$CLIENT_ID&response_type=code&redirect_uri=http://localhost:9999/callback&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256&state=test")
OAUTH_PARAMS=$(echo "$FORM_HTML" | grep -o 'name="oauth_params" value="[^"]*"' | sed 's/name="oauth_params" value="//;s/"$//' | sed 's/&amp;/\&/g')
AUTH_PAGE=$(curl -s -X POST $BASE/authorize \
  --data-urlencode "oauth_params=$OAUTH_PARAMS" \
  --data-urlencode "password=$MCP_PASSWORD")

# Extract and decode the auth code from the success page iframe
RAW_CODE=$(echo "$AUTH_PAGE" | grep -o 'code=[^&"]*' | head -1 | sed 's/code=//')
AUTH_CODE=$(node -e "process.stdout.write(decodeURIComponent(process.argv[1]))" "$RAW_CODE")

# 4. Exchange code for token
TOKEN=$(curl -s -X POST $BASE/oauth/token \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$AUTH_CODE" \
  --data-urlencode "redirect_uri=http://localhost:9999/callback" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "code_verifier=$CODE_VERIFIER" \
  | jq -r .access_token)
echo "Token: ${TOKEN:0:30}..."

# 5. Call a tool
curl -s -X POST $BASE/mcp -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"strava_list_activities","arguments":{"start_date":"2024-01-01","end_date":"2024-01-31"}}}' | jq .
```

---

## Manual deploy

If you prefer not to use `pnpm bootstrap`:

```bash
npx wrangler login
npx wrangler d1 create strava-cache
npx wrangler kv namespace create strava-oauth
# paste both IDs into wrangler.jsonc
npx wrangler d1 execute strava-cache --remote --file=./migrations/001_init.sql
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put MCP_AUTH_PASSWORD
pnpm deploy
# then write Strava tokens to KV manually:
npx wrangler kv key put strava:access_token '{"token":"...","expires_at":...}' --namespace-id <kv-id>
npx wrangler kv key put strava:refresh_token 'your_refresh_token' --namespace-id <kv-id>
```

---

## Tool reference

All date params optional, default to last 7 days (YYYY-MM-DD). `end_date` is always **inclusive**.

| Tool                          | Returns                                           |
| ----------------------------- | ------------------------------------------------- |
| `strava_list_activities`      | Activity list with distance, time, HR, pace/power |
| `strava_get_activity`         | Full activity detail with splits and best efforts |
| `strava_get_activity_streams` | Stream metadata (series_type, resolution, size)   |
| `strava_get_athlete_profile`  | Profile, location, FTP                            |
| `strava_get_athlete_stats`    | YTD and all-time totals by sport                  |
| `strava_get_athlete_zones`    | HR and power zones                                |

All tools accept `skip_cache` (bool) to force a fresh fetch.

`strava_get_activity_streams` accepts `stream_keys` (comma-separated). Available: `time`, `distance`, `altitude`, `velocity_smooth`, `heartrate`, `cadence`, `watts`, `temp`, `moving`, `grade_smooth`, `latlng` (excluded by default — contains GPS traces).

---

## Troubleshooting

**Tools not appearing** — remove and re-add the connector at `claude.ai/customize/connectors`.

**Strava 401 / token rejected** — run `pnpm bootstrap` again to re-authorize with Strava.

**Today's activities missing** — Strava may not have synced yet. Use `skip_cache: true` to check.

**Rotate MCP password** — `npx wrangler secret put MCP_AUTH_PASSWORD`, then `pnpm revoke` (invalidates Claude sessions so it re-auths with the new password; Strava tokens are preserved).

**Port 9999 in use (bootstrap OAuth)** — close whatever is using it and re-run `pnpm bootstrap`.

**`pnpm bootstrap` fails at Cloudflare login** — run `npx wrangler login` manually first.

---

## Project structure

```
src/
  index.ts          Worker entry — OAuth wrapper, /mcp dispatch, auth UI
  cache.ts          D1 cache (type-aware TTLs)
  strava.ts         Strava API client + retry/backoff + rate limit tracking
  auth.ts           Strava token refresh logic (reads/writes OAUTH_KV)
  tools.ts          MCP tool definitions
  ui.ts             Login and success page HTML
scripts/
  bootstrap.ts      Setup wizard (D1, KV, Strava OAuth, Worker deploy, secrets)
  connect-local.ts  Credentials + D1 schema + Strava OAuth for local dev
  strava-auth.ts    Strava OAuth flow helper (localhost:9999 callback server)
  revoke.ts         Purge MCP OAuth tokens to force re-auth (preserves Strava tokens)
migrations/
  001_init.sql      D1 schema
```
