/**
 * Throttled "run `unerr login`" nudge for the non-interactive surfaces.
 *
 * The hook / exec / compress-output / check-commit paths are invoked by the
 * IDE's PreToolUse/PostToolUse hooks and by git pre-commit/post-commit. When
 * login is blocked (`loginBlocked()`) they pass through unchanged — they never
 * deny, throw, or open a browser. But the agent/user still needs to learn that
 * login is required, so each surface emits ONE `ur|act` line, throttled to at
 * most once per `LOGIN_NUDGE_WINDOW_MS` per repo, so a busy session of hook
 * fires doesn't spam the same line on every Bash/Edit/commit.
 *
 * The throttle is a single timestamp file under `.unerr/state/`. Reads and
 * writes are wrapped so a missing/unwritable state dir can never throw into a
 * hook — a failed write just means the next call re-checks and may re-emit,
 * which is strictly safer than a thrown error breaking the user's command.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loginBlocked } from "../cloud/auth/index.js";

/** Throttle window: emit the login nudge at most once per hour per repo. */
export const LOGIN_NUDGE_WINDOW_MS = 60 * 60 * 1000;

/** The single agent-facing action line. Imperative verb + named command. */
export const LOGIN_NUDGE_LINE =
  "ur|act run `unerr login` — unerr is signed out; hooks pass through unchanged until you do";

function nudgeMarkerPath(cwd: string): string {
  return join(cwd, ".unerr", "state", "login-nudge.stamp");
}

/**
 * Decide whether to emit the login nudge now, recording the emission timestamp
 * when it returns true. Throttled to once per {@link LOGIN_NUDGE_WINDOW_MS} per
 * repo. Never throws: any filesystem failure resolves to "emit" (fail-open on
 * the nudge, never on the command).
 */
export function shouldEmitLoginNudge(
  cwd: string,
  now: number = Date.now()
): boolean {
  const markerPath = nudgeMarkerPath(cwd);

  try {
    if (existsSync(markerPath)) {
      const last = Number.parseInt(
        readFileSync(markerPath, "utf-8").trim(),
        10
      );
      if (Number.isFinite(last) && now - last < LOGIN_NUDGE_WINDOW_MS) {
        return false;
      }
    }
  } catch {
    // Unreadable marker → treat as "no recent emission" and fall through.
  }

  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, String(now), "utf-8");
  } catch {
    // Unwritable state dir → still emit once; we just can't throttle the next.
  }

  return true;
}

/**
 * Emit the throttled `run \`unerr login\`` nudge on stderr when login is blocked,
 * for an agent / maintenance command that otherwise runs unchanged while logged
 * out (`recon`, `review`, `index`, `learn`). stderr-only so it can never corrupt
 * a stdout payload (e.g. `recon --json`, the review report). Never blocks the
 * command, never throws — a logged-in machine is a no-op.
 */
export function nudgeIfLoggedOut(cwd: string = process.cwd()): void {
  if (loginBlocked() && shouldEmitLoginNudge(cwd)) {
    process.stderr.write(`${LOGIN_NUDGE_LINE}\n`);
  }
}
