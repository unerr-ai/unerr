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
import {
  deleteCredentials,
  deleteEntitlementsCache,
  deleteTeamConventionsCache,
  isLoggedIn,
} from "../cloud/credentials.js";

function out(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Disconnect this machine from your unerr team")
    .action(async () => {
      const wasLoggedIn = isLoggedIn();

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
