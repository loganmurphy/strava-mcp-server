import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock cache and strava modules so worker tests have no D1 or network I/O.
vi.mock("../cache", () => ({
  getCached: vi.fn(),
  setCached: vi.fn(),
  SINGLETON_KEY: "__singleton__",
}))

vi.mock("../strava", () => ({
  getAthleteStats: vi.fn(),
  getAthleteZones: vi.fn(),
  listActivities: vi.fn(),
  getActivityDetail: vi.fn(),
  getActivityZones: vi.fn(),
  getGear: vi.fn(),
}))

import * as cache from "../cache"
import * as strava from "../strava"
import worker, { handleMcp, defaultHandler } from "../index"
import { STRAVA_TOOLS } from "../tools"
import type { Env } from "../index"
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider"

function makeEnv(): Env {
  return {
    STRAVA_CLIENT_ID: "test-client-id",
    STRAVA_CLIENT_SECRET: "test-client-secret",
    DB: {} as D1Database,
    OAUTH_KV: {} as KVNamespace,
    MCP_AUTH_PASSWORD: "test-password",
    RATE_LIMITER: { limit: async () => ({ success: true }) } as Env["RATE_LIMITER"],
    OAUTH_PROVIDER: {} as OAuthHelpers,
  }
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} }
}

function jsonRpc(method: string, params?: Record<string, unknown>, id: number = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params })
}

function post(path: string, body: string, env = makeEnv(), ctx = makeCtx()) {
  return handleMcp(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    env,
    ctx,
    STRAVA_TOOLS,
    "strava-mcp-server",
  )
}

async function parseResult(res: Response) {
  const json = (await res.json()) as {
    result?: { content?: Array<{ text: string }> }
    error?: unknown
  }
  if (json.result?.content?.[0]) {
    return JSON.parse(json.result.content[0].text)
  }
  return json
}

const MOCK_ACTIVITY = { id: 1, name: "Morning Run", distance: 10000 }
const MOCK_RESP = { data: MOCK_ACTIVITY, rateLimit: null }
const MOCK_LIST_RESP = { data: [MOCK_ACTIVITY], rateLimit: null }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(cache.getCached).mockResolvedValue(null) // default: cache miss
  vi.mocked(cache.setCached).mockResolvedValue(undefined)
  vi.mocked(strava.getAthleteStats).mockResolvedValue(MOCK_RESP)
  vi.mocked(strava.getAthleteZones).mockResolvedValue(MOCK_RESP)
  vi.mocked(strava.listActivities).mockResolvedValue(MOCK_LIST_RESP)
  vi.mocked(strava.getActivityDetail).mockResolvedValue(MOCK_RESP)
  vi.mocked(strava.getActivityZones).mockResolvedValue({ data: [], rateLimit: null })
  vi.mocked(strava.getGear).mockResolvedValue(MOCK_RESP)
})

// ── Routing ───────────────────────────────────────────────────────────────────

describe("routing", () => {
  it("OPTIONS /mcp returns 204 with CORS headers", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/mcp", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:3000" },
      }),
      makeEnv(),
      makeCtx(),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000")
  })

  it("/health returns status ok", async () => {
    const res = await worker.fetch(new Request("http://localhost/health"), makeEnv(), makeCtx())
    const body = (await res.json()) as { status: string; server: string }
    expect(body.status).toBe("ok")
    expect(body.server).toBe("strava-mcp-server")
  })

  it("/ also returns status ok", async () => {
    const res = await worker.fetch(new Request("http://localhost/"), makeEnv(), makeCtx())
    expect(res.status).toBe(200)
  })

  it("unknown path returns 404", async () => {
    const res = await worker.fetch(new Request("http://localhost/unknown"), makeEnv(), makeCtx())
    expect(res.status).toBe(404)
  })

  it("unauthenticated request to /mcp returns 401", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/mcp", { method: "POST" }),
      makeEnv(),
      makeCtx(),
    )
    expect(res.status).toBe(401)
  })

  it("rewrites http:// to https:// when x-forwarded-proto: https", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/health", {
        headers: { "x-forwarded-proto": "https" },
      }),
      makeEnv(),
      makeCtx(),
    )
    expect(res.status).toBe(200)
  })
})

// ── JSON-RPC protocol ─────────────────────────────────────────────────────────

describe("initialize", () => {
  it("returns protocol version and server info", async () => {
    const res = await post("/mcp", jsonRpc("initialize"))
    const body = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } }
    expect(body.result.protocolVersion).toBe("2024-11-05")
    expect(body.result.serverInfo.name).toBe("strava-mcp-server")
  })
})

describe("tools/list", () => {
  it("returns all 4 STRAVA_TOOLS", async () => {
    const res = await post("/mcp", jsonRpc("tools/list"))
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } }
    const names = body.result.tools.map((t) => t.name)
    expect(names).toContain("strava_list_activities")
    expect(names).toContain("strava_get_activity")
    expect(names).toContain("strava_get_athlete_stats")
    expect(names).toContain("strava_get_athlete_zones")
    expect(names).toContain("strava_get_activity_zones")
    expect(names).toContain("strava_get_gear")
    expect(body.result.tools).toHaveLength(6)
  })
})

describe("ping", () => {
  it("returns an empty result", async () => {
    const res = await post("/mcp", jsonRpc("ping"))
    const body = (await res.json()) as { result: unknown }
    expect(body.result).toEqual({})
  })
})

describe("notifications", () => {
  it("returns 202 for notification methods (no id)", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    const res = await post("/mcp", body)
    expect(res.status).toBe(202)
  })
})

describe("unknown method", () => {
  it("returns error code -32601", async () => {
    const res = await post("/mcp", jsonRpc("nonexistent/method"))
    const body = (await res.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32601)
  })
})

describe("malformed JSON", () => {
  it("returns error code -32700", async () => {
    const res = await post("/mcp", "not json")
    const body = (await res.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32700)
  })
})

describe("missing tool name", () => {
  it("returns 400", async () => {
    const res = await post("/mcp", jsonRpc("tools/call", { arguments: {} }))
    expect(res.status).toBe(400)
  })
})

describe("unknown tool", () => {
  it("returns isError: true", async () => {
    const res = await post("/mcp", jsonRpc("tools/call", { name: "strava_nonexistent" }))
    const body = (await res.json()) as { result: { isError: boolean } }
    expect(body.result.isError).toBe(true)
  })
})

// ── Cache behavior ────────────────────────────────────────────────────────────

describe("cache hit", () => {
  it("returns cached data without calling Strava", async () => {
    vi.mocked(cache.getCached).mockResolvedValueOnce({ data: { id: 99 }, rateLimit: null })
    const res = await post("/mcp", jsonRpc("tools/call", { name: "strava_get_athlete_stats" }))
    const data = await parseResult(res)
    expect(data._cache).toBe("hit")
    expect(strava.getAthleteStats).not.toHaveBeenCalled()
  })
})

describe("cache miss", () => {
  it("fetches from Strava and schedules cache write via waitUntil", async () => {
    vi.mocked(cache.getCached).mockResolvedValueOnce(null)
    const ctx = makeCtx()
    const res = await post(
      "/mcp",
      jsonRpc("tools/call", { name: "strava_get_athlete_stats" }),
      makeEnv(),
      ctx,
    )
    const data = await parseResult(res)
    expect(data._cache).toBe("miss")
    expect(strava.getAthleteStats).toHaveBeenCalled()
    expect(ctx.waitUntil).toHaveBeenCalled()
  })
})

describe("skip_cache: true", () => {
  it("bypasses getCached and does not write back", async () => {
    const ctx = makeCtx()
    await post(
      "/mcp",
      jsonRpc("tools/call", { name: "strava_get_athlete_stats", arguments: { skip_cache: true } }),
      makeEnv(),
      ctx,
    )
    expect(cache.getCached).not.toHaveBeenCalled()
    expect(ctx.waitUntil).not.toHaveBeenCalled()
  })
})

describe("forceSkipCache flag", () => {
  it("bypasses cache when true", async () => {
    await handleMcp(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: jsonRpc("tools/call", { name: "strava_get_athlete_stats", arguments: {} }),
      }),
      makeEnv(),
      makeCtx(),
      STRAVA_TOOLS,
      "strava-mcp-server",
      true,
    )
    expect(cache.getCached).not.toHaveBeenCalled()
  })
})

// ── Individual tool dispatch ──────────────────────────────────────────────────

describe("strava_list_activities", () => {
  it("calls listActivities with date/page args and returns data", async () => {
    const res = await post(
      "/mcp",
      jsonRpc("tools/call", {
        name: "strava_list_activities",
        arguments: { start_date: "2024-01-01", end_date: "2024-01-31", page: 2, per_page: 25 },
      }),
    )
    const data = await parseResult(res)
    expect(strava.listActivities).toHaveBeenCalledWith(
      expect.anything(),
      "2024-01-01",
      "2024-01-31",
      2,
      25,
    )
    expect(data.data).toEqual([MOCK_ACTIVITY])
  })
})

describe("strava_get_activity", () => {
  it("calls getActivityDetail with the activity_id", async () => {
    const res = await post(
      "/mcp",
      jsonRpc("tools/call", { name: "strava_get_activity", arguments: { activity_id: "42" } }),
    )
    expect(strava.getActivityDetail).toHaveBeenCalledWith(expect.anything(), "42")
    expect(res.status).toBe(200)
  })
})

describe("strava_get_athlete_stats", () => {
  it("calls getAthleteStats", async () => {
    await post("/mcp", jsonRpc("tools/call", { name: "strava_get_athlete_stats" }))
    expect(strava.getAthleteStats).toHaveBeenCalled()
  })
})

describe("strava_get_athlete_zones", () => {
  it("calls getAthleteZones", async () => {
    await post("/mcp", jsonRpc("tools/call", { name: "strava_get_athlete_zones" }))
    expect(strava.getAthleteZones).toHaveBeenCalled()
  })
})

describe("strava_get_activity_zones", () => {
  it("calls getActivityZones with the activity_id", async () => {
    const res = await post(
      "/mcp",
      jsonRpc("tools/call", { name: "strava_get_activity_zones", arguments: { activity_id: "42" } }),
    )
    expect(strava.getActivityZones).toHaveBeenCalledWith(expect.anything(), "42")
    expect(res.status).toBe(200)
  })
})

describe("strava_get_gear", () => {
  it("calls getGear with the gear_id", async () => {
    const res = await post(
      "/mcp",
      jsonRpc("tools/call", { name: "strava_get_gear", arguments: { gear_id: "g12345" } }),
    )
    expect(strava.getGear).toHaveBeenCalledWith(expect.anything(), "g12345")
    expect(res.status).toBe(200)
  })
})

// ── Error handling ────────────────────────────────────────────────────────────

describe("Strava API error", () => {
  it("surfaces the error message in the tool response", async () => {
    vi.mocked(strava.getAthleteStats).mockRejectedValueOnce(
      new Error("Strava API error 500: internal error"),
    )
    const res = await post("/mcp", jsonRpc("tools/call", { name: "strava_get_athlete_stats" }))
    const body = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0]!.text).toContain("Strava API error 500")
  })

  it("handles non-Error thrown values", async () => {
    vi.mocked(strava.getAthleteStats).mockRejectedValueOnce("string error")
    const res = await post("/mcp", jsonRpc("tools/call", { name: "strava_get_athlete_stats" }))
    const body = (await res.json()) as { result: { isError: boolean } }
    expect(body.result.isError).toBe(true)
  })
})

// ── HTML security headers ─────────────────────────────────────────────────────

describe("HTML security headers", () => {
  it("login page includes CSP, nosniff, HSTS, and Referrer-Policy", async () => {
    const env = makeEnv()
    env.OAUTH_PROVIDER = {
      parseAuthRequest: vi.fn().mockResolvedValue({}),
    } as unknown as OAuthHelpers

    const res = await worker.fetch(
      new Request("http://localhost/authorize?client_id=x&response_type=code"),
      env,
      makeCtx(),
    )
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=")
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer")
  })
})

// ── defaultHandler routing ────────────────────────────────────────────────────

describe("defaultHandler", () => {
  it("OPTIONS on non-mcp route returns 204", async () => {
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", { method: "OPTIONS" }),
      makeEnv(),
      makeCtx(),
    )
    expect(res.status).toBe(204)
  })

  it("GET /authorize returns 400 when parseAuthRequest throws", async () => {
    const env = makeEnv()
    env.OAUTH_PROVIDER = {
      parseAuthRequest: vi.fn().mockRejectedValue(new Error("bad request")),
    } as unknown as OAuthHelpers
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize?bad=params"),
      env,
      makeCtx(),
    )
    expect(res.status).toBe(400)
  })

  it("POST /authorize returns 429 when rate limiter denies", async () => {
    const env = makeEnv()
    env.RATE_LIMITER = { limit: async () => ({ success: false }) } as Env["RATE_LIMITER"]
    const body = new FormData()
    body.append("password", "pw")
    body.append("oauth_params", "?foo=bar")
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", { method: "POST", body }),
      env,
      makeCtx(),
    )
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("60")
  })

  it("POST /authorize returns 400 on malformed form data", async () => {
    const env = makeEnv()
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      env,
      makeCtx(),
    )
    expect(res.status).toBe(400)
  })

  it("POST /authorize returns 400 when oauth_params is missing", async () => {
    const env = makeEnv()
    const body = new FormData()
    body.append("password", "pw")
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", { method: "POST", body }),
      env,
      makeCtx(),
    )
    expect(res.status).toBe(400)
  })

  it("POST /authorize returns 400 when reconstructed OAuth request is invalid", async () => {
    const env = makeEnv()
    env.OAUTH_PROVIDER = {
      parseAuthRequest: vi.fn().mockRejectedValue(new Error("bad oauth")),
    } as unknown as OAuthHelpers
    const body = new FormData()
    body.append("password", "test-password")
    body.append("oauth_params", "?bad=params")
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", { method: "POST", body }),
      env,
      makeCtx(),
    )
    expect(res.status).toBe(400)
  })

  it("POST /authorize returns 401 on wrong password", async () => {
    const env = makeEnv()
    env.OAUTH_PROVIDER = {
      parseAuthRequest: vi.fn().mockResolvedValue({}),
    } as unknown as OAuthHelpers
    const body = new FormData()
    body.append("password", "wrong-password")
    body.append("oauth_params", "?client_id=x")
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", { method: "POST", body }),
      env,
      makeCtx(),
    )
    expect(res.status).toBe(401)
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'")
  })

  it("POST /authorize returns 401 when password field is absent", async () => {
    const env = makeEnv()
    env.OAUTH_PROVIDER = {
      parseAuthRequest: vi.fn().mockResolvedValue({}),
    } as unknown as OAuthHelpers
    const body = new FormData()
    body.append("oauth_params", "?client_id=x")
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", { method: "POST", body }),
      env,
      makeCtx(),
    )
    expect(res.status).toBe(401)
  })

  it("POST /authorize completes auth and returns success page on correct password", async () => {
    const env = makeEnv()
    env.OAUTH_PROVIDER = {
      parseAuthRequest: vi.fn().mockResolvedValue({ scope: "read" }),
      completeAuthorization: vi
        .fn()
        .mockResolvedValue({ redirectTo: "https://client.example.com/callback?code=abc" }),
    } as unknown as OAuthHelpers
    const body = new FormData()
    body.append("password", "test-password")
    body.append("oauth_params", "?client_id=x&response_type=code")
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", { method: "POST", body }),
      env,
      makeCtx(),
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("Connected to Strava")
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'")
  })

  it("PUT /authorize returns 405", async () => {
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", { method: "PUT" }),
      makeEnv(),
      makeCtx(),
    )
    expect(res.status).toBe(405)
  })
})
