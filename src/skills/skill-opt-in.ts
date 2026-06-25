/**
 * Per-repo opt-in skill store.
 *
 * The default install ships ONLY the loose always-on skill. The rigid lifecycle
 * skills (exploration / build-and-debug / test-and-review / review / delegate)
 * are opt-in: a user adds them with `unerr skill install <id>`. This module is
 * the durable record of that choice so the installer writes them and the boot
 * self-heal keeps them instead of treating them as stale and wiping them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OPT_IN_SKILL_IDS } from "./local-pack.js";

/** Path to the per-repo opt-in record. */
export function optInStorePath(cwd: string): string {
  return join(cwd, ".unerr", "state", "opted-in-skills.json");
}

/** Normalize a user-supplied skill name to a bare id (drop any `unerr-` prefix). */
function bareId(id: string): string {
  return id.trim().replace(/^unerr-/, "");
}

/**
 * Read the opted-in skill ids for a repo, filtered to currently-known opt-in
 * skills (a renamed/removed skill in an old record is silently dropped). Returns
 * bare ids. Missing or corrupt file → empty set (safe default: only the loose
 * skill is installed).
 *
 * @sem domain=skills role=accessor
 */
export function readOptInSkills(cwd: string): Set<string> {
  const path = optInStorePath(cwd);
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      skills?: unknown;
    };
    const ids = Array.isArray(parsed.skills) ? parsed.skills : [];
    const known = new Set(OPT_IN_SKILL_IDS);
    return new Set(
      ids
        .filter((x): x is string => typeof x === "string")
        .map(bareId)
        .filter((id) => known.has(id))
    );
  } catch {
    return new Set();
  }
}

/** Persist the opted-in skill ids (sorted, deduped) for a repo. */
function writeOptInSkills(cwd: string, ids: Set<string>): void {
  const path = optInStorePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const skills = Array.from(ids).sort();
  writeFileSync(path, `${JSON.stringify({ skills }, null, 2)}\n`);
}

/**
 * Resolve a `skill install/remove` argument to a list of valid bare ids. `all`
 * expands to every opt-in skill; any other value is validated against the known
 * opt-in set. Returns `{ ids, unknown }` so the command can report bad names.
 *
 * @sem domain=skills role=validator
 */
export function resolveOptInTargets(arg: string): {
  ids: string[];
  unknown: string[];
} {
  const known = new Set(OPT_IN_SKILL_IDS);
  if (bareId(arg) === "all") return { ids: [...OPT_IN_SKILL_IDS], unknown: [] };
  const requested = arg
    .split(/[\s,]+/)
    .map(bareId)
    .filter((s) => s.length > 0);
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const id of requested) {
    if (known.has(id)) ids.push(id);
    else unknown.push(id);
  }
  return { ids, unknown };
}

/**
 * Add skills to the opt-in record. Returns the ids newly added and the full set
 * after the change.
 *
 * @sem domain=skills role=mutator
 */
export function addOptInSkills(
  cwd: string,
  ids: string[]
): { added: string[]; all: string[] } {
  const current = readOptInSkills(cwd);
  const added: string[] = [];
  for (const id of ids.map(bareId)) {
    if (!current.has(id)) {
      current.add(id);
      added.push(id);
    }
  }
  if (added.length > 0) writeOptInSkills(cwd, current);
  return { added, all: Array.from(current).sort() };
}

/**
 * Remove skills from the opt-in record. Returns the ids removed and the full set
 * after the change.
 *
 * @sem domain=skills role=mutator
 */
export function removeOptInSkills(
  cwd: string,
  ids: string[]
): { removed: string[]; all: string[] } {
  const current = readOptInSkills(cwd);
  const removed: string[] = [];
  for (const id of ids.map(bareId)) {
    if (current.has(id)) {
      current.delete(id);
      removed.push(id);
    }
  }
  if (removed.length > 0) writeOptInSkills(cwd, current);
  return { removed, all: Array.from(current).sort() };
}
