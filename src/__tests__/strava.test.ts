import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  stripActivityNoise,
  getAthleteProfile,
  getAthleteStats,
  getAthleteZones,
  listActivities,
  getActivityDetail,
  getActivityZones,
  getGear,
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
    STRAVA_REFRESH_TOKEN: "",
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

  it("returns null rateLimit when header values are malformed (NaN)", async () => {
    mockFetch(200, { id: 42 }, {
      "X-RateLimit-Usage": "abc,100",
      "X-RateLimit-Limit": "100,1000",
    })
    const result = await getAthleteProfile(makeEnv())
    expect(result.rateLimit).toBeNull()
  })
})

describe("429 without Retry-After header", () => {
  it("retries using default 60s when Retry-After header is absent", async () => {
    const spy = mockFetchSequence([
      { status: 429, body: "rate limited" }, // no Retry-After header
      { status: 200, body: { id: 7 } },
    ])
    const result = await getAthleteProfile(makeEnv())
    expect(result.data).toMatchObject({ id: 7 })
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe("401 handling", () => {
  it("throws a helpful re-authorize message on 401", async () => {
    mockFetch(401, { message: "Authorization Error" })
    await expect(getAthleteProfile(makeEnv())).rejects.toThrow("Strava API 401")
  })

  it("does not retry on 401", async () => {
    const spy = mockFetch(401, { message: "Authorization Error" })
    await expect(getAthleteProfile(makeEnv())).rejects.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe("402 handling", () => {
  it("throws a Summit subscription message on 402", async () => {
    mockFetch(402, { message: "Payment Required" })
    await expect(getAthleteProfile(makeEnv())).rejects.toThrow("Summit subscription")
  })

  it("does not retry on 402", async () => {
    const spy = mockFetch(402, { message: "Payment Required" })
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

describe("getActivityZones", () => {
  it("fetches /activities/:id/zones", async () => {
    const zones = [{ type: "heartrate", distribution_buckets: [{ min: 0, max: 130, time: 120 }] }]
    const spy = mockFetch(200, zones)
    const result = await getActivityZones(makeEnv(), "789")
    expect(spy.mock.calls[0]![0]).toContain("/activities/789/zones")
    expect(result.data).toEqual(zones)
  })
})

describe("getGear", () => {
  it("fetches /gear/:id", async () => {
    const gear = { id: "g12345", name: "Speedgoat 5", distance: 75600 }
    const spy = mockFetch(200, gear)
    const result = await getGear(makeEnv(), "g12345")
    expect(spy.mock.calls[0]![0]).toContain("/gear/g12345")
    expect(result.data).toMatchObject({ id: "g12345", distance: 75600 })
  })
})

