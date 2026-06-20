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
 * Login is mandatory (2026-06-14, owner decision; see
 * `.internal/LOGIN_UX_STRATEGY.md`). The `preAction` wall in
 * `src/entrypoints/cli.ts` calls `runLogin()` to drive a blocked command
 * through the device flow, then re-dispatches the original command. For
 * non-interactive use (CI / agents), set `UNERR_TOKEN` or pass `--token`.
 */

import type { Command } from "commander";
import { CloudClient, assertSafeBaseUrl } from "../cloud/client.js";
import {
  type Credentials,
  DEFAULT_API_URL,
  deleteCredentials,
  isLoggedIn,
  readCredentials,
  writeCredentials,
} from "../cloud/credentials.js";
import { runDeviceFlow } from "../cloud/device-flow.js";
import { refreshEntitlements } from "../cloud/entitlements.js";
import { loginBlocked } from "../cloud/login-gate.js";
import { recordLogin } from "../cloud/login-ledger.js";
import { computeMachineFingerprint } from "../cloud/machine-fingerprint.js";

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

    // A connected machine whose gate is NOT blocked is genuinely active —
    // nothing to do but confirm. (Switching teams still needs an explicit
    // `unerr logout` first.)
    if (!loginBlocked()) {
      const where = existing?.organization_id
        ? ` to ${existing.organization_id}`
        : "";
      out("");
      out(`  This machine is already connected${where}.`);
      out("  Run unerr logout first if you want to switch teams.");
      out("");
      return;
    }

    // Connected but BLOCKED (entitlement expired / revoked while the credential
    // is still on disk). The wall drives runLogin() exactly here, so refusing
    // with "already connected" would dead-end install/start. Self-heal: renew
    // the entitlement with the stored token first.
    if (existing?.token) {
      out("  Renewing your unerr session...");
      const landed = await refreshAndDescribePlan(
        existing.api_url || apiUrl,
        existing.token
      );
      if (!loginBlocked()) {
        out("");
        out(`  Reconnected. ${landed}`);
        out("");
        return;
      }
      // Refresh didn't clear the block — the stored sign-in is dead (revoked /
      // rejected). Drop it and re-authenticate from scratch below.
      out("  Your saved sign-in is no longer valid — reconnecting...");
      deleteCredentials();
    }
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
  recordLogin({ machineFingerprint: computeMachineFingerprint() });

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
      recordLogin({
        machineFingerprint: computeMachineFingerprint(),
        machineName: result.machine_name,
      });

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
