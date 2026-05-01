import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

import { banner, c, ok, warn, info, closePrompts, promptHidden } from "./prompts"
import { loadDevVars, saveDevVars, validatePassword } from "./utils"
import { runStravaOAuth } from "./strava-auth"

const DEV_VARS_PATH = path.resolve(process.cwd(), ".dev.vars")
const WRANGLER_JSONC_PATH = path.resolve(process.cwd(), "wrangler.jsonc")
const SCHEMA_PATH = path.resolve(process.cwd(), "migrations/001_init.sql")
const STRAVA_API_URL = "https://www.strava.com/settings/api"
const CONNECTORS_URL = "https://claude.ai/customize/connectors"

async function main() {
  banner("strava-mcp-server — Local setup", [
    "Sets up local credentials and D1 schema.",
    "No Cloudflare account needed — just keep `pnpm dev` running.",
    "",
    `${c.bold("You'll need:")}`,
    `  • A Strava API application (${c.cyan(STRAVA_API_URL)})`,
    "    Set Authorization Callback Domain to: localhost",
  ])

  const vars = loadDevVars(DEV_VARS_PATH)

  // Strava Client credentials
  let clientId = vars["STRAVA_CLIENT_ID"] ?? ""
  let clientSecret = vars["STRAVA_CLIENT_SECRET"] ?? ""

  if (!clientId || !clientSecret) {
    console.log(`  ${c.bold("Strava API credentials")}`)
    console.log(`  Get them from: ${c.cyan(STRAVA_API_URL)}`)
    console.log(`  ${c.dim("Required: set Authorization Callback Domain to")} ${c.cyan("localhost")}\n`)

    if (!clientId) {
      clientId = await promptHidden("Client ID (hidden)")
      if (!clientId) throw new Error("Client ID cannot be empty")
    }
    if (!clientSecret) {
      clientSecret = await promptHidden("Client Secret (hidden)")
      if (!clientSecret) throw new Error("Client Secret cannot be empty")
    }
    saveDevVars(DEV_VARS_PATH, { STRAVA_CLIENT_ID: clientId, STRAVA_CLIENT_SECRET: clientSecret })
    ok("Strava credentials saved to .dev.vars")
  } else {
    ok("Strava credentials already in .dev.vars")
  }

  // MCP password
  let mcpPassword = vars["MCP_AUTH_PASSWORD"] ?? ""
  if (!mcpPassword) {
    console.log(
      `\n  ${c.bold("MCP server password")} — you'll enter this once in the browser login prompt.`,
    )
    console.log(`  ${c.dim("Min 12 characters, one number, one special character.")}`)
    while (true) {
      mcpPassword = await promptHidden("Choose a password (hidden)")
      if (!mcpPassword) throw new Error("Password cannot be empty")
      const err = validatePassword(mcpPassword)
      if (err) {
        warn(err)
        continue
      }
      break
    }
    saveDevVars(DEV_VARS_PATH, { MCP_AUTH_PASSWORD: mcpPassword })
    ok("MCP_AUTH_PASSWORD saved to .dev.vars")
  } else {
    ok("MCP_AUTH_PASSWORD already in .dev.vars")
  }

  // wrangler.jsonc setup
  if (!fs.existsSync(WRANGLER_JSONC_PATH)) {
    const example = path.resolve(process.cwd(), "wrangler.example.jsonc")
    if (!fs.existsSync(example))
      throw new Error("wrangler.jsonc not found and wrangler.example.jsonc is missing")
    fs.copyFileSync(example, WRANGLER_JSONC_PATH)
    ok("Created wrangler.jsonc from example")
  } else {
    ok("wrangler.jsonc found")
  }

  // Regenerate Worker types
  info("Regenerating Worker types...")
  const typegen = spawnSync("npx", ["wrangler", "types"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  })
  if (typegen.status !== 0) warn("Type generation failed — run `pnpm cf-typegen` manually")
  else ok("worker-configuration.d.ts updated")

  // Apply local D1 schema
  info("Applying schema to local D1...")
  const migration = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "strava-cache", "--local", "--file", SCHEMA_PATH],
    { stdio: ["ignore", "inherit", "inherit"] },
  )
  if (migration.status !== 0) {
    warn(
      `Schema migration failed — run manually: npx wrangler d1 execute strava-cache --local --file=${SCHEMA_PATH}`,
    )
  } else {
    ok("Local D1 schema ready")
  }

  // Strava OAuth flow → store tokens in local KV
  console.log(`\n  ${c.bold("Strava authorization")} — connecting to your Strava account`)
  const tokens = await runStravaOAuth(clientId, clientSecret)
  ok("Strava tokens obtained")

  // Write tokens directly to local KV so stale tokens from previous runs don't take precedence.
  const kvEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" }
  const accessPayload = JSON.stringify({ token: tokens.accessToken, expires_at: tokens.expiresAt })
  const putAccess = spawnSync(
    "npx",
    ["wrangler", "kv", "key", "put", "strava:access_token", accessPayload, "--binding", "OAUTH_KV", "--local"],
    { stdio: ["ignore", "inherit", "inherit"], env: kvEnv },
  )
  if (putAccess.status !== 0) warn("Could not write to local KV — will fall back to .dev.vars on first request")
  else ok("strava:access_token written to local KV")

  const putRefresh = spawnSync(
    "npx",
    ["wrangler", "kv", "key", "put", "strava:refresh_token", tokens.refreshToken, "--binding", "OAUTH_KV", "--local"],
    { stdio: ["ignore", "inherit", "inherit"], env: kvEnv },
  )
  if (putRefresh.status === 0) ok("strava:refresh_token written to local KV")

  // Keep .dev.vars updated as a fallback in case local KV is cleared.
  saveDevVars(DEV_VARS_PATH, { STRAVA_REFRESH_TOKEN: tokens.refreshToken })
  ok("STRAVA_REFRESH_TOKEN saved to .dev.vars")

  console.log()
  ok("Local setup complete!")
  console.log()
  console.log(`  ${c.bold("Next steps:")}`)
  console.log(`  ${c.dim("1.")} Run ${c.cyan("pnpm dev")} in one terminal`)
  console.log(
    `  ${c.dim("2.")} Run ${c.cyan("ngrok http 8787")} in another → copy the ${c.cyan("https://")} URL`,
  )
  console.log(
    `  ${c.dim("3.")} Add ${c.cyan("<ngrok-url>/mcp")} as a custom connector at ${c.cyan(CONNECTORS_URL)}`,
  )
  console.log()
}

main()
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`\n${c.red("✗")} ${msg}`)
    process.exit(1)
  })
  .finally(() => closePrompts())
