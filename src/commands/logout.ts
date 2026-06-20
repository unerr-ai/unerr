/**
 * unerr logout — disconnect this machine from your team.
 *
 * Deletes the local credential file and the entitlement cache (written in
 * Sprint I3). The token also stays revocable server-side from the web app's
 * Settings → Machines page regardless of this local file.
 *
 * All output goes to stderr.
 */

import type { Command } from "commander";
import { clearAuthEvents } from "../cloud/auth-events.js";
import { CloudClient } from "../cloud/client.js";
import {
  deleteCredentials,
  deleteEntitlementsCache,
  deleteTeamConventionsCache,
  isLoggedIn,
  readCredentials,
} from "../cloud/credentials.js";
import { recordLogout } from "../cloud/login-ledger.js";
import { computeMachineFingerprint } from "../cloud/machine-fingerprint.js";

function out(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Hard ceiling on the best-effort disconnect call so logout never hangs. */
const DISCONNECT_TIMEOUT_MS = 3000;

/**
 * Best-effort POST /machine/disconnect so the server closes this machine's open
 * login-history entry. Bounded to {@link DISCONNECT_TIMEOUT_MS}; never throws.
 */
async function reportDisconnect(): Promise<void> {
  const creds = readCredentials();
  if (!creds?.token) return;
  try {
    const client = new CloudClient({
      apiUrl: creds.api_url,
      token: creds.token,
    });
    await Promise.race([
      client
        .postMachineDisconnect({
          reason: "logout",
          client_name: creds.machine_name || undefined,
          machine_fingerprint: computeMachineFingerprint(),
          at: new Date().toISOString(),
        })
        .catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, DISCONNECT_TIMEOUT_MS)),
    ]);
  } catch {
    /* best-effort — a logout must never fail on the network */
  }
}

export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Disconnect this machine from your unerr team")
    .action(async () => {
      const wasLoggedIn = isLoggedIn();

      // Tell the server we're going (best-effort, bounded) BEFORE we wipe the
      // token — once credentials are gone the call can't authenticate.
      if (wasLoggedIn) {
        await reportDisconnect();
        recordLogout("logout");
      }

      const removedCreds = deleteCredentials();
      deleteEntitlementsCache();
      deleteTeamConventionsCache();
      // Forget all provenance — logout is an intentional disconnect, so the
      // next state must be a clean `logged_out`, even if this machine was
      // previously revoked (which leaves a marker `authState()` reads).
      clearAuthEvents();

      out("");
      if (wasLoggedIn || removedCreds) {
        out("  Disconnected. This machine is no longer connected to a team.");
        out("  Your local code intelligence keeps working as before.");
      } else {
        out("  This machine wasn't connected to a team.");
      }
      out("");
    });
}
