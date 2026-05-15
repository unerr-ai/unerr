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

import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { clineAdapter } from "./adapters/cline.js";
import { cursorAdapter } from "./adapters/cursor.js";

// ── Types ────────────────────────────────────────────────────────────

/** Hook event categories. */
export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit";

/**
 * Agent-agnostic hook result returned by handler functions.
 * Adapters convert this to their agent's wire format.
 */
export interface HookResult {
  /** passthrough = no-op, nudge = advisory message, rewrite = change input, enrich = add context */
  type: "passthrough" | "nudge" | "rewrite" | "enrich";
  /** Advisory or enrichment message (used by nudge + enrich). */
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
  return adapter.formatPreToolUse(result);
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

// ── Convenience Constructors ─────────────────────────────────────────

/** Create a passthrough result. */
export function passthrough(): HookResult {
  return { type: "passthrough" };
}

/** Create a nudge (advisory systemMessage) result. */
export function nudge(message: string): HookResult {
  return { type: "nudge", message };
}

/** Create a rewrite (updatedInput) result. */
export function rewrite(updatedInput: Record<string, unknown>): HookResult {
  return { type: "rewrite", updatedInput };
}

/** Create an enrich (additionalContext) result. */
export function enrich(message: string): HookResult {
  return { type: "enrich", message };
}
