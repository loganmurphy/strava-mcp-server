# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Start local dev server on http://localhost:8787 (Miniflare, hot reload)
pnpm deploy       # Deploy to Cloudflare Workers (requires wrangler login)
pnpm cf-typegen   # Regenerate worker-configuration.d.ts from wrangler.jsonc bindings
pnpm bootstrap      # Interactive wizard — provisions D1, KV, runs Strava OAuth, deploys Worker
pnpm connect-local  # Set up local credentials + D1 schema + Strava OAuth (no Cloudflare needed)
pnpm revoke         # Invalidate all active MCP OAuth sessions (preserves Strava tokens)
pnpm reset          # Clear .dev.vars + .bootstrap-state + wrangler.jsonc (local state only)
pnpm format         # Prettier (write)
pnpm format:check   # Prettier (check only — used by pre-commit hook)
pnpm lint           # oxlint
pnpm test           # Vitest unit tests
pnpm coverage       # Vitest + v8 coverage (≥90% threshold)
npx tsc --noEmit -p tsconfig.scripts.json   # Type-check scripts
npx tsc --noEmit                             # Type-check the Worker
```

## Code style

Prettier enforces formatting on every commit (`pnpm format:check` runs in the pre-commit hook). Config: no semis, trailing commas, 100-char print width. Run `pnpm format` to auto-fix before committing.

No section-header comments (`// ── Foo ────`). Comments only where behavior is non-obvious.

Pre-commit hooks are managed by **lefthook** (`lefthook.yml`). They run lint + both typechecks in parallel before every commit.

D1 migrations:

```bash
npx wrangler d1 execute strava-cache --local --file=./migrations/001_init.sql   # local
npx wrangler d1 execute strava-cache --remote --file=./migrations/001_init.sql  # production
```

`wrangler.jsonc` is gitignored — copy from the template:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Local secrets live in `.dev.vars` (gitignored). A committed `.dev.vars.example` documents all required vars:

```
STRAVA_CLIENT_ID=your_strava_client_id
STRAVA_CLIENT_SECRET=your_strava_client_secret
MCP_AUTH_PASSWORD=your_mcp_password
```

Bootstrap state (Cloudflare account ID, KV namespace ID) lives in `.bootstrap-state` (gitignored).

## Architecture

There is no build step. Wrangler bundles `src/index.ts` directly via esbuild on `dev`/`deploy`.

### Two OAuth layers

This server has two distinct OAuth flows:

1. **MCP auth** (`@cloudflare/workers-oauth-provider`) — gates Claude's access to the `/mcp` endpoint via password login. Tokens stored in `OAUTH_KV` by the library.

2. **Strava auth** (`src/auth.ts`) — the Worker's identity with Strava API. Access tokens expire every 6h and are refreshed automatically via a stored refresh token. Both tokens live in `OAUTH_KV` under `strava:access_token` and `strava:refresh_token`. They're stored in KV so the Worker can rotate them at runtime. `STRAVA_REFRESH_TOKEN` is also set as a Worker secret by `pnpm bootstrap` as a fallback — `getAccessToken()` falls back to it if KV is empty, then writes the rotated tokens back to KV.

### Request flow

```
POST /mcp  (with Bearer token)
  → OAuthProvider.fetch()         verify MCP token in OAUTH_KV
      → McpApiHandler.fetch()     single /mcp route
          → handleMcp()           parse JSON-RPC, route by method
              → tools/list        return STRAVA_TOOLS (all 6) from tools.ts
              → tools/call        switch dispatch to per-tool handler
                  → getCached()   D1 lookup by (cache_type, cache_key)
                  → stravaFetch() on miss — calls getAccessToken() which auto-refreshes

GET /authorize  → defaultHandler  render password form (HTML)
POST /authorize → defaultHandler  validate MCP_AUTH_PASSWORD, completeAuthorization() → redirect
/oauth/token    → OAuthProvider   token exchange (handled internally)
/oauth/register → OAuthProvider   dynamic client registration (handled internally)
```

### Cache strategy (`src/cache.ts`)

Single-entry cache keyed by `(cache_type, cache_key)` — no per-day row merging like oura-mcp-server. TTLs:

- `activity_list` — 5m (new workout may just have synced)
- `activity` — 24h (stable after creation)
- `activity_zones` — 24h (stable after creation)
- `stats` — 1h (updates after each activity)
- `gear` — 1h (distance updates after each tagged activity)
- `zones` — 24h (only changes when user edits settings)

Cache keys:
- `activity_list`: `{startDate}_{endDate}_p{page}_{perPage}` (default strings when absent)
- `activity`, `activity_zones`: activity ID
- `gear`: gear ID
- `stats`, `zones`: `SINGLETON_KEY` (`__singleton__`)

Cache bypass: `skip_cache: true` tool argument (per-call) or `?no_cache` query param (per-request).

### Strava API (`src/strava.ts`)

`stravaFetch` wraps all API calls with:
- Automatic token retrieval via `getAccessToken(env)` on every request
- Retry/backoff: `Retry-After` header on 429, exponential (1s, 2s) on 5xx, max 2 retries
- Rate limit capture: `X-RateLimit-Usage` + `X-RateLimit-Limit` parsed into every `StravaResponse`

`stripActivityNoise` removes the `map` polyline field (large, not useful for text analysis).

`getAthleteStats` fetches `/athlete` first to get the ID, then `/athletes/{id}/stats`.

### Tools (`src/tools.ts`)

6 tools: `strava_list_activities`, `strava_get_activity`, `strava_get_athlete_stats`, `strava_get_athlete_zones`, `strava_get_activity_zones` (requires Strava Summit subscription — returns 402 for free accounts), `strava_get_gear`.

Adding a tool: add the fetch function in `strava.ts`, add the `ToolDef` to `STRAVA_TOOLS` in `tools.ts`, add a `case` in `handleMcp` in `index.ts`. Use `handleKeyedFetch` for tools keyed by an ID (activity, gear) or `handleSingleton` for tools with no key (stats, zones) — do not inline the cache logic.

### Testing

Tests call `handleMcp` directly (bypassing OAuth) for MCP logic. Routing tests that call `worker.fetch()` only exercise the `defaultHandler` routes and the OAuthProvider's 401 behavior.

`src/__tests__/mocks/cloudflare-workers.ts` provides a minimal `WorkerEntrypoint` stub — `cloudflare:workers` is not available in Node's ESM loader.

CI uses `cp .dev.vars.example .dev.vars` (committed file) instead of a fragile `printf` command.

### Scripts (`scripts/`)

`scripts/strava-auth.ts` contains the reusable Strava OAuth flow: starts a localhost:9999 HTTP server, opens a browser, captures the authorization code, exchanges it for tokens. Used by both `bootstrap.ts` and `connect-local.ts`.

`scripts/bootstrap.ts` authenticates to Cloudflare entirely via `wrangler login` — no Cloudflare SDK. All resource provisioning goes through wrangler CLI commands.

`scripts/revoke.ts` deletes only MCP OAuth tokens from KV (keys without the `strava:` prefix), preserving Strava tokens.
