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
 * - post-compact: flush file-body dedup after context compaction (PostCompact)
 */

import type { Command } from "commander";
import {
  safeAsyncHookAction,
  safeHookAction,
} from "../entrypoints/hook-runtime.js";
import { runPostCompactHookAsync } from "../hooks/compaction-hooks.js";
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
import { runUserPromptSubmitHook } from "../hooks/prompt-hooks.js";
import { runSessionStartHookAsync } from "../hooks/session-hooks.js";
import {
  runPostBashHookAsync,
  runPreBashHook,
  runPreShellHook,
} from "../hooks/shell-hooks.js";
import {
  runStopHookHandlerAsync,
  runSubagentStopHookHandlerAsync,
} from "../hooks/stop-hooks.js";
import {
  runPostWebSearchHook,
  runPreWebFetchHook,
} from "../hooks/web-hooks.js";
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
    .command("post-bash")
    .description(
      "Verification awareness: record check-command runs, nudge weak verify shapes"
    )
    .action(safeAsyncHookAction(runPostBashHookAsync));

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
    .description("Inject unerr tool reminder on each user prompt")
    .action(safeHookAction(runUserPromptSubmitHook));

  // ── SessionStart hook (Claude Code only — Cursor/Cline fall back to Surface 1) ──

  hook
    .command("session-start")
    .description("Inject resume strip into agent context at session boot")
    .action(safeAsyncHookAction(runSessionStartHookAsync));

  // ── PostCompact hook (Claude Code only) ─────────────────────────
  // Tells the proxy the agent's context was compacted, so file-body dedup drops
  // what the agent no longer holds. The session-start path (source
  // compact|clear) is the fallback for builds without PostCompact.

  hook
    .command("post-compact")
    .description(
      "Flush file-body dedup after context compaction (drops evicted entries)"
    )
    .action(safeAsyncHookAction(runPostCompactHookAsync));

  // ── Stop hook (turn end) ────────────────────────────────────────
  // Surfaces the close-out economy line server-side (replaces the agent
  // having to call unerr_turn_summary and paste it).

  hook
    .command("stop")
    .description(
      "Surface the close-out economy line at turn end (no round-trip)"
    )
    .action(safeAsyncHookAction(runStopHookHandlerAsync));

  // ── SubagentStop hook (Claude Code only — sub-agent turn end) ───
  // Same receipt as the Stop hook but skips the master-only leak detector so a
  // sub-agent sharing the master's cwd cannot false-fire or wipe the flag.

  hook
    .command("subagent-stop")
    .description(
      "Surface the close-out economy line at sub-agent turn end (no leak-detector)"
    )
    .action(safeAsyncHookAction(runSubagentStopHookHandlerAsync));
}
