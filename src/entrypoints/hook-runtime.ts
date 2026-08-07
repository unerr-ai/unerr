/**
 * Shared runtime for `unerr hook <event>` handlers — the light wrappers every
 * hook subprocess needs, split out so BOTH the fast-path dispatcher
 * (`cli-hook.ts`) and the Commander command (`commands/hook.ts`) import them
 * without pulling in each other or the command surface.
 *
 * This module imports ONLY node builtins plus genuinely light deps
 * (login-gate, login-nudge, nudge-state, repo-root) — nothing that transitively
 * reaches the command modules, the token/tool-budget code, or the graph. That
 * is load-bearing: it is what keeps a fired hook off the full CLI boot path.
 */

import { readFileSync } from "node:fs";
import { loginBlocked } from "../cloud/auth/index.js";
import {
  LOGIN_NUDGE_LINE,
  shouldEmitLoginNudge,
} from "../hooks/login-nudge.js";
import { pinSessionIdEnv } from "../proxy/nudge-state.js";
import { resolveRepoRoot } from "../utils/repo-root.js";

/**
 * Login-blocked passthrough for any hook event. When the machine is signed out
 * (`loginBlocked()`), no hook does graph-aware work: it writes the universal
 * passthrough JSON ("{}", which every adapter formatter falls back to — never a
 * deny, never a rewrite) and emits at most one throttled `ur|act` login nudge to
 * stderr. Returns true when it handled the call so the wrapper skips the handler.
 */
function handledByLoginGate(): boolean {
  if (!loginBlocked()) return false;
  process.stdout.write("{}");
  try {
    if (shouldEmitLoginNudge(process.cwd())) {
      process.stderr.write(`${LOGIN_NUDGE_LINE}\n`);
    }
  } catch {
    // Nudge is best-effort — never let it break the hook passthrough.
  }
  return true;
}

/**
 * Pin the nudge-state session key BEFORE any handler runs. Each Claude Code hook
 * is a fresh short-lived process that does NOT inherit `UNERR_SESSION_ID`, so
 * `statePath` (nudge-state.ts) was falling back to `pid-<process.pid>` — a new
 * flags file every turn, which silently re-fires every one-shot nudge (tool
 * roster, skill catalog, mark_intent, …) on every prompt. Resolve the stable
 * per-repo proxy session id (`.unerr/state/session.id`) — the same id the
 * long-lived proxy keys on — so all hook processes for one repo session share
 * one flags file and one-shot gating actually holds. Fall back to the agent's
 * own `session_id` from stdin when no proxy is up (still stable across a
 * conversation's turns, unlike the PID). Never overrides an inherited value.
 */
function ensureSessionIdEnv(stdin: string): void {
  // First try the stable proxy session id (`.unerr/state/session.id`) — the
  // shared resolver the `unerr exec` path uses too, so all short-lived child
  // processes for one repo session share one nudge flags file.
  pinSessionIdEnv(process.cwd());
  if (process.env.UNERR_SESSION_ID) return;
  // No live proxy — fall back to the agent's own session_id from stdin (still
  // stable across a conversation's turns, unlike pid-<pid>).
  try {
    const raw = JSON.parse(stdin) as { session_id?: unknown };
    if (typeof raw.session_id === "string" && raw.session_id.length > 0) {
      process.env.UNERR_SESSION_ID = raw.session_id;
    }
  } catch {
    // Best-effort — a missed resolution just degrades to per-PID keying (the
    // prior behaviour), never breaks the hook.
  }
}

/**
 * Pin the process working directory to the repo root before any handler runs.
 * Claude Code spawns each hook at the agent's cwd, which may be a subfolder
 * (the agent `cd`'d into it). Every handler resolves its `.unerr` state from
 * process.cwd(), so without this a fresh `.unerr` scratch tree gets scattered
 * into that subfolder every turn. Hooks never execute the user's command
 * (pre-bash only rewrites it) and tool `file_path` values are absolute, so a
 * chdir here is safe and also repairs post-edit review / blast-radius /
 * co-change, which all read `.unerr` from process.cwd(). Best-effort.
 */
export function pinCwdToRepoRoot(): void {
  try {
    const root = resolveRepoRoot(process.cwd());
    if (root !== process.cwd()) process.chdir(root);
  } catch {
    /* best-effort — never break the hook on a chdir failure */
  }
}

/**
 * Safe hook action wrapper. Reads stdin, runs the handler, writes stdout.
 * On ANY failure (EAGAIN on stdin, handler throw, etc.) outputs valid JSON "{}"
 * so Claude Code never sees a crash/invalid output and reports "hook error".
 * When login is blocked, passes through unchanged (no graph work, no deny).
 */
export function safeHookAction(handler: (stdin: string) => string): () => void {
  return () => {
    pinCwdToRepoRoot();
    if (handledByLoginGate()) return;
    try {
      const stdin = readFileSync(0, "utf-8");
      ensureSessionIdEnv(stdin);
      process.stdout.write(handler(stdin));
    } catch (e) {
      process.stderr.write(`[unerr] hook error: ${e}\n`);
      process.stdout.write("{}");
    }
  };
}

/** Async variant of safeHookAction for handlers that touch facts.db. */
export function safeAsyncHookAction(
  handler: (stdin: string) => Promise<string>
): () => Promise<void> {
  return async () => {
    pinCwdToRepoRoot();
    if (handledByLoginGate()) return;
    try {
      const stdin = readFileSync(0, "utf-8");
      ensureSessionIdEnv(stdin);
      process.stdout.write(await handler(stdin));
    } catch (e) {
      process.stderr.write(`[unerr] hook error: ${e}\n`);
      process.stdout.write("{}");
    }
  };
}
