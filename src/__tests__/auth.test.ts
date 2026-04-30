import { describe, it, expect, vi, beforeEach } from "vitest"
import { getAccessToken, refreshAccessToken } from "../auth"
import type { StravaAuthEnv } from "../auth"

const CLIENT_ID = "test-client-id"
const CLIENT_SECRET = "test-client-secret"
const VALID_TOKEN = "valid-access-token"
const REFRESH_TOKEN = "test-refresh-token"
const NEW_ACCESS_TOKEN = "new-access-token"
const NEW_REFRESH_TOKEN = "new-refresh-token"
const FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 3600 // 1h from now
const NEAR_EXPIRY = Math.floor(Date.now() / 1000) + 30 // 30s from now (within buffer)
const PAST_EXPIRY = Math.floor(Date.now() / 1000) - 60 // already expired

function makeEnv(kvOverrides?: Partial<KVNamespace>): StravaAuthEnv {
  return {
    STRAVA_CLIENT_ID: CLIENT_ID,
    STRAVA_CLIENT_SECRET: CLIENT_SECRET,
    STRAVA_REFRESH_TOKEN: "",
    OAUTH_KV: {
      get: vi.fn(),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
      ...kvOverrides,
    } as unknown as KVNamespace,
  }
}

function mockFetch(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("getAccessToken", () => {
  it("returns cached token when valid and not near expiry", async () => {
    const env = makeEnv({
      get: vi.fn().mockResolvedValueOnce(
        JSON.stringify({ token: VALID_TOKEN, expires_at: FUTURE_EXPIRY }),
      ),
    })
    const token = await getAccessToken(env)
    expect(token).toBe(VALID_TOKEN)
    expect(env.OAUTH_KV.get).toHaveBeenCalledWith("strava:access_token")
  })

  it("refreshes when cached token is within the expiry buffer", async () => {
    const env = makeEnv({
      get: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ token: VALID_TOKEN, expires_at: NEAR_EXPIRY }))
        .mockResolvedValueOnce(REFRESH_TOKEN),
    })
    mockFetch(200, {
      access_token: NEW_ACCESS_TOKEN,
      refresh_token: NEW_REFRESH_TOKEN,
      expires_at: FUTURE_EXPIRY,
    })
    const token = await getAccessToken(env)
    expect(token).toBe(NEW_ACCESS_TOKEN)
  })

  it("refreshes when cached token is expired", async () => {
    const env = makeEnv({
      get: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ token: VALID_TOKEN, expires_at: PAST_EXPIRY }))
        .mockResolvedValueOnce(REFRESH_TOKEN),
    })
    mockFetch(200, {
      access_token: NEW_ACCESS_TOKEN,
      refresh_token: NEW_REFRESH_TOKEN,
      expires_at: FUTURE_EXPIRY,
    })
    const token = await getAccessToken(env)
    expect(token).toBe(NEW_ACCESS_TOKEN)
  })

  it("refreshes when no cached token exists", async () => {
    const env = makeEnv({
      get: vi
        .fn()
        .mockResolvedValueOnce(null) // no access token
        .mockResolvedValueOnce(REFRESH_TOKEN),
    })
    mockFetch(200, {
      access_token: NEW_ACCESS_TOKEN,
      refresh_token: NEW_REFRESH_TOKEN,
      expires_at: FUTURE_EXPIRY,
    })
    const token = await getAccessToken(env)
    expect(token).toBe(NEW_ACCESS_TOKEN)
  })

  it("throws if no refresh token in KV or env", async () => {
    const env = makeEnv({
      get: vi.fn().mockResolvedValue(null),
    })
    await expect(getAccessToken(env)).rejects.toThrow("pnpm connect-local")
  })

  it("uses STRAVA_REFRESH_TOKEN env var when KV has no refresh token", async () => {
    const env = makeEnv({
      get: vi.fn().mockResolvedValue(null),
    })
    env.STRAVA_REFRESH_TOKEN = REFRESH_TOKEN
    mockFetch(200, {
      access_token: NEW_ACCESS_TOKEN,
      refresh_token: NEW_REFRESH_TOKEN,
      expires_at: FUTURE_EXPIRY,
    })
    const token = await getAccessToken(env)
    expect(token).toBe(NEW_ACCESS_TOKEN)
  })
})

describe("refreshAccessToken", () => {
  it("writes new access and refresh tokens to KV", async () => {
    const env = makeEnv()
    mockFetch(200, {
      access_token: NEW_ACCESS_TOKEN,
      refresh_token: NEW_REFRESH_TOKEN,
      expires_at: FUTURE_EXPIRY,
    })
    const token = await refreshAccessToken(env, REFRESH_TOKEN)
    expect(token).toBe(NEW_ACCESS_TOKEN)
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      "strava:access_token",
      expect.stringContaining(NEW_ACCESS_TOKEN),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    )
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith("strava:refresh_token", NEW_REFRESH_TOKEN)
  })

  it("throws a helpful message on 400 / invalid refresh token", async () => {
    const env = makeEnv()
    mockFetch(400, { message: "Bad Request" })
    await expect(refreshAccessToken(env, REFRESH_TOKEN)).rejects.toThrow(
      "pnpm bootstrap",
    )
  })

  it("throws a helpful message on 401", async () => {
    const env = makeEnv()
    mockFetch(401, { message: "Unauthorized" })
    await expect(refreshAccessToken(env, REFRESH_TOKEN)).rejects.toThrow(
      "Strava refresh token rejected",
    )
  })

  it("throws a generic error on 5xx", async () => {
    const env = makeEnv()
    mockFetch(500, "internal error")
    await expect(refreshAccessToken(env, REFRESH_TOKEN)).rejects.toThrow(
      "Strava token refresh failed (500)",
    )
  })

  it("sends correct payload to Strava token endpoint", async () => {
    const env = makeEnv()
    const spy = mockFetch(200, {
      access_token: NEW_ACCESS_TOKEN,
      refresh_token: NEW_REFRESH_TOKEN,
      expires_at: FUTURE_EXPIRY,
    })
    await refreshAccessToken(env, REFRESH_TOKEN)
    const [url, init] = spy.mock.calls[0]!
    expect(url).toBe("https://www.strava.com/oauth/token")
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toMatchObject({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    })
  })
})
