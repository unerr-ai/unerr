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
import { runStopHookHandlerAsync } from "../hooks/stop-hooks.js";
import { runPreBashHook } from "../hooks/shell-hooks.js";
import { runPreWebFetchHook } from "../hooks/web-hooks.js";

/**
 * Safe hook action wrapper. Reads stdin, runs the handler, writes stdout.
 * On ANY failure (EAGAIN on stdin, handler throw, etc.) outputs valid JSON "{}"
 * so Claude Code never sees a crash/invalid output and reports "hook error".
 */
function safeHookAction(handler: (stdin: string) => string): () => void {
  return () => {
    try {
      const stdin = readFileSync(0, "utf-8");
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
    try {
      const stdin = readFileSync(0, "utf-8");
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
    .description("Surface the close-out economy line at turn end (no round-trip)")
    .action(safeAsyncHookAction(runStopHookHandlerAsync));
}
