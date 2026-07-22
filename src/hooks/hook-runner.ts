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
 * Supported agents: Claude Code, Cursor, Cline, Codex, GitHub Copilot CLI,
 * Windsurf, Google Antigravity.
 * Fallback: Claude Code (most common MCP hook consumer).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSessionIdentity } from "../config/agent-registry.js";
import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";
import type { IdeType } from "../utils/detect.js";
import { antigravityAdapter } from "./adapters/antigravity.js";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { clineAdapter } from "./adapters/cline.js";
import { codexAdapter } from "./adapters/codex.js";
import { copilotCliAdapter } from "./adapters/copilot-cli.js";
import { cursorAdapter } from "./adapters/cursor.js";
import { windsurfAdapter } from "./adapters/windsurf.js";

// ── Types ────────────────────────────────────────────────────────────

/** Hook event categories. */
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "SessionStart"
  | "Stop";

/** SessionStart matcher — Claude Code emits one of these per session boot. */
export type SessionStartMatcher = "startup" | "resume" | "clear" | "compact";

/**
 * Agent-agnostic hook result returned by handler functions.
 * Adapters convert this to their agent's wire format.
 */
export interface HookResult {
  /** passthrough = no-op, nudge = advisory message, rewrite = change
   *  input, enrich = add context, deny = block the tool call outright,
   *  display = user-only systemMessage (never additionalContext), block =
   *  a blocking Stop decision (forces the agent to continue instead of
   *  ending its turn) — ONLY the capped autonomous-mode verify gate in
   *  stop-hooks.ts emits this; every other Stop path stays non-blocking. */
  action:
    | "passthrough"
    | "nudge"
    | "rewrite"
    | "enrich"
    | "deny"
    | "display"
    | "block";
  /** Advisory, enrichment, deny, or block reason (used by nudge + enrich + deny + display + block). */
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
  /**
   * The agent's OWN conversation/session id read from its hook payload
   * (Claude `session_id`, Cursor `conversation_id`), distinct from unerr's
   * per-bridge `session_id`. `null` when the payload carries none. Used to
   * group a conversation by `coalesce(native_session_id, session_id)`.
   */
  nativeSessionId?: string | null;
  /** Human-readable conversation title from the payload, if the agent sends
   *  one. `null` when absent. */
  sessionName?: string | null;
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

  /** Format a Stop (turn-end) hook result into agent-specific stdout JSON.
   *  Stop fires when the agent finishes responding. Claude Code's Stop event
   *  CANNOT inject model-readable context (no additionalContext) — it can only
   *  surface a user-facing `systemMessage` or force continuation via
   *  `decision:"block"`. So this carries the close-out economy line (the
   *  former unerr_turn_summary paste) straight to the user, zero round-trip.
   *  Adapters without a stop equivalent return "{}". */
  formatStop(result: HookResult): string;
}

// ── Adapter Registry ─────────────────────────────────────────────────

/**
 * Ordered list of adapters. More specific detectors first.
 * Claude Code is last (default fallback).
 */
const ADAPTERS: HookAdapter[] = [
  copilotCliAdapter, // hookType + hookVersion — most distinctive
  codexAdapter, // hook_event_name + Codex-specific tool names / env
  windsurfAdapter, // cascade_id / event_type prefix
  antigravityAdapter, // event (PascalCase) + tool + args
  cursorAdapter, // tool_name + cwd, no hook_event_name
  clineAdapter, // tool + params, no hook_event_name
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

/**
 * Normalize a raw payload through an adapter and stamp the agent attribution:
 * the detected `agentName`, plus the agent's native session id + conversation
 * name resolved from its `SessionIdentitySpec`. Every runner entry point goes
 * through this so the id triple is populated consistently on one path.
 */
function normalizeWithAdapter(
  adapter: HookAdapter,
  payload: Record<string, unknown>
): NormalizedPayload {
  const normalized = adapter.normalize(payload);
  normalized.agentName = adapter.name;
  const { nativeSessionId, sessionName } = resolveSessionIdentity(
    adapter.name as IdeType,
    payload
  );
  normalized.nativeSessionId = nativeSessionId;
  normalized.sessionName = sessionName;
  return normalized;
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
  handler: HookHandler,
  onResult?: (normalized: NormalizedPayload, result: HookResult) => void
): string {
  const payload = parseStdin(stdinJson);
  if (!payload) return "{}";

  const adapter = detectAdapter(payload);
  const normalized = normalizeWithAdapter(adapter, payload);
  const result = handler(normalized);
  // Side-effect seam: let the caller observe the decision (e.g. record a
  // savings event when a full-file Read is denied). Never blocks formatting.
  if (onResult) {
    try {
      onResult(normalized, result);
    } catch {
      /* best effort — a telemetry side effect never breaks the hook */
    }
  }
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
  const normalized = normalizeWithAdapter(adapter, payload);
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
  const normalized = normalizeWithAdapter(adapter, payload);
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
  const normalized = normalizeWithAdapter(adapter, payload);
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
  const normalized = normalizeWithAdapter(adapter, payload);
  const result = handler(normalized);
  return adapter.formatPromptSubmit(result);
}

/**
 * Async variant of {@link runPromptSubmitHook}. Identical pipeline (parse →
 * detect → normalize → handle → format) but awaits an async handler. Used by
 * the recall-injecting prompt-submit path, which queries the proxy's warm notes
 * store over UDS before deciding what to inject.
 */
export async function runPromptSubmitHookAsync(
  stdinJson: string,
  handler: AsyncHookHandler
): Promise<string> {
  const payload = parseStdin(stdinJson);
  if (!payload) return "{}";

  const adapter = detectAdapter(payload);
  const normalized = normalizeWithAdapter(adapter, payload);
  const result = await handler(normalized);
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
  const normalized = normalizeWithAdapter(adapter, payload);
  normalized.event = "SessionStart";
  const result = handler(normalized);
  return adapter.formatSessionStart(result);
}

/**
 * Run a Stop (turn-end) hook through the universal runner. Claude Code fires
 * Stop when the agent finishes a turn; the result is surfaced to the user
 * (systemMessage), not injected into model context. Adapters without a Stop
 * equivalent format to "{}".
 */
export async function runStopHookAsync(
  stdinJson: string,
  handler: AsyncHookHandler
): Promise<string> {
  const payload = parseStdin(stdinJson);
  if (!payload) return "{}";

  const adapter = detectAdapter(payload);
  const normalized = normalizeWithAdapter(adapter, payload);
  normalized.event = "Stop";
  const result = await handler(normalized);
  return adapter.formatStop(result);
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

/**
 * T7.6 — hard cap on injected additionalContext. Claude Code truncates or
 * rejects oversized additionalContext, and an over-long block buries the
 * load-bearing lines. We cap at 10,000 chars and SPILL the full payload to a
 * file (overflow-to-file) so nothing is silently dropped — the agent gets the
 * head plus a pointer to the complete block. Phrased as state, not an order
 * (prompt-injection defense — §7.6).
 */
export const MAX_ENRICH_CHARS = 10_000;

/** Cap an over-length enrich message: keep a head that fits under the cap
 *  (room reserved for the pointer line) and write the full text to a stable
 *  overflow file. Best-effort — a failed write degrades to an inline note. */
export function capEnrichMessage(message: string): string {
  if (message.length <= MAX_ENRICH_CHARS) return message;
  const head = message.slice(0, MAX_ENRICH_CHARS - 200);
  try {
    const dir = join(process.cwd(), ".unerr", "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "hook-context-overflow.txt");
    writeFileSync(file, message, "utf-8");
    return `${head}\n\nunerr trimmed this context to ${MAX_ENRICH_CHARS} chars; the full block is in ${file}`;
  } catch {
    return `${head}\n\nunerr trimmed this context to ${MAX_ENRICH_CHARS} chars`;
  }
}

/** Create an enrich (additionalContext) result, capped per {@link MAX_ENRICH_CHARS}. */
export function enrich(message: string): HookResult {
  return { action: "enrich", message: capEnrichMessage(message) };
}

/** Create a deny result — blocks the tool call. The `reason` is shown
 *  to the agent so it knows why the call was rejected and what to do
 *  instead. Adapters that lack a true deny channel fall back to a
 *  strongly-worded nudge. */
export function deny(reason: string): HookResult {
  return { action: "deny", message: reason };
}

/** Create a block result — a blocking Stop decision that forces the agent to
 *  keep going instead of ending its turn. Reserved for the capped
 *  autonomous-mode verify gate (stop-hooks.ts); every other Stop path must
 *  stay non-blocking. Adapters without a true Stop-block channel degrade to
 *  their existing non-blocking shape. */
export function block(reason: string): HookResult {
  return { action: "block", message: reason };
}

/** Create a display result — surfaces `message` to the USER ONLY via a
 *  top-level `systemMessage` (Claude Code PostToolUse). Never enters the
 *  model's context (no `additionalContext`). Non-claude adapters return "{}". */
export function display(message: string): HookResult {
  return { action: "display", message };
}

// ── Ambient PreToolUse injection (non-Claude-Code agents) ─────────────
//
// Claude Code receives the mark_intent reminder via UserPromptSubmit
// `additionalContext` (see prompt-hooks.ts). Cursor and Cline have no
// UserPromptSubmit injection channel — their only ambient surface is
// `agent_message` / `context` on PreToolUse. To keep the mark_intent
// contract working across all clients, we drain that reminder into the
// FIRST PreToolUse result of the session for non-Claude-Code agents.

/** Build the ambient prefix for non-Claude-Code agents. Returns an
 *  empty string when nothing is pending. */
function buildAmbientPreInjection(): string {
  const lines: string[] = [];

  // Intent one-shot reminder. Fires AT MOST once per session (the
  // `mark_intent_emitted` flag gates re-emission) so we don't argue
  // with the agent across every tool call. Demoted (Sprint 11): the marker
  // rides a closing-message `unerr journal -` sentinel scraped by the Stop hook,
  // not an MCP round-trip.
  try {
    const cwd = process.cwd();
    const state = readNudgeState(cwd);
    if (!state.mark_intent_emitted) {
      updateNudgeState(cwd, (s) => {
        s.mark_intent_emitted = true;
      });
      lines.push(
        "ur|act if this turn is a coding task (implement/fix/refactor/build), emit `unerr journal - goal - <one-sentence summary>` in your closing message so the resume strip records it (no tool call). Skip for pure read-only questions."
      );
    }
  } catch {
    /* nudge-state unavailable — skip */
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

  // Don't override a deny — that decision is load-bearing.
  if (result.action === "deny") return result;

  if (result.action === "passthrough") {
    return { action: "nudge", message: prefix };
  }
  if (result.action === "rewrite") {
    // Rewrites carry no message channel, so the ambient prefix (mark_intent
    // one-shot only) is dropped on this turn. mark_intent re-arms on the next
    // new conversation, so this is a rare, low-stakes miss rather than a
    // permanent silence.
    return result;
  }
  const existing = result.message ?? "";
  return {
    ...result,
    message: existing.length > 0 ? `${prefix}\n${existing}` : prefix,
  };
}
