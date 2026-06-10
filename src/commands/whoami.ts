/**
 * unerr whoami — show your team and plan.
 *
 * Reads the local credential file. If connected, calls the entitlements
 * endpoint to show the organization and plan. If not connected, says so
 * plainly and points to `unerr login`.
 *
 * A `401 revoked_token` means the team disconnected this machine: we wipe
 * the local credentials + entitlement cache and tell the user.
 *
 * All output goes to stderr. The machine token is never printed.
 */

import type { Command } from "commander";
import { CloudClient } from "../cloud/client.js";
import { readTeamConventions } from "../cloud/conventions-sync.js";
import { readCredentials } from "../cloud/credentials.js";
import { effectiveTier, refreshEntitlements } from "../cloud/entitlements.js";
import { handleRevokedToken } from "../cloud/login-state.js";

/**
 * Plain-language one-liner describing the synced team-conventions doc, if
 * any. This is a READ-ONLY "team (synced)" layer kept separate from the
 * locally-learned conventions — provenance stays visible, never merged.
 */
function teamConventionsLine(): string | null {
  const doc = readTeamConventions();
  if (!doc || doc.version === 0 || doc.content.trim().length === 0) {
    return null;
  }
  const lines = doc.content
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
  return `team (synced): conventions version ${doc.version}, ${lines} lines (read-only)`;
}

/** Plain-language line describing the cached tier (grace etc.). */
function cachedTierLine(): string | null {
  const tier = effectiveTier();
  if (tier.source === "grace" && tier.reconnect_by) {
    const by = new Date(tier.reconnect_by).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    return `running on a cached plan — reconnect by ${by} to keep ${tier.plan} features`;
  }
  return null;
}

function out(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("Show which team this machine is connected to, and its plan")
    .action(async () => {
      const creds = readCredentials();

      if (!creds) {
        out("");
        out("  Not connected to a team.");
        out("  Run unerr login to connect this machine.");
        out("");
        return;
      }

      out("");
      out(
        `  Machine: ${creds.machine_name || "(this machine)"}${
          creds.machine_id ? ` (${creds.machine_id})` : ""
        }`
      );

      const client = new CloudClient({
        apiUrl: creds.api_url,
        token: creds.token,
      });
      const res = await client.getEntitlements();

      if (res.ok) {
        // Refresh the signed cache while we're online, then read back the
        // effective (verified) tier so the displayed plan matches what
        // features will actually unlock.
        await refreshEntitlements(client).catch(() => undefined);
        out(`  Team:    ${res.data.organization_id}`);
        const tier = effectiveTier();
        // Show the verified gating plan; if the server isn't signing yet,
        // the verified tier is free even though the server reports more.
        if (tier.source === "none" && tier.plan === "free") {
          out(
            `  Plan:    ${res.data.plan} (unverified — paid features stay off)`
          );
        } else {
          out(`  Plan:    ${tier.plan}`);
        }
        const teamConv = teamConventionsLine();
        if (teamConv) out(`  ${teamConv}`);
        out("");
        return;
      }

      if (res.status === 401 && res.error.code === "revoked_token") {
        const msg = handleRevokedToken();
        out(`  ${msg}`);
        out("");
        process.exitCode = 1;
        return;
      }

      if (res.status === 401) {
        out("  Your saved login is no longer valid. Run unerr login again.");
        out("");
        process.exitCode = 1;
        return;
      }

      if (res.status === 0) {
        // Offline — show what we know from the signed cache + credential file.
        out(`  Team:    ${creds.organization_id || "(unknown)"}`);
        const tier = effectiveTier();
        out(`  Plan:    ${tier.plan}`);
        const grace = cachedTierLine();
        if (grace) out(`  ${grace}`);
        const teamConv = teamConventionsLine();
        if (teamConv) out(`  ${teamConv}`);
        out(`  ${res.error.message}`);
        out("  (Showing the last known plan — couldn't reach the cloud.)");
        out("");
        return;
      }

      out(`  Couldn't load your plan: ${res.error.message}`);
      out("");
      process.exitCode = 1;
    });
}
