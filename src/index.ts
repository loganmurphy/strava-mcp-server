import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider"
import { WorkerEntrypoint } from "cloudflare:workers"
import { getAthleteStats, getAthleteZones, listActivities, getActivityDetail, getActivityZones, getGear } from "./strava"
import type { StravaAuthEnv } from "./auth"
import { getCached, setCached, SINGLETON_KEY } from "./cache"
import { STRAVA_TOOLS, type ToolDef } from "./tools"
import { renderLoginPage, renderSuccessPage } from "./ui"

export interface Env extends StravaAuthEnv, Cloudflare.Env {
  // Injected by OAuthProvider at request time:
  OAUTH_PROVIDER: OAuthHelpers
  MCP_AUTH_PASSWORD: string
}

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: string | number | null
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result }
}

function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
}

// Applied to all HTML responses (login + success pages).
// frame-src * is required — the success page fires the OAuth callback in a hidden
// iframe whose src is the client's redirect_uri (unknown at serve time).
const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-src *",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  })
}

function toolResult(id: string | number | null, data: unknown): Response {
  return jsonResponse(
    ok(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }),
  )
}

async function handleListActivities(
  id: string | number | null,
  args: Record<string, unknown>,
  env: Env,
  ctx: ExecutionContext,
  skipCache: boolean,
): Promise<Response> {
  const startDate = args["start_date"] as string | undefined
  const endDate = args["end_date"] as string | undefined
  const page = (args["page"] as number | undefined) ?? 1
  const perPage = (args["per_page"] as number | undefined) ?? 50
  const cacheKey = `${startDate ?? "default"}_${endDate ?? "default"}_p${page}_${perPage}`

  if (!skipCache) {
    const cached = await getCached(env.DB, "activity_list", cacheKey)
    if (cached !== null) return toolResult(id, { ...cached, _cache: "hit" })
  }

  const resp = await listActivities(env, startDate, endDate, page, perPage)
  const data = { data: resp.data, rateLimit: resp.rateLimit }
  if (!skipCache) ctx.waitUntil(setCached(env.DB, "activity_list", cacheKey, data))
  return toolResult(id, { ...data, _cache: "miss" })
}

async function handleGetActivity(
  id: string | number | null,
  args: Record<string, unknown>,
  env: Env,
  ctx: ExecutionContext,
  skipCache: boolean,
): Promise<Response> {
  const activityId = args["activity_id"] as string

  if (!skipCache) {
    const cached = await getCached(env.DB, "activity", activityId)
    if (cached !== null) return toolResult(id, { ...cached, _cache: "hit" })
  }

  const resp = await getActivityDetail(env, activityId)
  const data = { data: resp.data, rateLimit: resp.rateLimit }
  if (!skipCache) ctx.waitUntil(setCached(env.DB, "activity", activityId, data))
  return toolResult(id, { ...data, _cache: "miss" })
}

async function handleSingleton(
  id: string | number | null,
  cacheType: string,
  env: Env,
  ctx: ExecutionContext,
  skipCache: boolean,
  fetcher: () => Promise<{ data: unknown; rateLimit: unknown }>,
): Promise<Response> {
  if (!skipCache) {
    const cached = await getCached(env.DB, cacheType, SINGLETON_KEY)
    if (cached !== null) return toolResult(id, { ...cached, _cache: "hit" })
  }

  const resp = await fetcher()
  const data = { data: resp.data, rateLimit: resp.rateLimit }
  if (!skipCache) ctx.waitUntil(setCached(env.DB, cacheType, SINGLETON_KEY, data))
  return toolResult(id, { ...data, _cache: "miss" })
}

export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  tools: ToolDef[],
  serverName: string,
  forceSkipCache = false,
): Promise<Response> {
  let body: JsonRpcRequest
  try {
    body = (await request.json()) as JsonRpcRequest
  } catch {
    return jsonResponse(err(null, -32700, "Parse error"), 400)
  }

  const { id, method, params = {} } = body

  if (id === undefined && method.startsWith("notifications/")) {
    return new Response(null, { status: 202 })
  }

  switch (method) {
    case "initialize":
      return jsonResponse(
        ok(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: "1.0.0" },
        }),
      )

    case "tools/list":
      return jsonResponse(ok(id, { tools }))

    case "tools/call": {
      const toolName = params["name"] as string
      const toolArgs = (params["arguments"] as Record<string, unknown>) ?? {}
      if (!toolName) return jsonResponse(err(id, -32602, "Missing tool name"), 400)

      try {
        const skipCache = forceSkipCache || toolArgs["skip_cache"] === true

        switch (toolName) {
          case "strava_list_activities":
            return await handleListActivities(id, toolArgs, env, ctx, skipCache)
          case "strava_get_activity":
            return await handleGetActivity(id, toolArgs, env, ctx, skipCache)
          case "strava_get_athlete_stats":
            return await handleSingleton(id, "stats", env, ctx, skipCache, () =>
              getAthleteStats(env),
            )
          case "strava_get_athlete_zones":
            return await handleSingleton(id, "zones", env, ctx, skipCache, () =>
              getAthleteZones(env),
            )
          case "strava_get_activity_zones": {
            const activityId = toolArgs["activity_id"] as string
            if (!skipCache) {
              const cached = await getCached(env.DB, "activity_zones", activityId)
              if (cached !== null) return toolResult(id, { ...cached, _cache: "hit" })
            }
            const resp = await getActivityZones(env, activityId)
            const data = { data: resp.data, rateLimit: resp.rateLimit }
            if (!skipCache) ctx.waitUntil(setCached(env.DB, "activity_zones", activityId, data))
            return toolResult(id, { ...data, _cache: "miss" })
          }
          case "strava_get_gear": {
            const gearId = toolArgs["gear_id"] as string
            if (!skipCache) {
              const cached = await getCached(env.DB, "gear", gearId)
              if (cached !== null) return toolResult(id, { ...cached, _cache: "hit" })
            }
            const resp = await getGear(env, gearId)
            const data = { data: resp.data, rateLimit: resp.rateLimit }
            if (!skipCache) ctx.waitUntil(setCached(env.DB, "gear", gearId, data))
            return toolResult(id, { ...data, _cache: "miss" })
          }
          default:
            throw new Error(`Unknown tool: ${toolName}`)
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return jsonResponse(
          ok(id, {
            content: [{ type: "text", text: `Error: ${message}` }],
            isError: true,
          }),
        )
      }
    }

    case "ping":
      return jsonResponse(ok(id, {}))

    default:
      return jsonResponse(err(id, -32601, `Method not found: ${method}`), 404)
  }
}

class McpApiHandler extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    // v8 ignore next 3 -- OAuthProvider handles CORS before reaching this handler
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS })
    }
    // v8 ignore next -- OAuthProvider rejects non-POST /mcp before reaching this handler
    if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)
    // v8 ignore next 2 -- McpApiHandler is only reachable through OAuthProvider (requires valid Bearer token)
    const noCache = new URL(request.url).searchParams.has("no_cache")
    return handleMcp(request, this.env, this.ctx, STRAVA_TOOLS, "strava-mcp-server", noCache)
  }
}

export const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS })
    }

    const url = new URL(request.url)

    if (url.pathname === "/authorize") {
      if (request.method === "GET") {
        try {
          await env.OAUTH_PROVIDER.parseAuthRequest(request)
        } catch {
          return new Response("Invalid authorization request", { status: 400 })
        }
        return new Response(renderLoginPage(url.search, false), { headers: HTML_HEADERS })
      }

      if (request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") ?? "global"
        const { success } = env.RATE_LIMITER
          ? await env.RATE_LIMITER.limit({ key: ip })
          : { success: true }
        if (!success) {
          return new Response(renderLoginPage("", false, true), {
            status: 429,
            headers: { ...HTML_HEADERS, "Retry-After": "60" },
          })
        }

        let formData: FormData
        try {
          formData = await request.formData()
        } catch {
          return new Response("Invalid form submission", { status: 400 })
        }

        const password = formData.get("password") as string | null
        const rawParams = formData.get("oauth_params") as string | null

        if (!rawParams) {
          return new Response("Missing OAuth parameters", { status: 400 })
        }

        const reconstructedRequest = new Request(url.origin + "/authorize" + rawParams, {
          method: "GET",
          headers: request.headers,
        })

        let oauthReq
        try {
          oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(reconstructedRequest)
        } catch {
          return new Response("Invalid authorization request", { status: 400 })
        }

        if (!password || password !== env.MCP_AUTH_PASSWORD) {
          return new Response(renderLoginPage(rawParams, true), {
            status: 401,
            headers: HTML_HEADERS,
          })
        }

        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReq,
          userId: "owner",
          metadata: { authorizedAt: new Date().toISOString() },
          scope: oauthReq.scope,
          props: {},
        })
        return new Response(renderSuccessPage(redirectTo), { headers: HTML_HEADERS })
      }

      return new Response("Method not allowed", { status: 405 })
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          server: "strava-mcp-server",
          version: "1.0.0",
          endpoint: "/mcp",
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    }

    return new Response("Not found", { status: 404 })
  },
}

const oauthProvider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  // 30-day access tokens — long-lived for a single-user personal tool
  accessTokenTTL: 3600 * 24 * 30,
  // Refresh tokens never expire — re-auth only needed if explicitly revoked
})

// Rewrite http:// → https:// when X-Forwarded-Proto: https is set.
// OAuthProvider builds discovery/issuer URLs from request.url; without this,
// ngrok and similar proxies cause the discovery document to advertise http://
// endpoints, which OAuth clients reject.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.headers.get("x-forwarded-proto") === "https" && request.url.startsWith("http://")) {
      request = new Request(request.url.replace(/^http:\/\//, "https://"), request)
    }
    return oauthProvider.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
