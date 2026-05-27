/**
 * Review-gate git hooks (docs/reviewer-architecture.md §5.2 Surface B).
 *
 * Installs two shell hooks, IDE-independent so they fire for any agent or human:
 *   - `pre-commit`  → `unerr check-commit` — runs the engine on the staged diff
 *     and propagates its exit code, so blocking mode (exit 1) stops the commit.
 *   - `post-commit` → `unerr check-commit --record-verdict` — attaches the
 *     verdict the gate computed to the new commit as a git note (the SHA only
 *     exists post-commit).
 *
 * Opt-in (§10): `unerr install` writes these only when asked, never by default.
 * Idempotent + marker-scoped: a hook the user already owns is appended to, not
 * clobbered, and uninstall removes only unerr's section.
 *
 * Mirrors the marker discipline of `installPrepareCommitMsgHook` in
 * `git-trailers.ts`.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MARKER = "# unerr-review-gate";

const PRE_COMMIT_BODY = `${MARKER} (pre-commit)
# Review staged changes; a non-zero exit (blocking mode) stops the commit.
if command -v unerr >/dev/null 2>&1; then
  unerr check-commit || exit $?
fi`;

const POST_COMMIT_BODY = `${MARKER} (post-commit)
# Attach the gate's verdict to the new commit. Never fails the commit.
if command -v unerr >/dev/null 2>&1; then
  unerr check-commit --record-verdict >/dev/null 2>&1 || true
fi`;

/** Write one hook: create with a shebang, or append our section to an existing
 *  hook the user already owns. Returns true when (now) installed. */
function installOneHook(hookPath: string, body: string): boolean {
  try {
    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, "utf-8");
      if (existing.includes(MARKER)) return true; // already installed
      writeFileSync(hookPath, `${existing.trimEnd()}\n\n${body}\n`, {
        mode: 0o755,
      });
      chmodSync(hookPath, 0o755);
      return true;
    }
    writeFileSync(hookPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    chmodSync(hookPath, 0o755);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the pre-commit + post-commit review-gate hooks. No-op (returns false)
 * when `.git/hooks` is absent (not a git repo). Idempotent.
 */
export function installReviewGateHooks(projectRoot: string): boolean {
  const hooksDir = join(projectRoot, ".git", "hooks");
  if (!existsSync(hooksDir)) return false;
  const pre = installOneHook(join(hooksDir, "pre-commit"), PRE_COMMIT_BODY);
  const post = installOneHook(join(hooksDir, "post-commit"), POST_COMMIT_BODY);
  return pre && post;
}

/** Remove our section from one hook (or delete the file when it's entirely ours). */
function uninstallOneHook(hookPath: string): void {
  if (!existsSync(hookPath)) return;
  try {
    const content = readFileSync(hookPath, "utf-8");
    if (!content.includes(MARKER)) return; // not ours — leave it

    const markerIdx = content.indexOf(MARKER);
    const before = content.slice(0, markerIdx).trimEnd();
    // If only a shebang precedes our section, the hook is entirely ours.
    const beforeLines = before.split("\n").filter((l) => l.trim().length > 0);
    if (beforeLines.length <= 1 && beforeLines[0]?.startsWith("#!")) {
      unlinkSync(hookPath);
      return;
    }
    writeFileSync(hookPath, `${before}\n`, { mode: 0o755 });
  } catch {
    /* best effort */
  }
}

/** Remove the review-gate hooks (or just our section from shared hooks). */
export function uninstallReviewGateHooks(projectRoot: string): void {
  const hooksDir = join(projectRoot, ".git", "hooks");
  if (!existsSync(hooksDir)) return;
  uninstallOneHook(join(hooksDir, "pre-commit"));
  uninstallOneHook(join(hooksDir, "post-commit"));
}
