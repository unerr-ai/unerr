/**
 * unerr update — view the auto-update status and set the local policy.
 *
 * Three shapes (AUTO_UPDATE_STRATEGY.md §7):
 *  - `unerr update`               → print the resting status (current/latest/
 *                                   policy/manager + the exact upgrade command).
 *  - `unerr update --mode <m>`    → persist `update.mode` (auto|notify|off) to
 *                                   the user-level ~/.unerr/settings.json. The
 *                                   daemon picks it up on its next sweep; this
 *                                   never restarts a running unerr.
 *  - `unerr update --check`       → force a registry check now (bypass throttle)
 *                                   and print what it found.
 *
 * Auto-update is machine-wide (one daemon per machine), so the mode lives in
 * the USER settings file, not the per-repo one. We never sudo, never install
 * from here, and never touch the user's project files — applying an update is
 * the daemon's job, gated by U5.
 *
 * All output goes to stderr to protect the MCP stdout stream.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import type { UpdatePolicy } from "../update/update-config.js";
import {
  releaseNotesUrl,
  updateStatusLine,
  updateStatusPanel,
} from "../update/update-surface.js";

function out(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Path to the user-level settings file (auto-update is machine-wide). */
function userSettingsPath(): string {
  return join(homedir(), ".unerr", "settings.json");
}

/**
 * Persist `update.mode` into ~/.unerr/settings.json, preserving every other
 * key. Reads-merges-writes the single latest file (no versioning, no backup).
 */
function writeUpdateMode(mode: UpdatePolicy): void {
  const path = userSettingsPath();
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      current = {};
    }
  }
  const existingUpdate =
    typeof current.update === "object" && current.update !== null
      ? (current.update as Record<string, unknown>)
      : {};
  const next = { ...current, update: { ...existingUpdate, mode } };
  mkdirSync(join(homedir(), ".unerr"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

/** Render the resting status block to stderr. */
function printStatus(): void {
  const panel = updateStatusPanel();
  out("");
  out(`  ${updateStatusLine()}`);
  out("");
  out(`  policy:  ${panel.policy}`);
  out(`  manager: ${panel.manager} (${panel.mode})`);
  if (panel.latest) {
    out(`  latest:  ${panel.latest} — ${releaseNotesUrl(panel.latest)}`);
  }
  if (panel.pendingVersion) {
    out(`  staged:  ${panel.pendingVersion} (applies on next restart)`);
  }
  if (panel.upgradeCommand) {
    out(`  upgrade: ${panel.upgradeCommand}`);
  }
  out("");
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Show auto-update status, or set the policy (auto|notify|off)")
    .option(
      "--mode <mode>",
      "set the auto-update policy: auto | notify | off"
    )
    .option("--check", "check the registry for a newer release now")
    .action(async (opts: { mode?: string; check?: boolean }) => {
      // ── Set the policy ─────────────────────────────────────────
      if (opts.mode !== undefined) {
        const mode = opts.mode.trim().toLowerCase();
        if (mode !== "auto" && mode !== "notify" && mode !== "off") {
          out(`[unerr] Invalid mode "${opts.mode}". Use: auto | notify | off`);
          process.exit(1);
        }
        writeUpdateMode(mode);
        out(`[unerr] Auto-update mode set to "${mode}".`);
        out(
          "  Takes effect on the daemon's next check; no restart needed."
        );
        printStatus();
        return;
      }

      // ── Force a check ──────────────────────────────────────────
      if (opts.check) {
        const { checkForUpdate } = await import(
          "../update/version-check.js"
        );
        out("[unerr] Checking the registry for a newer release…");
        const res = await checkForUpdate({ force: true });
        if (res.kind === "none") {
          out(`  unerr ${res.current} — up to date.`);
        } else {
          out(
            `  unerr ${res.latest} available (${res.kind}) — release notes: ${releaseNotesUrl(res.latest ?? "")}`
          );
        }
        printStatus();
        return;
      }

      // ── Default: show status ───────────────────────────────────
      printStatus();
    });
}
