/**
 * Universal Hook Runner — agent-agnostic hook orchestrator.
 *
 * Detects the calling agent from stdin JSON shape, routes through the
 * appropriate adapter, and returns the response in the agent's expected format.
 *
 * Adapter protocol:
 *   1. Parse stdin JSON
 *   2. Try each adapter's `detect()` until one matches
 *   3. Extract normalized tool input via adapter
 *   4. Run the hook handler (returns agent-agnostic HookResult)
 *   5. Format the response via adapter
 *
 * Supported agents: Claude Code, Cursor, Cline.
 * Fallback: Claude Code (most common MCP hook consumer).
 */

import {
  consumeAnyPendingTopicShift,
  setPendingTopicShift,
} from "../intelligence/topic-shift.js";
import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { clineAdapter } from "./adapters/cline.js";
import { cursorAdapter } from "./adapters/cursor.js";

// ── Types ────────────────────────────────────────────────────────────

/** Hook event categories. */
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "SessionStart";

/** SessionStart matcher — Claude Code emits one of these per session boot. */
export type SessionStartMatcher = "startup" | "resume" | "clear" | "compact";

/**
 * Agent-agnostic hook result returned by handler functions.
 * Adapters convert this to their agent's wire format.
 */
export interface HookResult {
  /** passthrough = no-op, nudge = advisory message, rewrite = change
   *  input, enrich = add context, deny = block the tool call outright. */
  action: "passthrough" | "nudge" | "rewrite" | "enrich" | "deny";
  /** Advisory, enrichment, or deny reason (used by nudge + enrich + deny). */
  message?: string;
  /** Rewritten tool input (used by rewrite). */
  updatedInput?: Record<string, unknown>;
}

/**
 * Normalized hook payload — agent-agnostic representation of the incoming hook event.
 */
export interface NormalizedPayload {
  /** The original parsed JSON from stdin. */
  raw: Record<string, unknown>;
  /** Extracted tool input (command, file_path, pattern, etc.). */
  toolInput: Record<string, unknown>;
  /** Tool name if available (e.g., "Read", "Bash"). */
  toolName?: string;
  /** The hook event type if detectable. */
  event?: HookEvent;
  /** Detected agent name (e.g., "claude-code", "cursor", "cline"). */
  agentName?: string;
}

/**
 * Hook adapter interface — each agent implements this.
 */
export interface HookAdapter {
  /** Adapter identifier (e.g., "claude-code", "cursor", "cline"). */
  readonly name: string;

  /**
   * Returns true if the stdin payload matches this agent's hook protocol.
   * Adapters are tried in order; first match wins.
   */
  detect(payload: Record<string, unknown>): boolean;

  /** Extract normalized payload from agent-specific stdin JSON. */
  normalize(payload: Record<string, unknown>): NormalizedPayload;

  /** Format a PreToolUse hook result into agent-specific stdout JSON. */
  formatPreToolUse(result: HookResult): string;

  /** Format a PostToolUse hook result into agent-specific stdout JSON. */
  formatPostToolUse(result: HookResult): string;

  /** Format a UserPromptSubmit hook result into agent-specific stdout JSON. */
  formatPromptSubmit(result: HookResult): string;

  /** Format a SessionStart hook result into agent-specific stdout JSON.
   *  Adapters without a session-start equivalent should return "{}" — the
   *  resume strip falls back to first-tool-call injection in that case. */
  formatSessionStart(result: HookResult): string;
}

// ── Adapter Registry ─────────────────────────────────────────────────

/**
 * Ordered list of adapters. More specific detectors first.
 * Claude Code is last (default fallback).
 */
const ADAPTERS: HookAdapter[] = [
  cursorAdapter,
  clineAdapter,
  claudeCodeAdapter, // default fallback
];

// ── Runner ───────────────────────────────────────────────────────────

/**
 * Detect the appropriate adapter for a parsed stdin payload.
 * Returns Claude Code adapter as fallback (most common).
 */
export function detectAdapter(payload: Record<string, unknown>): HookAdapter {
  for (const adapter of ADAPTERS) {
    if (adapter.detect(payload)) return adapter;
  }
  return claudeCodeAdapter;
}

/** Parse stdin JSON, returning null on failure. */
function parseStdin(stdinJson: string): Record<string, unknown> | null {
  const trimmed = stdinJson.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Handler function type — receives normalized payload, returns agent-agnostic result.
 */
export type HookHandler = (normalized: NormalizedPayload) => HookResult;

/**
 * Run a PreToolUse hook through the universal runner.
 *
 * @param stdinJson — raw stdin from the hook process
 * @param handler — agent-agnostic handler that produces a HookResult
 * @returns JSON string for stdout
 */
export function runPreToolUseHook(
  stdinJson: string,
  handler: HookHandler
): string {
  const payload = parseStdin(stdinJson);
  if (!payload) return "{}";

  const adapter = detectAdapter(payload);
  const normalized = adapter.normalize(payload);
  normalized.agentName = adapter.name;
  const result = handler(normalized);
  const augmented = augmentForAmbientPreInjection(normalized, result);
  return adapter.formatPreToolUse(augmented);
}

/**
 * Async handler type — for handlers that must await IO (e.g. a UDS query to
 * the proxy's warm graph). Mirrors {@link HookHandler} but returns a Promise.
 */
export type AsyncHookHandler = (
  normalized: NormalizedPayload
) => Promise<HookResult>;

/**
 * Async variant of {@link runPreToolUseHook}. Identical pipeline (parse →
 * detect → normalize → handle → ambient augment → format) but awaits an
 * async handler. Used by the pre-edit hook, which queries the proxy over UDS.
 */
export async function runPreToolUseHookAsync(
  stdinJson: string,
  handler: AsyncHookHandler
): Promise<string> {
  const payload = parseStdin(stdinJson);
  if (!payload) return "{}";

  const adapter = detectAdapter(payload);
  const normalized = adapter.normalize(payload);
  normalized.agentName = adapter.name;
  const result = await handler(normalized);
  const augmented = augmentForAmbientPreInjection(normalized, result);
  return adapter.formatPreToolUse(augmented);
}

/**
 * Run a PostToolUse hook through the universal runner.
 */
export function runPostToolUseHook(
  stdinJson: string,
  handler: HookHandler
): string {
  const payload = parseStdin(stdinJson);
  if (!payload) return "{}";

  const adapter = detectAdapter(payload);
  const normalized = adapter.normalize(payload);
  normalized.agentName = adapter.name;
  const result = handler(normalized);
  return adapter.formatPostToolUse(result);
}

/**
 * Async variant of {@link runPostToolUseHook}. Identical pipeline but awaits an
 * async handler. Used by the post-edit review hook, which queries the proxy's
 * warm graph over UDS to run the review engine after an edit.
 */
export async function runPostToolUseHookAsync(
  stdinJson: string,
  handler: AsyncHookHandler
): Promise<string> {
  const payload = parseStdin(stdinJson);
  if (!payload) return "{}";

  const adapter = detectAdapter(payload);
  const normalized = adapter.normalize(payload);
  normalized.agentName = adapter.name;
  const result = await handler(normalized);
  return adapter.formatPostToolUse(result);
}

/**
 * Run a UserPromptSubmit hook through the universal runner.
 */
export function runPromptSubmitHook(
  stdinJson: string,
  handler: HookHandler
): string {
  const payload = parseStdin(stdinJson);
  if (!payload) return "{}";

  const adapter = detectAdapter(payload);
  const normalized = adapter.normalize(payload);
  normalized.agentName = adapter.name;
  const result = handler(normalized);
  return adapter.formatPromptSubmit(result);
}

/**
 * Run a SessionStart hook through the universal runner. Currently only
 * Claude Code implements a meaningful SessionStart format; Cursor/Cline
 * adapters return "{}" and the resume strip falls back to first-tool-call
 * injection (Surface 1) for those clients.
 */
export function runSessionStartHook(
  stdinJson: string,
  handler: HookHandler
): string {
  const payload = parseStdin(stdinJson);
  if (!payload) return "{}";

  const adapter = detectAdapter(payload);
  const normalized = adapter.normalize(payload);
  normalized.agentName = adapter.name;
  normalized.event = "SessionStart";
  const result = handler(normalized);
  return adapter.formatSessionStart(result);
}

// ── Convenience Constructors ─────────────────────────────────────────

/** Create a passthrough result. */
export function passthrough(): HookResult {
  return { action: "passthrough" };
}

/** Create a nudge (advisory systemMessage) result. */
export function nudge(message: string): HookResult {
  return { action: "nudge", message };
}

/** Create a rewrite (updatedInput) result. */
export function rewrite(updatedInput: Record<string, unknown>): HookResult {
  return { action: "rewrite", updatedInput };
}

/** Create an enrich (additionalContext) result. */
export function enrich(message: string): HookResult {
  return { action: "enrich", message };
}

/** Create a deny result — blocks the tool call. The `reason` is shown
 *  to the agent so it knows why the call was rejected and what to do
 *  instead. Adapters that lack a true deny channel fall back to a
 *  strongly-worded nudge. */
export function deny(reason: string): HookResult {
  return { action: "deny", message: reason };
}

// ── Ambient PreToolUse injection (non-Claude-Code agents) ─────────────
//
// Claude Code receives the topic-shift signal + mark_intent reminder
// via UserPromptSubmit `additionalContext` (see prompt-hooks.ts). Cursor
// and Cline have no UserPromptSubmit injection channel — their only
// ambient surface is `agent_message` / `context` on PreToolUse. To keep
// the topic-shift + mark_intent contract working across all clients, we
// drain those signals into the FIRST PreToolUse result of the session
// for non-Claude-Code agents.

/** Build the ambient prefix for non-Claude-Code agents. Returns an
 *  empty string when nothing is pending. */
function buildAmbientPreInjection(): string {
  const lines: string[] = [];

  // mark_intent one-shot reminder. Fires AT MOST once per session (the
  // `mark_intent_emitted` flag gates re-emission) so we don't argue
  // with the agent across every tool call.
  try {
    const cwd = process.cwd();
    const state = readNudgeState(cwd);
    if (!state.mark_intent_emitted) {
      updateNudgeState(cwd, (s) => {
        s.mark_intent_emitted = true;
      });
      lines.push(
        "ur|act before continuing, call `mark_intent({text:'<one-sentence summary>'})` if this turn is a coding task (implement/fix/refactor/build). Skip for pure read-only questions."
      );
    }
  } catch {
    /* nudge-state unavailable — skip */
  }

  // Topic-shift reminder — drains any pending signal stashed by the
  // last recall_notes call.
  try {
    const shift = consumeAnyPendingTopicShift();
    if (shift?.flag) {
      const pct = Math.round(shift.overlap * 100);
      lines.push(
        `ur|fct topic-shift detected (overlap ${pct}%) — call unerr_recall_notes({prompt:"<recent user prompt>"}) before continuing to load fresh anchors`
      );
    }
  } catch {
    /* topic-shift module unavailable — skip */
  }
  return lines.join("\n");
}

/** Splice the ambient prefix into a PreToolUse HookResult. Used only
 *  for non-Claude-Code agents (Cursor, Cline). Promotes passthrough →
 *  nudge when there's content to deliver. */
function augmentForAmbientPreInjection(
  normalized: NormalizedPayload,
  result: HookResult
): HookResult {
  if (normalized.agentName === "claude-code") return result;
  const prefix = buildAmbientPreInjection();
  if (prefix.length === 0) return result;

  // Don't override a deny — that decision is load-bearing. Topic-shift
  // can ride on the next PreToolUse after the deny is acknowledged.
  if (result.action === "deny") return result;

  if (result.action === "passthrough") {
    return { action: "nudge", message: prefix };
  }
  if (result.action === "rewrite") {
    // Rewrites don't carry a message — a separate nudge frame is not
    // possible. Re-queue the prefix by re-stashing the topic-shift so
    // the next PreToolUse gets it. Best-effort with a sentinel session
    // id; precision lost is acceptable — the signal still surfaces on
    // the next call.
    try {
      setPendingTopicShift("__ambient_requeue__", {
        flag: true,
        overlap: 0,
      });
    } catch {
      /* ignore */
    }
    return result;
  }
  const existing = result.message ?? "";
  return {
    ...result,
    message: existing.length > 0 ? `${prefix}\n${existing}` : prefix,
  };
}
