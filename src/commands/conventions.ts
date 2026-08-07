/**
 * unerr conventions — the team's shared conventions document.
 *
 * Two explicit commands sit beside the daemon's automatic background pull:
 *
 *   unerr conventions pull          — fetch the team doc now, save it locally,
 *                                     and print where it landed.
 *   unerr conventions push <file>   — replace the team doc with a file you
 *                                     wrote (or stdin). Uses the optimistic
 *                                     version lock; on a conflict it shows a
 *                                     short summary and asks you to pull first.
 *
 * IMPORTANT — what `push` sends: only the conventions text a human gave it
 * (a file path or stdin). It NEVER sends anything generated from scanning
 * your code, and nothing else ever leaves your machine. The machine token
 * is never printed.
 *
 * All output goes to stderr (stdout stays clean for any piped use). These
 * are cloud features — they need a connected team on a plan that includes
 * conventions sync; otherwise you get a plain-language explanation, not an
 * error.
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  handleRevokedToken,
  readCredentials,
  teamConventionsPath,
} from "../cloud/auth/index.js";
import {
  CloudClient,
  PERSONAL_SCOPE_MESSAGE,
  isPersonalScope,
  readTeamConventions,
  scopeFromEntitlements,
  syncConventions,
  writeTeamConventions,
} from "../cloud/sync/index.js";

function out(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Count non-blank lines as a rough "headline count" for the diff summary. */
function lineCount(text: string): number {
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}

/** Read the whole of stdin as a string (for `push` with no file argument). */
async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk.toString());
  return chunks.join("");
}

export function registerConventionsCommand(program: Command): void {
  const conventions = program
    .command("conventions")
    .description("Your team's shared conventions document (cloud feature)");

  // ── conventions pull ──────────────────────────────────────
  conventions
    .command("pull")
    .description("Fetch your team's conventions document now and save it")
    .action(async () => {
      const creds = readCredentials();
      if (!creds) {
        out("");
        out("  Not connected to a team. Run unerr login first.");
        out("");
        process.exitCode = 1;
        return;
      }

      const client = new CloudClient({
        apiUrl: creds.api_url,
        token: creds.token,
      });
      const outcome = await syncConventions(client);

      out("");
      switch (outcome.result) {
        case "updated":
          out(`  Pulled your team's conventions (version ${outcome.version}).`);
          out(`  Saved to ${teamConventionsPath()}`);
          out('  It shows up as a read-only "team (synced)" layer.');
          break;
        case "unchanged":
          out(
            `  Already up to date (version ${outcome.version}). Nothing to pull.`
          );
          out(`  Stored at ${teamConventionsPath()}`);
          break;
        case "gated":
          // Plain-language explanation — not an error.
          out(`  ${outcome.message}`);
          break;
        case "revoked":
          out(`  ${outcome.message}`);
          process.exitCode = 1;
          break;
        case "network":
          out("  Couldn't reach the unerr cloud — check your connection.");
          out("  Your last synced copy is still in place.");
          break;
        case "not_logged_in":
          out("  Not connected to a team. Run unerr login first.");
          process.exitCode = 1;
          break;
        case "error":
          out(`  Couldn't pull conventions: ${outcome.message}`);
          process.exitCode = 1;
          break;
      }
      out("");
    });

  // ── conventions push ──────────────────────────────────────
  conventions
    .command("push [file]")
    .description(
      "Replace your team's conventions with a file you wrote (or stdin). " +
        "Only this text is sent — never anything from scanning your code."
    )
    .action(async (file?: string) => {
      const creds = readCredentials();
      if (!creds) {
        out("");
        out("  Not connected to a team. Run unerr login first.");
        out("");
        process.exitCode = 1;
        return;
      }

      // Read the human-provided content: a file argument, else stdin.
      let content: string;
      try {
        content = file ? readFileSync(file, "utf-8") : await readStdin();
      } catch (err) {
        out("");
        out(`  Couldn't read ${file ?? "stdin"}: ${(err as Error).message}`);
        out("");
        process.exitCode = 1;
        return;
      }
      if (content.trim().length === 0) {
        out("");
        out("  Nothing to push — the conventions text was empty.");
        out("  Pass a file: unerr conventions push CONVENTIONS.md");
        out("");
        process.exitCode = 1;
        return;
      }

      const client = new CloudClient({
        apiUrl: creds.api_url,
        token: creds.token,
      });

      // B6: a personal-scope token cannot own a shared conventions document —
      // the server answers PUT with `400 scope_unsupported`. Skip the PUT
      // before any write so a solo account gets a plain explanation, not an
      // error. An unknown scope (older server) falls through and the server is
      // the backstop. Entitlement-fetch failure also falls through.
      const ent = await client.getEntitlements();
      const scope = scopeFromEntitlements(ent.ok ? ent.data : null);
      if (isPersonalScope(scope)) {
        out("");
        out(`  ${PERSONAL_SCOPE_MESSAGE}`);
        out("");
        return;
      }

      // Send the last-seen version for the optimistic lock. Absent when we
      // have never pulled (the server then treats it as a fresh write).
      const stored = readTeamConventions();
      const lastVersion = stored?.version;

      const res = await client.putConventions(content, lastVersion);

      out("");
      if (res.ok) {
        out(
          `  Pushed. Your team's conventions are now version ${res.data.version}.`
        );
        // Keep the local copy in step so the next pull is a cheap 304.
        writeTeamConventions({
          content,
          version: res.data.version,
          updated_at: new Date().toISOString(),
          etag: `"v${res.data.version}"`,
          synced_at: new Date().toISOString(),
        });
        out("");
        return;
      }

      if (res.status === 0) {
        out("  Couldn't reach the unerr cloud — check your connection.");
        out("  Nothing was changed. Try again when you're online.");
        out("");
        process.exitCode = 1;
        return;
      }

      if (res.status === 401 && res.error.code === "revoked_token") {
        out(`  ${handleRevokedToken()}`);
        out("");
        process.exitCode = 1;
        return;
      }

      if (res.status === 409 && res.error.code === "version_conflict") {
        // Someone changed the doc since we last pulled. Re-fetch, show a
        // short before/after summary, and ask the user to pull + retry. We
        // do NOT auto-merge.
        const fresh = await client.getConventions();
        out(
          "  Someone else changed the team conventions since your last pull."
        );
        if (fresh.ok && !fresh.notModified) {
          const yourLines = lineCount(content);
          const theirLines = lineCount(fresh.data.content ?? "");
          out(
            `  You're pushing ${yourLines} lines (from version ${
              lastVersion ?? "?"
            }); the team doc is now version ${fresh.data.version} with ${theirLines} lines.`
          );
        }
        out(
          "  Run unerr conventions pull, fold in your changes, then push again."
        );
        out("");
        process.exitCode = 1;
        return;
      }

      out(`  Couldn't push conventions: ${res.error.message}`);
      out("");
      process.exitCode = 1;
    });
}
