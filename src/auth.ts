// Strava token management.
//
// Strava issues short-lived access tokens (6h) backed by long-lived refresh tokens.
// Access tokens are cached in OAUTH_KV under `strava:access_token`.
// Refresh tokens are stored in OAUTH_KV under `strava:refresh_token` so the Worker
// can write back a rotated value without requiring a redeployment (Worker secrets
// are not writable at runtime).
//
// Bootstrap writes the initial tokens; this module handles all subsequent refreshes.

const ACCESS_TOKEN_KEY = "strava:access_token"
const REFRESH_TOKEN_KEY = "strava:refresh_token"
const REFRESH_URL = "https://www.strava.com/oauth/token"

// Refresh this many seconds before actual expiry to avoid races.
const EXPIRY_BUFFER_SECS = 60

interface CachedAccessToken {
  token: string
  expires_at: number // Unix seconds (matches Strava's field name)
}

interface RefreshResponse {
  access_token: string
  refresh_token: string
  expires_at: number
}

export interface StravaAuthEnv {
  OAUTH_KV: KVNamespace
  STRAVA_CLIENT_ID: string
  STRAVA_CLIENT_SECRET: string
  // Local dev only — set in .dev.vars by `pnpm connect-local` as a fallback
  // when the local KV store hasn't been seeded. After the first successful
  // refresh the rotated token is written to KV and this var is no longer used.
  STRAVA_REFRESH_TOKEN: string
}

export async function getAccessToken(env: StravaAuthEnv): Promise<string> {
  const cached = await env.OAUTH_KV.get(ACCESS_TOKEN_KEY)
  if (cached) {
    const { token, expires_at } = JSON.parse(cached) as CachedAccessToken
    if (Math.floor(Date.now() / 1000) < expires_at - EXPIRY_BUFFER_SECS) {
      return token
    }
  }

  const refreshToken = (await env.OAUTH_KV.get(REFRESH_TOKEN_KEY)) || env.STRAVA_REFRESH_TOKEN || null
  if (!refreshToken) {
    throw new Error(
      "Strava refresh token not found. Run `pnpm connect-local` (local dev) or `pnpm bootstrap` (production).",
    )
  }

  return refreshAccessToken(env, refreshToken)
}

// Strava may rotate the refresh token on use — always write back whatever the response includes.
export async function refreshAccessToken(env: StravaAuthEnv, refreshToken: string): Promise<string> {
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    if (res.status === 400 || res.status === 401) {
      throw new Error(
        `Strava refresh token rejected (${res.status}). Re-authorize by running \`pnpm bootstrap\`.`,
      )
    }
    throw new Error(`Strava token refresh failed (${res.status}): ${text}`)
  }

  const data = (await res.json()) as RefreshResponse

  // Write back both tokens. Access token TTL is set to expiry + buffer so KV
  // auto-expires it — reads after that return null and trigger another refresh.
  const ttlSecs = data.expires_at - Math.floor(Date.now() / 1000) + EXPIRY_BUFFER_SECS
  await Promise.all([
    env.OAUTH_KV.put(
      ACCESS_TOKEN_KEY,
      JSON.stringify({ token: data.access_token, expires_at: data.expires_at }),
      { expirationTtl: Math.max(ttlSecs, 60) },
    ),
    env.OAUTH_KV.put(REFRESH_TOKEN_KEY, data.refresh_token),
  ])

  return data.access_token
}
