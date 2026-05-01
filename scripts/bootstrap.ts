import * as fs from "node:fs"
import * as path from "node:path"
import { spawn, spawnSync } from "node:child_process"

import {
  banner,
  c,
  confirm,
  closePrompts,
  info,
  ok,
  pick,
  promptHidden,
  pressEnter,
  step,
  warn,
} from "./prompts"
import { copyToClipboard, loadDevVars, openBrowser, saveDevVars, validatePassword } from "./utils"
import { runStravaOAuth } from "./strava-auth"

const WORKER_NAME = "strava-mcp-server"
const D1_NAME = "strava-cache"
const KV_NAME = "strava-oauth"
const STRAVA_API_URL = "https://www.strava.com/settings/api"
const AUTH_SECRET_NAME = "MCP_AUTH_PASSWORD"

const DEV_VARS_PATH = path.resolve(process.cwd(), ".dev.vars")
const BOOTSTRAP_STATE_PATH = path.resolve(process.cwd(), ".bootstrap-state")
const WRANGLER_JSONC_PATH = path.resolve(process.cwd(), "wrangler.jsonc")
const WRANGLER_EXAMPLE_PATH = path.resolve(process.cwd(), "wrangler.example.jsonc")
const SCHEMA_PATH = path.resolve(process.cwd(), "migrations/001_init.sql")

function wranglerWhoami(): { email: string; accounts: { id: string; name: string }[] } | null {
  const result = spawnSync("npx", ["wrangler", "whoami"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  })
  const out = (result.stdout ?? "") + (result.stderr ?? "")
  if (result.status !== 0 || out.includes("not authenticated")) return null

  const email = out.match(/associated with the email\s+(\S+)/)?.[1] ?? "unknown"
  const accounts: { id: string; name: string }[] = []
  for (const m of out.matchAll(/│\s+(.+?)\s+│\s+([0-9a-f]{32})\s+│/g)) {
    accounts.push({ name: m[1]!.trim(), id: m[2]!.trim() })
  }
  return { email, accounts }
}

async function ensureWranglerAuth(): Promise<{ accountId: string; accountName: string }> {
  step(1, "Connect to Cloudflare")

  let whoami = wranglerWhoami()
  if (whoami) {
    ok(`Already signed in as ${c.cyan(whoami.email)}`)
  } else {
    info("Opening Cloudflare sign-in in your browser...")
    console.log(`  ${c.dim("No account yet? You can create a free one during this step.")}`)
    await new Promise<void>((resolve, reject) => {
      loginChild = spawn("npx", ["wrangler", "login"], { stdio: "inherit" })
      loginChild.on("exit", (code) => {
        loginChild = null
        if (code !== 0) reject(new Error("`wrangler login` was cancelled or failed"))
        else resolve()
      })
      loginChild.on("error", (err) => {
        loginChild = null
        reject(err)
      })
    })

    whoami = wranglerWhoami()
    if (!whoami)
      throw new Error(
        "Could not verify Cloudflare credentials after login.\n" +
          `  Fallback: set ${c.cyan("CLOUDFLARE_API_TOKEN")} in your environment and re-run.`,
      )
    ok(`Signed in as ${c.cyan(whoami.email)}`)
  }

  return pickAccount(whoami.accounts)
}

async function pickAccount(
  accounts: { id: string; name: string }[],
): Promise<{ accountId: string; accountName: string }> {
  step(2, "Select Cloudflare account")

  if (accounts.length === 0)
    throw new Error("No Cloudflare accounts found — try `wrangler login` again")

  const saved =
    loadDevVars(BOOTSTRAP_STATE_PATH)["CLOUDFLARE_ACCOUNT_ID"] ??
    process.env["CLOUDFLARE_ACCOUNT_ID"]
  if (saved) {
    const match = accounts.find((a) => a.id === saved)
    if (match) {
      info(`Using saved account — ${c.cyan(match.name)}`)
      console.log(`  ${c.dim("(Run `pnpm reset` to clear saved state and switch accounts.)")}`)
      return { accountId: match.id, accountName: match.name }
    }
    warn("Saved account ID not found — prompting below.")
  }

  let selected: { id: string; name: string }
  if (accounts.length === 1) {
    selected = accounts[0]!
    ok(`Using ${c.cyan(selected.name)} ${c.dim(`(${selected.id})`)}`)
  } else {
    const idx = await pick(
      "You have multiple accounts — which one?",
      accounts,
      (a) => `${a.name} ${c.dim(`(${a.id})`)}`,
      0,
    )
    selected = accounts[idx]!
    ok(`Using ${c.cyan(selected.name)}`)
  }

  saveDevVars(BOOTSTRAP_STATE_PATH, { CLOUDFLARE_ACCOUNT_ID: selected.id })
  return { accountId: selected.id, accountName: selected.name }
}

function ensureD1(accountId: string): string {
  step(4, "D1 cache database")

  const listResult = spawnSync("npx", ["wrangler", "d1", "list", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  })
  if (listResult.status === 0 && listResult.stdout?.trim()) {
    const dbs = JSON.parse(listResult.stdout) as { uuid: string; name: string }[]
    const existing = dbs.find((db) => db.name === D1_NAME)
    if (existing?.uuid) {
      ok(`Found existing D1 database ${c.cyan(D1_NAME)}`)
      return existing.uuid
    }
  }

  info(`Creating D1 database "${D1_NAME}"...`)
  const createResult = spawnSync("npx", ["wrangler", "d1", "create", D1_NAME], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  })
  if (createResult.status !== 0) throw new Error(`D1 create failed: ${createResult.stderr?.trim()}`)

  const uuid = createResult.stdout.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )?.[0]
  if (!uuid) throw new Error("D1 create succeeded but couldn't parse the database UUID")
  ok(`Created D1 database ${c.cyan(D1_NAME)} ${c.dim(`(${uuid})`)}`)
  return uuid
}

function ensureKvNamespace(accountId: string): string {
  step(5, "KV namespace for OAuth tokens")

  const listResult = spawnSync("npx", ["wrangler", "kv", "namespace", "list"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  })
  if (listResult.status === 0 && listResult.stdout?.trim()) {
    const namespaces = JSON.parse(listResult.stdout) as { id: string; title: string }[]
    const existing = namespaces.find((ns) => ns.title === KV_NAME)
    if (existing?.id) {
      ok(`Found existing KV namespace ${c.cyan(KV_NAME)}`)
      return existing.id
    }
  }

  info(`Creating KV namespace "${KV_NAME}"...`)
  const createResult = spawnSync("npx", ["wrangler", "kv", "namespace", "create", KV_NAME], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  })
  if (createResult.status !== 0) throw new Error(`KV create failed: ${createResult.stderr?.trim()}`)

  const id = createResult.stdout.match(/"id":\s*"([^"]+)"/)?.[1]
  if (!id) throw new Error("KV create succeeded but couldn't parse the namespace ID")
  ok(`Created KV namespace ${c.cyan(KV_NAME)} ${c.dim(`(${id})`)}`)
  return id
}

function writeWranglerConfig(d1DatabaseId: string, kvNamespaceId: string): void {
  step(6, "Local Worker config (wrangler.jsonc)")

  if (!fs.existsSync(WRANGLER_EXAMPLE_PATH)) throw new Error(`Missing ${WRANGLER_EXAMPLE_PATH}`)
  const out = fs
    .readFileSync(WRANGLER_EXAMPLE_PATH, "utf8")
    .replace(/YOUR_DATABASE_ID/g, d1DatabaseId)
    .replace(/YOUR_KV_NAMESPACE_ID/g, kvNamespaceId)
  fs.writeFileSync(WRANGLER_JSONC_PATH, out)
  ok(
    `Wrote wrangler.jsonc ${c.dim(`(D1: ${d1DatabaseId.slice(0, 8)}… KV: ${kvNamespaceId.slice(0, 8)}…)`)}`,
  )
}

function applyD1Schema(accountId: string): void {
  step(7, "D1 schema migration")

  if (!fs.existsSync(SCHEMA_PATH)) throw new Error(`Missing schema file ${SCHEMA_PATH}`)
  info("Applying migrations/001_init.sql...")
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", D1_NAME, "--remote", "--file", SCHEMA_PATH],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    },
  )
  if (result.status !== 0) throw new Error("D1 schema migration failed")
  ok("Schema applied")
}

async function ensureStravaCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  step(8, "Strava API credentials")

  const vars = loadDevVars(DEV_VARS_PATH)
  let clientId = vars["STRAVA_CLIENT_ID"] ?? ""
  let clientSecret = vars["STRAVA_CLIENT_SECRET"] ?? ""

  if (clientId && clientSecret) {
    if (await confirm("Found existing Strava credentials in .dev.vars — use them?", true)) {
      ok("Reusing existing Strava credentials")
      return { clientId, clientSecret }
    }
  }

  console.log("  You need a Strava API application to connect this server.")
  console.log(`  ${c.bold("Create one at:")} ${c.cyan(STRAVA_API_URL)}`)
  console.log(`  ${c.dim("Important: set Authorization Callback Domain to")} ${c.cyan("localhost")}\n`)

  if (!(await confirm("Do you have a Strava API app already?", false))) {
    openBrowser(STRAVA_API_URL)
    await pressEnter("Press Enter once your Strava app is created...")
  }

  clientId = await promptHidden("Client ID (hidden)")
  if (!clientId) throw new Error("Client ID cannot be empty")

  clientSecret = await promptHidden("Client Secret (hidden)")
  if (!clientSecret) throw new Error("Client Secret cannot be empty")

  saveDevVars(DEV_VARS_PATH, { STRAVA_CLIENT_ID: clientId, STRAVA_CLIENT_SECRET: clientSecret })
  ok("Strava credentials saved to .dev.vars")
  return { clientId, clientSecret }
}

async function promptMcpPassword(): Promise<string> {
  step(9, "MCP server password")

  const existing = loadDevVars(DEV_VARS_PATH)[AUTH_SECRET_NAME]
  if (existing) {
    if (await confirm("Found existing MCP password in .dev.vars — use it?", true)) {
      ok("Reusing existing MCP password")
      return existing
    }
  }

  console.log("  This password protects your MCP server from unauthorized access.")
  console.log("  You'll enter it once when connecting Claude; the token lasts 30 days.")
  console.log(
    `  ${c.dim("Min 12 characters, one number, one special character. Never stored in code or logs.")}\n`,
  )

  while (true) {
    const password = await promptHidden("Choose a password (hidden)")
    if (!password) throw new Error("Password cannot be empty")
    const err = validatePassword(password)
    if (err) {
      warn(err)
      continue
    }
    saveDevVars(DEV_VARS_PATH, { [AUTH_SECRET_NAME]: password })
    ok("Password saved to .dev.vars")
    return password
  }
}

async function runDeploy(accountId: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", "deploy"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    })

    let output = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      const t = chunk.toString()
      output += t
      process.stdout.write(t)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      const t = chunk.toString()
      output += t
      process.stderr.write(t)
    })
    child.on("exit", (code) => resolve({ code, output }))
    child.on("error", reject)
  })
}

async function waitForWorker(
  workerUrl: string,
  isFirstDeploy: boolean,
  timeoutMs = 120_000,
): Promise<boolean> {
  const healthUrl = `${workerUrl}/health`
  const deadline = Date.now() + timeoutMs
  if (isFirstDeploy) {
    console.log()
    info(
      "First-time deploy: Cloudflare is provisioning an SSL certificate for your workers.dev subdomain.",
    )
    info("This only happens once — subsequent deploys are instant.")
  }
  process.stdout.write(`  ${c.dim("•")} ${c.dim("Waiting for Worker to come online")}`)
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) })
      if (res.ok) {
        process.stdout.write("\n")
        return true
      }
    } catch {
      // SSL not ready or Worker not up yet — keep polling
    }
    process.stdout.write(c.dim("."))
    await new Promise((r) => setTimeout(r, 3_000))
  }
  process.stdout.write("\n")
  return false
}

async function deployWorker(accountId: string): Promise<string> {
  step(10, "Deploy Worker to Cloudflare")

  for (let attempt = 1; attempt <= 2; attempt++) {
    info(
      attempt === 1
        ? "Running `wrangler deploy`... (first deploy takes ~20s)"
        : "Retrying deploy...",
    )

    const { code, output } = await runDeploy(accountId)

    if (code === 0) {
      const match = output.match(/https:\/\/[\w-]+\.[\w-]+\.workers\.dev/)
      if (!match) throw new Error("Deploy succeeded but couldn't parse the Worker URL from output.")
      ok(`Worker deployed → ${c.cyan(match[0])}`)
      return match[0]
    }

    if (attempt === 1 && output.includes("workers.dev subdomain")) {
      warn("Your Cloudflare account needs a workers.dev subdomain — required for first deploy.")
      console.log(
        `  ${c.dim("Cloudflare auto-populates a subdomain — accept it or change it, then click Save.")}`,
      )
      openBrowser(`https://dash.cloudflare.com/${accountId}/workers`)
      await pressEnter("Press Enter once your subdomain is registered...")
      continue
    }

    throw new Error(`wrangler deploy failed (exit ${code})`)
  }

  // v8 ignore next -- unreachable: loop always returns or throws before this
  throw new Error("wrangler deploy failed — check your Cloudflare account setup")
}

async function authorizeStrava(
  accountId: string,
  kvId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  step(11, "Authorize Strava")

  const tokens = await runStravaOAuth(clientId, clientSecret)
  ok("Strava tokens obtained")

  const accessTokenPayload = JSON.stringify({ token: tokens.accessToken, expires_at: tokens.expiresAt })
  const cfEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: "false" }

  const putAccess = spawnSync(
    "npx",
    ["wrangler", "kv", "key", "put", "strava:access_token", accessTokenPayload, "--namespace-id", kvId],
    { stdio: ["ignore", "inherit", "inherit"], env: cfEnv },
  )
  if (putAccess.status !== 0) throw new Error("Failed to write strava:access_token to production KV")
  ok("strava:access_token written to production KV")

  const putRefresh = spawnSync(
    "npx",
    ["wrangler", "kv", "key", "put", "strava:refresh_token", tokens.refreshToken, "--namespace-id", kvId],
    { stdio: ["ignore", "inherit", "inherit"], env: cfEnv },
  )
  if (putRefresh.status !== 0) throw new Error("Failed to write strava:refresh_token to production KV")
  ok("strava:refresh_token written to production KV")

  return tokens.refreshToken
}

function setWorkerSecrets(
  accountId: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  mcpPassword: string,
): void {
  step(12, "Set Worker secrets")

  for (const [name, value] of [
    ["STRAVA_CLIENT_ID", clientId],
    ["STRAVA_CLIENT_SECRET", clientSecret],
    // Fallback if KV tokens are ever missing — auth.ts uses this before failing
    ["STRAVA_REFRESH_TOKEN", refreshToken],
    [AUTH_SECRET_NAME, mcpPassword],
  ] as const) {
    const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
      input: value,
      stdio: ["pipe", "ignore", "inherit"],
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    })
    if (result.status !== 0) throw new Error(`Failed to set secret ${name}`)
    ok(`Secret ${c.cyan(name)} set`)
  }
}

let loginChild: import("node:child_process").ChildProcess | null = null

process.on("SIGINT", () => {
  if (loginChild) {
    try {
      loginChild.kill("SIGTERM")
    } catch {
      /* ignore */
    }
  }
  closePrompts()
  process.exit(130)
})

async function main(): Promise<void> {
  banner("strava-mcp-server — Bootstrap", [
    "This will set up everything needed to chat with",
    "your Strava data in Claude.",
    "",
    "It creates (in your Cloudflare account):",
    "  • A D1 database for caching",
    "  • A KV namespace for OAuth tokens",
    "  • A Worker that talks to the Strava API",
    "",
    "Access is protected by a password you choose.",
    "",
    `${c.bold("You'll need:")}`,
    `  • A ${c.cyan("Cloudflare account")} — free, sign up during the login step`,
    `  • A ${c.cyan("Strava API application")} (strava.com/settings/api)`,
    `    Set Authorization Callback Domain to: ${c.cyan("localhost")}`,
    "",
    `Estimated time: ${c.bold("~3 minutes")}`,
  ])

  if (!(await confirm("Ready to start?", true))) {
    console.log("  Cancelled. Run again any time with `pnpm bootstrap`.")
    return
  }

  const { accountId } = await ensureWranglerAuth()

  step(3, "Check existing resources")
  const d1List = spawnSync("npx", ["wrangler", "d1", "list", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  })
  const kvList = spawnSync("npx", ["wrangler", "kv", "namespace", "list"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  })
  const dbs =
    d1List.status === 0 && d1List.stdout?.trim()
      ? (JSON.parse(d1List.stdout) as { name: string }[])
      : []
  const kvs =
    kvList.status === 0 && kvList.stdout?.trim()
      ? (JSON.parse(kvList.stdout) as { title: string }[])
      : []
  const existingD1 = dbs.some((db) => db.name === D1_NAME)
  const existingKv = kvs.some((ns) => ns.title === KV_NAME)

  console.log()
  banner("Ready to provision", [
    `Cloudflare account:  ${c.cyan(accountId)}`,
    "",
    `${c.bold("The following will happen:")}`,
    `  • D1 database "${D1_NAME}" — ${existingD1 ? c.dim("reuse existing") : c.green("create new")}`,
    `  • KV namespace "${KV_NAME}" — ${existingKv ? c.dim("reuse existing") : c.green("create new")}`,
    `  • Apply D1 schema (idempotent)`,
    `  • Deploy Worker "${WORKER_NAME}" (create on first run, update otherwise)`,
    `  • Authorize with Strava (browser OAuth flow)`,
    `  • Set STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, MCP_AUTH_PASSWORD secrets`,
  ])
  if (!(await confirm("Proceed?", true))) {
    console.log("  Cancelled — no changes were made.")
    return
  }

  const dbId = ensureD1(accountId)
  const kvId = ensureKvNamespace(accountId)
  saveDevVars(BOOTSTRAP_STATE_PATH, { KV_NAMESPACE_ID: kvId })
  writeWranglerConfig(dbId, kvId)

  step(6.5, "Regenerate Worker types")
  info("Running `wrangler types`...")
  const typegen = spawnSync("npx", ["wrangler", "types"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  })
  if (typegen.status !== 0) warn("Type generation failed — run `pnpm cf-typegen` manually")
  else ok("worker-configuration.d.ts updated")

  applyD1Schema(accountId)

  const { clientId, clientSecret } = await ensureStravaCredentials()
  const mcpPassword = await promptMcpPassword()
  const workerUrl = await deployWorker(accountId)

  const refreshToken = await authorizeStrava(accountId, kvId, clientId, clientSecret)
  saveDevVars(DEV_VARS_PATH, { STRAVA_REFRESH_TOKEN: refreshToken })
  ok("STRAVA_REFRESH_TOKEN saved to .dev.vars")
  setWorkerSecrets(accountId, clientId, clientSecret, refreshToken, mcpPassword)

  const alreadyConnected = loadDevVars(BOOTSTRAP_STATE_PATH)["CLAUDE_CONNECTED"] === "true"
  const ready = await waitForWorker(workerUrl, !alreadyConnected)
  if (!ready) {
    warn("Worker URL isn't responding yet — SSL cert may still be provisioning.")
    warn("Wait ~60s and try connecting Claude, or re-run `pnpm bootstrap` to retry.")
  } else {
    ok("Worker is live and reachable")
  }

  const mcpUrl = `${workerUrl}/mcp`
  const clipped = copyToClipboard(mcpUrl)
  if (!alreadyConnected) {
    openBrowser("https://claude.ai/settings/connectors")
    saveDevVars(BOOTSTRAP_STATE_PATH, { CLAUDE_CONNECTED: "true" })
  }

  console.log()
  banner("✅  Setup complete!", [
    `Worker:  ${c.cyan(workerUrl)}`,
    "",
    `${c.bold("Connect Claude:")} ${clipped ? "MCP URL copied to clipboard —" : "paste this URL:"}`,
    `  ${c.cyan(mcpUrl)}`,
    ...(alreadyConnected
      ? [`  ${c.dim("Run `pnpm revoke` to force re-auth if you changed your password.")}`]
      : [`  ${c.dim("(browser opened to claude.ai/settings/connectors)")}`]),
    "",
    `${c.dim("First connection opens a browser for your MCP password.")}`,
    `${c.dim("Token lasts 30 days — re-auth is automatic via Strava refresh token.")}`,
  ])
}

main()
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`\n${c.red("✗ Setup failed:")} ${msg}`)
    process.exit(1)
  })
  .finally(() => closePrompts())
