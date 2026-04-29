-- Strava data cache
-- Keyed by (cache_type, cache_key).
--
-- cache_type values:
--   activity_list  — date-range activity lists; cache_key = "{after_unix}_{before_unix}"
--   activity       — full activity detail; cache_key = activity ID
--   streams        — time-series streams; cache_key = "{activity_id}:{sorted_stream_keys}"
--   athlete        — athlete profile singleton; cache_key = "__singleton__"
--   stats          — athlete YTD/all-time stats singleton; cache_key = "__singleton__"
--   zones          — HR and power zones singleton; cache_key = "__singleton__"
--
-- TTL is enforced in application code.
-- schema_version allows selective cache invalidation if the data shape changes.

CREATE TABLE IF NOT EXISTS strava_cache (
  cache_type     TEXT    NOT NULL,
  cache_key      TEXT    NOT NULL,
  data           TEXT    NOT NULL,  -- JSON-stringified response
  fetched_at     INTEGER NOT NULL,  -- Unix ms
  schema_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (cache_type, cache_key)
);
