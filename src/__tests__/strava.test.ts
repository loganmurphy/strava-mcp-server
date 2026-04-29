import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  stripStreamNoise,
  stripActivityNoise,
  getAthleteProfile,
  getAthleteStats,
  getAthleteZones,
  listActivities,
  getActivityDetail,
  getActivityStreams,
  STREAM_KEYS,
} from "../strava"
import type { StravaAuthEnv } from "../auth"

// Mock the auth module so stravaFetch gets a predictable token without KV.
vi.mock("../auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("mock-access-token"),
}))

function makeEnv(): StravaAuthEnv {
  return {
    STRAVA_CLIENT_ID: "test-client-id",
    STRAVA_CLIENT_SECRET: "test-client-secret",
    OAUTH_KV: {} as KVNamespace,
  }
}

/** Create a fresh Response for each call to avoid "body already used" errors on retry tests. */
function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers,
      }),
    ),
  )
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const spy = vi.spyOn(globalThis, "fetch")
  for (const { status, body, headers = {} } of responses) {
    spy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers,
        }),
      ),
    )
  }
  return spy
}

const RATE_LIMIT_HEADERS = {
  "X-RateLimit-Usage": "10,100",
  "X-RateLimit-Limit": "100,1000",
}

beforeEach(() => {
  vi.restoreAllMocks()
  // Make setTimeout call its callback immediately so retry tests don't hang.
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => {
    ;(fn as () => void)()
    return 0 as unknown as ReturnType<typeof setTimeout>
  })
})

// ── Strip helpers ────────────────────────────────────────────────────────────

describe("stripStreamNoise", () => {
  it("removes the data array, keeps metadata fields", () => {
    const stream = {
      type: "heartrate",
      series_type: "distance",
      original_size: 1234,
      resolution: "high",
      data: [120, 130, 125, 140],
    }
    const result = stripStreamNoise(stream)
    expect(result).not.toHaveProperty("data")
    expect(result).toMatchObject({
      type: "heartrate",
      series_type: "distance",
      original_size: 1234,
      resolution: "high",
    })
  })

  it("handles streams with no data field without throwing", () => {
    const stream = { type: "altitude", original_size: 0 }
    const result = stripStreamNoise(stream)
    expect(result).not.toHaveProperty("data")
    expect(result).toMatchObject({ type: "altitude", original_size: 0 })
  })
})

describe("stripActivityNoise", () => {
  it("removes the map polyline object, keeps other fields", () => {
    const activity = {
      id: 12345,
      name: "Morning Run",
      distance: 10000,
      map: { id: "a12345", summary_polyline: "encoded_polyline_data", resource_state: 2 },
      average_heartrate: 145,
    }
    const result = stripActivityNoise(activity)
    expect(result).not.toHaveProperty("map")
    expect(result).toMatchObject({
      id: 12345,
      name: "Morning Run",
      distance: 10000,
      average_heartrate: 145,
    })
  })

  it("does not mutate the original object", () => {
    const activity = { id: 1, map: { id: "m1" }, name: "Run" }
    stripActivityNoise(activity)
    expect(activity).toHaveProperty("map")
  })
})

// ── stravaFetch (via public API functions) ────────────────────────────────────

describe("rate limit parsing", () => {
  it("returns rate limit info when headers are present", async () => {
    mockFetch(200, { id: 42 }, RATE_LIMIT_HEADERS)
    const result = await getAthleteProfile(makeEnv())
    expect(result.rateLimit).toEqual({
      used15min: 10,
      usedDaily: 100,
      limit15min: 100,
      limitDaily: 1000,
    })
  })

  it("returns null rateLimit when headers are absent", async () => {
    mockFetch(200, { id: 42 })
    const result = await getAthleteProfile(makeEnv())
    expect(result.rateLimit).toBeNull()
  })
})

describe("401 handling", () => {
  it("throws a helpful re-authorize message on 401", async () => {
    mockFetch(401, { message: "Authorization Error" })
    await expect(getAthleteProfile(makeEnv())).rejects.toThrow("pnpm bootstrap")
  })

  it("does not retry on 401", async () => {
    const spy = mockFetch(401, { message: "Authorization Error" })
    await expect(getAthleteProfile(makeEnv())).rejects.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe("retry behavior", () => {
  it("retries on 500 and succeeds on third attempt", async () => {
    const spy = mockFetchSequence([
      { status: 500, body: "internal error" },
      { status: 500, body: "internal error" },
      { status: 200, body: { id: 99 }, headers: RATE_LIMIT_HEADERS },
    ])
    const result = await getAthleteProfile(makeEnv())
    expect(result.data).toMatchObject({ id: 99 })
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it("throws after exhausting retries on 5xx", async () => {
    const spy = mockFetchSequence([
      { status: 503, body: "service unavailable" },
      { status: 503, body: "service unavailable" },
      { status: 503, body: "service unavailable" },
    ])
    await expect(getAthleteProfile(makeEnv())).rejects.toThrow("503")
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it("retries on 429 with Retry-After header", async () => {
    const spy = mockFetchSequence([
      { status: 429, body: "rate limited", headers: { "Retry-After": "1" } },
      { status: 200, body: { id: 7 }, headers: RATE_LIMIT_HEADERS },
    ])
    const result = await getAthleteProfile(makeEnv())
    expect(result.data).toMatchObject({ id: 7 })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it("does not retry non-transient 4xx (e.g. 404)", async () => {
    const spy = mockFetch(404, { message: "Not Found" })
    await expect(getAthleteProfile(makeEnv())).rejects.toThrow("404")
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

// ── Athlete endpoints ─────────────────────────────────────────────────────────

describe("getAthleteProfile", () => {
  it("fetches /athlete and returns data", async () => {
    const spy = mockFetch(200, { id: 123, firstname: "Jane" })
    const result = await getAthleteProfile(makeEnv())
    expect(result.data).toMatchObject({ id: 123, firstname: "Jane" })
    expect(spy.mock.calls[0]![0]).toContain("/athlete")
  })

  it("sends Authorization header with bearer token", async () => {
    const spy = mockFetch(200, { id: 1 })
    await getAthleteProfile(makeEnv())
    const [, init] = spy.mock.calls[0]!
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer mock-access-token",
    })
  })
})

describe("getAthleteStats", () => {
  it("fetches profile first then stats for that athlete ID", async () => {
    const spy = mockFetchSequence([
      { status: 200, body: { id: 456 } },
      { status: 200, body: { recent_run_totals: { count: 5 } } },
    ])
    const result = await getAthleteStats(makeEnv())
    expect(result.data).toMatchObject({ recent_run_totals: { count: 5 } })
    expect(spy.mock.calls[0]![0]).toContain("/athlete")
    expect(spy.mock.calls[1]![0]).toContain("/athletes/456/stats")
  })
})

describe("getAthleteZones", () => {
  it("fetches /athlete/zones", async () => {
    const spy = mockFetch(200, { heart_rate: { custom_zones: false } })
    await getAthleteZones(makeEnv())
    expect(spy.mock.calls[0]![0]).toContain("/athlete/zones")
  })
})

// ── Activity endpoints ────────────────────────────────────────────────────────

describe("listActivities", () => {
  it("uses default date range when no dates provided", async () => {
    const spy = mockFetch(200, [])
    await listActivities(makeEnv())
    const url = spy.mock.calls[0]![0] as string
    expect(url).toContain("after=")
    expect(url).toContain("before=")
  })

  it("converts ISO dates to Unix timestamps", async () => {
    const spy = mockFetch(200, [])
    await listActivities(makeEnv(), "2024-01-01", "2024-01-31")
    const url = spy.mock.calls[0]![0] as string
    // 2024-01-01 00:00:00 UTC = 1704067200
    expect(url).toContain("after=1704067200")
    // end uses exclusive end (start of 2024-02-01) = 1706745600
    expect(url).toContain("before=1706745600")
  })

  it("strips map polyline from each activity in the list", async () => {
    mockFetch(200, [
      { id: 1, name: "Run", map: { id: "m1" } },
      { id: 2, name: "Ride", map: { id: "m2" } },
    ])
    const result = await listActivities(makeEnv())
    expect((result.data as Array<Record<string, unknown>>).every((a) => !("map" in a))).toBe(true)
  })

  it("passes page and per_page params", async () => {
    const spy = mockFetch(200, [])
    await listActivities(makeEnv(), undefined, undefined, 2, 25)
    const url = spy.mock.calls[0]![0] as string
    expect(url).toContain("page=2")
    expect(url).toContain("per_page=25")
  })
})

describe("getActivityDetail", () => {
  it("fetches /activities/:id and strips map", async () => {
    const spy = mockFetch(200, { id: 789, name: "Trail Run", map: { id: "m789" } })
    const result = await getActivityDetail(makeEnv(), "789")
    expect(spy.mock.calls[0]![0]).toContain("/activities/789")
    expect(result.data).not.toHaveProperty("map")
    expect(result.data).toMatchObject({ id: 789, name: "Trail Run" })
  })
})

// ── Activity streams ──────────────────────────────────────────────────────────

describe("getActivityStreams", () => {
  it("requests default stream keys (no latlng)", async () => {
    const spy = mockFetch(200, {
      heartrate: { type: "heartrate", data: [120, 130], original_size: 2 },
    })
    await getActivityStreams(makeEnv(), "111")
    const url = spy.mock.calls[0]![0] as string
    expect(url).toContain("keys=")
    expect(url).not.toContain("latlng")
    expect(url).toContain("heartrate")
  })

  it("strips raw data arrays from every stream type", async () => {
    mockFetch(200, {
      heartrate: { type: "heartrate", data: [120, 130, 125], original_size: 3, resolution: "high" },
      altitude: { type: "altitude", data: [100, 102, 101], original_size: 3, resolution: "high" },
    })
    const result = await getActivityStreams(makeEnv(), "222")
    const streams = result.data as Record<string, Record<string, unknown>>
    expect(streams["heartrate"]).not.toHaveProperty("data")
    expect(streams["altitude"]).not.toHaveProperty("data")
    expect(streams["heartrate"]).toMatchObject({ type: "heartrate", original_size: 3 })
  })

  it("accepts custom stream keys including latlng", async () => {
    const spy = mockFetch(200, {
      latlng: { type: "latlng", data: [[37.0, -122.0]], original_size: 1 },
    })
    await getActivityStreams(makeEnv(), "333", ["latlng"])
    const url = spy.mock.calls[0]![0] as string
    expect(url).toContain("keys=latlng")
  })

  it("uses key_by_type=true query param", async () => {
    const spy = mockFetch(200, {})
    await getActivityStreams(makeEnv(), "444")
    const url = spy.mock.calls[0]![0] as string
    expect(url).toContain("key_by_type=true")
  })
})

// ── STREAM_KEYS export ────────────────────────────────────────────────────────

describe("STREAM_KEYS", () => {
  it("includes all expected stream types", () => {
    expect(STREAM_KEYS).toContain("time")
    expect(STREAM_KEYS).toContain("latlng")
    expect(STREAM_KEYS).toContain("heartrate")
    expect(STREAM_KEYS).toContain("watts")
    expect(STREAM_KEYS).toContain("grade_smooth")
  })
})
