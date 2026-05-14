/**
 * UserPromptSubmit hook — appends a concise unerr tool reminder to user prompt context.
 *
 * Uses the universal hook runner for multi-agent protocol support.
 * Fires on every user message. Appends ~50 tokens of context reminding the agent
 * that unerr graph tools are available.
 */

import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";
import {
  type HookHandler,
  enrich,
  passthrough,
  runPromptSubmitHook,
} from "./hook-runner.js";

/**
 * Agent-agnostic prompt submit handler.
 * Injects a brief tool-preference reminder into user prompt context.
 *
 * Nudge v2 (N1): when UNERR_NUDGE_V2=1, only fire on the first non-trivial
 * prompt of a session, then go silent until the next session. v1 default
 * behavior (fire on every prompt ≥10 chars) is preserved.
 */
const promptSubmitHandler: HookHandler = (normalized) => {
  // Extract the user's message to detect if it's code-related
  const raw = normalized.raw;
  const message = (raw.user_message ?? raw.prompt ?? "") as string;

  // Skip for very short messages (likely confirmations like "yes", "ok", "continue")
  if (message.length < 10) return passthrough();

  // N1 — Tier 0 one-shot session onboarding (opt-in)
  if (process.env.UNERR_NUDGE_V2 === "1") {
    try {
      const cwd = process.cwd();
      const state = readNudgeState(cwd);
      if (state.tier0_emitted) return passthrough();
      updateNudgeState(cwd, (s) => {
        s.tier0_emitted = true;
      });
    } catch {
      // State unavailable — fall through to v1 behaviour
    }
  }

  // Detect code-related intent for stronger nudge
  const isCodeTask =
    /\b(fix|bug|add|implement|refactor|debug|update|change|modify|create|delete|remove|test|find|search|where|who calls|callers|dependencies|import)\b/i.test(
      message,
    );

  // Table rows #24/#25 TRIM — why (faster/graph-backed/project-aware) leads,
  // then what (tool roster + when-tags for markers). Half the bytes, same signal.
  if (isCodeTask) {
    return enrich(
      "[unerr] Prefer unerr MCP tools for code work (faster, graph-backed, project-aware): " +
        "`search_code` (NOT grep/glob) · `get_references` (NOT grep for fn names) · " +
        "`file_read` (NOT built-in Read for understanding; built-in Read is only for pre-Edit) · " +
        "`file_outline` · `get_entity`. " +
        "Mark progress: `mark_intent` (task start) · `mark_decision` · `mark_blocker` · " +
        "`mark_resolution` — these power the cross-session timeline.",
    );
  }

  return enrich(
    "[unerr] Prefer unerr MCP tools (graph-backed, <5ms): " +
      "`search_code` · `get_references` · `file_read` · `file_outline` · `get_entity`. " +
      "Drop `mark_intent` / `mark_decision` / `mark_blocker` / `mark_resolution` as you work — " +
      "they keep the timeline coherent across sessions.",
  );
};

/**
 * UserPromptSubmit hook handler.
 * Returns JSON string for stdout.
 */
export function runUserPromptSubmitHook(stdinJson: string): string {
  return runPromptSubmitHook(stdinJson, promptSubmitHandler);
}
