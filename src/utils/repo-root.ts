/**
 * Resolve the project root a `.unerr` scratch dir must live under.
 *
 * Short-lived unerr processes (`unerr hook <event>`, `unerr exec`) are spawned
 * by the agent at its current working directory. When the agent `cd`s into a
 * subfolder (or the session itself is rooted in one, e.g. `docs/`), every
 * `join(process.cwd(), ".unerr", …)` write would drop a fresh `.unerr` scratch
 * tree into that subfolder — scattering `sessions.json`, nudge flags, receipts,
 * and tee logs across the repo. This resolver pins those writes to the one
 * project root instead, so state stays in `<repo-root>/.unerr` regardless of
 * where inside the repo a command runs.
 *
 * Resolution walks up from `startDir` and returns the FIRST of:
 *   1. the nearest ancestor (including start) that contains a `.git` entry —
 *      a directory OR a file (git worktrees and submodules use a `.git` file);
 *   2. else the nearest ancestor that contains an existing `.unerr` directory
 *      (covers non-git projects that were still `unerr install`-ed);
 *   3. else `startDir` unchanged (never throws, never invents a root).
 *
 * `.git` takes precedence over `.unerr` so a stray `docs/.unerr` left by the
 * old behaviour can never shortcut resolution to the subfolder. The `.unerr`
 * fallback also skips `$HOME` and the system temp root — their `.unerr` is
 * global/spurious state, never a project root, so a marker-less directory never
 * escapes upward into `~/.unerr`.
 *
 * Pure and synchronous (no simple-git, no async) — safe on the hook hot path.
 *
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Cache by startDir — a short-lived process resolves the same root repeatedly. */
const cache = new Map<string, string>();

/** True when `dir` contains a `.git` entry (a directory for a normal clone, a
 *  file for a worktree/submodule). Any stat error reads as "not present". */
function hasGit(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** True when `dir` contains an existing `.unerr` DIRECTORY (not a stray file). */
function hasUnerrDir(dir: string): boolean {
  try {
    return statSync(join(dir, ".unerr")).isDirectory();
  } catch {
    return false;
  }
}

/** realpath, falling back to the input when the path can't be resolved. Used so
 *  the spurious-root check survives symlinked roots (macOS `/var`→`/private/var`
 *  means `process.cwd()` is realpath'd while `os.tmpdir()` is not). */
function realOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

const HOME_REAL = realOrSelf(homedir());
const TMP_REAL = realOrSelf(tmpdir());

/**
 * `$HOME` and the system temp root are NEVER project roots, yet both routinely
 * contain a `.unerr` directory: `~/.unerr` is the global process-manager state
 * (always present), and `<tmp>/.unerr` is left by tests / stray runs. The weak
 * `.unerr` fallback must skip them, or a marker-less directory anywhere under
 * `$HOME` (or a temp dir) would resolve its "repo root" up to `$HOME` / the temp
 * root and scatter scratch into the global state dir. `.git` is exempt — a real
 * `.git` at either location would legitimately be a repo. Compared by realpath so
 * a symlinked temp/home root (e.g. `/var` vs `/private/var`) still matches. */
function isSpuriousUnerrRoot(dir: string): boolean {
  const real = realOrSelf(dir);
  return real === HOME_REAL || real === TMP_REAL;
}

/**
 * The project root under which unerr should keep its per-session scratch. See
 * the module doc for the precedence. Returns an absolute-or-original path; the
 * result is cached per `startDir`.
 */
export function resolveRepoRoot(startDir: string = process.cwd()): string {
  const cached = cache.get(startDir);
  if (cached !== undefined) return cached;

  let unerrFallback: string | null = null;
  let dir = startDir;
  // Walk up to the filesystem root. `dirname("/") === "/"`, so stop when the
  // parent stops changing.
  for (;;) {
    if (hasGit(dir)) {
      cache.set(startDir, dir);
      return dir;
    }
    // Remember the first real `.unerr` seen, but keep climbing for a `.git`
    // root. Skip `$HOME` / the temp root — their `.unerr` is global state, not a
    // project (see isSpuriousUnerrRoot).
    if (
      unerrFallback === null &&
      hasUnerrDir(dir) &&
      !isSpuriousUnerrRoot(dir)
    ) {
      unerrFallback = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const resolved = unerrFallback ?? startDir;
  cache.set(startDir, resolved);
  return resolved;
}

/** Clear the resolution cache — for tests that create/remove markers at runtime. */
export function clearRepoRootCache(): void {
  cache.clear();
}
