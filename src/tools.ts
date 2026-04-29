export interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, { type: string; description: string }>
    required?: string[]
  }
}

const SKIP_CACHE_PROP = {
  skip_cache: {
    type: "boolean",
    description: "Set to true to bypass the D1 cache and fetch fresh data directly from Strava.",
  },
} as const

const DATE_RANGE_PROPS = {
  start_date: {
    type: "string",
    description: "Start date in YYYY-MM-DD format (default: 7 days ago)",
  },
  end_date: {
    type: "string",
    description: "End date in YYYY-MM-DD format, inclusive (default: today)",
  },
  ...SKIP_CACHE_PROP,
} as const

export const STRAVA_TOOLS: ToolDef[] = [
  {
    name: "strava_list_activities",
    description:
      "List the authenticated athlete's activities in a date range. " +
      "Returns summary data for each activity including type, distance, moving time, elapsed time, " +
      "total elevation gain, average/max speed, average/max heart rate, average watts, and start date. " +
      "Use start_date and end_date to narrow the range (defaults to last 7 days). " +
      "Supports pagination via page and per_page for athletes with many activities.",
    inputSchema: {
      type: "object",
      properties: {
        ...DATE_RANGE_PROPS,
        page: {
          type: "number",
          description: "Page number for pagination (default: 1)",
        },
        per_page: {
          type: "number",
          description: "Number of activities per page, max 200 (default: 50)",
        },
      },
    },
  },
  {
    name: "strava_get_activity",
    description:
      "Get full detail for a single Strava activity by its ID. " +
      "Includes all summary fields plus segment efforts, splits by mile/km, laps, " +
      "best efforts (e.g. fastest mile, 5K), and gear info. " +
      "Use strava_list_activities first to find activity IDs.",
    inputSchema: {
      type: "object",
      properties: {
        activity_id: {
          type: "string",
          description: "The Strava activity ID (numeric string)",
        },
        ...SKIP_CACHE_PROP,
      },
      required: ["activity_id"],
    },
  },
  {
    name: "strava_get_activity_streams",
    description:
      "Get time-series stream data for an activity. Returns metadata (series_type, resolution, " +
      "original_size) for each requested stream — raw data arrays are stripped to keep responses " +
      "concise. Available streams: time, distance, altitude, velocity_smooth, heartrate, cadence, " +
      "watts, temp, moving, grade_smooth, latlng (GPS, excluded by default for privacy). " +
      "Useful for understanding effort distribution, elevation profile, or power output over a ride.",
    inputSchema: {
      type: "object",
      properties: {
        activity_id: {
          type: "string",
          description: "The Strava activity ID",
        },
        stream_keys: {
          type: "string",
          description:
            "Comma-separated list of stream types to include. " +
            "Defaults to: time,distance,altitude,velocity_smooth,heartrate,cadence,watts. " +
            "Add latlng to include GPS coordinates (privacy-sensitive).",
        },
        ...SKIP_CACHE_PROP,
      },
      required: ["activity_id"],
    },
  },
  {
    name: "strava_get_athlete_profile",
    description:
      "Get the authenticated athlete's Strava profile. " +
      "Includes name, location, follower/following counts, profile photo URL, " +
      "measurement preference (feet vs meters), and FTP (functional threshold power).",
    inputSchema: {
      type: "object",
      properties: { ...SKIP_CACHE_PROP },
    },
  },
  {
    name: "strava_get_athlete_stats",
    description:
      "Get the athlete's all-time and year-to-date totals by sport (run, ride, swim). " +
      "Totals include activity count, distance, moving time, and elevation gain. " +
      "Also includes recent 4-week totals. Useful for summarizing training volume.",
    inputSchema: {
      type: "object",
      properties: { ...SKIP_CACHE_PROP },
    },
  },
  {
    name: "strava_get_athlete_zones",
    description:
      "Get the athlete's heart rate and power (cycling) zones. " +
      "Heart rate zones are based on max HR; power zones are based on FTP. " +
      "Useful for contextualizing effort levels in activity analysis.",
    inputSchema: {
      type: "object",
      properties: { ...SKIP_CACHE_PROP },
    },
  },
]
