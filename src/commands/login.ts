/**
 * unerr login — connect this machine to your team.
 *
 * Two paths:
 *  - Default: the RFC 8628 device flow (works everywhere, including SSH).
 *  - `--token <token>`: paste a machine token directly (CI / locked-down
 *    environments). The token is validated by calling the entitlements
 *    endpoint before anything is written to disk.
 *
 * All output goes to stderr (stdout stays clean for MCP JSON-RPC). The
 * machine token is never printed.
 *
 * Logging in is optional — the CLI works fully without an account. This
 * command only adds cloud features for paid teams.
 */

import { createInterface } from "node:readline";
import type { Command } from "commander";
import { CloudClient, assertSafeBaseUrl } from "../cloud/client.js";
import {
  type Credentials,
  DEFAULT_API_URL,
  isLoggedIn,
  readCredentials,
  writeCredentials,
} from "../cloud/credentials.js";
import { runDeviceFlow } from "../cloud/device-flow.js";
import { refreshEntitlements } from "../cloud/entitlements.js";

function out(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Fetch + cache the signed entitlement token right after login, and return a
 * plain-language sentence describing the plan the machine landed on. Never
 * throws — login already succeeded; a failed refresh just yields a softer
 * message (the daemon's periodic job will catch up).
 */
async function refreshAndDescribePlan(
  apiUrl: string,
  token: string
): Promise<string> {
  try {
    const outcome = await refreshEntitlements(
      new CloudClient({ apiUrl, token })
    );
    if (outcome.result === "ok") {
      if (outcome.verified) {
        return `Your team is on the ${outcome.plan} plan.`;
      }
      // Server has no signing key — plan is reported but unverified, so the
      // CLI treats it as free for gating. Say so plainly.
      return `Your team reports the ${outcome.plan} plan (the server isn't signing plans yet, so paid features stay off until it does).`;
    }
  } catch {
    /* fall through to the soft message */
  }
  return "Run unerr whoami to see your team's plan.";
}

/** Resolve the API URL for a fresh login (env override wins). */
function resolveApiUrl(): string {
  const env = process.env.UNERR_API_URL?.trim();
  return (env || DEFAULT_API_URL).replace(/\/+$/, "");
}

/**
 * The login flow, callable from the `login` command AND from install-time
 * chaining (A5) — one implementation, no duplicate login path. Resolves the
 * control-plane URL, refuses an unsafe one, short-circuits when already
 * connected, then runs the `--token` path or the interactive device flow.
 * All output is on stderr; the token is never printed. Never throws.
 */
export async function runLogin(opts: { token?: string } = {}): Promise<void> {
  const apiUrl = resolveApiUrl();

  // Refuse an unencrypted / malformed control-plane URL up front, with a
  // friendly message instead of an uncaught throw from CloudClient.
  try {
    assertSafeBaseUrl(apiUrl);
  } catch (err) {
    out("");
    out(`  ${err instanceof Error ? err.message : String(err)}`);
    out("");
    process.exitCode = 1;
    return;
  }

  if (isLoggedIn()) {
    const existing = readCredentials();
    const where = existing?.organization_id
      ? ` to ${existing.organization_id}`
      : "";
    out("");
    out(`  This machine is already connected${where}.`);
    out("  Run unerr logout first if you want to switch teams.");
    out("");
    return;
  }

  if (opts.token) {
    await loginWithToken(apiUrl, opts.token.trim());
    return;
  }

  await loginWithDeviceFlow(apiUrl);
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Connect this machine to your unerr team")
    .option(
      "--token <token>",
      "Sign in with a machine token instead of the browser (for CI)"
    )
    .action(async (opts: { token?: string }) => {
      await runLogin(opts);
    });
}

/** One-key [Y/n] confirm on stderr; empty/yes → true, 30s timeout → false. */
export function askConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    const timer = setTimeout(() => {
      rl.close();
      resolve(false);
    }, 30_000);
    rl.question("  Connect to your unerr team now? [Y/n] ", (answer) => {
      clearTimeout(timer);
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "" || a === "y" || a === "yes");
    });
  });
}

/**
 * Offer the one-key connect prompt from any non-serving entry point — bare
 * `unerr` first-run, `unerr pm status`, and `unerr install`. A no-op when this
 * machine is already connected or when there is no interactive terminal (the
 * MCP-serving path, a pipe, or CI), so it never re-nags a connected user and
 * never blocks a non-interactive run. Login is on by default; this is the one
 * shared prompt so a user never has to discover `unerr login` on their own.
 */
export async function offerLoginIfNeeded(): Promise<void> {
  if (isLoggedIn()) return;
  const hasTty = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (!hasTty) return;
  if (await askConnect()) {
    await runLogin();
  } else {
    process.stderr.write(
      "\n  \x1b[38;2;161;161;170mYou're on the free plan. Run `unerr login` any time to connect your team.\x1b[0m\n\n"
    );
  }
}

/** `--token` path: validate against entitlements, then save. */
async function loginWithToken(apiUrl: string, token: string): Promise<void> {
  if (!token) {
    out("  No token provided. Pass it like: unerr login --token <token>");
    process.exitCode = 1;
    return;
  }

  out("  Checking the token...");
  const client = new CloudClient({ apiUrl, token });
  const res = await client.getEntitlements();

  if (!res.ok) {
    if (res.status === 0) {
      out(`  ${res.error.message}`);
      out("  The token was not saved. Try again when you're online.");
      process.exitCode = 1;
      return;
    }
    if (res.status === 401) {
      out("  That token didn't work — it may be wrong or already revoked.");
      out("  Get a fresh one by running unerr login (no --token).");
      process.exitCode = 1;
      return;
    }
    out(`  Could not verify the token: ${res.error.message}`);
    process.exitCode = 1;
    return;
  }

  const creds: Credentials = {
    api_url: apiUrl,
    token,
    organization_id: res.data.organization_id ?? "",
    machine_id: res.data.machine_id ?? "",
    machine_name: "",
  };
  writeCredentials(creds);

  // Refresh the signed entitlement cache immediately so offline tier checks
  // work right away, and report the plan we actually landed on.
  const landed = await refreshAndDescribePlan(apiUrl, token);

  out("");
  out(`  Connected. ${landed}`);
  out("");
}

/** Default path: device flow, then save the minted credential. */
async function loginWithDeviceFlow(apiUrl: string): Promise<void> {
  const result = await runDeviceFlow(apiUrl);

  switch (result.status) {
    case "success": {
      const creds: Credentials = {
        api_url: apiUrl,
        token: result.access_token,
        organization_id: result.organization_id,
        machine_id: result.machine_id,
        machine_name: result.machine_name,
      };
      writeCredentials(creds);

      // Prime the signed entitlement cache now (so offline tier checks work
      // immediately) and report the plan we landed on.
      const landed = await refreshAndDescribePlan(apiUrl, result.access_token);

      out("");
      out(
        `  Connected as ${result.machine_name || "this machine"}${
          result.organization_id ? ` to ${result.organization_id}` : ""
        }.`
      );
      out(`  ${landed}`);
      out("  Run unerr whoami any time to see your team and plan.");
      out("");
      return;
    }
    case "denied":
    case "expired":
    case "network":
    case "error":
      out("");
      out(`  ${result.message}`);
      out("");
      process.exitCode = 1;
      return;
  }
}
