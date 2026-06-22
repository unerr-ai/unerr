/**
 * `unerr hook <pre-*|post-*|prompt-submit>` — Hook handlers for all event types.
 *
 * Each subcommand reads stdin JSON and writes stdout JSON.
 * - pre-bash: rewrites Bash commands to route through `unerr exec` (transparent)
 * - pre-read/pre-grep/pre-glob: inject systemMessage nudges suggesting unerr tools
 * - pre-write/pre-edit: blast radius + convention validation before code modifications
 * - post-read/post-grep/post-glob: enrich tool output with graph navigation suggestions
 * - post-write/post-edit: convention check + caller verification after modifications
 * - prompt-submit: inject unerr tool reminder on each user prompt (UserPromptSubmit)
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { loginBlocked } from "../cloud/login-gate.js";
import {
  LOGIN_NUDGE_LINE,
  shouldEmitLoginNudge,
} from "../hooks/login-nudge.js";
import {
  runPostEditHookAsync,
  runPostGlobHook,
  runPostGrepHook,
  runPostReadHookAsync,
  runPostWriteHook,
  runPreEditHookAsync,
  runPreGlobHook,
  runPreGrepHook,
  runPreReadHook,
  runPreWriteHook,
} from "../hooks/navigation-hooks.js";
import { runUserPromptSubmitHookAsync } from "../hooks/prompt-hooks.js";
import { runSessionStartHookAsync } from "../hooks/session-hooks.js";
import { runPreBashHook, runPreShellHook } from "../hooks/shell-hooks.js";
import {
  runStopHookHandlerAsync,
  runStopPersistWorkerAsync,
} from "../hooks/stop-hooks.js";
import {
  runPostWebSearchHook,
  runPreWebFetchHook,
} from "../hooks/web-hooks.js";
import { pinSessionIdEnv } from "../proxy/nudge-state.js";

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
 * Safe hook action wrapper. Reads stdin, runs the handler, writes stdout.
 * On ANY failure (EAGAIN on stdin, handler throw, etc.) outputs valid JSON "{}"
 * so Claude Code never sees a crash/invalid output and reports "hook error".
 * When login is blocked, passes through unchanged (no graph work, no deny).
 */
function safeHookAction(handler: (stdin: string) => string): () => void {
  return () => {
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
function safeAsyncHookAction(
  handler: (stdin: string) => Promise<string>
): () => Promise<void> {
  return async () => {
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

export function registerHookCommand(program: Command): void {
  const hook = program
    .command("hook")
    .description("IDE hook handlers (stdin/stdout JSON)");

  // ── PreToolUse hooks ──────────────────────────────────────────

  hook
    .command("pre-bash")
    .description("Rewrite Bash tool input to pipe through unerr exec")
    .action(safeHookAction(runPreBashHook));

  hook
    .command("pre-shell")
    .description(
      "Drift nudge for shell hooks that can't rewrite to unerr exec (Cursor beforeShellExecution)"
    )
    .action(safeHookAction(runPreShellHook));

  hook
    .command("pre-read")
    .description("Nudge agent to use file_outline/file_read instead of Read")
    .action(safeHookAction(runPreReadHook));

  hook
    .command("pre-grep")
    .description("Nudge agent to use search_code/get_callers instead of Grep")
    .action(safeHookAction(runPreGrepHook));

  hook
    .command("pre-glob")
    .description("Nudge agent to use search_code instead of Glob")
    .action(safeHookAction(runPreGlobHook));

  hook
    .command("pre-write")
    .description("Blast radius + convention check before Write")
    .action(safeHookAction(runPreWriteHook));

  hook
    .command("pre-edit")
    .description("Blast radius + convention check before Edit")
    .action(safeAsyncHookAction(runPreEditHookAsync));

  hook
    .command("pre-webfetch")
    .description(
      "Redirect WebFetch to fetch_url (DOM-extracted, BM25, fewer tokens)"
    )
    .action(safeHookAction(runPreWebFetchHook));

  // ── PostToolUse hooks ─────────────────────────────────────────

  hook
    .command("post-read")
    .description(
      "Enrich Read output with graph navigation + once-per-session conventions"
    )
    .action(safeAsyncHookAction(runPostReadHookAsync));

  hook
    .command("post-grep")
    .description("Enrich Grep output with graph navigation suggestions")
    .action(safeHookAction(runPostGrepHook));

  hook
    .command("post-glob")
    .description("Enrich Glob output with graph navigation suggestions")
    .action(safeHookAction(runPostGlobHook));

  hook
    .command("post-websearch")
    .description(
      "Nudge bulk fetch_url({urls:[...]}) to read all search results in one roundtrip"
    )
    .action(safeHookAction(runPostWebSearchHook));

  hook
    .command("post-write")
    .description("Post-write convention check + caller verification reminder")
    .action(safeHookAction(runPostWriteHook));

  hook
    .command("post-edit")
    .description("Post-edit graph-backed review + caller verification reminder")
    .action(safeAsyncHookAction(runPostEditHookAsync));

  // ── UserPromptSubmit hook ───────────────────────────────────────

  hook
    .command("prompt-submit")
    .description(
      "Inject warm recall (notes) + unerr tool reminder on each user prompt"
    )
    .action(safeAsyncHookAction(runUserPromptSubmitHookAsync));

  // ── SessionStart hook (Claude Code only — Cursor/Cline fall back to Surface 1) ──

  hook
    .command("session-start")
    .description("Inject resume strip into agent context at session boot")
    .action(safeAsyncHookAction(runSessionStartHookAsync));

  // ── Stop hook (turn end) ────────────────────────────────────────
  // Surfaces the close-out economy line server-side (replaces the agent
  // having to call unerr_turn_summary and paste it).

  hook
    .command("stop")
    .description(
      "Surface the close-out economy line at turn end (no round-trip)"
    )
    .action(safeAsyncHookAction(runStopHookHandlerAsync));

  // ── Stop-persist worker (spawned detached by the Stop hook) ─────
  // Hidden: not a user-facing command. Detached children get no stdin, so the
  // transcript path rides argv; the worker re-reads + re-scrapes it itself.

  hook
    .command("stop-persist", { hidden: true })
    .description(
      "Background worker: persist unerr-save sentinels from a transcript"
    )
    .requiredOption("--transcript <path>", "Claude Code transcript JSONL path")
    .action(async (opts: { transcript: string }) => {
      try {
        await runStopPersistWorkerAsync(opts.transcript);
      } catch (e) {
        process.stderr.write(`[unerr] stop-persist worker error: ${e}\n`);
      }
    });
}
