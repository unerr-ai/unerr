/**
 * Repo working-directory guard.
 *
 * A per-repo `unerr` proxy/bridge must never adopt $HOME or the filesystem
 * root as its project root: the `.unerr/` it would create there collides with
 * the process-manager's global `~/.unerr/` state. That collision is what
 * produced a stray global `graph.db`, empty `snapshots/`+`ledger/`, and a
 * clobbered `config.json`. This module is the single source of truth for that
 * classification — kept separate from `cli.ts` (which runs `program.parse()`
 * at import) so it stays unit-testable.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { parse, resolve } from "node:path";

/** Resolve real path; fall back to a normalized absolute path if it can't. */
export function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Classify a candidate repo working directory. Returns the reason a directory
 * is unsafe to host a `.unerr/` (`"home"` or `"root"`), or `"ok"`. `home` is
 * injectable for tests; it defaults to the real home directory.
 */
export function classifyRepoCwd(
  cwd: string,
  home: string = homedir()
): "home" | "root" | "ok" {
  const realCwd = safeRealpath(cwd);
  if (realCwd === safeRealpath(home)) return "home";
  if (realCwd === parse(realCwd).root) return "root";
  return "ok";
}
