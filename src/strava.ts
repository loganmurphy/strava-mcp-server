import { getAccessToken, type StravaAuthEnv } from "./auth"

const STRAVA_BASE = "https://www.strava.com/api/v3"
const MAX_RETRIES = 2

export type StravaItem = Record<string, unknown>

export interface RateLimitInfo {
  used15min: number
  usedDaily: number
  limit15min: number
  limitDaily: number
}

export interface StravaResponse<T> {
  data: T
  rateLimit: RateLimitInfo | null
}

function parseRateLimit(headers: Headers): RateLimitInfo | null {
  const usage = headers.get("X-RateLimit-Usage")
  const limit = headers.get("X-RateLimit-Limit")
  if (!usage || !limit) return null
  const [used15, usedDay] = usage.split(",").map(Number)
  const [lim15, limDay] = limit.split(",").map(Number)
  if ([used15, usedDay, lim15, limDay].some((n) => n === undefined || isNaN(n))) return null
  return { used15min: used15!, usedDaily: usedDay!, limit15min: lim15!, limitDaily: limDay! }
}

async function stravaFetch(
  env: StravaAuthEnv,
  path: string,
  params?: URLSearchParams,
): Promise<StravaResponse<unknown>> {
  const qs = params?.toString()
  const url = `${STRAVA_BASE}${path}${qs ? "?" + qs : ""}`

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const token = await getAccessToken(env)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })

    if (res.ok) {
      const data = await res.json()
      return { data, rateLimit: parseRateLimit(res.headers) }
    }

    const text = await res.text()

    if (res.status === 401) {
      throw new Error(
        `Strava API 401: ${text}\n\n` +
          "This usually means the token is expired/revoked or lacks the required scope.\n" +
          "Fix: re-authorize by running `pnpm connect-local` (local) or `pnpm bootstrap` (production).",
      )
    }

    // Retry on 429 (rate limited) and transient 5xx errors.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const delayMs =
        res.status === 429
          ? Math.min(parseInt(res.headers.get("Retry-After") ?? "60", 10) * 1_000, 60_000)
          : 1_000 * 2 ** attempt // 1s, 2s
      await new Promise<void>((r) => setTimeout(r, delayMs))
      continue
    }

    throw new Error(`Strava API error ${res.status}: ${text}`)
  }

  // v8 ignore next -- loop always returns or throws before this
  throw new Error("Strava API request failed after retries")
}

function dateToUnix(dateStr: string, endOfDay = false): number {
  const d = new Date(dateStr + "T00:00:00Z")
  if (endOfDay) d.setUTCDate(d.getUTCDate() + 1) // exclusive end = start of next day
  return Math.floor(d.getTime() / 1000)
}

function defaultAfter(): number {
  return Math.floor((Date.now() - 7 * 86_400_000) / 1000)
}

function defaultBefore(): number {
  return Math.floor((Date.now() + 86_400_000) / 1000) // tomorrow, to include today
}

export function stripActivityNoise(activity: StravaItem): StravaItem {
  const result = { ...activity }
  // map is a large polyline object useful for rendering but not for text analysis
  delete result["map"]
  return result
}

export async function getAthleteProfile(
  env: StravaAuthEnv,
): Promise<StravaResponse<StravaItem>> {
  return stravaFetch(env, "/athlete") as Promise<StravaResponse<StravaItem>>
}

export async function getAthleteStats(
  env: StravaAuthEnv,
): Promise<StravaResponse<StravaItem>> {
  const profile = await getAthleteProfile(env)
  const athleteId = (profile.data as StravaItem)["id"]
  return stravaFetch(env, `/athletes/${athleteId}/stats`) as Promise<StravaResponse<StravaItem>>
}

export async function getAthleteZones(
  env: StravaAuthEnv,
): Promise<StravaResponse<StravaItem>> {
  return stravaFetch(env, "/athlete/zones") as Promise<StravaResponse<StravaItem>>
}

export async function listActivities(
  env: StravaAuthEnv,
  startDate?: string,
  endDate?: string,
  page = 1,
  perPage = 50,
): Promise<StravaResponse<StravaItem[]>> {
  const params = new URLSearchParams({
    after: String(startDate ? dateToUnix(startDate) : defaultAfter()),
    before: String(endDate ? dateToUnix(endDate, true) : defaultBefore()),
    page: String(page),
    per_page: String(perPage),
  })
  const resp = await stravaFetch(env, "/athlete/activities", params)
  const activities = (resp.data as StravaItem[]).map(stripActivityNoise)
  return { data: activities, rateLimit: resp.rateLimit }
}

export async function getActivityDetail(
  env: StravaAuthEnv,
  activityId: string,
): Promise<StravaResponse<StravaItem>> {
  const resp = await stravaFetch(env, `/activities/${activityId}`)
  return { data: stripActivityNoise(resp.data as StravaItem), rateLimit: resp.rateLimit }
}

export async function getActivityZones(
  env: StravaAuthEnv,
  activityId: string,
): Promise<StravaResponse<StravaItem[]>> {
  return stravaFetch(env, `/activities/${activityId}/zones`) as Promise<StravaResponse<StravaItem[]>>
}

export async function getGear(
  env: StravaAuthEnv,
  gearId: string,
): Promise<StravaResponse<StravaItem>> {
  return stravaFetch(env, `/gear/${gearId}`) as Promise<StravaResponse<StravaItem>>
}

