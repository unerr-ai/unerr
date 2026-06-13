/**
 * Persist the machine-wide auto-update policy to `~/.unerr/settings.json`.
 *
 * Auto-update is machine-wide (one daemon per machine), so `update.mode` lives
 * in the USER settings file, not the per-repo one. Read-merge-write keeps every
 * other key intact. The daemon picks the new mode up on its next sweep; this
 * never restarts a running unerr. The sole writer now that the `unerr update`
 * CLI command is gone — the dashboard Settings page calls it via the
 * `/api/system/update-mode` route.
 *
 * @sem domain=configuration role=writer
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UpdatePolicy } from "./update-config.js";

/** Path to the user-level settings file (auto-update is machine-wide). */
function userSettingsPath(): string {
  return join(homedir(), ".unerr", "settings.json");
}

/**
 * Persist `update.mode` into `~/.unerr/settings.json`, preserving every other
 * key. Reads-merges-writes the single latest file (no versioning, no backup).
 */
export function writeUpdateMode(mode: UpdatePolicy): void {
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
