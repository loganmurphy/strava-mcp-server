/**
 * Runs the Strava OAuth 2.0 authorization code flow.
 *
 * Opens a browser to the Strava authorization page, starts a local HTTP server
 * on port 9999 to receive the callback, then exchanges the code for tokens.
 */

import * as http from "node:http"
import { openBrowser } from "./utils"
import { c, info, ok } from "./prompts"

const REDIRECT_URI = "http://localhost:9999/callback"
const TOKEN_URL = "https://www.strava.com/oauth/token"
// read: basic profile; profile:read_all: zones; activity:read_all: private activities
const SCOPE = "read,profile:read_all,activity:read_all"

export interface StravaTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export async function runStravaOAuth(
  clientId: string,
  clientSecret: string,
): Promise<StravaTokens> {
  const authUrl =
    `https://www.strava.com/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPE)}`

  info("Opening Strava authorization in your browser...")
  console.log(`  ${c.dim("If the browser doesn't open, visit:")}`)
  console.log(`  ${c.cyan(authUrl)}\n`)
  openBrowser(authUrl)

  const code = await waitForCode()
  ok("Authorization code received")

  return exchangeCode(clientId, clientSecret, code)
}

/** Starts a local HTTP server that captures the OAuth callback code. */
function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:9999`)
      const code = url.searchParams.get("code")
      const error = url.searchParams.get("error")

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(`<html><body><h2>Authorization denied: ${error}</h2><p>You may close this window.</p></body></html>`)
        server.close()
        reject(new Error(`Strava denied authorization: ${error}`))
        return
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(`<html><body><h2>No code received</h2><p>You may close this window.</p></body></html>`)
        return
      }

      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(`<!DOCTYPE html>
<html><head><title>Strava MCP — Authorized</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}
.card{background:white;border-radius:12px;padding:2rem;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:360px}</style>
</head><body><div class="card"><h2>✓ Connected to Strava</h2>
<p>You may close this window and return to the terminal.</p></div></body></html>`)
      server.close()
      resolve(code)
    })

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error("Port 9999 is already in use — close whatever is running on it and try again."))
      } else {
        reject(err)
      }
    })

    server.listen(9999, "localhost", () => {
      process.stdout.write(`  ${c.dim("•")} ${c.dim("Listening for callback on http://localhost:9999/callback")}`)
      process.stdout.write("\n")
    })
  })
}

async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<StravaTokens> {
  info("Exchanging authorization code for tokens...")

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Strava token exchange failed (${res.status}): ${text}`)
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    expires_at: number
  }

  if (!data.access_token || !data.refresh_token) {
    throw new Error("Strava returned an incomplete token response")
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
  }
}
