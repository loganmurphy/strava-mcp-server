const SCHEMA_VERSION = 1

const TTL_MS: Record<string, number> = {
  activity_list: 5 * 60 * 1000, //  5m — athlete may have just finished a workout
  activity: 24 * 60 * 60 * 1000, // 24h — stable once synced
  streams: 24 * 60 * 60 * 1000, // 24h — stable once synced
  athlete: 60 * 60 * 1000, //  1h — profile changes are rare
  stats: 60 * 60 * 1000, //  1h — updates after each activity
  zones: 24 * 60 * 60 * 1000, // 24h — only changes when user updates settings
}

function ttlFor(cacheType: string): number {
  return TTL_MS[cacheType] ?? 60 * 60 * 1000 // 1h default
}

function isStale(fetchedAt: number, cacheType: string): boolean {
  return Date.now() - fetchedAt > ttlFor(cacheType)
}

export const SINGLETON_KEY = "__singleton__"

export function makeStreamKey(activityId: string, streamKeys: string[]): string {
  return `${activityId}:${[...streamKeys].sort().join(",")}`
}

export async function getCached(
  db: D1Database,
  cacheType: string,
  cacheKey: string,
): Promise<unknown | null> {
  const row = await db
    .prepare(
      "SELECT data, fetched_at FROM strava_cache WHERE cache_type = ? AND cache_key = ? AND schema_version = ?",
    )
    .bind(cacheType, cacheKey, SCHEMA_VERSION)
    .first<{ data: string; fetched_at: number }>()

  if (!row) return null
  if (isStale(row.fetched_at, cacheType)) return null
  return JSON.parse(row.data)
}

export async function setCached(
  db: D1Database,
  cacheType: string,
  cacheKey: string,
  data: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO strava_cache (cache_type, cache_key, data, fetched_at, schema_version)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(cacheType, cacheKey, JSON.stringify(data), Date.now(), SCHEMA_VERSION)
    .run()
}
