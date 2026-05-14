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
  runPostEditHook,
  runPostGlobHook,
  runPostGrepHook,
  runPostReadHook,
  runPostWriteHook,
  runPreEditHook,
  runPreGlobHook,
  runPreGrepHook,
  runPreReadHook,
  runPreWriteHook,
} from "../hooks/navigation-hooks.js";
import { runUserPromptSubmitHook } from "../hooks/prompt-hooks.js";
import { runPreBashHook } from "../hooks/shell-hooks.js";

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
    .action(safeHookAction(runPreEditHook));

  // ── PostToolUse hooks ─────────────────────────────────────────

  hook
    .command("post-read")
    .description("Enrich Read output with graph navigation suggestions")
    .action(safeHookAction(runPostReadHook));

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
    .description("Post-edit convention check + caller verification reminder")
    .action(safeHookAction(runPostEditHook));

  // ── UserPromptSubmit hook ───────────────────────────────────────

  hook
    .command("prompt-submit")
    .description("Inject unerr tool reminder on each user prompt")
    .action(safeHookAction(runUserPromptSubmitHook));
}
