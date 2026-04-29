# strava-mcp-server — Implementation Plan

> Working document. Delete once the project is shipped.

## Goal

A self-hosted Cloudflare Worker MCP server exposing Strava activity data as tools for Claude. Single-user, OAuth 2.1 to Claude, OAuth 2.0 to Strava. Built using `oura-mcp-server` as a structural template.

---

## Part 1 — Audit of `oura-mcp-server` (the template)

### What's done well — keep these patterns

**Architecture**

- Clean file boundaries: `index.ts` (Worker entry + JSON-RPC dispatch), `<api>.ts` (external API client, single responsibility), `cache.ts` (D1 cache), `tools.ts` (MCP tool defs), `ui.ts` (HTML pages). Each file is independently testable.
- `handleMcp()` exported as a named function so tests bypass the OAuth wrapper. Big win for test coverage without mocking the OAuth provider.
- HTTP→HTTPS rewrite in the default export so ngrok-fronted dev servers don't advertise `http://` discovery URLs.

**Bootstrap wizard (`scripts/bootstrap.ts`)**

- Genuinely the best part of the template. Worth porting wholesale:
  - Idempotent — every step checks for existing resources before creating.
  - Read-only checks first, then a "Ready to provision" banner with explicit `Y/n` before any mutation.
  - Auto-detects missing `workers.dev` subdomain on first deploy and recovers (opens browser, prompts to register, retries once).
  - Numbered steps with consistent status markers (`✓ • ! ✗`).
  - ANSI colors built without dependencies (`scripts/prompts.ts` — copy as-is).
  - Hidden password input via raw stdin mode, with backspace handling and Ctrl+C escape.
  - SIGINT handler kills the `wrangler login` child cleanly.
  - State split: `.dev.vars` for Worker-bound vars, `.bootstrap-state` for script-only state (CF account ID). Prevents `wrangler types` from generating spurious type fields.

**Cache strategy (`src/cache.ts`)**

- Per-day rows enable partial cache hits — a 7-day query with 5 cached days only fetches 2.
- Three-tier TTL (today/yesterday/older) accounts for retroactive data adjustment.
- Empty responses never cached — avoids serving stale emptiness while data is still syncing.
- Writes via `ctx.waitUntil()` are non-blocking.
- Two bypass paths: `?no_cache` query param (per-request, useful for smoke tests) and `skip_cache: true` tool argument (per-call, surface-able to the LLM).

**Tooling**

- oxlint (fast, replaces eslint) + Prettier (no-semi, 100-char) + lefthook (parallel pre-commit).
- Volta pins Node 24 / pnpm 10 in `package.json`.
- Vitest with v8 coverage at 90% threshold.
- `cloudflare:workers` import is aliased to a stub in `vitest.config.ts`; `@cloudflare/workers-oauth-provider` is forced through Vite's pipeline so the alias propagates to its internal imports.
- `worker-configuration.d.ts` is gitignored; CI regenerates it via `cf-typegen` after dropping placeholder vars into `.dev.vars`.

**Docs**

- README has Bootstrap → Connect → Local dev → Smoke testing → Manual deploy → Tool reference → Troubleshooting → Project structure. The "Full OAuth flow (cURL PKCE)" block is fully automated and worth keeping.
- CLAUDE.md captures big-picture architecture in ~200 lines — what an instance needs to be productive, not what they can `ls` to find.

### Areas to improve — fix in this build

1. ~~**No retry/backoff on external API calls.**~~ ✅ Fixed in `oura-mcp-server` (`fix/security-and-retry`): exponential backoff on 5xx (1s, 2s), 429 respects `Retry-After` (capped 60s), max 2 retries. Port `ouraget` pattern directly to `stravaFetch` — Strava also needs `X-RateLimit-Usage` header capture added on top.

2. **No structured error context.** Errors throw plain strings. Adding a request ID and including it in error responses makes Cloudflare dashboard log correlation trivial.

3. **`/health` is static.** Doesn't actually check D1 or KV. A real health check that verifies bindings (`SELECT 1` on D1, `get('__health__')` on KV) catches misconfiguration before users hit it.

4. **`fetchFromOura()` switch statement** couples MCP layer to specific tool names. A registry map (`{ tool_name → fetcher_fn }`) is cleaner and removes the dead-code default case.

5. **Tool description duplication.** Every tool repeats the inclusive-end-date convention. Helper functions or a description-builder would DRY this up.

6. **Generated types in CI are fragile.** The `printf '...' > .dev.vars` in CI to coerce consistent type generation works but is brittle. Better: declare all expected vars in `wrangler.example.jsonc` under `vars` so `cf-typegen` is deterministic without `.dev.vars` shenanigans.

7. **Cache schema has no metadata column.** No way to invalidate selectively (e.g. "drop everything from API v1"). Add a `schema_version` or `source_version` column upfront.

8. **Hardcoded `userId: "owner"`** in `completeAuthorization`. Fine for personal tool, but a constant named `OWNER_USER_ID` documents intent better than a magic string.

9. **No request-scoped logging.** Cloudflare observability captures invocations, but adding a `console.log({requestId, tool, durationMs, cacheStatus})` line per tool call makes debugging 10× faster.

10. **`scripts/connect-local.ts` and `scripts/bootstrap.ts` duplicate prompt logic.** Could share a `promptCredentials()` helper. Not urgent.

---

## Part 2 — What's different about Strava

### Auth model

| Concern              | Oura                         | Strava                                                   |
| -------------------- | ---------------------------- | -------------------------------------------------------- |
| Token type           | Personal Access Token (PAT)  | OAuth 2.0 access + refresh                               |
| User registers app?  | No                           | Yes — at strava.com/settings/api                         |
| Token lifetime       | ~3 months                    | Access: 6h. Refresh: long-lived (rotates on use rarely)  |
| Server-side refresh? | No                           | Yes — required                                           |
| Initial token grant  | Paste from web page          | Browser OAuth flow (authorize → redirect → exchange)     |

**Implication:** Bootstrap can't just prompt for a token — it needs to run the OAuth flow.

### Bootstrap-time OAuth flow

The wizard launches a temp HTTP listener on `localhost:9999`, opens the Strava authorize URL in the browser, captures the callback, exchanges code for tokens. This is a one-time cost — refresh tokens persist across deploys.

```
User → bootstrap.ts
  ↓ prompts for client_id + client_secret (from their Strava app)
  ↓ spawns temp http server on :9999
  ↓ opens browser to https://www.strava.com/oauth/authorize?...&redirect_uri=http://localhost:9999/callback
  ↓ user clicks "Authorize" in browser
  ↓ Strava redirects to localhost:9999/callback?code=...
  ↓ bootstrap captures code, POSTs to https://www.strava.com/oauth/token
  ↓ receives access_token + refresh_token + expires_at
  ↓ stores refresh_token + client_id + client_secret as CF secrets
  ↓ stores access_token + expiry in KV (as initial cached token)
```

**Strava app config requirement:** The user's Strava app must have `localhost` as the Authorization Callback Domain. We document this in the bootstrap walkthrough.

### Refresh token storage

**Decision: store refresh token in KV, not as a Worker secret.**

Why: Cloudflare Workers cannot update their own secrets at runtime. Strava's docs say refresh tokens are "long-lived" but in rare cases they rotate on use. If they do and we can't write the new value, the server breaks.

Storing in KV makes refresh token rotation seamless. Initial value is written by bootstrap; subsequent refreshes can write back. We protect it with a unique key prefix.

**Storage layout:**

```
KV namespace: OAUTH_KV (shared with @cloudflare/workers-oauth-provider)

Keys:
  strava:refresh_token       → string (rotates rarely)
  strava:access_token        → { token: string, expires_at: number }
  strava:client_id           → string (rarely changes; could be Worker secret instead)
  strava:client_secret       → string (must be confidential — Worker secret)

Worker secrets (wrangler secret put):
  STRAVA_CLIENT_ID
  STRAVA_CLIENT_SECRET
  MCP_AUTH_PASSWORD
```

Actually, simpler split: `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` as Worker secrets (stable, set once); `strava:refresh_token` and `strava:access_token` in KV (mutable). Lean toward this.

### Token refresh logic

- On each tool call: check cached access token's `expires_at`. If `now + 60s > expires_at`, refresh.
- Refresh response includes a new access token, new expiry, and *possibly* a new refresh token. Always write back if returned.
- Use a KV-based mutex (write-then-read) or accept that occasional concurrent refreshes are fine — they'll just produce slightly different access tokens, both valid.

### Rate limits

Strava: **100 requests per 15 minutes, 1000 per day.** Both read+write combined.

Headers returned on every response:

- `X-RateLimit-Usage: 25,300` (15min usage, daily usage)
- `X-RateLimit-Limit: 100,1000`

**Implications for cache strategy:**

- Cache hit ratio matters more here than for Oura. Bias TTLs longer.
- Surface rate limit usage in tool responses (e.g. as `_rate_limit` field alongside `_cache`).
- Implement exponential backoff with `Retry-After` respect (Strava 429 includes this header).

### Data shape — activity-centric, not date-centric

Oura's data is fundamentally per-day. Strava's is per-activity. This breaks the per-day cache row pattern.

**Hybrid cache schema:**

| Cache type        | Key                               | TTL                | Why                                                        |
| ----------------- | --------------------------------- | ------------------ | ---------------------------------------------------------- |
| Activity list     | `list:{after}-{before}`           | 5m today / 1h older | List can change as new activities sync; older lists stable |
| Activity detail   | `activity:{id}`                   | 7d                 | Once recorded, activities rarely change                    |
| Activity streams  | `streams:{id}:{keys}`             | 7d                 | Immutable once activity exists                             |
| Athlete profile   | `athlete`                         | 24h                | Profile changes are rare                                   |
| Athlete stats     | `stats`                           | 1h                 | Updates as activities sync                                 |
| Athlete zones     | `zones`                           | 24h                | Set in app, rarely changes                                 |
| Gear              | `gear:{id}`                       | 24h                | Mileage updates as activities sync                         |

Schema:

```sql
CREATE TABLE IF NOT EXISTS strava_cache (
  cache_type   TEXT    NOT NULL,    -- 'list' | 'activity' | 'streams' | 'athlete' | etc.
  cache_key    TEXT    NOT NULL,    -- '2026-04-01_2026-04-07' or '12345678' or '__singleton__'
  data         TEXT    NOT NULL,    -- JSON
  fetched_at   INTEGER NOT NULL,    -- Unix ms
  schema_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (cache_type, cache_key)
);
```

### Tools (initial scope)

Start with 6, add gear/segments later if useful:

| Tool                       | Returns                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `strava_list_activities`   | Activity list for date range (id, type, distance, time, summary) |
| `strava_activity_detail`   | Full activity by ID (laps, splits, segment efforts)              |
| `strava_activity_streams`  | Time-series (HR, watts, cadence, etc.) — opt-in, downsampled     |
| `strava_athlete_profile`   | Basic athlete info (FTP, weight, gear)                           |
| `strava_athlete_stats`     | YTD totals, all-time totals, recent totals                       |
| `strava_athlete_zones`     | HR zones and power zones                                         |

**Streams handling:** Stream payloads can be tens of thousands of points. Default to summary stats (min/max/avg/percentiles). Full stream only if `include_full_streams: true` is passed and `resolution: 'low'` (Strava supports `low`/`medium`/`high`).

### Date conversion

Strava's `before`/`after` filters use Unix timestamps, not `YYYY-MM-DD`. We accept the Oura-style inclusive-date contract from callers and convert internally.

```
caller: end_date: "2026-04-25"
        ↓
worker: before = unixOf("2026-04-26 00:00:00Z")  (next day midnight UTC = inclusive)
        after  = unixOf("2026-04-19 00:00:00Z")
```

Note: activity timestamps come back with `start_date_local` (local TZ). The `start_date` field is UTC. We pass through both — let the LLM use whichever is appropriate.

### Privacy note for docs

The MCP server holds the user's full Strava token. It can read private activities, follower lists, etc. README should call this out — no different from giving any third-party app full access, but worth being explicit since the data is uniquely identifying (location traces).

---

## Part 3 — Implementation phases

### Phase 0 — Repo skeleton (today)

- [x] `git init` at `~/Dev/strava-mcp-server`
- [x] This `IMPLEMENTATION_PLAN.md`
- [ ] Copy template files: `package.json`, `tsconfig.json`, `tsconfig.scripts.json`, `vitest.config.ts`, `.oxlintrc.json`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `lefthook.yml`, `LICENSE`
- [ ] Adapt `package.json` (rename, drop Oura deps, keep dev deps)
- [ ] Initial commit: "skeleton from oura-mcp-server template"

### Phase 1 — Auth + token refresh (the hard part, do it first)

- [ ] `src/auth.ts` — Strava OAuth helpers:
  - `getAccessToken(env)` — reads cached token from KV, refreshes if near expiry
  - `refreshAccessToken(env, refreshToken)` — POSTs to `/oauth/token`, writes back access token + refresh token to KV
- [ ] Unit tests with mocked `fetch` covering: fresh token cached, expired token triggers refresh, refresh response with new refresh_token writes both, refresh failure surfaces clear error
- [ ] No external API calls yet — just the auth layer

### Phase 2 — Strava API client

- [ ] `src/strava.ts` — one function per endpoint we expose
- [ ] Shared `stravaFetch(env, path, params)` that:
  - Calls `getAccessToken(env)` for auth
  - Retry/backoff pattern: port directly from `ouraget` in oura template (already tested)
  - Surfaces a clear "token expired/revoked" message on 401
  - Captures `X-RateLimit-Usage` and `X-RateLimit-Limit` response headers, attaches as `_rate_limit` to result
- [ ] Stream noise stripping (downsample / summary stats)
- [ ] Unit tests

### Phase 3 — MCP layer

- [ ] `src/index.ts` — copy from oura template
- [ ] `src/tools.ts` — define 6 tools
- [ ] `src/cache.ts` — adapt to multi-key-type schema
- [ ] `src/ui.ts` — copy login/success pages, swap branding (security headers via `HTML_HEADERS` constant already in template — copy as-is)
- [ ] `migrations/001_init.sql` — new schema
- [ ] Wire up `handleMcp` for the new tool registry

### Phase 4 — Bootstrap script

- [ ] Copy `scripts/prompts.ts` and `scripts/utils.ts` as-is
- [ ] `scripts/bootstrap.ts`:
  - Steps 1–7 same as Oura (CF auth, account pick, D1, KV, wrangler.jsonc, types, schema)
  - Step 8 NEW: Strava app registration walkthrough — open `https://strava.com/settings/api`, prompt for `client_id` + `client_secret`
  - Step 9 NEW: Browser OAuth flow with temp `localhost:9999` listener (Node `http` module)
  - Step 10 NEW: Store refresh token in KV via `wrangler kv key put`
  - Step 11: MCP password (same as Oura)
  - Step 12–13: Deploy + secrets
- [ ] `scripts/connect-local.ts` — same pattern, writes to `.dev.vars` and local Miniflare KV
- [ ] `scripts/revoke.ts` — copy as-is (with local fallback)

### Phase 5 — Tests + CI

- [ ] Port test infrastructure (`mocks/`, `vitest.config.ts`)
- [ ] Auth tests, Strava API tests, cache tests, MCP routing tests
- [ ] Aim for 90% coverage from day one
- [ ] `.github/workflows/ci.yml` — port from Oura, swap placeholder env vars
- [ ] `.github/pull_request_template.md` — copy

### Phase 6 — Docs

- [ ] `README.md` — adapt structure, swap Strava-specific bits, include the privacy callout
- [ ] `CLAUDE.md` — write from scratch, capturing Strava-specific gotchas (token refresh, rate limits, stream sizes)
- [ ] `SECURITY.md` — copy from Oura
- [ ] Smoke test cURL block — adapt for Strava (same OAuth-to-MCP flow, just different tool names)

### Phase 7 — Ship

- [ ] Initial deploy via `pnpm bootstrap` (validates the wizard end-to-end)
- [ ] Smoke test against deployed Worker
- [ ] Connect to Claude.ai, validate all tools
- [ ] Create GitHub repo (`gh repo create loganmurphy/strava-mcp-server --public --source=.`)
- [ ] Delete this file

---

## Open questions / decision points

1. **GitHub repo public or private?** — Same as Oura (public, MIT) seems consistent with the personal-tool-but-template philosophy.

2. **Streams: opt-in flag or always summary?** — Lean toward summary by default, full streams on `include_full_streams: true` flag (similar to `skip_cache`).

3. **Webhook subscriptions for new-activity push?** — Out of scope for v1. Polling on demand is fine for an LLM tool.

4. **Should the bootstrap detect & guide Strava app creation?** — Yes, but we can't automate it (no API). Open the page, prompt for `client_id`/`client_secret`, give clear instructions about callback domain = `localhost`.

5. **Multi-tenant?** — No. Single user. Same as Oura.

6. **Activity pagination** — Strava's `per_page` max is 200. Most users won't need more in a single tool call. Default `per_page=200`, expose `page` arg.

---

## Notes from the Oura experience worth carrying forward

- **Don't conflate `.dev.vars` with script state.** Strava bootstrap will have several piece of state that aren't Worker bindings (Strava app callback domain, last successful refresh, etc.). Use `.bootstrap-state` for those.
- **Test the bootstrap from a clean machine** before merging. The whole point of the wizard is hand-holding; the only way to know it works is to wipe state and try.
- **Empty cache responses for in-progress data.** Strava activities take ~5 min to sync after upload. Today's activity list should have a short TTL.
- **Plan for the OAuth callback subtleties early.** The hidden iframe pattern in `ui.ts` is for the Claude → MCP OAuth flow; the bootstrap's localhost listener is for the MCP → Strava OAuth flow. They're independent but easy to confuse.
