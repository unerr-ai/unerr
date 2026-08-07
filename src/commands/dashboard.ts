/**
 * unerr dashboard — open the cloud analytics dashboard in the browser.
 *
 * The dashboard is the cloud, org-scoped and authenticated. There is no
 * local analytics dashboard (removed in L1); the local CLI surfaces only a
 * live status view (the per-turn economy line + `pm status` / `doctor`).
 *
 * The dashboard URL is derived from the SAME `api_url` the cloud client uses
 * — `readCredentials().api_url`, which already honors the `UNERR_API_URL`
 * override and falls back to the configured default. It is NEVER hardcoded.
 * The authenticated landing route on the web app is `/overview` (login,
 * register, and accept-invitation all redirect there), so the dashboard URL
 * is `<api_url>/overview`.
 *
 * Logged out → no `api_url` to derive from, so we explain how to log in
 * instead of guessing a host.
 *
 * All output goes to stderr (stdout is reserved for MCP JSON-RPC).
 */

import type { Command } from "commander";
import { readCredentials } from "../cloud/auth/index.js";
import { openUrlInDefaultBrowser } from "../utils/exec.js";

/** Authenticated landing route on the cloud web app. */
const CLOUD_DASHBOARD_PATH = "/overview";

function out(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Build the cloud dashboard URL from the configured cloud `api_url`. Returns
 * `null` when logged out (no credential → no base URL to derive from).
 */
export function resolveCloudDashboardUrl(): string | null {
  const creds = readCredentials();
  if (!creds) return null;
  // `creds.api_url` is the resolved base (env override → stored → default,
  // trailing slashes stripped) — the exact base CloudClient is constructed
  // with. Append the authenticated landing route.
  return `${creds.api_url}${CLOUD_DASHBOARD_PATH}`;
}

export function registerDashboardCommand(program: Command): void {
  program
    .command("dashboard")
    .description("Open the cloud analytics dashboard in your browser")
    .action(async () => {
      const url = resolveCloudDashboardUrl();

      if (!url) {
        out("");
        out("  Not connected to a team — no dashboard to open.");
        out("  Run unerr login to connect this machine, then try again.");
        out("");
        return;
      }

      out("");
      out(`  Opening the cloud dashboard: ${url}`);
      out("");
      try {
        await openUrlInDefaultBrowser(url);
      } catch {
        // Headless / no browser handler — the URL is already printed above so
        // the user can open it manually.
        out("  Could not open a browser automatically.");
        out(`  Open this URL manually: ${url}`);
        out("");
      }
    });
}
