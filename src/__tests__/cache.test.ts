import { describe, it, expect, vi, beforeEach } from "vitest"
import { getCached, setCached, SINGLETON_KEY } from "../cache"

// Minimal D1Database stub — we control what `first` and `run` return.
function makeDb(firstResult: unknown = null) {
  const run = vi.fn().mockResolvedValue({ success: true })
  const first = vi.fn().mockResolvedValue(firstResult)
  const bind = vi.fn().mockReturnValue({ first, run })
  const prepare = vi.fn().mockReturnValue({ bind })
  return { prepare, bind, first, run } as unknown as D1Database & {
    prepare: ReturnType<typeof vi.fn>
    first: ReturnType<typeof vi.fn>
    run: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("SINGLETON_KEY", () => {
  it("is a stable string", () => {
    expect(typeof SINGLETON_KEY).toBe("string")
    expect(SINGLETON_KEY.length).toBeGreaterThan(0)
  })
})

describe("getCached", () => {
  it("returns null when no row exists", async () => {
    const db = makeDb(null)
    const result = await getCached(db, "activity", "123")
    expect(result).toBeNull()
  })

  it("returns parsed data when row is fresh", async () => {
    const payload = { id: 123, name: "Morning Run" }
    const db = makeDb({ data: JSON.stringify(payload), fetched_at: Date.now() - 1000 })
    const result = await getCached(db, "activity", "123")
    expect(result).toEqual(payload)
  })

  it("returns null when row is stale for activity (>24h)", async () => {
    const payload = { id: 123 }
    const staleTime = Date.now() - 25 * 60 * 60 * 1000 // 25h ago
    const db = makeDb({ data: JSON.stringify(payload), fetched_at: staleTime })
    const result = await getCached(db, "activity", "123")
    expect(result).toBeNull()
  })

  it("returns null when activity_list is stale (>5m)", async () => {
    const payload = [{ id: 1 }]
    const staleTime = Date.now() - 6 * 60 * 1000 // 6m ago
    const db = makeDb({ data: JSON.stringify(payload), fetched_at: staleTime })
    const result = await getCached(db, "activity_list", "1700000000_1700100000")
    expect(result).toBeNull()
  })

  it("returns data when activity_list is fresh (within 5m)", async () => {
    const payload = [{ id: 1 }]
    const db = makeDb({ data: JSON.stringify(payload), fetched_at: Date.now() - 60_000 })
    const result = await getCached(db, "activity_list", "key")
    expect(result).toEqual(payload)
  })

  it("uses 1h default TTL for unknown cache types", async () => {
    const payload = { id: 1 }
    // fresh (30m ago) → should be returned despite unknown type
    const db = makeDb({ data: JSON.stringify(payload), fetched_at: Date.now() - 30 * 60 * 1000 })
    const result = await getCached(db, "unknown_type", "key")
    expect(result).toEqual(payload)
  })

  it("treats unknown cache type as stale after 1h", async () => {
    const payload = { id: 1 }
    const staleTime = Date.now() - 61 * 60 * 1000 // 61m ago
    const db = makeDb({ data: JSON.stringify(payload), fetched_at: staleTime })
    const result = await getCached(db, "unknown_type", "key")
    expect(result).toBeNull()
  })

  it("queries with schema_version in the WHERE clause", async () => {
    const db = makeDb(null)
    await getCached(db, "athlete", SINGLETON_KEY)
    const sql: string = db.prepare.mock.calls[0]![0]
    expect(sql).toContain("schema_version")
  })

  it("passes cacheType and cacheKey to the query", async () => {
    const db = makeDb(null)
    await getCached(db, "streams", "abc:time,heartrate")
    // bind receives (cacheType, cacheKey, schemaVersion)
    const boundArgs = (db as unknown as { bind: ReturnType<typeof vi.fn> }).bind.mock.calls[0]
    expect(boundArgs).toContain("streams")
    expect(boundArgs).toContain("abc:time,heartrate")
  })
})

describe("setCached", () => {
  it("calls run on the prepared statement", async () => {
    const db = makeDb()
    await setCached(db, "activity", "789", { id: 789 })
    expect((db as unknown as { run: ReturnType<typeof vi.fn> }).run).toHaveBeenCalled()
  })

  it("JSON-stringifies the data before storing", async () => {
    const db = makeDb()
    const data = { id: 1, name: "Run" }
    await setCached(db, "activity", "1", data)
    const boundArgs = (db as unknown as { bind: ReturnType<typeof vi.fn> }).bind.mock.calls[0]
    expect(boundArgs).toContain(JSON.stringify(data))
  })

  it("includes schema_version in the INSERT", async () => {
    const db = makeDb()
    await setCached(db, "zones", SINGLETON_KEY, { heart_rate: {} })
    const sql: string = db.prepare.mock.calls[0]![0]
    expect(sql).toContain("schema_version")
  })

  it("uses INSERT OR REPLACE to upsert", async () => {
    const db = makeDb()
    await setCached(db, "athlete", SINGLETON_KEY, { id: 1 })
    const sql: string = db.prepare.mock.calls[0]![0]
    expect(sql.toUpperCase()).toContain("INSERT OR REPLACE")
  })

  it("stores the current timestamp as fetched_at", async () => {
    const before = Date.now()
    const db = makeDb()
    await setCached(db, "stats", SINGLETON_KEY, {})
    const after = Date.now()
    const boundArgs = (db as unknown as { bind: ReturnType<typeof vi.fn> }).bind.mock.calls[0]!
    const fetchedAt = boundArgs.find((a: unknown) => typeof a === "number" && a >= before && a <= after)
    expect(fetchedAt).toBeDefined()
  })
})
