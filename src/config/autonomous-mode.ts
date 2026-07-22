/**
 * Per-repo autonomous-mode flag: set by `unerr install claude-code
 * --autonomous` for sessions that run with no human watching, read by hooks
 * and instruction content to switch from advisory nudges to strict
 * verification behavior.
 *
 * @sem domain=configuration role=settings
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * True when the repo's `.unerr/config.json` carries `"autonomous": true`.
 * Safe inside hook handlers: synchronous single small-file read, and every
 * failure mode (missing file, bad JSON) reads as interactive mode.
 *
 * @sem domain=configuration role=settings
 */
export function readAutonomousMode(repoRoot: string): boolean {
  try {
    const raw = readFileSync(join(repoRoot, ".unerr", "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).autonomous === true
    );
  } catch {
    return false;
  }
}

/**
 * Sets or clears the `autonomous` key in `.unerr/config.json`, preserving
 * every other key. Clearing deletes the key so an interactive repo's config
 * stays byte-stable across repeated plain installs.
 *
 * @sem domain=configuration role=settings
 */
export function writeAutonomousMode(repoRoot: string, on: boolean): void {
  const configDir = join(repoRoot, ".unerr");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable config: rebuild with only the mode key; ensureRepoConfig
      // restores repoId on the next install pass.
    }
  }
  if (on) {
    existing.autonomous = true;
  } else {
    const { autonomous: _cleared, ...rest } = existing;
    existing = rest;
  }
  writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`);
}
